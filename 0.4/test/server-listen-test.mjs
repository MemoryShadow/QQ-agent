// 隔离启动真实 HTTP 服务，验证内网监听、SSE、同源校验及原有可选令牌。
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { bootApp, createChecker, freePort, waitFor, ROOT } from './_harness.mjs';

const c = createChecker('内网控制台');
let ctx;

try {
  ctx = await bootApp({ config: { server: { host: '0.0.0.0', port: await freePort(), token: '' } } });
  const { app, port, base, request, rawRequest } = ctx;
  const host = `agent.example.test:${port}`;

  await c.check('可通过配置指定内网监听，无需口令', async () => {
    assert.equal(app.server.address().address, '0.0.0.0');
    assert.equal(app.getConfig().server.host, '0.0.0.0');
  });

  for (const args of [['--host', '0.0.0.0'], ['--host=0.0.0.0'], ['--host']]) {
    await c.check(`真实 headless 入口接受 ${args.join(' ')}，覆盖配置且不写回`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-host-cli-'));
      const childPort = await freePort();
      const configFile = path.join(dir, 'config.json');
      fs.writeFileSync(configFile, JSON.stringify({ ...app.getConfig(), server: { host: '127.0.0.1', port: childPort, token: '' } }));
      const child = spawn(process.execPath, ['src/server.js', ...args], {
        cwd: ROOT, env: { ...process.env, QQ_AGENT_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      try {
        // 启动日志通过 API 读取，避免依赖终端日志转发方式。
        await waitFor(async () => {
          if (child.exitCode !== null) return true;
          const response = await fetch(`http://127.0.0.1:${childPort}/api/logs`, { signal: AbortSignal.timeout(1000) });
          const data = await response.json();
          return data.logs?.some((entry) => entry.text.includes(`http://0.0.0.0:${childPort}`));
        }, 8000, 'headless 启动');
        assert.equal(child.exitCode, null, output);
        const response = await fetch(`http://127.0.0.1:${childPort}/api/status`);
        assert.equal(response.status, 200);
        await response.text();
        assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).server.host, '127.0.0.1');
      } finally {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
            child.kill('SIGINT');
            await exited;
          }
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }

  await c.check('页面和脚本可直接访问，不触发登录挑战', async () => {
    for (const url of ['/', '/app/00-core.js']) {
      const r = await request('GET', url);
      assert.equal(r.status, 200, url);
      assert.equal(r.headers.get('www-authenticate'), null);
      assert.ok(r.text.length > 100);
    }
  });

  await c.check('远程同源 API 和明文密钥端点可用', async () => {
    const headers = { host, origin: `http://${host}`, 'x-console-token': 'qq-agent-console' };
    for (const url of ['/api/status', '/api/api-key', '/api/config']) {
      const r = await rawRequest('GET', url, headers);
      assert.equal(r.status, 200, url);
    }
  });

  await c.check('仍拒绝外部 Origin、Referer 和跨站请求', async () => {
    for (const source of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { referer: 'https://evil.example/' },
      { 'sec-fetch-site': 'cross-site' }
    ]) {
      const r = await rawRequest('GET', '/api/api-key', { host, ...source });
      assert.equal(r.status, 403, JSON.stringify(source));
    }
    const before = app.orchestrator.paused;
    const r = await request('POST', '/api/pause', {
      origin: 'https://evil.example', body: { paused: !before }
    });
    assert.equal(r.status, 403);
    assert.equal(app.orchestrator.paused, before);
    const events = await rawRequest('GET', '/api/events', { host, origin: 'https://evil.example' });
    assert.equal(events.status, 403);
  });

  await c.check('同源请求可以保存设置', async () => {
    const r = await request('POST', '/api/config', {
      origin: base, body: { ui: { theme: 'light' } }
    });
    assert.equal(r.status, 200);
    assert.equal(app.getConfig().ui.theme, 'light');
  });

  await c.check('实时事件流无需凭据即可连接', async () => {
    const controller = new AbortController();
    try {
      const r = await fetch(`${base}/api/events`, { signal: controller.signal });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/event-stream/);
      const reader = r.body.getReader();
      const first = await reader.read();
      assert.match(Buffer.from(first.value).toString(), /event: hello/);
      await reader.cancel();
    } finally {
      controller.abort();
    }
  });

  const lanAddress = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
  if (lanAddress) {
    await c.check('通过真实非回环网卡 IP 直接访问页面和 API', async () => {
      const origin = `http://${lanAddress}:${port}`;
      for (const url of ['/', '/api/status']) {
        const r = await fetch(origin + url, {
          headers: { origin }, signal: AbortSignal.timeout(5000)
        });
        assert.equal(r.status, 200, url);
        await r.text();
      }
    });
  } else {
    console.log('  SKIP  当前环境没有非回环 IPv4 网卡');
  }

  await c.check('原有 server.token 可选校验行为保持不变', async () => {
    const token = 'existing-console-token-test-only';
    app.updateConfig({ server: { token } });
    try {
      const denied = await request('GET', '/api/status');
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('www-authenticate'), null);
      assert.equal((await rawRequest('GET', '/api/status', { host, 'x-console-token': 'wrong-token' })).status, 401);
      assert.equal((await rawRequest('GET', '/api/status', { host, 'x-console-token': token })).status, 200);
      assert.equal((await rawRequest('GET', `/api/status?token=${token}`, { host })).status, 200);
      const config = await rawRequest('GET', '/api/config', { host, 'x-console-token': token });
      assert.equal(config.status, 200);
      assert.equal(config.data.server.token, undefined);
      assert.ok(!config.text.includes(token));
    } finally {
      app.updateConfig({ server: { token: '' } });
    }
    assert.equal((await rawRequest('GET', '/api/status', { host })).status, 200);
  });
} finally {
  if (ctx) await ctx.teardown();
}

c.finish();
process.exit(process.exitCode || 0);

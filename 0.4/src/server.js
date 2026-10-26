// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
import { createApp } from './app.js';
import { parseArgs } from 'node:util';

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
// 未捕获异常后进程处于未定义状态（定时器丢失/连接悬空），记录后退出，
// 交给外层（systemd/脚本守护）重启 —— 只打印不退出会"半死不活"地挂着
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  process.exit(1);
});

// --host 不带地址时监听所有 IPv4 网卡，也支持 --host 地址 / --host=地址。
const args = process.argv.slice(2).map((arg, i, all) =>
  arg === '--host' && (!all[i + 1] || all[i + 1].startsWith('-')) ? '--host=0.0.0.0' : arg
);
const { values } = parseArgs({ args, options: { host: { type: 'string' } } });
if (values.host !== undefined && !values.host.trim()) throw new Error('--host 的地址不能为空');
const app = createApp({ host: values.host });
app.start().catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('退出中…');
  await app.stop();
  process.exit(0);
});

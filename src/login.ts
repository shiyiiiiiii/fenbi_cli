/**
 * npm run login —— 登录一次，Cookie 落到 .auth/cookies.json，之后自动复用。
 *
 * 做法：用系统已安装的 Chrome 以独立 profile 启动（%LOCALAPPDATA%\fenbi-cli\chrome-profile），
 * 开 CDP 端口，打开粉笔登录页；用户自己在窗口里登录，脚本每 3 秒通过 CDP 读 Cookie
 * 并打一次 users/current，确认后写盘并关闭窗口。不接触账号密码/验证码。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { AUTH_FILE, headerFrom, probeCookieHeader, saveCookies, type StoredCookie } from './auth.js';

const LOGIN_URLS = [
  'https://www.fenbi.com/spa/tiku/guide/catalog',
  'https://fenbi.com/spa/tiku/guide/catalog',
  'https://tiku.fenbi.com/',
];

const PROFILE_DIR = path.join(process.env.LOCALAPPDATA ?? 'C:\\Users\\Public\\AppData\\Local', 'fenbi-cli', 'chrome-profile');
const POLL_MS = 3000;

type Args = { keep: boolean; port: number | null; help: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { keep: false, port: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') args.keep = true;
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env['PROGRAMFILES(X86)']
      ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

type CdpMessage = { id?: number; result?: unknown; error?: { message?: string } };

class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(String(ev.data)) as CdpMessage;
      } catch {
        return;
      }
      if (typeof msg.id !== 'number') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP 错误'));
      else p.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP 连接已关闭'));
      }
      this.pending.clear();
    });
  }

  static connect(url: string, timeoutMs = 10000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error('CDP 连接超时'));
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new Cdp(ws));
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP 连接失败'));
        },
        { once: true },
      );
    });
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 15000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function waitForVersion(port: number, timeoutMs: number): Promise<{ webSocketDebuggerUrl: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()) as { webSocketDebuggerUrl: string };
    } catch {
      // Chrome 还没起来
    }
    await sleep(300);
  }
  throw new Error(`等不到 Chrome 的调试端口 ${port}（profile 可能已被其他 Chrome 实例占用，请先关掉它）`);
}

async function waitForPage(port: number, timeoutMs: number): Promise<{ webSocketDebuggerUrl: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = (await res.json()) as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).startsWith('devtools://'));
        if (page?.webSocketDebuggerUrl) return { webSocketDebuggerUrl: page.webSocketDebuggerUrl };
      }
    } catch {
      // 继续等
    }
    await sleep(300);
  }
  throw new Error('Chrome 没有可用的标签页');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法: npm run login [-- --keep] [-- --port 9222]

用系统 Chrome 的独立 profile 打开粉笔登录页；你在窗口里登录后，
脚本会自动把 Cookie 写到 ${AUTH_FILE}（每次启动 TUI 自动复用，失效再跑一次）。

  --keep        登录成功后保留浏览器窗口
  --port <n>    指定 CDP 端口（默认随机）
  --help        显示帮助`);
    return;
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error('找不到系统 Chrome。请安装 Google Chrome，或用环境变量 CHROME_PATH 指向 chrome.exe。');
    process.exit(1);
  }

  await mkdir(PROFILE_DIR, { recursive: true });
  const port = args.port ?? (await freePort());

  console.log(`Chrome：${chrome}`);
  console.log(`独立配置：${PROFILE_DIR}`);
  console.log(`调试端口：${port}`);

  const child = spawn(
    chrome,
    [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: false },
  );
  child.on('error', (e) => {
    console.error(`启动 Chrome 失败：${e.message}`);
    process.exit(1);
  });

  let browser: Cdp | null = null;
  try {
    const version = await waitForVersion(port, 20000);
    browser = await Cdp.connect(version.webSocketDebuggerUrl);

    const pageTarget = await waitForPage(port, 15000);
    const page = await Cdp.connect(pageTarget.webSocketDebuggerUrl);
    await page.send('Page.enable').catch(() => undefined);

    for (const url of LOGIN_URLS) {
      try {
        const nav = await page.send<{ errorText?: string }>('Page.navigate', { url });
        if (!nav?.errorText) {
          console.log(`已打开登录页：${url}`);
          break;
        }
        console.log(`打开失败（${nav.errorText}），换下一个入口：${url}`);
      } catch (e) {
        console.log(`打开失败（${(e as Error).message}），换下一个入口：${url}`);
      }
    }

    console.log('');
    console.log('请在弹出的 Chrome 窗口里完成登录（扫码/账号密码都行，本脚本不接触你的凭据）。');
    console.log(`每 ${POLL_MS / 1000} 秒自动检查一次登录态，Ctrl+C 可随时退出。`);
    console.log('');

    let lastState = '';
    for (;;) {
      if (browser.closed || page.closed) throw new Error('Chrome 窗口已关闭，登录未完成');
      let cookies: StoredCookie[] = [];
      try {
        const res = await browser.send<{ cookies?: StoredCookie[] }>('Storage.getCookies');
        cookies = res?.cookies ?? [];
      } catch (e) {
        if (browser.closed) throw new Error('Chrome 窗口已关闭，登录未完成');
        console.log(`读取 Cookie 失败（${(e as Error).message}），稍后重试…`);
        await sleep(POLL_MS);
        continue;
      }
      const header = headerFrom(cookies);
      if (header) {
        const probe = await probeCookieHeader(header);
        if (probe.ok) {
          const file = await saveCookies(cookies);
          console.log(`✓ 已登录：userid=${probe.userId}${probe.phone ? `（${probe.phone}）` : ''}`);
          console.log(`✓ Cookie 已写入 ${file}`);
          page.close();
          if (!args.keep) {
            await browser.send('Browser.close').catch(() => undefined);
            console.log('已关闭登录窗口。');
          }
          browser.close();
          process.exit(0);
        }
        const state = probe.status ? `HTTP ${probe.status}` : probe.detail;
        if (state !== lastState) console.log(`尚未登录（${state}），继续等待…`);
        lastState = state;
      }
      await sleep(POLL_MS);
    }
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    if (browser) browser.close();
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\n已退出登录流程（Chrome 窗口保留，可手动关闭）。');
  process.exit(130);
});

void main();

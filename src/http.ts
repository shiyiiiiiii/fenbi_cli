/**
 * 统一 HTTP 出口：sync / quick / auth 的所有请求都走 fenbiFetch。
 *
 * 头部对齐本机登录用的 Chrome（版本从安装目录探测，UA 用主版本号），
 * 补上 Accept / Accept-Language / Referer / Origin / sec-ch-ua / sec-fetch-*。
 * 说明：TLS 指纹、HTTP/2 头顺序、accept-encoding 等由运行时（undici）决定，脚本层不模拟。
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const FALLBACK_MAJOR = '157';

function detectChromeMajor(): string {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter((p): p is string => !!p)
    .map((p) => path.join(p, 'Google', 'Chrome', 'Application'));
  for (const dir of roots) {
    try {
      const versions = readdirSync(dir)
        .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]));
      const latest = versions.at(-1);
      if (latest) return latest.split('.')[0];
    } catch {
      // 目录不存在就继续找下一个
    }
  }
  return FALLBACK_MAJOR;
}

const CHROME_MAJOR = detectChromeMajor();

/** 与登录浏览器一致的 Chrome UA（Windows / x64） */
export const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

const SEC_CH_UA = `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`;

export type FenbiFetchInit = Omit<RequestInit, 'headers'> & {
  cookie?: string;
  /** 页面来源；tiku 接口由 www.fenbi.com 的页面发起 */
  referer?: string;
  headers?: Record<string, string>;
};

/** fenbi.com 域下的统一请求；cookie 显式传入，头部在这里补齐 */
export function fenbiFetch(url: string, init: FenbiFetchInit = {}): Promise<Response> {
  const { cookie, referer = 'https://www.fenbi.com/', headers, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const base: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'user-agent': CHROME_UA,
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    referer,
  };
  if (method !== 'GET' && method !== 'HEAD') base.origin = 'https://www.fenbi.com';
  if (cookie) base.cookie = cookie;
  return fetch(url, { ...rest, headers: { ...base, ...(headers ?? {}) } });
}

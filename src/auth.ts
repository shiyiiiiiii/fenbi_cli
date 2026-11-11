/**
 * 登录态与 Cookie 的唯一入口。
 *
 * 读取顺序：FENBI_COOKIE 环境变量 > .auth/cookies.json（npm run login 写出）> verify/cookies.json
 * 登录校验：GET /api/users/current（200 有 id 视为已登录；401/403/453 视为需要登录）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { fenbiFetch } from './http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'https://tiku.fenbi.com';

export const AUTH_FILE = process.env.FENBI_AUTH_FILE
  ? path.resolve(process.env.FENBI_AUTH_FILE)
  : path.join(ROOT, '.auth', 'cookies.json');
export const VERIFY_FILE = process.env.FENBI_COOKIE_FILE
  ? path.resolve(process.env.FENBI_COOKIE_FILE)
  : path.join(ROOT, 'verify', 'cookies.json');

export type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
};

export type CookieSource = 'env' | 'auth' | 'verify';

export type CookieInfo = { header: string; source: CookieSource; file?: string };

function isFenbiDomain(domain: string): boolean {
  return /(^|\.)fenbi\.com$/i.test(domain);
}

/** Cookie 数组 → 请求头；同名以后出现的为准 */
export function headerFrom(cookies: StoredCookie[]): string {
  const map = new Map<string, string>();
  for (const c of cookies) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
    if (!isFenbiDomain(String(c.domain ?? ''))) continue;
    map.set(c.name, c.value);
  }
  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function readCookiesFile(file: string): Promise<StoredCookie[] | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as StoredCookie[]) : null;
  } catch {
    return null;
  }
}

/** 按统一顺序取 Cookie；都没有时返回 null */
export async function loadCookie(opts?: { verifyFile?: string }): Promise<CookieInfo | null> {
  const env = process.env.FENBI_COOKIE?.trim();
  if (env) return { header: env, source: 'env' };

  const candidates: Array<{ source: CookieSource; file: string }> = [
    { source: 'auth', file: AUTH_FILE },
    { source: 'verify', file: opts?.verifyFile ? path.resolve(opts.verifyFile) : VERIFY_FILE },
  ];
  for (const { source, file } of candidates) {
    const cookies = await readCookiesFile(file);
    const header = cookies ? headerFrom(cookies) : '';
    if (header) return { header, source, file };
  }
  return null;
}

export async function loadCookieHeader(): Promise<string> {
  const info = await loadCookie();
  if (!info) {
    throw new Error(
      `没有可用 Cookie：先运行 npm run login，或把 Cookie 写到 ${AUTH_FILE} / ${VERIFY_FILE}，或设置 FENBI_COOKIE。`,
    );
  }
  return info.header;
}

/** 浏览器里拿到的 Cookie 落盘到 .auth/cookies.json（只保留 fenbi.com 域） */
export async function saveCookies(cookies: StoredCookie[]): Promise<string> {
  const kept = cookies
    .filter((c) => c && typeof c.name === 'string' && isFenbiDomain(String(c.domain ?? '')))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? '/',
      ...(c.expires ? { expires: c.expires } : {}),
    }));
  await mkdir(path.dirname(AUTH_FILE), { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify(kept, null, 2), 'utf8');
  return AUTH_FILE;
}

export type UserProbe =
  | { ok: true; userId: number; phone?: string }
  | { ok: false; status: number; detail: string };

/** 用给定 Cookie 头打一次 users/current（不读文件） */
export async function probeCookieHeader(header: string): Promise<UserProbe> {
  let res: Response;
  try {
    res = await fenbiFetch(`${HOST}/api/users/current`, { cookie: header });
  } catch (e) {
    return { ok: false, status: 0, detail: (e as Error).message };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, detail: `HTTP ${res.status} ${text.slice(0, 100)}`.trim() };
  try {
    const data = JSON.parse(text) as { id?: number; phone?: string };
    if (typeof data?.id === 'number') return { ok: true, userId: data.id, phone: data.phone };
    return { ok: false, status: res.status, detail: '响应里没有 user id' };
  } catch {
    return { ok: false, status: res.status, detail: '接口返回非 JSON（可能是登录页跳转）' };
  }
}

export type SessionState =
  | { state: 'ok'; userId: number; phone?: string; source: CookieSource }
  | { state: 'unauthorized'; source: CookieSource; detail: string }
  | { state: 'network'; detail: string }
  | { state: 'none'; detail: string };

const AUTH_STATUS = new Set([401, 403, 453]);

/** 启动校验：区分「没有 Cookie / 登录失效 / 网络异常」 */
export async function checkSession(): Promise<SessionState> {
  const info = await loadCookie();
  if (!info) return { state: 'none', detail: '本地没有 Cookie' };
  const probe = await probeCookieHeader(info.header);
  if (probe.ok) return { state: 'ok', userId: probe.userId, phone: probe.phone, source: info.source };
  if (probe.status === 0 || probe.status >= 500) return { state: 'network', detail: probe.detail };
  if (AUTH_STATUS.has(probe.status)) return { state: 'unauthorized', source: info.source, detail: probe.detail };
  return { state: 'network', detail: probe.detail };
}

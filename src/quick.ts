/**
 * 「快速练习（联网）」的最小 API 客户端。
 *
 * 链路（2026-11 实测，见 verify/quick_net.log）：
 *   getCurrent → POST /api/{prefix}/exercises(type=3&exerciseTimeMode=2)
 *     → getExercise（拿 static token / submitUrl / updateUserAnswerUrl）
 *     → static/exercise（题面）
 *     → incrUpdate 逐题上报（answer.type=201）→ submit → static/solution + getMeta
 *
 * 只负责请求与最小归一化，渲染与交互在 tui.tsx。
 */
import { loadCookieHeader as loadSharedCookieHeader } from './auth.js';
import { fenbiFetch, type FenbiFetchInit } from './http.js';

const HOST = 'https://tiku.fenbi.com';
const LIST_QS = 'app=web&kav=131&av=134&hav=128&version=3.0.0.0&deviceId=&gav=2&apcId=0';
const COMBINE_QS = 'kav=125&av=127&hav=125&app=web&apcid=0&deviceId=&gav=2';

/** 快速练习的固定题量（服务端决定，客户端不传；仅用于界面提示） */
export const QUICK_COUNT = 15;

export type QuickErrorKind = 'auth' | 'network' | 'api' | 'data';

export class QuickError extends Error {
  kind: QuickErrorKind;
  constructor(kind: QuickErrorKind, message: string) {
    super(message);
    this.name = 'QuickError';
    this.kind = kind;
  }
}

export type Category = {
  examCategoryId: number;
  name: string;
  path: string[];
  prefix: string;
  courseName: string;
};

export type QuickQuestion = {
  globalId: string;
  id: number;
  type: number;
  content: string;
  options: string[];
  optionsType: number | null;
  answer: { choice: string; type: number } | null;
  solution: { content: string | null; source: string | null; keypoints: Array<{ id: number; name: string }> };
  stats: { wrongCount: number; totalCount: number; correctRatio: number } | null;
};

export type QuickMaterial = { globalId: string; content: string };

export type QuickCard = {
  nodeType: number;
  key?: string;
  name?: string;
  materialKeys?: string[];
  children?: QuickCard[];
};

export type LoadedExercise = {
  key: string;
  prefix: string;
  name: string;
  token: string;
  submitUrl: string;
  updateUrl: string;
  materials: QuickMaterial[];
  questions: QuickQuestion[];
  card: QuickCard | null;
};

type RawQuestion = {
  id: number;
  globalId: string;
  type: number;
  content: string;
  accessories?: Array<{ options?: string[]; type?: number }>;
};

type StaticExercise = {
  name?: string;
  materials?: QuickMaterial[];
  questions?: RawQuestion[];
  card?: QuickCard | null;
};

type SolutionItem = RawQuestion & {
  solution?: string;
  source?: string;
  keypoints?: Array<{ id: number; name: string }>;
  correctAnswer?: { choice: string; type: number };
};

type MetaItem = { id: number; wrongCount: number; totalCount: number; correctRatio: number };

// ---------------------------------------------------------------- 基础设施

/** Cookie 统一走 auth：FENBI_COOKIE > .auth/cookies.json > verify/cookies.json */
export async function loadCookieHeader(): Promise<string> {
  try {
    return await loadSharedCookieHeader();
  } catch (e) {
    throw new QuickError('auth', (e as Error).message);
  }
}

function authHint(msg: string): QuickError {
  return new QuickError('auth', `登录态已失效：${msg}\n请运行 npm run login 重新登录，或更新 verify/cookies.json / FENBI_COOKIE。`);
}

/** 会话失效的几种表现：401/403/453、返回网页、或消息里带登录/会话字样 */
function looksLikeAuthFailure(status: number, msg: string): boolean {
  return status === 401 || status === 403 || status === 453 || /登录|登陆|login|session|DeviceSid/i.test(msg);
}

async function request<T>(url: string, cookieHeader: string, init?: FenbiFetchInit): Promise<T> {
  let res: Response;
  try {
    res = await fenbiFetch(url, { ...init, cookie: cookieHeader });
  } catch (e) {
    throw new QuickError('network', `网络请求失败：${(e as Error).message}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (looksLikeAuthFailure(res.status, text) || /<html/i.test(text)) {
      throw authHint(`HTTP ${res.status}，接口返回网页而非 JSON`);
    }
    throw new QuickError('api', `HTTP ${res.status} 返回非 JSON：${text.slice(0, 120)}`);
  }

  const obj = parsed as { code?: number; msg?: string; message?: string; data?: unknown };
  const msg = obj?.msg ?? obj?.message ?? '';
  if (looksLikeAuthFailure(res.status, msg) && res.status !== 200) throw authHint(`HTTP ${res.status} ${msg}`.trim());
  if (res.status >= 400) {
    throw new QuickError('api', `HTTP ${res.status}：${msg || text.slice(0, 150)}`);
  }
  if (typeof obj?.code === 'number' && obj.code !== 1) {
    if (looksLikeAuthFailure(0, msg)) throw authHint(msg);
    throw new QuickError('api', `code=${obj.code} ${msg}`.trim());
  }
  return parsed as T;
}

function withQuery(base: string, extra: string): string {
  return `${base}${base.includes('?') ? '&' : '?'}${extra}`;
}

// ---------------------------------------------------------------- 业务接口

/** 当前考试类目：examcatid + 课程 prefix（不硬编码 syzc/xingce） */
export async function getCurrent(cookieHeader: string): Promise<Category> {
  const url = `${HOST}/activity/userexamcategory/getCurrent?noCacheTag=${Date.now()}&${LIST_QS}`;
  const res = await request<{
    data?: {
      examCategoryId: number;
      name?: string;
      path?: string[];
      currentCourse?: { name?: string; prefix?: string };
      courses?: Array<{ name?: string; prefix?: string }>;
    };
  }>(url, cookieHeader);
  const data = res.data;
  const course = data?.currentCourse ?? data?.courses?.[0];
  if (!data?.examCategoryId || !course?.prefix) {
    throw new QuickError('data', 'getCurrent 未返回 examCategoryId / currentCourse.prefix，无法确定练习类目。');
  }
  return {
    examCategoryId: data.examCategoryId,
    name: data.name ?? String(data.examCategoryId),
    path: data.path ?? [],
    prefix: course.prefix,
    courseName: course.name ?? '',
  };
}

/** 用户已选的考试类目列表（含课程 prefix）；接口异常时抛 QuickError */
export async function getSelectedCategories(cookieHeader: string): Promise<Category[]> {
  const url = `${HOST}/activity/userexamcategory/getUserSelectedList?noCacheTag=${Date.now()}&${LIST_QS}`;
  const res = await request<{
    data?: Array<{
      examCategoryId: number;
      name?: string;
      path?: string[];
      courses?: Array<{ name?: string; prefix?: string }>;
    }>;
  }>(url, cookieHeader);
  const list = res.data ?? [];
  const out: Category[] = [];
  for (const item of list) {
    const course = item.courses?.[0];
    if (!item.examCategoryId || !course?.prefix) continue;
    out.push({
      examCategoryId: item.examCategoryId,
      name: item.name ?? String(item.examCategoryId),
      path: item.path ?? [],
      prefix: course.prefix,
      courseName: course.name ?? '',
    });
  }
  return out;
}

/** 创建一轮快速练习（type=3 即 Quick）。会在账号里留下一条练习记录。 */
export async function createQuick(
  cookieHeader: string,
  category: Category,
): Promise<{ key: string; name: string; questionCount: number }> {
  const url = `${HOST}/api/${encodeURIComponent(category.prefix)}/exercises?${LIST_QS}&examcatid=${category.examCategoryId}`;
  const res = await request<{ key?: string; sheet?: { name?: string; questionCount?: number } }>(url, cookieHeader, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'type=3&exerciseTimeMode=2',
  });
  if (!res.key) throw new QuickError('data', '创建练习的响应里没有 key。');
  return {
    key: res.key,
    name: res.sheet?.name ?? '快速智能练习',
    questionCount: res.sheet?.questionCount ?? QUICK_COUNT,
  };
}

type ExerciseDetail = {
  data?: {
    exerciseId?: string;
    name?: string;
    staticUrl?: { urls?: string[] };
    submitUrl?: string;
    updateUserAnswerUrl?: string;
    switchVO?: { requestKey?: string };
  };
};

/** getExercise + static/exercise：拿到练习 key 对应的 token 与题面 */
export async function loadExercise(cookieHeader: string, prefix: string, key: string): Promise<LoadedExercise> {
  const detailUrl = `${HOST}/combine/exercise/getExercise?format=html&key=${encodeURIComponent(key)}&routecs=${encodeURIComponent(prefix)}&${COMBINE_QS}`;
  const detail = await request<ExerciseDetail>(detailUrl, cookieHeader);
  const d = detail.data;
  const staticUrl = d?.staticUrl?.urls?.[0];
  const token = staticUrl ? new URL(staticUrl).searchParams.get('key') : (d?.switchVO?.requestKey ?? null);
  if (!token) throw new QuickError('data', `getExercise 未返回 staticUrl / requestKey（${key}）。`);
  if (!d?.submitUrl || !d.updateUserAnswerUrl) {
    throw new QuickError('data', 'getExercise 未返回 submitUrl / updateUserAnswerUrl。');
  }

  const sheetUrl = `${HOST}/combine/static/exercise?key=${encodeURIComponent(token)}&routecs=${encodeURIComponent(prefix)}&type=1&${COMBINE_QS}`;
  const sheet = await request<StaticExercise>(sheetUrl, cookieHeader);

  return {
    key,
    prefix,
    name: sheet.name ?? d?.name ?? '快速智能练习',
    token,
    submitUrl: d.submitUrl,
    updateUrl: d.updateUserAnswerUrl,
    materials: sheet.materials ?? [],
    card: sheet.card ?? null,
    questions: (sheet.questions ?? []).map((q) => ({
      globalId: q.globalId,
      id: q.id,
      type: q.type,
      content: q.content,
      options: q.accessories?.[0]?.options ?? [],
      optionsType: q.accessories?.[0]?.type ?? null,
      answer: null,
      solution: { content: null, source: null, keypoints: [] },
      stats: null,
    })),
  };
}

/** 全站正确率等统计，失败不影响主流程 */
export async function fetchStats(cookieHeader: string, prefix: string, token: string): Promise<Record<string, MetaItem>> {
  const url = `${HOST}/combine/question/getMeta?requestKey=${encodeURIComponent(token)}&routecs=${encodeURIComponent(prefix)}&${COMBINE_QS}`;
  const res = await request<{ data?: Record<string, MetaItem> }>(url, cookieHeader);
  return res.data ?? {};
}

export type AnswerItem = { globalId: string; choice: string; time: number };

/** 逐题上报作答（answer.type 必须是 201，101 会被服务端静默忽略） */
export async function reportAnswers(
  cookieHeader: string,
  prefix: string,
  updateUrl: string,
  items: AnswerItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (!items.length) return;
  const url = withQuery(updateUrl, `routecs=${encodeURIComponent(prefix)}&${COMBINE_QS}`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    await request(url, cookieHeader, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ key: it.globalId, time: it.time, answer: { choice: it.choice, type: 201 } }]),
    });
    onProgress?.(i + 1, items.length);
  }
}

export async function submitExercise(cookieHeader: string, prefix: string, submitUrl: string): Promise<void> {
  const url = withQuery(submitUrl, `routecs=${encodeURIComponent(prefix)}&${COMBINE_QS}`);
  await request(url, cookieHeader, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

/** 交卷后才有解析；未交卷时该接口 404 "exercise is not submit" */
export async function fetchSolutions(
  cookieHeader: string,
  prefix: string,
  token: string,
): Promise<Array<{ globalId: string; answer: { choice: string; type: number } | null; solution: QuickQuestion['solution'] }>> {
  const url = `${HOST}/combine/static/solution?key=${encodeURIComponent(token)}&routecs=${encodeURIComponent(prefix)}&type=1&${COMBINE_QS}`;
  const res = await request<{ solutions?: SolutionItem[] }>(url, cookieHeader);
  return (res.solutions ?? []).map((s) => ({
    globalId: s.globalId,
    answer: s.correctAnswer ?? null,
    solution: {
      content: s.solution ?? null,
      source: s.source ?? null,
      keypoints: s.keypoints ?? [],
    },
  }));
}

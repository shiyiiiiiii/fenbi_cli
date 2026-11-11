import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadCookie } from './auth.js';
import { fenbiFetch, type FenbiFetchInit } from './http.js';
import { readCatalogFile, scanLocalPapers, type CatalogPaper } from './catalog.js';

/**
 * 粉笔题库同步器（最小实现）
 * 链路：papers/v2 → (exercises 创建/复用) → getExercise → static/exercise
 *       → static/solution → getMeta
 * 只做 GET 读取与"开始练习"这一必要动作，不提交答案。
 */

const HOST = 'https://tiku.fenbi.com';
// 列表接口版本号（实测 2026-11：kav/av/hav 为 131/134/128）
const LIST_QS = 'app=web&kav=131&av=134&hav=128&version=3.0.0.0&deviceId=&gav=2&apcId=0';
// 练习接口版本号
const COMBINE_QS = 'routecs=xingce&kav=125&av=127&hav=125&app=web&apcid=0&deviceId=&gav=2';
// static/* 必须补的完整参数：只带 key 会 404
const STATIC_QS = 'routecs=xingce&type=1&kav=125&av=127&hav=125&app=web&apcid=0&deviceId=&gav=2';

type Args = {
  paper?: string;
  label?: string;
  token?: string;
  catalog: string | null;
  category?: string;
  onlyExercise: boolean;
  submitted: boolean;
  force: boolean;
  limit: number;
  outDir: string;
  cookiesFile: string;
  examcat: string;
  report: boolean;
  create: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    catalog: null,
    onlyExercise: false,
    submitted: false,
    force: false,
    limit: 3,
    outDir: 'data',
    cookiesFile: 'verify/cookies.json',
    examcat: '1000134',
    report: false,
    create: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--paper') args.paper = val();
    else if (a === '--label') args.label = val();
    else if (a === '--token') args.token = val();
    else if (a === '--catalog') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.catalog = next;
        i++;
      } else {
        args.catalog = path.join('data', 'catalog.json');
      }
    } else if (a === '--category') args.category = val();
    else if (a === '--only-exercise') args.onlyExercise = true;
    else if (a === '--submitted') args.submitted = true;
    else if (a === '--force') args.force = true;
    else if (a === '--limit') args.limit = Number(val());
    else if (a === '--out') args.outDir = val();
    else if (a === '--cookies') args.cookiesFile = val();
    else if (a === '--examcat') args.examcat = val();
    else if (a === '--report') args.report = true;
    else if (a === '--create') args.create = true;
    else if (a === '--help' || a === '-h') {
      console.log(`用法:
  npm run sync -- --paper 1_1_40bsrit            # 按练习 key 同步一套卷
  npm run sync -- --label 1 --limit 3            # 同步某分类下前 N 套卷（仅限已有进行中练习的卷）
  npm run sync -- --catalog --label 1 --limit 3  # 从 data/catalog.json 批量同步（默认跳过已同步）
  npm run sync -- --catalog --category 国考      # 按分类名称/路径筛选清单
  npm run sync -- --catalog --only-exercise      # 只挑有进行中练习的卷子
  npm run sync -- --catalog --submitted --limit 20 # 只挑已交卷的卷子（走试卷级解析，不建练习）
  npm run sync -- --token <staticUrl 里的 key>   # 已交卷的练习无法走 getExercise，用 token 直接同步
可选:
  --catalog [file]   从清单批量同步，默认 data/catalog.json
  --category <文字>  按清单里的分类名/层级路径筛选
  --only-exercise    只同步已有 exerciseKey 的卷子
  --submitted        只同步已交卷的卷子；没有 exerciseKey 时走 getPaperSolution
  --force            已同步过的也重新拉取（默认跳过）
  --limit <n>        批量时最多处理几套，默认 3
  --out <dir>        输出目录，默认 data/
  --cookies <file>   Cookie 文件，默认 verify/cookies.json（或环境变量 FENBI_COOKIE）
  --examcat <id>     examcatid，默认 1000134（行测）
  --create           批量同步时，对无 exercise.key 的卷创建练习（默认跳过）
  --report           额外抓取 getReport 成绩报告`);
      process.exit(0);
    }
  }
  return args;
}

async function loadCookieHeader(args: Args): Promise<string> {
  const info = await loadCookie({ verifyFile: args.cookiesFile });
  if (!info) {
    throw new Error(
      `没有可用 Cookie：先运行 npm run login，或把 Cookie 写到 .auth/cookies.json / ${args.cookiesFile}，或设置 FENBI_COOKIE。`,
    );
  }
  return info.header;
}

async function api<T>(url: string, cookieHeader: string, init?: FenbiFetchInit): Promise<T> {
  const res = await fenbiFetch(url, { ...init, cookie: cookieHeader });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)} :: ${url}`);
  const parsed = JSON.parse(text) as unknown;
  if (parsed && typeof parsed === 'object' && 'code' in parsed && (parsed as { code: number }).code !== 1) {
    const msg = (parsed as { msg?: string }).msg ?? '';
    throw new Error(`code=${(parsed as { code: number }).code} ${msg} :: ${url}`);
  }
  return parsed as T;
}

type Paper = {
  id: number;
  name: string;
  date?: string;
  type?: number;
  combineKey?: string;
  paperMeta?: unknown;
  exercise?: { key?: string | null; id?: number; status?: number };
};

type ExerciseDetail = {
  code: number;
  data: { exerciseId: string; name: string; status?: number; staticUrl?: { urls?: string[] } };
};

type RawQuestion = {
  id: number;
  globalId: string;
  tikuPrefix?: string;
  content: string;
  type: number;
  accessories?: Array<{ options?: string[]; type?: number }>;
};

type StaticExercise = {
  name: string;
  materials: Array<{ id: number; globalId: string; content: string; accessories?: unknown }>;
  questions: RawQuestion[];
  card?: unknown;
};

type SolutionItem = RawQuestion & {
  solution?: string;
  source?: string;
  keypoints?: Array<{ id: number; name: string }>;
  correctAnswer?: { choice: string; type: number };
};

type StaticSolution = {
  name: string;
  materials?: Array<{ id: number; globalId: string; content: string }>;
  solutions: SolutionItem[];
  card?: unknown;
};

type MetaItem = {
  id: number;
  wrongCount: number;
  totalCount: number;
  mostWrongAnswer?: { choice: string; type: number };
  correctRatio: number;
};

/** 试卷级解析（/combine/cdn/paper/solution）里正文是 doc JSON，不是 HTML */
type DocNode = { name: string; value?: string; children?: DocNode[] };

type PaperSolutionDoc = {
  name: string;
  materials?: Array<{ id: number; globalId: string; content: string }>;
  solutions: Array<{
    id: number;
    globalId: string;
    tikuPrefix?: string;
    content: string;
    type: number;
    accessories?: Array<{ options?: string[]; type?: number }>;
    solution?: string;
    source?: string;
    keypoints?: Array<{ id: number; name: string }>;
    correctAnswer?: { choice: string; type: number };
  }>;
  card?: unknown;
};

const IMAGE_BASE = '//fb.fbstatic.cn/api/tarzan/images/';
const FORMULA_BASE = '//fb.fbstatic.cn/api/planet/accessories/formulas?latex=';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function docNodeToHtml(node: DocNode): string {
  const kids = () => (node.children ?? []).map(docNodeToHtml).join('');
  switch (node.name) {
    case 'doc':
      return kids();
    case 'p':
      return `<p>${kids()}</p>`;
    case 'br':
      return '<br>';
    case 'u':
      return `<u>${kids()}</u>`;
    case 'txt':
      return escapeHtml(node.value ?? '');
    case 'img':
      return `<img src="${IMAGE_BASE}${node.value ?? ''}" />`;
    case 'tex':
      // 公式是服务端渲染图片，value 形如 <token>?widthRatio=…；只取 token
      return `<img flag="tex" src="${FORMULA_BASE}${(node.value ?? '').split('?')[0]}" />`;
    default:
      return kids();
  }
}

/** doc JSON → HTML；已经是 HTML 或解析失败时原样返回 */
function docToHtml(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text.startsWith('{')) return raw;
  try {
    return docNodeToHtml(JSON.parse(text) as DocNode);
  } catch {
    return raw;
  }
}

/** 无进行中的练习时，"开始练习"——与网页点击等价，返回新的 exercise key */
async function createExercise(paperId: number, args: Args, cookieHeader: string): Promise<string> {
  const url = `${HOST}/api/xingce/exercises?${LIST_QS}&examcatid=${encodeURIComponent(args.examcat)}`;
  const res = await fenbiFetch(url, {
    method: 'POST',
    cookie: cookieHeader,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `paperId=${paperId}&type=1`,
  });
  const data = (await res.json()) as { key?: string };
  if (!res.ok || !data.key) throw new Error(`创建练习失败: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data.key;
}

async function syncByToken(token: string, exerciseKey: string | null, paper: Paper | null, args: Args, cookieHeader: string) {
  const staticUrl = `${HOST}/combine/static/exercise?key=${encodeURIComponent(token)}&${STATIC_QS}`;
  let sheet: StaticExercise | null = null;
  let sheetError: string | null = null;
  try {
    sheet = await api<StaticExercise>(staticUrl, cookieHeader);
  } catch (e) {
    // 已交卷的练习不再提供 static/exercise，只能从解析里还原题面
    sheetError = (e as Error).message;
  }

  let solution: StaticSolution | null = null;
  let solutionError: string | null = null;
  try {
    solution = await api<StaticSolution>(`${HOST}/combine/static/solution?key=${encodeURIComponent(token)}&${STATIC_QS}`, cookieHeader);
  } catch (e) {
    // 未交卷时返回 "exercise is not submit"，此时只落题面
    solutionError = (e as Error).message;
  }
  if (!sheet && !solution) throw new Error(`static/exercise 与 static/solution 均失败：${sheetError}`);

  let meta: Record<string, MetaItem> = {};
  try {
    const res = await api<{ data?: Record<string, MetaItem> }>(
      `${HOST}/combine/question/getMeta?requestKey=${encodeURIComponent(token)}&${COMBINE_QS}`,
      cookieHeader,
    );
    meta = res.data ?? {};
  } catch {
    meta = {};
  }

  const solutionByGlobalId = new Map((solution?.solutions ?? []).map((s) => [s.globalId, s]));
  const baseQuestions: RawQuestion[] = sheet?.questions ?? (solution?.solutions ?? []);

  const questions = baseQuestions.map((q) => {
    const s = solutionByGlobalId.get(q.globalId);
    return {
      globalId: q.globalId,
      id: q.id,
      tikuPrefix: q.tikuPrefix,
      type: q.type,
      content: q.content,
      accessories: q.accessories ?? [],
      options: q.accessories?.[0]?.options ?? [],
      optionsType: q.accessories?.[0]?.type ?? null,
      answer: s?.correctAnswer ?? null,
      solution: {
        content: s?.solution ?? null,
        source: s?.source ?? null,
        keypoints: s?.keypoints ?? [],
      },
      stats: meta[q.globalId] ?? null,
    };
  });

  let report: unknown = null;
  if (args.report && exerciseKey) {
    report = await api(
      `${HOST}/combine/exercise/getReport?format=html&key=${encodeURIComponent(exerciseKey)}&no_toast&${COMBINE_QS}`,
      cookieHeader,
    ).catch((e) => ({ error: String(e) }));
  }

  const doc = {
    schemaVersion: 1,
    syncedAt: new Date().toISOString(),
    exerciseKey,
    token,
    paper,
    sheetName: sheet?.name ?? solution?.name ?? '',
    hasSolution: !!solution,
    solutionError,
    materials: sheet?.materials ?? solution?.materials ?? [],
    questions,
    card: sheet?.card ?? solution?.card ?? null,
    report,
  };

  await mkdir(args.outDir, { recursive: true });
  const base = exerciseKey ?? `token_${token.slice(0, 10)}`;
  const file = path.join(args.outDir, `${base.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
  await writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
  return { file, count: questions.length, withAnswer: questions.filter((q) => q.answer).length, solutionError };
}

async function syncByKey(exerciseKey: string, paper: Paper | null, args: Args, cookieHeader: string) {
  const detail = await api<ExerciseDetail>(
    `${HOST}/combine/exercise/getExercise?format=html&key=${encodeURIComponent(exerciseKey)}&${COMBINE_QS}`,
    cookieHeader,
  );
  const staticUrl = detail.data.staticUrl?.urls?.[0];
  const token = staticUrl ? new URL(staticUrl).searchParams.get('key') : null;
  if (!token) throw new Error(`getExercise 未返回 staticUrl/token: ${exerciseKey}`);
  return syncByToken(token, exerciseKey, paper, args, cookieHeader);
}

/** 按分类名或层级路径筛选清单条目 */
function matchesCategory(paper: CatalogPaper, keyword: string): boolean {
  const k = keyword.trim();
  if (!k) return true;
  return paper.name.includes(k) || paper.labelPaths.some((p) => p.join(' / ').includes(k));
}

/**
 * 已交卷且没有 exerciseKey 的卷子：按试卷级解析同步。
 * papers/{id} 取 encodeCheckInfo → getPaperSolution(checkId, paperId) → staticUrl
 * → 下载 CDN 试卷解析（doc JSON）→ 转 HTML 落盘。全程只读，不创建练习。
 */
async function syncSubmittedPaper(paper: CatalogPaper, args: Args, cookieHeader: string) {
  const info = await api<{ encodeCheckInfo?: string | null }>(
    `${HOST}/api/xingce/papers/${paper.paperId}?${LIST_QS}&examcatid=${encodeURIComponent(args.examcat)}`,
    cookieHeader,
  );
  const checkId = info.encodeCheckInfo;
  if (!checkId) throw new Error('该卷没有 checkId（encodeCheckInfo 为空），无法取试卷解析');

  const solved = await api<{ data: { staticUrl?: { urls?: string[] } } }>(
    `${HOST}/combine/exercise/getPaperSolution?format=json&checkId=${encodeURIComponent(checkId)}&paperId=${paper.paperId}&${COMBINE_QS}`,
    cookieHeader,
  );
  const staticUrl = solved.data.staticUrl?.urls?.[0];
  if (!staticUrl) throw new Error('getPaperSolution 未返回 staticUrl');

  const res = await fenbiFetch(staticUrl, { cookie: cookieHeader });
  if (!res.ok) throw new Error(`试卷解析下载失败：HTTP ${res.status}`);
  const parsed = JSON.parse(await res.text()) as PaperSolutionDoc;
  if (!Array.isArray(parsed.solutions) || !parsed.solutions.length) throw new Error('试卷解析里没有题目');

  const questions = parsed.solutions.map((s) => {
    const options = s.accessories?.[0]?.options ?? [];
    return {
      globalId: s.globalId,
      id: s.id,
      tikuPrefix: s.tikuPrefix ?? 'xingce',
      type: s.type,
      content: docToHtml(s.content) ?? '',
      accessories: [{ options, type: s.accessories?.[0]?.type ?? null }],
      options,
      optionsType: s.accessories?.[0]?.type ?? null,
      answer: s.correctAnswer ?? null,
      solution: {
        content: docToHtml(s.solution),
        source: s.source ?? null,
        keypoints: s.keypoints ?? [],
      },
      stats: null,
    };
  });

  const token = decodeURIComponent(new URL(staticUrl).pathname.split('/').pop() ?? '');

  const doc = {
    schemaVersion: 1,
    syncedAt: new Date().toISOString(),
    exerciseKey: null,
    token,
    paper: { id: paper.paperId, name: paper.name, date: paper.date ?? undefined },
    sheetName: parsed.name || paper.name,
    hasSolution: true,
    solutionError: null,
    materials: (parsed.materials ?? []).map((m) => ({ id: m.id, globalId: m.globalId, content: docToHtml(m.content) ?? '' })),
    questions,
    card: parsed.card ?? null,
    report: null,
  };

  await mkdir(args.outDir, { recursive: true });
  const file = path.join(args.outDir, `paper_${paper.paperId}.json`);
  await writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
  return { file, count: questions.length, withAnswer: questions.filter((q) => q.answer).length };
}

/** 从 data/catalog.json 批量同步；默认跳过已同步，绝不隐式创建练习 */
async function syncFromCatalog(args: Args, cookieHeader: string): Promise<void> {
  const doc = readCatalogFile(args.catalog!);
  const local = scanLocalPapers(args.outDir);
  const labelId = args.label ? Number(args.label) : null;

  const matched = doc.papers.filter((paper) => {
    if (labelId !== null && !paper.labelIds.includes(labelId)) return false;
    if (args.category && !matchesCategory(paper, args.category)) return false;
    if (args.onlyExercise && !paper.exerciseKey) return false;
    if (args.submitted && !paper.submitted) return false;
    return true;
  });
  const fresh = args.force
    ? matched
    : matched.filter((paper) => {
        const info =
          (paper.exerciseKey ? local.byKey.get(paper.exerciseKey) : undefined) ?? local.byPaperId.get(paper.paperId);
        return !info;
      });
  const picked = fresh.slice(0, args.limit);

  const pendingText = args.force ? `按 --force 重拉 ${fresh.length} 套` : `其中未同步 ${fresh.length} 套`;
  console.log(
    `清单 ${doc.papers.length} 套；筛选后 ${matched.length} 套，${pendingText}；本次处理 ${picked.length} 套`,
  );
  if (!picked.length) {
    console.log('没有符合条件的卷子（已同步的默认跳过；要重拉加 --force）');
    return;
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const paper of picked) {
    try {
      let key = paper.exerciseKey;
      if (!key && paper.submitted) {
        const r = await syncSubmittedPaper(paper, args, cookieHeader);
        console.log(`✓ 已交卷 ${paper.name} -> ${r.file}（${r.count} 题，含答案 ${r.withAnswer} 题）`);
        ok++;
        continue;
      }
      if (!key) {
        if (!args.create) {
          console.log(`  - 跳过《${paper.name}》：没有进行中的练习（要创建请加 --create）`);
          skipped++;
          continue;
        }
        key = await createExercise(paper.paperId, args, cookieHeader);
        console.log(`  · 《${paper.name}》无进行中练习，已创建 ${key}`);
      }
      const r = await syncByKey(key, { id: paper.paperId, name: paper.name, date: paper.date ?? undefined }, args, cookieHeader);
      console.log(`✓ ${key} ${paper.name} -> ${r.file}（${r.count} 题，含答案 ${r.withAnswer} 题）`);
      if (r.solutionError) console.log(`  注意：${paper.name} 解析未取到（${r.solutionError.slice(0, 60)}）`);
      ok++;
    } catch (e) {
      failed++;
      console.error(`✗ ${paper.name}: ${(e as Error).message}`);
    }
  }
  console.log(`完成：成功 ${ok}，跳过 ${skipped}，失败 ${failed}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.paper && !args.label && !args.token && !args.catalog) {
    console.error('需要 --paper <exerciseKey>、--label <labelId>、--token <static key> 或 --catalog');
    process.exit(1);
  }
  const cookieHeader = await loadCookieHeader(args);

  if (args.token) {
    const r = await syncByToken(args.token, args.paper ?? null, null, args, cookieHeader);
    console.log(`✓ token -> ${r.file}（${r.count} 题，含答案 ${r.withAnswer} 题）`);
    if (r.solutionError) console.log(`  注意：解析未取到（${r.solutionError.slice(0, 80)}）`);
    return;
  }

  if (args.paper) {
    const r = await syncByKey(args.paper, null, args, cookieHeader);
    console.log(`✓ ${args.paper} -> ${r.file}（${r.count} 题，含答案 ${r.withAnswer} 题）`);
    if (r.solutionError) console.log(`  注意：解析未取到（${r.solutionError.slice(0, 80)}）`);
    return;
  }

  if (args.catalog) {
    await syncFromCatalog(args, cookieHeader);
    return;
  }

  const url = `${HOST}/api/xingce/papers/v2?labelId=${encodeURIComponent(args.label!)}&toPage=0&pageSize=15&${LIST_QS}&examcatid=${encodeURIComponent(args.examcat)}`;
  const list = await api<{ list: Paper[] }>(url, cookieHeader);
  const picked = list.list.slice(0, args.limit);
  console.log(`分类 ${args.label} 共 ${list.list.length} 套，取前 ${picked.length} 套`);

  for (const p of picked) {
    try {
      let key = p.exercise?.key ?? null;
      if (!key) {
        if (!args.create) {
          console.log(`  - 跳过《${p.name}》：没有进行中的练习（要创建请加 --create）`);
          continue;
        }
        key = await createExercise(p.id, args, cookieHeader);
        console.log(`  · ${p.name} 无进行中练习，已创建 ${key}`);
      }
      const r = await syncByKey(key, p, args, cookieHeader);
      console.log(`✓ ${key} ${p.name} -> ${r.file}（${r.count} 题，含答案 ${r.withAnswer} 题）`);
      if (r.solutionError) console.log(`  注意：${p.name} 解析未取到（${r.solutionError.slice(0, 60)}）`);
    } catch (e) {
      console.error(`✗ ${p.name}: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error('同步失败:', (e as Error).message);
  process.exit(1);
});

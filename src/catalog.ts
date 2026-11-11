/**
 * 题库清单（只读）。
 *
 * 遍历 /api/{prefix}/subLabels 的分类树（含 childrenLabels 递归），
 * 再按分类分页拉 /api/{prefix}/papers/v2，汇总成 data/catalog.json。
 * 只发 GET，不创建任何练习；分页之间默认间隔 150ms。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadCookie } from './auth.js';
import { fenbiFetch } from './http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'https://tiku.fenbi.com';
const LIST_QS = 'app=web&kav=131&av=134&hav=128&version=3.0.0.0&deviceId=&gav=2&apcId=0';

export type LocalPaperInfo = { file: string; questionCount: number | null };
export type LocalIndex = {
  byKey: Map<string, LocalPaperInfo>;
  byPaperId: Map<number, LocalPaperInfo>;
  files: number;
};

export type CatalogPaper = {
  paperId: number;
  name: string;
  date: string | null;
  combineKey: string | null;
  questionCount: number | null;
  labelIds: number[];
  labelPaths: string[][];
  exerciseKey: string | null;
  exerciseStatus: number | null;
  /** 是否存在已交卷的练习（列表里 exercise.status === 1） */
  submitted: boolean;
  synced: boolean;
  localFile: string | null;
};

export type CatalogLabel = {
  id: number;
  name: string;
  path: string[];
  paperCount: number | null;
  fetched: number;
  pages: number;
  truncated: boolean;
  error: string | null;
};

export type CatalogDoc = {
  schemaVersion: 1;
  generatedAt: string;
  examCategoryId: string;
  prefix: string;
  options: { pageSize: number; maxPages: number };
  stats: {
    labels: number;
    paperEntries: number;
    papers: number;
    synced: number;
    withExercise: number;
    submitted: number;
  };
  labels: CatalogLabel[];
  papers: CatalogPaper[];
};

type RawLabel = {
  id: number;
  name: string;
  labelMeta?: { paperCount?: number };
  childrenLabels?: RawLabel[] | null;
};

type RawPaper = {
  id: number;
  name: string;
  date?: string;
  combineKey?: string;
  exercise?: { key?: string | null; status?: number } | null;
};

type PaperPage = {
  pageInfo?: { totalItem?: number; totalPage?: number; currentPage?: number };
  list?: RawPaper[];
};

type Args = {
  label: number | null;
  maxPages: number;
  pageSize: number;
  delay: number;
  examcat: string;
  prefix: string;
  outFile: string;
  dataDir: string;
  cookiesFile: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    label: null,
    maxPages: 0,
    pageSize: 100,
    delay: 150,
    examcat: '1000134',
    prefix: 'xingce',
    outFile: path.join('data', 'catalog.json'),
    dataDir: 'data',
    cookiesFile: path.join('verify', 'cookies.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--label') args.label = Number(val());
    else if (a === '--max-pages') args.maxPages = Number(val());
    else if (a === '--page-size') args.pageSize = Number(val());
    else if (a === '--delay') args.delay = Number(val());
    else if (a === '--examcat') args.examcat = val();
    else if (a === '--prefix') args.prefix = val();
    else if (a === '--out') args.outFile = val();
    else if (a === '--data-dir') args.dataDir = val();
    else if (a === '--cookies') args.cookiesFile = val();
    else if (a === '--help' || a === '-h') {
      console.log(`用法:
  npm run catalog                                  # 遍历全部分类并生成 data/catalog.json
  npm run catalog -- --label 2906                  # 只遍历该分类及其子分类
  npm run catalog -- --max-pages 3                 # 每个分类最多拉 3 页
  npm run catalog -- --page-size 100 --delay 150   # 分页大小与请求间隔（毫秒）

可选:
  --examcat <id>     examcatid，默认 1000134
  --prefix <p>       课程前缀，默认 xingce
  --out <file>       输出文件，默认 data/catalog.json
  --data-dir <dir>   本地已同步卷子的目录，默认 data/
  --cookies <file>   Cookie 文件，默认 verify/cookies.json（FENBI_COOKIE 优先）
  --help             显示帮助

只读接口：不会创建练习。`);
      process.exit(0);
    }
  }
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function loadCookieHeader(args: Args): Promise<string> {
  const info = await loadCookie({ verifyFile: args.cookiesFile });
  if (!info) {
    throw new Error(
      `没有可用 Cookie：先运行 npm run login，或把 Cookie 写到 .auth/cookies.json / ${args.cookiesFile}，或设置 FENBI_COOKIE。`,
    );
  }
  return info.header;
}

async function getJson<T>(url: string, cookieHeader: string): Promise<T> {
  const res = await fenbiFetch(url, { cookie: cookieHeader });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 160)} :: ${url}`);
  const parsed = JSON.parse(text) as unknown;
  if (parsed && typeof parsed === 'object' && 'code' in parsed && (parsed as { code: number }).code !== 1) {
    throw new Error(`code=${(parsed as { code: number }).code} :: ${url}`);
  }
  return parsed as T;
}

/** 扫描本地 data/*.json，建立 exerciseKey / paperId 到文件与题量的索引 */
export function scanLocalPapers(dir: string): LocalIndex {
  const index: LocalIndex = { byKey: new Map(), byPaperId: new Map(), files: 0 };
  const abs = path.resolve(dir);
  if (!existsSync(abs)) return index;
  for (const file of readdirSync(abs)) {
    if (!file.endsWith('.json')) continue;
    let doc: {
      exerciseKey?: string | null;
      questions?: unknown[];
      paper?: { id?: number } | null;
    };
    try {
      doc = JSON.parse(readFileSync(path.join(abs, file), 'utf8')) as typeof doc;
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.questions)) continue;
    const info: LocalPaperInfo = { file, questionCount: doc.questions.length };
    index.files++;
    if (typeof doc.exerciseKey === 'string' && doc.exerciseKey) index.byKey.set(doc.exerciseKey, info);
    if (typeof doc.paper?.id === 'number') index.byPaperId.set(doc.paper.id, info);
  }
  return index;
}

export function readCatalogFile(file: string): CatalogDoc {
  const abs = path.resolve(file);
  if (!existsSync(abs)) throw new Error(`找不到清单文件：${abs}，先运行 npm run catalog`);
  const doc = JSON.parse(readFileSync(abs, 'utf8')) as CatalogDoc;
  if (!doc || doc.schemaVersion !== 1 || !Array.isArray(doc.papers)) {
    throw new Error(`清单文件格式不对：${abs}`);
  }
  return doc;
}

function flattenLabels(nodes: RawLabel[], parents: string[] = []): Array<{ node: RawLabel; path: string[] }> {
  const out: Array<{ node: RawLabel; path: string[] }> = [];
  for (const node of nodes) {
    const current = [...parents, node.name];
    out.push({ node, path: current });
    const children = node.childrenLabels ?? [];
    if (children.length) out.push(...flattenLabels(children, current));
  }
  return out;
}

/** 定位指定 id 的节点，并带上祖先名称，保证 --label 时 path 仍是完整层级 */
function locateLabel(
  nodes: RawLabel[],
  id: number,
  parents: string[] = [],
): { node: RawLabel; parents: string[] } | null {
  for (const node of nodes) {
    if (node.id === id) return { node, parents };
    const hit = locateLabel(node.childrenLabels ?? [], id, [...parents, node.name]);
    if (hit) return hit;
  }
  return null;
}

async function fetchLabelPapers(
  label: RawLabel,
  args: Args,
  cookieHeader: string,
): Promise<{ items: RawPaper[]; pages: number; truncated: boolean; total: number | null; error: string | null }> {
  const items: RawPaper[] = [];
  let pages = 0;
  let total: number | null = null;
  let error: string | null = null;

  const limitPages = args.maxPages > 0 ? args.maxPages : Number.POSITIVE_INFINITY;
  for (let page = 0; page < limitPages; page++) {
    const url = `${HOST}/api/${encodeURIComponent(args.prefix)}/papers/v2?labelId=${label.id}&toPage=${page}&pageSize=${args.pageSize}&${LIST_QS}&examcatid=${encodeURIComponent(args.examcat)}`;
    try {
      const data = await getJson<PaperPage>(url, cookieHeader);
      pages++;
      const list = Array.isArray(data.list) ? data.list : [];
      items.push(...list);
      const totalPage = data.pageInfo?.totalPage;
      if (typeof data.pageInfo?.totalItem === 'number') total = data.pageInfo.totalItem;
      if (!list.length) break;
      if (typeof totalPage !== 'number' || page + 1 >= totalPage) break;
    } catch (e) {
      error = (e as Error).message;
      break;
    }
    await sleep(args.delay);
  }

  const totalPage = total !== null ? Math.ceil(total / args.pageSize) : null;
  const truncated = totalPage !== null && pages < totalPage;
  return { items, pages, truncated, total, error };
}

export async function buildCatalog(args: Args, cookieHeader: string): Promise<CatalogDoc> {
  const labelsUrl = `${HOST}/api/${encodeURIComponent(args.prefix)}/subLabels?${LIST_QS}&examcatid=${encodeURIComponent(args.examcat)}`;
  const tree = await getJson<RawLabel[]>(labelsUrl, cookieHeader);
  if (!Array.isArray(tree)) throw new Error('subLabels 返回的不是数组');

  let roots: RawLabel[] = tree;
  let rootParents: string[] = [];
  if (args.label) {
    const hit = locateLabel(tree, args.label);
    if (!hit) throw new Error(`分类树里找不到 labelId=${args.label}`);
    roots = [hit.node];
    rootParents = hit.parents;
  }
  const entries = flattenLabels(roots, rootParents);

  const local = scanLocalPapers(args.dataDir);
  const labelDocs: CatalogLabel[] = [];
  const paperMap = new Map<number, CatalogPaper>();

  console.log(`分类 ${entries.length} 个，开始拉取卷子列表（pageSize=${args.pageSize}，delay=${args.delay}ms）…`);

  for (let i = 0; i < entries.length; i++) {
    const { node, path: labelPath } = entries[i];
    const result = await fetchLabelPapers(node, args, cookieHeader);
    labelDocs.push({
      id: node.id,
      name: node.name,
      path: labelPath,
      paperCount: typeof node.labelMeta?.paperCount === 'number' ? node.labelMeta.paperCount : null,
      fetched: result.items.length,
      pages: result.pages,
      truncated: result.truncated,
      error: result.error,
    });

    for (const item of result.items) {
      const exercise = item.exercise;
      const exerciseKey = typeof exercise?.key === 'string' && exercise.key ? exercise.key : null;
      const exerciseStatus = typeof exercise?.status === 'number' ? exercise.status : null;
      const existing = paperMap.get(item.id);
      if (existing) {
        if (!existing.labelIds.includes(node.id)) existing.labelIds.push(node.id);
        if (!existing.labelPaths.some((p) => p.join('/') === labelPath.join('/'))) existing.labelPaths.push(labelPath);
        continue;
      }
      paperMap.set(item.id, {
        paperId: item.id,
        name: item.name,
        date: item.date ?? null,
        combineKey: item.combineKey ?? null,
        questionCount: null,
        labelIds: [node.id],
        labelPaths: [labelPath],
        exerciseKey,
        exerciseStatus,
        submitted: exerciseStatus === 1,
        synced: false,
        localFile: null,
      });
    }

    const suffix = result.error ? `  ✗ ${result.error.slice(0, 80)}` : result.truncated ? '  （已按 max-pages 截断）' : '';
    console.log(
      `[${i + 1}/${entries.length}] ${labelPath.join(' / ')}：${result.items.length}/${result.total ?? '?'} 套，${result.pages} 页${suffix}`,
    );
    if (result.error && result.pages === 0) await sleep(args.delay);
  }

  const papers = [...paperMap.values()];
  for (const paper of papers) {
    const info =
      (paper.exerciseKey ? local.byKey.get(paper.exerciseKey) : undefined) ?? local.byPaperId.get(paper.paperId);
    if (info) {
      paper.synced = true;
      paper.localFile = info.file;
      paper.questionCount = info.questionCount;
    }
  }

  const stats = {
    labels: labelDocs.length,
    paperEntries: labelDocs.reduce((n, l) => n + l.fetched, 0),
    papers: papers.length,
    synced: papers.filter((p) => p.synced).length,
    withExercise: papers.filter((p) => !!p.exerciseKey).length,
    submitted: papers.filter((p) => p.submitted).length,
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    examCategoryId: args.examcat,
    prefix: args.prefix,
    options: { pageSize: args.pageSize, maxPages: args.maxPages },
    stats,
    labels: labelDocs,
    papers,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cookieHeader = await loadCookieHeader(args);
  const doc = await buildCatalog(args, cookieHeader);

  const out = path.resolve(args.outFile);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(doc, null, 2), 'utf8');

  const s = doc.stats;
  console.log('');
  console.log(`✓ 清单已写入 ${out}`);
  console.log(`  分类 ${s.labels} 个；卷子 ${s.papers} 套（含重复条目 ${s.paperEntries}）`);
  console.log(`  已同步 ${s.synced} 套；有进行中练习可直读 ${s.withExercise} 套；已交卷 ${s.submitted} 套`);
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
})();

if (isMain) {
  main().catch((e) => {
    console.error('生成清单失败:', (e as Error).message);
    process.exit(1);
  });
}

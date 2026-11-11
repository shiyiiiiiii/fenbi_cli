/**
 * 粉笔 CLI 刷题 TUI（只读 data/*.json，不发任何网络请求）
 *
 * 模式：
 * - 整卷模拟：按卷面顺序作答，交卷后统一看解析
 * - 即时反馈：只抽有答案/解析的题，答一题立刻看对错与解析
 *
 * 键位：A–D 选择 / Enter 提交 / N、P 翻题 / ↑↓ 滚动 / Esc 返回 / Q 退出
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import {
  QUICK_COUNT,
  QuickError,
  createQuick,
  fetchSolutions,
  fetchStats,
  getCurrent,
  getSelectedCategories,
  loadCookieHeader,
  loadExercise,
  reportAnswers,
  submitExercise,
  type Category,
  type LoadedExercise,
} from './quick.js';
import { htmlToText, truncate, wrapText, wrapWithPrefix } from './text.js';
import { checkSession, type SessionState } from './auth.js';
import { openQuestionHtml } from './questionHtml.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.FENBI_DATA_DIR ? path.resolve(process.env.FENBI_DATA_DIR) : path.join(ROOT, 'data');
const PROGRESS_FILE = process.env.FENBI_PROGRESS ? path.resolve(process.env.FENBI_PROGRESS) : path.join(ROOT, 'progress.json');
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

type Solution = {
  content: string | null;
  source: string | null;
  keypoints: Array<{ id: number; name: string }>;
};

type Question = {
  globalId: string;
  id: number;
  type: number;
  content: string;
  options: string[];
  optionsType: number | null;
  answer: { choice: string; type: number } | null;
  solution: Solution;
  stats: { wrongCount: number; totalCount: number; correctRatio: number } | null;
};

type Material = { globalId: string; content: string };

type CardNode = {
  nodeType: number;
  key?: string;
  name?: string;
  materialKeys?: string[];
  children?: CardNode[];
};

type PaperDoc = {
  sheetName?: string;
  exerciseKey?: string | null;
  hasSolution?: boolean;
  materials?: Material[];
  questions?: Question[];
  card?: CardNode | null;
};

type Paper = {
  file: string;
  name: string;
  exerciseKey: string | null;
  hasSolution: boolean;
  questions: Question[];
  materials: Map<string, string>;
  layout: Map<string, { chapter: string | null; materialKeys: string[] }>;
  solvable: boolean;
};

type AnswerRecord = { picked: string[]; correct?: boolean };
type ProgressStore = { version: 1; papers: Record<string, Record<string, AnswerRecord>> };

type Line = { text: string; color?: string; bold?: boolean; dim?: boolean };

type View =
  | { t: 'home' }
  | { t: 'mode'; paper: Paper }
  | { t: 'run'; paper: Paper; mode: 'exam' | 'feedback' }
  | { t: 'quick' }
  | { t: 'quick-run'; session: QuickSession };

// ---------------------------------------------------------------- 数据读取

type Layout = Map<string, { chapter: string | null; materialKeys: string[] }>;

/** 从 card 树里取出每题的章节名与材料 key（离线卷与联网卷共用） */
function buildLayout(card: CardNode | null | undefined): Layout {
  const layout: Layout = new Map();
  const walk = (node: CardNode | null | undefined, chapter: string | null): void => {
    if (!node) return;
    const nextChapter = node.nodeType === 1 && node.name ? node.name : chapter;
    if (node.nodeType === 2 && node.key) {
      layout.set(node.key, { chapter: chapter, materialKeys: node.materialKeys ?? [] });
    }
    for (const child of node.children ?? []) walk(child, nextChapter);
  };
  walk(card, null);
  return layout;
}

function loadPapers(): Paper[] {
  if (!existsSync(DATA_DIR)) return [];
  const papers: Paper[] = [];
  for (const file of readdirSync(DATA_DIR)) {
    if (!file.endsWith('.json')) continue;
    let doc: PaperDoc;
    try {
      doc = JSON.parse(readFileSync(path.join(DATA_DIR, file), 'utf8')) as PaperDoc;
    } catch {
      continue;
    }
    const questions = (doc.questions ?? []).filter((q) => q && typeof q.globalId === 'string');
    if (!questions.length) continue;

    const layout = buildLayout(doc.card);

    papers.push({
      file,
      name: doc.sheetName || file.replace(/\.json$/, ''),
      exerciseKey: doc.exerciseKey ?? null,
      hasSolution: !!doc.hasSolution,
      questions,
      materials: new Map((doc.materials ?? []).map((m) => [m.globalId, m.content])),
      layout,
      solvable: !!doc.hasSolution && questions.some((q) => q.answer),
    });
  }
  return papers.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function loadProgress(): ProgressStore {
  try {
    const raw = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')) as ProgressStore;
    if (raw && raw.papers) return { version: 1, papers: raw.papers };
  } catch {
    // 没有进度文件就是全新开始
  }
  return { version: 1, papers: {} };
}

function saveProgress(store: ProgressStore): void {
  try {
    writeFileSync(PROGRESS_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch {
    // 进度写失败不影响答题
  }
}

// ---------------------------------------------------------------- 文本组装

function answerLetters(q: Question): string[] {
  if (!q.answer) return [];
  return q.answer.choice
    .split(/[,，]/)
    .map((x) => LETTERS[Number(x)] ?? x.trim())
    .filter(Boolean);
}

function isCorrect(q: Question, picked: string[] | undefined): boolean | null {
  if (!q.answer) return null;
  const right = new Set(answerLetters(q));
  const mine = new Set(picked ?? []);
  if (right.size !== mine.size) return false;
  for (const l of right) if (!mine.has(l)) return false;
  return true;
}

function materialLines(paper: Paper, q: Question, width: number): Line[] {
  const info = paper.layout.get(q.globalId);
  const lines: Line[] = [];
  for (const key of info?.materialKeys ?? []) {
    const content = paper.materials.get(key);
    if (!content) continue;
    lines.push({ text: '── 材料 ──', dim: true });
    for (const l of wrapText(htmlToText(content), width)) lines.push({ text: l, dim: true });
    lines.push({ text: '' });
  }
  return lines;
}

function buildAnswerLines(paper: Paper, q: Question, picked: string[], width: number): Line[] {
  const lines: Line[] = [];
  const chapter = paper.layout.get(q.globalId)?.chapter;
  if (chapter) lines.push({ text: `【${chapter}】`, dim: true });
  lines.push(...materialLines(paper, q, width));

  lines.push({ text: '── 题目 ──', dim: true });
  for (const l of wrapText(htmlToText(q.content), width)) lines.push({ text: l });
  lines.push({ text: '' });

  lines.push({ text: `── 选项${q.optionsType === 102 ? '（多选，可多次切换）' : ''} ──`, dim: true });
  const selected = new Set(picked);
  q.options.forEach((opt, i) => {
    const letter = LETTERS[i] ?? '?';
    const on = selected.has(letter);
    const prefix = `${on ? '●' : '○'} ${letter}. `;
    wrapWithPrefix(prefix, htmlToText(opt), width).forEach((l) => {
      lines.push({ text: l, color: on ? 'cyan' : undefined, bold: on });
    });
  });
  lines.push({ text: '' });
  lines.push({ text: picked.length ? `已选：${picked.join(' ')}` : '尚未选择（按 A–D）', dim: !picked.length });
  return lines;
}

function buildReviewLines(paper: Paper, q: Question, picked: string[], index: number, width: number): Line[] {
  const lines: Line[] = [];
  const correct = isCorrect(q, picked);
  const right = answerLetters(q);
  const status = correct === null ? '无答案数据' : correct ? '回答正确' : picked.length ? '回答错误' : '未作答';

  lines.push({
    text: `第 ${index + 1} 题 · 你的答案：${picked.length ? picked.join(' ') : '—'} · 正确答案：${right.length ? right.join(' ') : '—'} · ${status}`,
    color: correct === null ? 'gray' : correct ? 'green' : 'red',
    bold: true,
  });
  const chapter = paper.layout.get(q.globalId)?.chapter;
  if (chapter) lines.push({ text: `【${chapter}】`, dim: true });
  lines.push(...materialLines(paper, q, width));

  lines.push({ text: '── 题目 ──', dim: true });
  for (const l of wrapText(htmlToText(q.content), width)) lines.push({ text: l });
  lines.push({ text: '' });

  lines.push({ text: '── 选项 ──', dim: true });
  const mine = new Set(picked);
  q.options.forEach((opt, i) => {
    const letter = LETTERS[i] ?? '?';
    const hit = right.includes(letter);
    const wrongPick = correct !== null && mine.has(letter) && !hit;
    const prefix = `${hit ? '✓' : wrongPick ? '✗' : ' '} ${letter}. `;
    wrapWithPrefix(prefix, htmlToText(opt), width).forEach((l) => {
      lines.push({ text: l, color: hit ? 'green' : wrongPick ? 'red' : undefined, bold: hit || wrongPick });
    });
  });
  lines.push({ text: '' });

  lines.push({ text: '── 解析 ──', dim: true });
  const sol = htmlToText(q.solution?.content);
  if (sol) {
    for (const l of wrapText(sol, width)) lines.push({ text: l });
  } else {
    lines.push({ text: '（本题暂无解析正文）', dim: true });
  }

  const points = (q.solution?.keypoints ?? []).map((k) => k.name).filter(Boolean);
  if (points.length) {
    lines.push({ text: '' });
    lines.push({ text: '── 考点 ──', dim: true });
    for (const l of wrapText(points.join('；'), width)) lines.push({ text: l, color: 'yellow' });
  }
  if (q.solution?.source) lines.push({ text: `来源：${q.solution.source}`, dim: true });
  if (q.stats) {
    const ratio = Number.isFinite(q.stats.correctRatio) ? `${q.stats.correctRatio.toFixed(1)}%` : '—';
    lines.push({ text: `全站正确率：${ratio}（${q.stats.totalCount} 人作答）`, dim: true });
  }
  return lines;
}

function missingSolutionBanner(paper: Paper, width: number): Line[] {
  const key = paper.exerciseKey ?? '<exerciseKey>';
  const text = [
    '这套卷子还没有解析数据（hasSolution = false）。',
    '在网页里交卷后，用 static key 补同步：',
    `  npm run sync -- --paper ${key} --token <staticUrl 里的 key>`,
  ].join('\n');
  return [
    { text: '⚠ 无解析数据', color: 'yellow', bold: true },
    ...wrapText(text, width).map((l) => ({ text: l, color: 'yellow' as const })),
    { text: '' },
  ];
}

// ---------------------------------------------------------------- 界面

function termSize(stream: NodeJS.WritableStream | undefined): { columns: number; rows: number } {
  const s = stream as unknown as { columns?: number; rows?: number } | undefined;
  return { columns: s?.columns ?? 100, rows: s?.rows ?? 30 };
}

function authLines(auth: SessionState | { state: 'checking' } | null, width: number): Line[] {
  if (!auth || auth.state === 'checking') return [{ text: '登录态校验中…', dim: true }];
  if (auth.state === 'ok') {
    const src = auth.source === 'env' ? 'FENBI_COOKIE' : auth.source === 'auth' ? '.auth/cookies.json' : 'verify/cookies.json';
    return [{ text: `已登录：userid ${auth.userId} · Cookie 来自 ${src}`, color: 'green', dim: true }];
  }
  if (auth.state === 'unauthorized') {
    return [
      { text: `登录已失效（${auth.detail}）`, color: 'yellow', bold: true },
      ...wrapText('运行 npm run login 重新登录，回到这里按 R 重试；整卷模拟与即时反馈不受影响。', width).map(
        (l): Line => ({ text: l, color: 'yellow' }),
      ),
    ];
  }
  if (auth.state === 'network') {
    return [
      { text: `登录态校验失败（网络异常，不代表未登录）：${auth.detail}`, color: 'yellow' },
      ...wrapText('离线两种模式不受影响；可稍后按 R 重试。', width).map((l): Line => ({ text: l, dim: true })),
    ];
  }
  return [
    { text: '未登录（本地没有 Cookie）', color: 'yellow' },
    ...wrapText('快速练习需要先运行 npm run login；整卷模拟与即时反馈可直接使用。', width).map(
      (l): Line => ({ text: l, dim: true }),
    ),
  ];
}

function Home({
  papers,
  index,
  auth,
}: {
  papers: Paper[];
  index: number;
  auth: SessionState | { state: 'checking' } | null;
}) {
  const { stdout } = useStdout();
  const width = termSize(stdout).columns - 2;

  const total = papers.length + 1;
  const visible = 14;
  const offset = Math.max(0, Math.min(index - Math.floor(visible / 2), Math.max(0, total - visible)));
  const slice = Array.from({ length: Math.min(visible, total - offset) }, (_, i) => offset + i);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">粉笔 CLI 刷题</Text>
      <Text dimColor>选择一套卷子（data/ 为离线只读；快速练习走网络）</Text>
      {authLines(auth, width).map((l, i) => (
        <Text key={i} color={l.color} bold={l.bold} dimColor={l.dim} wrap="truncate">
          {l.text}
        </Text>
      ))}
      <Text />
      {slice.map((at) => {
        const active = at === index;
        if (at === 0) {
          return (
            <Text key="quick" color={active ? 'cyan' : undefined} bold={active} wrap="truncate">
              {active ? '▶ ' : '  '}
              {'快速练习（联网）'}
              <Text dimColor>{'  固定 15 题 · 会在账号创建一条练习'}</Text>
            </Text>
          );
        }
        const p = papers[at - 1];
        const tags = [`${p.questions.length} 题`];
        tags.push(p.solvable ? '可即时反馈' : p.hasSolution ? '有解析' : '无解析');
        return (
          <Text key={p.file} color={active ? 'cyan' : undefined} bold={active} wrap="truncate">
            {active ? '▶ ' : '  '}
            {truncate(p.name, Math.max(20, width - 26))}
            <Text dimColor>{`  ${tags.join(' · ')}`}</Text>
          </Text>
        );
      })}
      <Text />
      {papers.length ? (
        <Text dimColor>↑/↓ 选择   Enter 进入   R 重新校验登录   Q 退出</Text>
      ) : (
        <Text dimColor>data/ 下暂无卷子；可先走「快速练习」，或用 npm run sync 同步。 R 重新校验登录   Q 退出</Text>
      )}
    </Box>
  );
}

function ModeSelect({ paper, index, notice }: { paper: Paper; index: number; notice: string }) {
  const items = [
    { title: '整卷模拟', desc: '按卷面顺序作答，交卷后统一看全套解析' },
    {
      title: '即时反馈',
      desc: paper.solvable ? '答一题立刻看对错与解析（筛选/错题重练后续补）' : '这套卷没有答案与解析数据，不可用',
    },
  ];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan" wrap="truncate">{paper.name}</Text>
      <Text dimColor>{`${paper.questions.length} 题 · ${paper.solvable ? '含答案解析' : '无解析数据'}`}</Text>
      <Text />
      {items.map((item, i) => {
        const active = i === index;
        const disabled = i === 1 && !paper.solvable;
        return (
          <Box key={item.title} flexDirection="column">
            <Text color={active ? (disabled ? 'yellow' : 'cyan') : undefined} bold={active}>
              {active ? '▶ ' : '  '}
              {item.title}
            </Text>
            <Text dimColor>{`    ${item.desc}`}</Text>
          </Box>
        );
      })}
      <Text />
      {notice ? <Text color="yellow">{notice}</Text> : <Text dimColor>↑/↓ 选择   Enter 开始   Esc 返回   Q 退出</Text>}
    </Box>
  );
}

function Runner({
  paper,
  mode,
  store,
  onBack,
  onQuit,
}: {
  paper: Paper;
  mode: 'exam' | 'feedback';
  store: ProgressStore;
  onBack: () => void;
  onQuit: () => void;
}) {
  const { stdout } = useStdout();
  const { columns, rows } = termSize(stdout);
  const width = Math.max(20, columns - 2);
  const bodyHeight = Math.max(6, rows - 4);

  const order = useMemo(() => {
    const all = paper.questions.map((_, i) => i);
    if (mode === 'exam') return all;
    const pool = all.filter((i) => paper.questions[i].answer);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool;
  }, [paper, mode]);

  const [picks, setPicks] = useState<Record<string, string[]>>(() => {
    const saved = store.papers[paper.file] ?? {};
    const out: Record<string, string[]> = {};
    for (const [gid, rec] of Object.entries(saved)) out[gid] = rec.picked ?? [];
    return out;
  });
  const [pos, setPos] = useState(() => {
    if (mode !== 'exam') return 0;
    const saved = store.papers[paper.file] ?? {};
    const at = order.findIndex((i) => !(saved[paper.questions[i].globalId]?.picked ?? []).length);
    return at > 0 ? at : 0;
  });
  const [scroll, setScroll] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [startAt] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const question = paper.questions[order[Math.min(pos, order.length - 1)]];
  const answering = mode === 'exam' ? !submitted : !revealed.has(question.globalId);
  const reviewing = !answering;

  const persist = (nextPicks: Record<string, string[]>, markCorrect = false) => {
    const rec: Record<string, AnswerRecord> = {};
    for (const [gid, picked] of Object.entries(nextPicks)) {
      if (!picked.length) continue;
      const prev = store.papers[paper.file]?.[gid];
      const q = paper.questions.find((x) => x.globalId === gid);
      const correct = markCorrect && q ? isCorrect(q, picked) ?? undefined : prev?.correct;
      rec[gid] = correct === undefined ? { picked } : { picked, correct };
    }
    store.papers[paper.file] = rec;
    saveProgress(store);
  };

  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(order.length - 1, next));
    setPos(clamped);
    setScroll(0);
    setNotice('');
  };

  const choose = (letter: string) => {
    if (!answering) return;
    const idx = LETTERS.indexOf(letter);
    if (idx < 0 || idx >= question.options.length) return;
    const current = picks[question.globalId] ?? [];
    const multi = question.optionsType === 102;
    const next = multi
      ? current.includes(letter)
        ? current.filter((x) => x !== letter)
        : [...current, letter].sort()
      : [letter];
    const nextPicks = { ...picks, [question.globalId]: next };
    setPicks(nextPicks);
    persist(nextPicks);
    setNotice('');
  };

  const submitExam = (finalPicks: Record<string, string[]>) => {
    setSubmitted(true);
    persist(finalPicks, true);
    setPos(0);
    setScroll(0);
    setNotice('');
  };

  // O：把当前题导出成 HTML 用浏览器打开，补终端里看不到的公式/图表
  const openCurrent = () => {
    void openQuestionHtml({
      paper,
      question,
      picked: picks[question.globalId] ?? [],
      revealed: !answering,
      index: pos + 1,
      total: order.length,
      modeLabel: mode === 'exam' ? '整卷模拟' : '即时反馈',
    })
      .then(() => setNotice('已用浏览器打开当前题（.tmp/question.html）'))
      .catch((e) => setNotice(`打开失败：${messageOf(e)}`));
  };

  const onEnter = () => {
    if (!answering) {
      go(pos + 1);
      return;
    }
    if (mode === 'feedback') {
      if (!(picks[question.globalId] ?? []).length) {
        setNotice('先选答案再提交');
        return;
      }
      const next = new Set(revealed).add(question.globalId);
      setRevealed(next);
      persist(picks, true);
      setScroll(0);
      setNotice('');
      return;
    }
    // 整卷模拟：提交即下一题，最后一题即交卷
    if (pos >= order.length - 1) submitExam(picks);
    else go(pos + 1);
  };

  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === 'q') {
      persist(picks, submitted || mode === 'feedback');
      onQuit();
      return;
    }
    if (ch === 'o') {
      openCurrent();
      return;
    }
    if (key.escape) {
      persist(picks, submitted || mode === 'feedback');
      onBack();
      return;
    }
    if (key.upArrow) {
      setScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setScroll((s) => s + 1);
      return;
    }
    if (key.pageUp) {
      setScroll((s) => Math.max(0, s - bodyHeight));
      return;
    }
    if (key.pageDown) {
      setScroll((s) => s + bodyHeight);
      return;
    }
    if (ch === 'n') {
      go(pos + 1);
      return;
    }
    if (ch === 'p') {
      go(pos - 1);
      return;
    }
    if (/^[a-f]$/.test(ch)) {
      choose(ch.toUpperCase());
      return;
    }
    if (key.return) onEnter();
  });

  const picked = picks[question.globalId] ?? [];
  const lines = reviewedLines();
  const maxScroll = Math.max(0, lines.length - bodyHeight);
  const scrollPos = Math.min(scroll, maxScroll);
  const visible = lines.slice(scrollPos, scrollPos + bodyHeight);
  while (visible.length < bodyHeight) visible.push({ text: '' });

  function reviewedLines(): Line[] {
    if (mode === 'exam' && !submitted) return buildAnswerLines(paper, question, picked, width);
    if (mode === 'feedback' && !reviewing) return buildAnswerLines(paper, question, picked, width);
    const head = paper.hasSolution ? [] : missingSolutionBanner(paper, width);
    return [...head, ...buildReviewLines(paper, question, picked, paper.questions.indexOf(question), width)];
  }

  const answered = Object.values(picks).filter((v) => v.length).length;
  const elapsed = Math.floor((now - startAt) / 1000);
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  let title = mode === 'exam' ? '整卷模拟' : '即时反馈';
  if (mode === 'exam' && submitted) title = '整卷解析';
  if (mode === 'feedback' && reviewing) title = '答案与解析';

  const hints = answering
    ? mode === 'exam'
      ? 'A–D 选择   Enter 提交并下一题（最后一题交卷）   N/P 翻题   O 浏览器看原题   ↑/↓ 滚动   Esc 返回   Q 退出'
      : 'A–D 选择   Enter 提交并看解析   N/P 换题   O 浏览器看原题   ↑/↓ 滚动   Esc 返回   Q 退出'
    : 'Enter 下一题   N/P 翻题   O 浏览器看原题   ↑/↓ 滚动   Esc 返回   Q 退出';

  return (
    <Box flexDirection="column" height={rows} paddingX={0}>
      <Box paddingX={1} justifyContent="space-between">
        <Text wrap="truncate">
          <Text bold color="cyan">{title}</Text>
          <Text dimColor>  {truncate(paper.name, Math.max(10, width - 40))}</Text>
        </Text>
        <Text>
          <Text bold>{`${pos + 1}/${order.length}`}</Text>
          <Text dimColor>  已答 {answered}  </Text>
          <Text color="yellow">{clock}</Text>
        </Text>
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(10, columns))}</Text>
      <Box flexDirection="column" height={bodyHeight} paddingX={1}>
        {visible.map((line, i) => (
          <Text key={i} color={line.color} bold={line.bold} dimColor={line.dim} wrap="truncate">
            {line.text || ' '}
          </Text>
        ))}
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(10, columns))}</Text>
      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor wrap="truncate">{hints}</Text>
        {notice ? <Text color="yellow">{notice}</Text> : null}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------- 快速练习（联网）

type QuickSession = {
  category: Category;
  cookie: string;
  exerciseKey: string;
  prefix: string;
  submitUrl: string;
  updateUrl: string;
  token: string;
  paper: Paper;
};

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 已选字母 → 服务端 choice（"0" / "0,2"） */
function choiceValue(picked: string[]): string {
  return picked
    .map((l) => LETTERS.indexOf(l))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)
    .join(',');
}

function quickPaper(ex: LoadedExercise, stats: Record<string, { wrongCount: number; totalCount: number; correctRatio: number }>): Paper {
  return {
    file: `quick:${ex.key}`,
    name: ex.name,
    exerciseKey: ex.key,
    hasSolution: false,
    questions: ex.questions.map((q) => ({ ...q, stats: stats[q.globalId] ?? null })),
    materials: new Map(ex.materials.map((m) => [m.globalId, m.content])),
    layout: buildLayout(ex.card),
    solvable: false,
  };
}

/** 类目展示名：path 末尾通常已经包含 name，去掉重复的一段 */
function categoryLabel(c: Category): string {
  const parts = [...c.path];
  if (parts[parts.length - 1] === c.name) parts.pop();
  return [...parts, c.name].filter(Boolean).join(' / ');
}

function QuickSetup({
  onBack,
  onQuit,
  onStart,
}: {
  onBack: () => void;
  onQuit: () => void;
  onStart: (session: QuickSession) => void;
}) {
  const { stdout } = useStdout();
  const width = Math.max(20, termSize(stdout).columns - 2);
  const [phase, setPhase] = useState<'loading' | 'select' | 'ready' | 'creating' | 'error'>('loading');
  const [categories, setCategories] = useState<Category[]>([]);
  const [index, setIndex] = useState(0);
  const [category, setCategory] = useState<Category | null>(null);
  const [fallback, setFallback] = useState('');
  const [status, setStatus] = useState('正在读取已选考试类目…');
  const [error, setError] = useState('');
  const cookieRef = useRef('');
  const createdRef = useRef<null | { key: string; name: string; questionCount: number }>(null);

  const init = async () => {
    setPhase('loading');
    setError('');
    setFallback('');
    setStatus('正在读取已选考试类目…');
    try {
      cookieRef.current = await loadCookieHeader();
      let selected: Category[] = [];
      let selectError = '';
      try {
        selected = await getSelectedCategories(cookieRef.current);
      } catch (e) {
        selectError = messageOf(e);
      }
      if (selected.length) {
        const current = await getCurrent(cookieRef.current).catch(() => null);
        const hit = current ? selected.findIndex((c) => c.examCategoryId === current.examCategoryId) : -1;
        const i = hit >= 0 ? hit : 0;
        setCategories(selected);
        setIndex(i);
        setCategory(selected[i]);
        setFallback(current ? '' : '当前考试类目读取失败，已默认选中第一项。');
        setStatus('');
        setPhase('select');
      } else {
        const cat = await getCurrent(cookieRef.current);
        setCategory(cat);
        setFallback(selectError ? `读取已选类目失败（${selectError}），已退回使用当前考试类目。` : '已选类目为空，已退回使用当前考试类目。');
        setStatus('');
        setPhase('ready');
      }
    } catch (e) {
      setError(messageOf(e));
      setPhase('error');
    }
  };

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const begin = async (target: Category | null = category) => {
    if (!target) return;
    setPhase('creating');
    setError('');
    const cookie = cookieRef.current;
    try {
      if (!createdRef.current) {
        setStatus('正在创建练习…');
        createdRef.current = await createQuick(cookie, target);
      }
      const created = createdRef.current;
      setStatus('正在获取题面…');
      const ex = await loadExercise(cookie, target.prefix, created.key);
      setStatus('正在获取全站正确率…');
      const stats = await fetchStats(cookie, target.prefix, ex.token).catch(() => ({}));
      onStart({
        category: target,
        cookie,
        exerciseKey: ex.key,
        prefix: ex.prefix,
        submitUrl: ex.submitUrl,
        updateUrl: ex.updateUrl,
        token: ex.token,
        paper: quickPaper(ex, stats),
      });
    } catch (e) {
      setError(messageOf(e));
      setPhase('error');
    }
  };

  const backToPick = () => {
    createdRef.current = null;
    setError('');
    setStatus('');
    if (categories.length) {
      setCategory(categories[index]);
      setPhase('select');
    } else {
      setPhase('ready');
    }
  };

  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === 'q') {
      onQuit();
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
    if (phase === 'select') {
      if (key.upArrow || key.downArrow) {
        const next = key.upArrow ? Math.max(0, index - 1) : Math.min(categories.length - 1, index + 1);
        setIndex(next);
        setCategory(categories[next]);
        return;
      }
      if (key.return) {
        void begin(categories[index]);
        return;
      }
      return;
    }
    if (phase === 'ready' && key.return) {
      void begin();
      return;
    }
    if (phase === 'error' && (ch === 'r' || key.return)) {
      if (createdRef.current) void begin();
      else if (categories.length) backToPick();
      else if (category) void begin();
      else void init();
    }
  });

  const header = (
    <>
      <Text bold color="cyan">快速练习（联网）</Text>
      {category ? (
        <>
          <Text>{`当前类目：${categoryLabel(category)}`}</Text>
          <Text dimColor>{`课程：${category.courseName || '—'}（prefix=${category.prefix}）  examcatid=${category.examCategoryId}`}</Text>
        </>
      ) : null}
      <Text />
    </>
  );

  if (phase === 'select') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">快速练习（联网）</Text>
        <Text dimColor>选择考试类目（只影响这一轮练习，不会改动你在网页上的当前考试）</Text>
        <Text />
        {categories.map((c, i) => {
          const active = i === index;
          const label = categoryLabel(c);
          return (
            <Text key={c.examCategoryId} color={active ? 'cyan' : undefined} bold={active}>
              {(active ? '▶ ' : '  ') + label}
              <Text dimColor>{`（${c.courseName || '—'} prefix=${c.prefix}）`}</Text>
            </Text>
          );
        })}
        <Text />
        <Text>↑/↓ 选择   Enter 创建并开始   Esc 返回   Q 退出</Text>
      </Box>
    );
  }

  if (phase === 'error') {
    const retryText = createdRef.current
      ? 'R / Enter 重试（沿用已创建的练习）'
      : categories.length
        ? 'R / Enter 重新选择类目'
        : 'R / Enter 重试';
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Text color="red" bold>⚠ 出错了</Text>
        {wrapText(error, width).map((l, i) => (
          <Text key={i} color="yellow">{l}</Text>
        ))}
        {!createdRef.current && category ? (
          <Text dimColor>{`上次选择：${categoryLabel(category)}（${category.courseName || '—'} prefix=${category.prefix}）`}</Text>
        ) : null}
        <Text />
        <Text dimColor>{`${retryText}   Esc 返回   Q 退出`}</Text>
      </Box>
    );
  }

  if (phase === 'loading' || phase === 'creating') {
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Text color="cyan">{status}</Text>
        {phase === 'creating' && createdRef.current ? (
          <Text dimColor>{`练习 key：${createdRef.current.key}`}</Text>
        ) : null}
        <Text />
        <Text dimColor>Q 退出</Text>
      </Box>
    );
  }

  const lines = [
    `本轮由服务端即时组卷，固定 ${QUICK_COUNT} 题（实际题量以创建结果为准）。`,
    '开始会在当前账号里新建一条「快速智能练习」记录；答题中按 Enter 作答并前进，最后一题 Enter 进入交卷确认。',
    '交卷时先逐题上报作答，再提交；提交后不可修改，随后展示答案与解析。',
    '答题中途 Esc 返回不会交卷，这条练习会留在账号里（未交卷）。',
    'Cookie 来源：verify/cookies.json 或环境变量 FENBI_COOKIE。',
  ];

  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      {fallback ? (
        <>
          <Text color="yellow">{fallback}</Text>
          <Text />
        </>
      ) : null}
      {lines.map((t, i) => (
        <Text key={i} color={i === 0 ? 'yellow' : undefined} dimColor={i > 0}>
          {'· '}
          {t}
        </Text>
      ))}
      <Text />
      <Text>Enter 创建并开始   Esc 返回   Q 退出</Text>
    </Box>
  );
}

function QuickRunner({ session, onExit, onQuit }: { session: QuickSession; onExit: () => void; onQuit: () => void }) {
  const { stdout } = useStdout();
  const { columns, rows } = termSize(stdout);
  const width = Math.max(20, columns - 2);
  const bodyHeight = Math.max(6, rows - 4);

  const [paper, setPaper] = useState<Paper>(session.paper);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [pos, setPos] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [phase, setPhase] = useState<'answering' | 'confirm' | 'submitting' | 'review' | 'error'>('answering');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<{ stage: 'report' | 'submit' | 'solution'; msg: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [startAt] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const total = paper.questions.length;
  const question = paper.questions[Math.min(pos, total - 1)];
  const picked = picks[question.globalId] ?? [];
  const answered = Object.values(picks).filter((v) => v.length).length;

  const go = (next: number) => {
    setPos(Math.max(0, Math.min(total - 1, next)));
    setScroll(0);
    setNotice('');
  };

  const choose = (letter: string) => {
    const idx = LETTERS.indexOf(letter);
    if (idx < 0 || idx >= question.options.length) return;
    const current = picks[question.globalId] ?? [];
    const multi = question.optionsType === 102;
    const next = multi ? (current.includes(letter) ? current.filter((x) => x !== letter) : [...current, letter].sort()) : [letter];
    setPicks({ ...picks, [question.globalId]: next });
    setNotice('');
  };

  const loadSolutions = async () => {
    setPhase('submitting');
    setStatus('正在拉取解析…');
    try {
      const [sols, stats] = await Promise.all([
        fetchSolutions(session.cookie, session.prefix, session.token),
        fetchStats(session.cookie, session.prefix, session.token).catch(
          (): Record<string, { wrongCount: number; totalCount: number; correctRatio: number }> => ({}),
        ),
      ]);
      const byId = new Map(sols.map((s) => [s.globalId, s]));
      setPaper((prev) => ({
        ...prev,
        hasSolution: true,
        solvable: true,
        questions: prev.questions.map((q) => {
          const s = byId.get(q.globalId);
          return {
            ...q,
            answer: s?.answer ?? q.answer,
            solution: s?.solution ?? q.solution,
            stats: stats[q.globalId] ?? q.stats,
          };
        }),
      }));
      setPos(0);
      setScroll(0);
      setNotice('');
      setPhase('review');
    } catch (e) {
      setError({ stage: 'solution', msg: messageOf(e) });
      setPhase('error');
    }
  };

  const doSubmit = async () => {
    setPhase('submitting');
    setError(null);
    const items = paper.questions
      .filter((q) => (picks[q.globalId] ?? []).length)
      .map((q) => ({
        globalId: q.globalId,
        choice: choiceValue(picks[q.globalId]),
        time: Math.max(1, Math.round((Date.now() - startAt) / 1000)),
      }));
    try {
      setStatus(items.length ? `正在上报作答 0/${items.length}…` : '没有已答题目，跳过上报');
      await reportAnswers(session.cookie, session.prefix, session.updateUrl, items, (done, n) =>
        setStatus(`正在上报作答 ${done}/${n}…`),
      );
    } catch (e) {
      setError({ stage: 'report', msg: messageOf(e) });
      setPhase('error');
      return;
    }
    setStatus('正在交卷…');
    try {
      await submitExercise(session.cookie, session.prefix, session.submitUrl);
    } catch (e) {
      setError({ stage: 'submit', msg: messageOf(e) });
      setPhase('error');
      return;
    }
    await loadSolutions();
  };

  const retry = () => {
    if (!error) return;
    if (error.stage === 'solution') void loadSolutions();
    else void doSubmit();
  };

  // O：把当前题导出成 HTML 用浏览器打开，补终端里看不到的公式/图表
  const openCurrent = () => {
    void openQuestionHtml({
      paper,
      question,
      picked: picks[question.globalId] ?? [],
      revealed: phase === 'review',
      index: pos + 1,
      total,
      modeLabel: phase === 'review' ? '快速练习解析' : '快速练习',
    })
      .then(() => setNotice('已用浏览器打开当前题（.tmp/question.html）'))
      .catch((e) => setNotice(`打开失败：${messageOf(e)}`));
  };

  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === 'q') {
      onQuit();
      return;
    }
    if (key.escape) {
      if (phase === 'confirm') {
        setPhase('answering');
        setNotice('已取消交卷');
        return;
      }
      onExit();
      return;
    }
    if (phase === 'submitting') return;
    if (phase === 'error') {
      if (ch === 'r') {
        retry();
        return;
      }
      if (key.return && error?.stage === 'solution') {
        setPaper((prev) => ({ ...prev, hasSolution: false }));
        setPos(0);
        setScroll(0);
        setPhase('review');
      }
      return;
    }
    if (phase === 'confirm') {
      if (key.return) void doSubmit();
      return;
    }
    if (ch === 'o') {
      openCurrent();
      return;
    }
    if (key.upArrow) {
      setScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setScroll((s) => s + 1);
      return;
    }
    if (key.pageUp) {
      setScroll((s) => Math.max(0, s - bodyHeight));
      return;
    }
    if (key.pageDown) {
      setScroll((s) => s + bodyHeight);
      return;
    }
    if (ch === 'n') {
      go(pos + 1);
      return;
    }
    if (ch === 'p') {
      go(pos - 1);
      return;
    }
    if (phase === 'review') {
      if (key.return) go(pos + 1);
      return;
    }
    if (/^[a-f]$/.test(ch)) {
      choose(ch.toUpperCase());
      return;
    }
    if (key.return) {
      if (!picked.length) {
        setNotice('先选答案再按 Enter');
        return;
      }
      if (pos >= total - 1) {
        setPhase('confirm');
        setScroll(0);
        setNotice('');
      } else {
        go(pos + 1);
      }
    }
  });

  const elapsed = Math.floor((now - startAt) / 1000);
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  let lines: Line[];
  let title = '快速练习';
  let hints = 'A–D 选择   Enter 提交并下一题（最后一题确认交卷）   N/P 翻题   O 浏览器看原题   ↑/↓ 滚动   Esc 返回   Q 退出';

  if (phase === 'confirm') {
    title = '交卷确认';
    const missing = total - answered;
    lines = wrapText(
      [
        `已答 ${answered}/${total}${missing ? `，未答 ${missing} 题` : '，全部作答'}`,
        '交卷后会先逐题上报作答，再提交练习，然后展示答案与解析；提交后不可修改。',
      ].join('\n'),
      width,
    ).map((l) => ({ text: l }));
    hints = 'Enter 确认交卷   Esc 返回检查   Q 退出';
  } else if (phase === 'submitting') {
    title = '交卷中';
    lines = [
      { text: status, color: 'cyan', bold: true },
      { text: '' },
      { text: '请稍候，不要关闭窗口。', dim: true },
    ];
    hints = '交卷中…';
  } else if (phase === 'error' && error) {
    title = error.stage === 'solution' ? '已交卷 · 解析失败' : '交卷失败';
    lines = [
      {
        text:
          error.stage === 'solution'
            ? '练习已成功交卷，但解析没有取到。'
            : error.stage === 'report'
              ? '作答上报失败，练习尚未提交。'
              : '交卷请求失败，练习可能尚未提交。',
        color: 'yellow',
        bold: true,
      },
      { text: '' },
      ...wrapText(error.msg, width).map((l) => ({ text: l, color: 'red' as const })),
      { text: '' },
      {
        text:
          error.stage === 'solution'
            ? '可以 R 重试拉取解析，或 Enter 先按无解析查看题面。'
            : '可以 R 重试（会重新上报并再次提交），或 Esc 返回；练习仍会留在账号里。',
        dim: true,
      },
    ];
    hints = error.stage === 'solution' ? 'R 重试解析   Enter 无解析查看   Esc 返回   Q 退出' : 'R 重试交卷   Esc 返回   Q 退出';
  } else if (phase === 'review') {
    title = '快速练习解析';
    const head: Line[] = [];
    if (!paper.hasSolution) {
      head.push(
        { text: '⚠ 已交卷，但解析数据不可用：仅展示题面与你选的答案。', color: 'yellow', bold: true },
        { text: '' },
      );
    }
    lines = [...head, ...buildReviewLines(paper, question, picked, pos, width)];
    hints = 'Enter / N 下一题   P 上一题   O 浏览器看原题   ↑/↓ 滚动   Esc 完成并返回   Q 退出';
  } else {
    lines = buildAnswerLines(paper, question, picked, width);
  }

  const maxScroll = Math.max(0, lines.length - bodyHeight);
  const scrollPos = Math.min(scroll, maxScroll);
  const visible = lines.slice(scrollPos, scrollPos + bodyHeight);
  while (visible.length < bodyHeight) visible.push({ text: '' });

  return (
    <Box flexDirection="column" height={rows} paddingX={0}>
      <Box paddingX={1} justifyContent="space-between">
        <Text wrap="truncate">
          <Text bold color="cyan">{title}</Text>
          <Text dimColor>  {truncate(paper.name, Math.max(10, width - 52))}</Text>
          <Text dimColor>{`  ${session.exerciseKey}`}</Text>
        </Text>
        <Text>
          <Text bold>{`${pos + 1}/${total}`}</Text>
          <Text dimColor>  已答 {answered}  </Text>
          <Text color="yellow">{clock}</Text>
        </Text>
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(10, columns))}</Text>
      <Box flexDirection="column" height={bodyHeight} paddingX={1}>
        {visible.map((line, i) => (
          <Text key={i} color={line.color} bold={line.bold} dimColor={line.dim} wrap="truncate">
            {line.text || ' '}
          </Text>
        ))}
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(10, columns))}</Text>
      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor wrap="truncate">{hints}</Text>
        {notice ? <Text color="yellow">{notice}</Text> : null}
      </Box>
    </Box>
  );
}

export function App() {
  const { exit } = useApp();
  const papers = useMemo(loadPapers, []);
  const store = useMemo(loadProgress, []);
  const [view, setView] = useState<View>({ t: 'home' });
  const [homeIndex, setHomeIndex] = useState(0);
  const [modeIndex, setModeIndex] = useState(0);
  const [notice, setNotice] = useState('');
  const [auth, setAuth] = useState<SessionState | { state: 'checking' }>({ state: 'checking' });
  const authSeq = useRef(0);

  const refreshAuth = async () => {
    const seq = ++authSeq.current;
    setAuth({ state: 'checking' });
    const result = await checkSession().catch(
      (e): SessionState => ({ state: 'network', detail: (e as Error).message }),
    );
    if (authSeq.current === seq) setAuth(result);
  };

  useEffect(() => {
    void refreshAuth();
    // 启动时校验一次；之后按 R 手动重试
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const quit = () => {
    exit();
    setTimeout(() => process.exit(0), 30);
  };

  // 主页与模式选择共用一份键盘处理；答题界面自己接管。
  useInput(
    (input, key) => {
      if (view.t === 'home') {
        if (input.toLowerCase() === 'q') {
          quit();
          return;
        }
        if (input.toLowerCase() === 'r') {
          setNotice('');
          void refreshAuth();
          return;
        }
        if (key.upArrow) setHomeIndex((i) => Math.max(0, i - 1));
        else if (key.downArrow) setHomeIndex((i) => Math.min(papers.length, i + 1));
        else if (key.return) {
          setNotice('');
          if (homeIndex === 0) {
            setView({ t: 'quick' });
          } else {
            setModeIndex(0);
            setView({ t: 'mode', paper: papers[homeIndex - 1] });
          }
        }
        return;
      }
      if (view.t === 'mode') {
        if (input.toLowerCase() === 'q') {
          quit();
          return;
        }
        if (key.escape) {
          setView({ t: 'home' });
          return;
        }
        if (key.upArrow) setModeIndex(0);
        else if (key.downArrow) setModeIndex(1);
        else if (key.return) {
          if (modeIndex === 1 && !view.paper.solvable) {
            setNotice('这套卷没有答案解析数据，不能即时反馈；先整卷作答，或按页面提示补同步。');
            return;
          }
          setView({ t: 'run', paper: view.paper, mode: modeIndex === 0 ? 'exam' : 'feedback' });
        }
      }
    },
    { isActive: view.t === 'home' || view.t === 'mode' },
  );

  if (view.t === 'home') {
    return <Home papers={papers} index={homeIndex} auth={auth} />;
  }

  if (view.t === 'mode') {
    return <ModeSelect paper={view.paper} index={modeIndex} notice={notice} />;
  }

  if (view.t === 'quick') {
    return (
      <QuickSetup
        onBack={() => setView({ t: 'home' })}
        onQuit={quit}
        onStart={(session) => setView({ t: 'quick-run', session })}
      />
    );
  }

  if (view.t === 'quick-run') {
    return <QuickRunner session={view.session} onExit={() => setView({ t: 'home' })} onQuit={quit} />;
  }

  return (
    <Runner
      key={`${view.paper.file}:${view.mode}`}
      paper={view.paper}
      mode={view.mode}
      store={store}
      onBack={() => setView({ t: 'mode', paper: view.paper })}
      onQuit={quit}
    />
  );
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
})();

if (isMain) render(<App />);

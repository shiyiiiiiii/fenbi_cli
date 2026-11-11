/**
 * 把当前题导出成一份本地 HTML 并用系统默认浏览器打开。
 *
 * 目的：终端里公式/图表只能显示占位符，按 O 可以看原始富文本与真实图片。
 * 题面、选项、材料都保留题库返回的 HTML，只把 <img> 的协议相对地址补成 https。
 * 文件固定写到 .tmp/question.html，每次覆盖，不落 data/。
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_DIR = path.join(ROOT, '.tmp');
export const QUESTION_HTML_FILE = path.join(TMP_DIR, 'question.html');

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

type Solution = {
  content: string | null;
  source: string | null;
  keypoints: Array<{ id: number; name: string }>;
};

export type HtmlQuestion = {
  globalId: string;
  content: string;
  options: string[];
  optionsType: number | null;
  answer: { choice: string; type: number } | null;
  solution: Solution;
  stats: { wrongCount: number; totalCount: number; correctRatio: number } | null;
};

export type HtmlPaper = {
  name: string;
  materials: Map<string, string>;
  layout: Map<string, { chapter: string | null; materialKeys: string[] }>;
};

export type OpenOptions = {
  paper: HtmlPaper;
  question: HtmlQuestion;
  /** 当前已选的字母，如 ['A'] / ['A','C'] */
  picked: string[];
  /** 答案与解析是否已揭晓（整卷交卷后 / 即时反馈揭示后 / 快速练习交卷后） */
  revealed: boolean;
  /** 1 起的题号 */
  index: number;
  total: number;
  /** 顶部显示的模式名，如「整卷模拟」 */
  modeLabel: string;
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 协议相对地址补 https:；站内绝对路径补域名。只动图片地址，不碰正文。 */
function absolutizeImages(html: string): string {
  return html.replace(
    /(<(?:img|source)\b[^>]*?\b(?:src|data-src)\s*=\s*["'])([^"']+)(["'])/gi,
    (_m, pre: string, url: string, post: string) => {
      const u = url.trim();
      if (u.startsWith('//')) return `${pre}https:${u}${post}`;
      if (u.startsWith('/')) return `${pre}https://www.fenbi.com${u}${post}`;
      return `${pre}${u}${post}`;
    },
  );
}

/** 空 <u>（空白、&nbsp;、纯下划线）加 class="blank"，由 CSS 撑出可见横线 */
function markBlankUnderlines(html: string): string {
  return html.replace(/<u\b([^>]*)>([\s\S]*?)<\/u>/gi, (match, attrs: string, inner: string) => {
    if (/<img\b/i.test(inner)) return match;
    const plain = inner
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
      .replace(/\s+/g, '')
      .trim();
    if (!plain || /^[_＿]+$/.test(plain)) {
      const cleaned = attrs.replace(/\sclass\s*=\s*(["'])[\s\S]*?\1/i, '');
      return `<u${cleaned} class="blank"></u>`;
    }
    return match;
  });
}

function prepareRich(html: string): string {
  return absolutizeImages(markBlankUnderlines(html));
}

function answerLetters(answer: { choice: string } | null): string[] {
  if (!answer?.choice) return [];
  return answer.choice
    .split(/[,，]/)
    .map((x) => LETTERS[Number(x.trim())])
    .filter((x): x is string => !!x);
}

function materialBlocks(paper: HtmlPaper, question: HtmlQuestion): string {
  const keys = paper.layout.get(question.globalId)?.materialKeys ?? [];
  const blocks: string[] = [];
  for (const key of keys) {
    const content = paper.materials.get(key);
    if (!content) continue;
    blocks.push(
      `<section class="material"><div class="label">材料</div><div class="rich">${prepareRich(content)}</div></section>`,
    );
  }
  return blocks.join('\n');
}

function optionList(question: HtmlQuestion, picked: string[], revealed: boolean): string {
  const right = revealed ? answerLetters(question.answer) : [];
  const mine = new Set(picked);
  const items = question.options.map((opt, i) => {
    const letter = LETTERS[i] ?? '?';
    const isRight = right.includes(letter);
    const isMine = mine.has(letter);
    const isWrong = revealed && isMine && !isRight;
    const classes = ['opt', isRight ? 'correct' : '', isWrong ? 'wrong' : '', isMine ? 'picked' : '']
      .filter(Boolean)
      .join(' ');
    const badge = [
      isRight ? '正确答案' : '',
      isMine ? '你的选择' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return [
      `<li class="${classes}">`,
      `<div class="opt-head"><span class="letter">${letter}</span>${badge ? `<span class="badge">${badge}</span>` : ''}</div>`,
      `<div class="rich">${prepareRich(opt)}</div>`,
      '</li>',
    ].join('');
  });
  const typeNote = question.optionsType === 102 ? '<div class="note">多选题</div>' : '';
  return `${typeNote}<ol class="options">${items.join('\n')}</ol>`;
}

function answerSection(question: HtmlQuestion, picked: string[], revealed: boolean): string {
  if (!revealed) return '';
  const right = answerLetters(question.answer);
  const mine = picked.length ? picked.join(' ') : '未作答';
  const answerText = right.length ? right.join(' ') : '暂无答案数据';
  const resultClass = !right.length ? 'muted' : right.join('') === [...picked].sort().join('') ? 'ok' : 'bad';
  return [
    '<section class="answer">',
    `<div class="label">答案</div>`,
    `<div class="answer-line ${resultClass}">正确答案：${esc(answerText)}</div>`,
    `<div class="muted">你的选择：${esc(mine)}</div>`,
    '</section>',
  ].join('');
}

function solutionSection(question: HtmlQuestion, revealed: boolean): string {
  if (!revealed) return '';
  const parts: string[] = ['<section class="solution"><div class="label">解析</div>'];
  const content = question.solution?.content;
  if (content) parts.push(`<div class="rich">${prepareRich(content)}</div>`);
  else parts.push('<div class="muted">本题暂无解析正文。</div>');

  const points = (question.solution?.keypoints ?? []).map((k) => k.name).filter(Boolean);
  if (points.length) {
    parts.push('<div class="keypoints"><span class="label">考点</span>');
    for (const p of points) parts.push(`<span class="point">${esc(p)}</span>`);
    parts.push('</div>');
  }
  if (question.solution?.source) {
    parts.push(`<div class="muted">来源：${esc(question.solution.source)}</div>`);
  }
  if (question.stats) {
    const ratio = Number.isFinite(question.stats.correctRatio) ? `${question.stats.correctRatio.toFixed(1)}%` : '—';
    parts.push(`<div class="muted">全站正确率：${ratio}（${question.stats.totalCount} 人作答）</div>`);
  }
  parts.push('</section>');
  return parts.join('');
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #fff;
    color: #1f2328;
    font: 16px/1.75 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; padding: 28px 20px 64px; }
  header { margin-bottom: 20px; }
  header .meta { color: #666; font-size: 14px; }
  h1 { font-size: 20px; margin: 6px 0 2px; }
  .chapter { color: #666; font-size: 14px; }
  .label {
    display: inline-block;
    margin: 18px 0 6px;
    color: #8a6d3b;
    font-size: 13px;
    letter-spacing: .04em;
  }
  .rich { overflow-wrap: anywhere; }
  .rich p { margin: .5em 0; }
  .rich img { max-width: 100%; height: auto; }
  .rich u { text-underline-offset: 3px; }
  .rich u.blank {
    display: inline-block;
    min-width: 5em;
    height: 1em;
    border-bottom: 1.5px solid currentColor;
    text-decoration: none;
    vertical-align: -0.12em;
  }
  .rich table { border-collapse: collapse; max-width: 100%; }
  .rich td, .rich th { border: 1px solid #ddd; padding: 4px 8px; }
  .material { padding: 10px 14px; background: #f7f7f8; border-left: 3px solid #d0d0d4; margin: 14px 0; }
  .material .label { margin-top: 0; }
  .options { list-style: none; padding: 0; margin: 8px 0; }
  .opt { border: 1px solid #dcdce0; border-radius: 6px; padding: 10px 12px; margin: 8px 0; }
  .opt-head { display: flex; align-items: center; gap: 10px; }
  .letter { font-weight: 600; min-width: 1.2em; }
  .badge { font-size: 12px; color: #666; }
  .opt.correct { border-color: #2e7d32; background: #f2f8f2; }
  .opt.correct .badge { color: #2e7d32; }
  .opt.wrong { border-color: #c62828; background: #fdf4f4; }
  .opt.wrong .badge { color: #c62828; }
  .opt.picked .letter { text-decoration: underline; }
  .answer, .solution { margin-top: 22px; border-top: 1px solid #eee; padding-top: 6px; }
  .answer-line { font-weight: 600; }
  .answer-line.ok { color: #2e7d32; }
  .answer-line.bad { color: #c62828; }
  .muted { color: #666; font-size: 14px; }
  .note { color: #666; font-size: 13px; }
  .keypoints { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .keypoints .label { margin: 0; }
  .point { background: #f3f4f6; border-radius: 4px; padding: 2px 8px; font-size: 13px; }
`;

/** 纯渲染：给定题目与揭晓状态，返回完整 HTML 字符串。 */
export function renderQuestionHtml(opts: OpenOptions): string {
  const { paper, question, picked, revealed, index, total, modeLabel } = opts;
  const chapter = paper.layout.get(question.globalId)?.chapter;
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${esc(paper.name)} · 第 ${index} 题</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<header>',
    `<div class="meta">${esc(modeLabel)} · 第 ${index} / ${total} 题</div>`,
    `<h1>${esc(paper.name)}</h1>`,
    chapter ? `<div class="chapter">${esc(chapter)}</div>` : '',
    '</header>',
    materialBlocks(paper, question),
    '<section class="question">',
    '<div class="label">题目</div>',
    `<div class="rich">${prepareRich(question.content)}</div>`,
    '</section>',
    optionList(question, picked, revealed),
    picked.length ? `<div class="muted">你的选择：${esc(picked.join(' '))}</div>` : '',
    answerSection(question, picked, revealed),
    solutionSection(question, revealed),
    '</main>',
    '</body>',
    '</html>',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

function openInBrowser(file: string): void {
  const url = pathToFileURL(file).href;
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true })
      : process.platform === 'darwin'
        ? spawn('open', [url], { stdio: 'ignore', detached: true })
        : spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // 打不开浏览器不影响 TUI，文件仍然写在 .tmp/question.html
  });
  child.unref();
}

/** 渲染、写盘并打开；返回 HTML 文件路径。 */
export async function openQuestionHtml(opts: OpenOptions): Promise<string> {
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(QUESTION_HTML_FILE, renderQuestionHtml(opts), 'utf8');
  openInBrowser(QUESTION_HTML_FILE);
  return QUESTION_HTML_FILE;
}

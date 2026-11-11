/**
 * 终端文本化：把题库里的 HTML 转成可读纯文本，并按终端显示宽度折行。
 * 图片（含 flag="tex" 的公式图）只留占位符，不做还原。
 * 填空题的空 <u>（空白、&nbsp;、纯下划线）会转成可见横线，避免空格被折叠后看不见。
 * 圈号 ①–⑳ 统一改写成括号数字；两个以上连续圈号（排序题选项）用连字符连接。
 */

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&ensp;': ' ',
  '&emsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/** 空 <u> 在终端里的占位：5 个全角下划线，显示宽度 10 */
const BLANK = '＿＿＿＿＿';

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&ensp;|&emsp;|&lt;|&gt;|&amp;|&quot;|&#39;|&apos;/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

/** <u> 里的内容转成一行纯文本，用于判断是不是空 */
function underlinePlain(inner: string): string {
  const withoutTags = inner.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

/** <u> 空/纯下划线 → 可见横线；有真实内容 → 用下划线包起来；图片占位保持原样 */
function underlineToText(html: string): string {
  return html.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, (_m, inner: string) => {
    const plain = underlinePlain(inner);
    if (!plain || /^[_＿]+$/.test(plain)) return BLANK;
    if (/\[(?:公式图|图)\]/.test(plain)) return plain;
    return `_${plain}_`;
  });
}

/** ①(U+2460) 起的圈号，最多到 ⑳ */
const CIRCLED_MIN = 0x2460;
const CIRCLED_SEQ = /[\u2460-\u2473]+/g;

function circledToNumber(ch: string): number {
  return (ch.codePointAt(0) ?? CIRCLED_MIN) - CIRCLED_MIN + 1;
}

/**
 * 圈号改写：单个 ① → `(1) `；连续两个以上（排序题选项）→ `3-1-5-6-2`。
 * 只处理 ①–⑳，带圈字母（Ⓐ 等）与普通数字不受影响。
 */
function convertCircledNumbers(s: string): string {
  return s.replace(CIRCLED_SEQ, (seq) => {
    const nums = [...seq].map(circledToNumber);
    if (nums.length >= 2) return nums.join('-');
    return `(${nums[0]}) `;
  });
}

/** HTML → 纯文本。<p> 换行，<u> 空时输出横线，<img> 变成 [公式图]/[图]。 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  let s = html;
  s = s.replace(/<img\b[^>]*>/gi, (m) => (/flag\s*=\s*["']?tex|latex=/i.test(m) ? '[公式图]' : '[图]'));
  s = underlineToText(s);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '· ');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = convertCircledNumbers(s);
  s = s.replace(/\r/g, '');
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 单个码点的终端宽度（CJK 全角按 2 计）。 */
function charWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** 按显示宽度硬折行，保留原有换行。 */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(4, width);
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (!rawLine) {
      out.push('');
      continue;
    }
    let cur = '';
    let curWidth = 0;
    for (const ch of rawLine) {
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (curWidth + w > limit && cur) {
        out.push(cur);
        cur = '';
        curWidth = 0;
        if (ch === ' ') continue;
      }
      cur += ch;
      curWidth += w;
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
}

/** 带前缀/缩进的折行，用于选项、解析段落。 */
export function wrapWithPrefix(prefix: string, text: string, width: number): string[] {
  const indent = ' '.repeat(displayWidth(prefix));
  return wrapText(text, Math.max(4, width - displayWidth(prefix))).map((line, i) => (i === 0 ? prefix + line : indent + line));
}

/** 按显示宽度截断，超出加省略号。 */
export function truncate(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

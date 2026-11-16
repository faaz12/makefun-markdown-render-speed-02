// parse.js — a fast CommonMark 0.31.2 + GFM renderer, round-3 rewrite.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders
// with its defaults (gfm on, breaks off, pedantic off, async off).
// Dependency-free, no I/O, no state kept between calls.
//
// How it works, inside out: the source is first normalised to \n line
// ends and split into lines. A block lexer walks the lines and builds a
// small tree (paragraphs, headings, fences, lists, quotes, tables, raw
// HTML, code). Each leaf's text is then scanned into a flat list of
// inline pieces — text runs, code spans, links, images, raw tags and
// delimiter runs — the delimiter runs are settled into <em>/<strong>/
// <del> nodes, and the pieces are emitted straight to HTML strings.
//
// This file was written from the marked behaviour as its spec; the
// layout below (blocks first, inline second, rendering last) and every
// name in it are this rewrite's own.

const PUNCT_SET = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

// --- single-character classification -------------------------------------
// All three take a Unicode code point and answer by range tests, with a
// Unicode property test only for the non-ASCII tail.

function punctCp(cp) {
  if (cp < 128) return PUNCT_SET.indexOf(String.fromCharCode(cp)) !== -1;
  return /[\p{P}\p{S}]/u.test(String.fromCodePoint(cp));
}

function spaceCp(cp) {
  if (cp < 128) {
    return cp === 32 || cp === 9 || cp === 10 || cp === 13 || cp === 12 || cp === 11;
  }
  return /\s/u.test(String.fromCodePoint(cp));
}

function alnumCp(cp) {
  if (cp < 128) {
    return (cp >= 97 && cp <= 122) || (cp >= 65 && cp <= 90) || (cp >= 48 && cp <= 57);
  }
  return /[\p{L}\p{N}]/u.test(String.fromCodePoint(cp));
}

// Is this one-character string an ASCII punctuation character?
function asciiPunctCh(c) {
  return c !== undefined && PUNCT_SET.indexOf(c) !== -1;
}

// Is this (possibly multi-code-unit) string a single punctuation char?
function strIsPunct(s) {
  if (s === '') return false;
  if (s.length === 1) return punctCp(s.charCodeAt(0));
  return /[\p{P}\p{S}]/u.test(s);
}

// Is this string a single whitespace character?
function strIsSpace(s) {
  if (s === '') return false;
  if (s.length === 1) return spaceCp(s.charCodeAt(0));
  return /\s/u.test(s);
}

// --- escaping ------------------------------------------------------------
// A bare & is escaped unless it opens something shaped like a character
// reference (&word; or &#...;), which passes through untouched: named
// entities are never decoded. Numeric references are decoded first
// (&#35; -> #, &#0; -> U+FFFD) and the result is then escaped.
const AMP_RE = /&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)|[<>"']/g;
const NUM_REF_RE = /&(?:#(\d{1,7})|#[Xx]([0-9A-Fa-f]{1,6}));/g;
const ANY_SPECIAL_RE = /[&<>"']/g;

function escOne(c) {
  switch (c) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    default: return '&#39;';
  }
}

function escHtml(s) {
  return s.replace(AMP_RE, escOne);
}

function decodeNums(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(NUM_REF_RE, (_whole, dec, hex) => {
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(cp);
  });
}

// A run of ordinary text: decode numeric references, then escape.
function textOut(s) {
  return escHtml(decodeNums(s));
}

// Full escaping for an escaped character: & is always escaped, so a
// literal & from a backslash escape can never look like an entity.
function textOutStrict(s) {
  return s.replace(ANY_SPECIAL_RE, escOne);
}

// Code span content: escape everything, entities included.
function escCode(s) {
  return s.replace(ANY_SPECIAL_RE, escOne);
}

// Strip backslash escapes (backslash before ASCII punctuation only)
// and decode numeric references — for link destinations and titles.
function unesc(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && asciiPunctCh(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += c;
    }
  }
  return decodeNums(out);
}

// Strip backslash escapes only (no numeric decoding) — for link
// destinations and titles, where marked keeps numeric references raw.
function stripSlashes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && asciiPunctCh(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

// Encode a link destination the way marked does: encodeURI, keeping
// literal % signs intact (%25 is turned back into %).
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch (_e) {
    return null;
  }
  return href;
}

// Fold a link label for reference lookup: collapse whitespace, trim,
// case-fold (lower, UPPER, lower, so that ẞ and SS fold together).
function foldRef(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

// --- line utilities ------------------------------------------------------
// Lines are objects {txt, lazy}: lazy marks a line that entered a block
// quote or list item as a lazy paragraph continuation (a setext
// underline on such a line is plain text, never a heading).

function blankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Columns of leading whitespace (space = 1, tab = to the next multiple
// of 4). A line of only whitespace reports a large indent.
function indentOf(s) {
  let col = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return i === s.length ? 1000 : col;
}

// Expand tabs to spaces, tracking the column (tab stops every 4).
// Used for the whitespace after a blockquote '>' or a list marker,
// where marked expands tabs from the marker's column.
function expandTab(s, startCol) {
  let col = startCol;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else { out += c; col++; }
  }
  return out;
}

// Remove the first n columns of a line; a tab straddling the boundary
// turns into the spaces that are left of it.
function dropCols(s, n) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < n) {
    const c = s[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const nc = col + (4 - (col % 4));
      if (nc <= n) { col = nc; i++; }
      else { return ' '.repeat(nc - n) + s.slice(i + 1); }
    } else break;
  }
  return s.slice(i);
}

// Strip an indented-code prefix: up to 3 spaces plus a tab, or 1-4 spaces.
// (A tab is consumed whole here.)
function dropCodeIndent(s) {
  const m = /^(?: {0,3}\t| {1,4})/.exec(s);
  return m ? s.slice(m[0].length) : s;
}

// Strip a list item's content indent from a continuation line: expand
// the leading whitespace to spaces from column 0, then drop
// contentCols columns (marked expands, then slices — a tab straddling
// the boundary leaves spaces, never a tab).
function dropItemIndent(line, contentCols) {
  let k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  const expanded = expandTab(line.slice(0, k), 0) + line.slice(k);
  return expanded.slice(contentCols);
}

// --- block-start detectors ------------------------------------------------

// ATX heading info {depth, txt} or null.
function atxOf(line) {
  const ind = indentOf(line);
  if (ind > 3) return null;
  const s = dropCols(line, ind);
  const m = /^(#{1,6})(?:[ \t]+|[ \t]*$)/.exec(s);
  if (!m) return null;
  let content = s.slice(m[0].length);
  content = content.replace(/[ \t]+$/, '');
  if (/^#+$/.test(content)) content = '';
  else content = content.replace(/[ \t]+#+$/, '');
  return { depth: m[1].length, txt: content };
}

// Fenced-code info {ch, len, info, indent} or null.
function fenceOf(line) {
  const ind = indentOf(line);
  if (ind > 3) return null;
  const s = dropCols(line, ind);
  const m = /^(`{3,}|~{3,})/.exec(s);
  if (!m) return null;
  const fence = m[1];
  const info = s.slice(fence.length);
  if (fence[0] === '`' && info.indexOf('`') !== -1) return null;
  return { ch: fence[0], len: fence.length, info, indent: ind };
}

function isRule(line) {
  const ind = indentOf(line);
  if (ind > 3) return false;
  const s = dropCols(line, ind);
  return /^(?:-[ \t]*){3,}$/.test(s) || /^(?:_[ \t]*){3,}$/.test(s) || /^(?:\*[ \t]*){3,}$/.test(s);
}

// Setext underline level: 1 for =, 2 for -, else 0.
function setextOf(line) {
  const ind = indentOf(line);
  if (ind > 3) return 0;
  const s = dropCols(line, ind);
  if (/^=+[ \t]*$/.test(s)) return 1;
  if (/^-+[ \t]*$/.test(s)) return 2;
  return 0;
}

const HTML_BLOCK_TAGS = new Set(('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul').split('|'));

// Inline-tag patterns, also used by the inline scanner (sticky copies
// are built from these in the inline section below).
const AUTO_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^ \t\n<>]+|[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
const TAG_OPEN_RE = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/;
const TAG_CLOSE_RE = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/;
const COMMENT_RE = /^<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const PI_RE = /^<\?[\s\S]*?(?:\?>|$)/;
const DECL_RE = /^<![A-Za-z][\s\S]*?(?:>|$)/;
const CDATA_RE = /^<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/;

// HTML block type (1-7) starting on this line, or 0.
function htmlKind(line) {
  const ind = indentOf(line);
  if (ind > 3) return 0;
  const s = dropCols(line, ind);
  if (/^<(?:script|pre|style|textarea)(?:[\s>]|\/>|$)/i.test(s)) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(s)) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(s);
  if (m && HTML_BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  // type 7: a complete open or close tag, alone on the line
  const rest = s.replace(/[ \t]+$/, '');
  TAG_OPEN_RE.lastIndex = 0;
  const om = TAG_OPEN_RE.exec(s);
  if (om && om.index === 0 && om[0].length === rest.length) return 7;
  TAG_CLOSE_RE.lastIndex = 0;
  const cm = TAG_CLOSE_RE.exec(s);
  if (cm && cm.index === 0 && cm[0].length === rest.length) return 7;
  return 0;
}

// Block-quote marker: returns the line with the marker stripped, or null.
// The whitespace after '>' is expanded to spaces from the marker's column,
// then the marker plus one space is removed.
function quoteOf(line) {
  const ind = indentOf(line);
  if (ind > 3) return null;
  const s = dropCols(line, ind);
  if (s[0] !== '>') return null;
  let rest = s.slice(1);
  let k = 0;
  while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) k++;
  if (k > 0) rest = expandTab(rest.slice(0, k), ind + 1) + rest.slice(k);
  if (rest[0] === ' ' || rest[0] === '\t') rest = rest.slice(1);
  return rest;
}

// Parse a list marker at the start of a line (indent at most 3).
// Returns {ordered, bullet, delim, start, contentCols, rest, empty}.
function markerOf(line) {
  const ind = indentOf(line);
  if (ind > 3) return null;
  const s = dropCols(line, ind);
  let m = /^([*+-])/.exec(s);
  let ordered = false;
  let bullet = null;
  let delim = null;
  let start = 0;
  let mw = 0;
  if (m) {
    bullet = m[1];
    mw = 1;
  } else {
    m = /^(\d{1,9})([.)])/.exec(s);
    if (!m) return null;
    ordered = true;
    delim = m[2];
    start = parseInt(m[1], 10);
    mw = m[1].length + 1;
  }
  const b = ind + mw;
  const g = s.slice(mw);
  if (blankLine(g)) {
    // empty item: content indent is one past the marker
    return { ordered, bullet, delim, start, contentCols: b + 1, rest: '', empty: true };
  }
  // Expand the whitespace run after the marker from the marker's column,
  // then the content starts at the first non-space column; if that is
  // more than 4 spaces in, the content indent is marker + 1 and the
  // extra spaces stay in the content.
  let k = 0;
  while (k < g.length && (g[k] === ' ' || g[k] === '\t')) k++;
  if (k === 0) return null;
  const expanded = expandTab(g.slice(0, k), b) + g.slice(k);
  let r = 0;
  while (r < expanded.length && expanded[r] === ' ') r++;
  if (r > 4) r = 1;
  const rest = expanded.slice(r);
  return { ordered, bullet, delim, start, contentCols: r + b, rest, empty: blankLine(rest) };
}

// --- link reference definitions ------------------------------------------

// Skip spaces/tabs and single newlines (never a blank line). Returns
// the new index, or -1 when a blank line or the end is in the way.
function skipWs(src, i) {
  const n = src.length;
  for (;;) {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
    if (i < n && src[i] === '\n') {
      let k = i + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k >= n || src[k] === '\n') return -1;
      i = k;
      continue;
    }
    return i;
  }
}

// Try to parse a link reference definition at src[pos] (which starts a
// line, indented at most 3). Returns {label, href, title, end} or null.
function readDef(src, pos) {
  const n = src.length;
  let i = pos;
  while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
  if (i >= n || src[i] !== '[') return null;
  let j = i + 1;
  let label = '';
  while (j < n) {
    const c = src[j];
    if (c === '\\' && j + 1 < n) { label += src.slice(j, j + 2); j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') break;
    if (c === '\n') {
      let k = j + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k >= n || src[k] === '\n') return null;
      label += '\n';
      j++;
      continue;
    }
    label += c;
    j++;
  }
  if (j >= n || src[j] !== ']') return null;
  if (label.trim() === '') return null;
  let k = j + 1;
  if (src[k] !== ':') return null;
  k++;
  k = skipWs(src, k);
  if (k === -1 || k >= n) return null;
  let href;
  if (src[k] === '<') {
    let e = k + 1;
    while (e < n && src[e] !== '>' && src[e] !== '\n') {
      if (src[e] === '\\' && e + 1 < n) e += 2;
      else e++;
    }
    if (e >= n || src[e] !== '>') return null;
    href = src.slice(k + 1, e);
    k = e + 1;
  } else {
    let depth = 0;
    let e = k;
    while (e < n) {
      const c = src[e];
      if (c === '\\' && e + 1 < n) { e += 2; continue; }
      if (src.charCodeAt(e) <= 32) break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      e++;
    }
    if (e === k) return null;
    href = src.slice(k, e);
    k = e;
  }
  let title = null;
  // Optional title: on this line (after whitespace), or the next
  // non-blank line. The title must be separated from the destination
  // by whitespace; a title opener glued to the destination kills the
  // definition. If the title does not parse, or junk follows it, the
  // definition falls back to having no title.
  let m = k;
  let hadWs = false;
  while (m < n && (src[m] === ' ' || src[m] === '\t')) { m++; hadWs = true; }
  if (m < n && src[m] === '\n') {
    let p = m + 1;
    while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
    if (p < n && src[p] !== '\n' && (src[p] === '"' || src[p] === "'" || src[p] === '(')) {
      m = p;
      hadWs = true;
    }
  }
  let titleEnd = -1;
  if (m < n && (src[m] === '"' || src[m] === "'" || src[m] === '(')) {
    if (!hadWs) return null;
    const q = src[m];
    const close = q === '(' ? ')' : q;
    let e = m + 1;
    let ok = false;
    while (e < n) {
      const c = src[e];
      if (c === '\\' && e + 1 < n) { e += 2; continue; }
      if (c === close) { ok = true; break; }
      if (c === '\n') {
        let p = e + 1;
        while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
        if (p >= n || src[p] === '\n') break;
      }
      e++;
    }
    if (ok) {
      title = src.slice(m + 1, e);
      titleEnd = e + 1;
    }
  }
  let endPos = title !== null ? titleEnd : k;
  let mm = endPos;
  while (mm < n && (src[mm] === ' ' || src[mm] === '\t')) mm++;
  if (mm < n && src[mm] !== '\n') {
    if (title !== null) {
      title = null;
      mm = k;
      while (mm < n && (src[mm] === ' ' || src[mm] === '\t')) mm++;
      if (mm < n && src[mm] !== '\n') return null;
    } else {
      return null;
    }
  }
  return { label, href, title, end: mm };
}

// Try a definition starting at lines[i]. Returns the index of the first
// line after it, or -1. The definition is stored (first one wins).
function defLines(lines, i, defs) {
  if (indentOf(lines[i].txt) > 3) return -1;
  let text = '';
  let count = 0;
  for (let t = i; t < lines.length && count < 5; t++) {
    if (blankLine(lines[t].txt)) break;
    if (count > 0) text += '\n';
    text += lines[t].txt;
    count++;
  }
  if (count === 0) return -1;
  const d = readDef(text, 0);
  if (!d) return -1;
  const key = foldRef(d.label);
  if (!defs.has(key)) defs.set(key, { href: d.href, title: d.title });
  let used = 1;
  for (let p = 0; p < d.end && used <= count; p++) {
    if (text[p] === '\n') used++;
  }
  return i + used;
}

// --- simple block readers -------------------------------------------------

function readAtx(lines, i) {
  const info = atxOf(lines[i].txt);
  if (!info) return null;
  return { node: { ty: 'head', depth: info.depth, txt: info.txt }, next: i + 1 };
}

function readFence(lines, i) {
  const fi = fenceOf(lines[i].txt);
  if (!fi) return null;
  const closeRe = new RegExp('^' + (fi.ch === '`' ? '`' : '~') + '{' + fi.len + ',}[ \\t]*$');
  // Indent compensation only matches BACKTICK fences: a tilde fence's
  // content keeps its full indent; a backtick fence's content lines
  // lose up to as many leading whitespace CHARACTERS as the opening
  // fence line has (a tab counts as one character, not four columns).
  const fenceIndentLen = fi.ch === '`' ? /^[ \t]*/.exec(lines[i].txt)[0].length : 0;
  const stripFenceIndent = (line) => {
    if (fenceIndentLen === 0) return line;
    const m = /^[ \t]*/.exec(line);
    const leadLen = m ? m[0].length : 0;
    return line.slice(Math.min(leadLen, fenceIndentLen));
  };
  let content = '';
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j].txt;
    if (!blankLine(line)) {
      const ind = indentOf(line);
      if (ind <= 3 && closeRe.test(dropCols(line, ind))) {
        j++;
        break;
      }
    }
    content += stripFenceIndent(line) + '\n';
    j++;
  }
  const word = fi.info.trim().split(/\s+/, 1)[0] || '';
  const lang = word.replace(/\\([\p{P}\p{S}])/gu, '$1');
  // The content drops exactly one trailing newline when its last
  // line is blank (the content ends with a blank line, or is a
  // single blank line). A non-blank last line keeps its newline.
  if (content.endsWith('\n\n') || content === '\n') content = content.slice(0, -1);
  return { node: { ty: 'code', lang: lang === '' ? null : lang, txt: content }, next: j };
}

function readIndented(lines, i) {
  if (indentOf(lines[i].txt) < 4) return null;
  let content = '';
  let j = i;
  while (j < lines.length) {
    const line = lines[j].txt;
    if (blankLine(line)) {
      // Tentative: keep it only if more indented lines follow; a blank
      // line keeps its own (indent-stripped) spaces, like any line.
      let k = j + 1;
      while (k < lines.length && blankLine(lines[k].txt)) k++;
      if (k >= lines.length || indentOf(lines[k].txt) < 4) break;
      while (j < k) { content += dropCodeIndent(lines[j].txt) + '\n'; j++; }
      continue;
    }
    if (indentOf(line) < 4) break;
    content += dropCodeIndent(line) + '\n';
    j++;
  }
  return { node: { ty: 'code', lang: null, txt: content }, next: j };
}

// Strip trailing blank lines from an HTML block's text, keeping at most
// one trailing newline.
function trimHtmlTail(s) {
  const parts = s.split('\n');
  let t = parts.length - 1;
  while (t >= 0 && blankLine(parts[t])) t--;
  if (parts.length - t <= 2) return s;
  return parts.slice(0, t + 1).join('\n');
}

function readHtml(lines, i, srcEndsWithNL) {
  const type = htmlKind(lines[i].txt);
  if (!type) return null;
  if (type === 1) {
    const tag = /<([A-Za-z][A-Za-z0-9-]*)/.exec(lines[i].txt)[1].toLowerCase();
    const closeRe = new RegExp('</' + tag + '>', 'i');
    let endLine = -1;
    for (let j = i; j < lines.length; j++) {
      if (closeRe.test(lines[j].txt)) { endLine = j; break; }
    }
    if (endLine === -1) {
      let a = lines.slice(i).map((l) => l.txt).join('\n');
      if (srcEndsWithNL) a += '\n';
      return { node: { ty: 'html', txt: trimHtmlTail(a) }, next: lines.length };
    }
    // One trailing newline is kept unless the next line is a truly
    // empty blank line (a spaces-only blank line does not count).
    let keepNL;
    if (endLine === lines.length - 1) keepNL = srcEndsWithNL;
    else keepNL = lines[endLine + 1].txt !== '';
    let text = lines.slice(i, endLine + 1).map((l) => l.txt).join('\n');
    if (keepNL) text += '\n';
    return { node: { ty: 'html', txt: text }, next: endLine + 1 };
  }
  if (type >= 2 && type <= 5) {
    const marker = { 2: '-->', 3: '?>', 4: '>', 5: ']]>' }[type];
    let endLine = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j].txt.indexOf(marker) !== -1) { endLine = j; break; }
    }
    if (endLine === -1) {
      let a = lines.slice(i).map((l) => l.txt).join('\n');
      if (srcEndsWithNL) a += '\n';
      return { node: { ty: 'html', txt: trimHtmlTail(a) }, next: lines.length };
    }
    let keepNL;
    if (endLine === lines.length - 1) keepNL = srcEndsWithNL;
    else keepNL = lines[endLine + 1].txt !== '';
    let text = lines.slice(i, endLine + 1).map((l) => l.txt).join('\n');
    if (keepNL) text += '\n';
    return { node: { ty: 'html', txt: text }, next: endLine + 1 };
  }
  // Types 6 and 7: end at a blank line or the end.
  let j = i;
  while (j < lines.length && !blankLine(lines[j].txt)) j++;
  if (j < lines.length) {
    return { node: { ty: 'html', txt: lines.slice(i, j).map((l) => l.txt).join('\n') }, next: j };
  }
  let a = lines.slice(i).map((l) => l.txt).join('\n');
  if (srcEndsWithNL) a += '\n';
  return { node: { ty: 'html', txt: trimHtmlTail(a) }, next: lines.length };
}

// --- paragraph interruption ----------------------------------------------

// Whether a line starts a block that interrupts a paragraph. An
// ordered list only interrupts when it starts with 1 — except in a
// non-top context (a list item), where the paragraph is lexed line
// by line and any ordered item starts a list.
function breaksPara(line, top) {
  if (blankLine(line)) return false;
  if (atxOf(line) || fenceOf(line) || isRule(line)) return true;
  const ht = htmlKind(line);
  if (ht >= 1 && ht <= 6) return true;
  if (quoteOf(line) !== null) return true;
  const lm = markerOf(line);
  if (lm) {
    if (lm.empty) return false;
    if (lm.ordered && lm.start !== 1 && top !== false) return false;
    return true;
  }
  return false;
}

// Does this line leave a paragraph open after it (for lazy lines)? A
// line starting a block that interrupts a paragraph does not; a list
// marker leaves one open when its item starts with paragraph text.
function lineKeepsPara(line, wasOpen) {
  if (blankLine(line)) return false;
  if (atxOf(line) || fenceOf(line) || isRule(line)) return false;
  const ht = htmlKind(line);
  if (ht >= 1 && ht <= 6) return false;
  if (quoteOf(line) !== null) return false;
  // An indented-code line only continues a paragraph that is already
  // open; on its own it starts a code block, not a paragraph.
  if (indentOf(line) >= 4) return wasOpen;
  const lm = markerOf(line);
  if (lm) {
    if (lm.empty) return false;
    if (indentOf(lm.rest) >= 4) return false;
    if (atxOf(lm.rest) || fenceOf(lm.rest) || isRule(lm.rest)) return false;
    const ht2 = htmlKind(lm.rest);
    if (ht2 >= 1 && ht2 <= 6) return false;
    return true;
  }
  return true;
}

// Whether a paragraph is open after this line, looking through nested
// quotes and list items to the innermost content (a lazy line in an
// outer quote can continue a paragraph buried inside them).
function paraOpen(line, wasOpen) {
  let cur = line;
  for (;;) {
    const qs = quoteOf(cur);
    if (qs !== null) { cur = qs; continue; }
    const lm = markerOf(cur);
    if (lm) {
      if (lm.empty) return false;
      cur = lm.rest;
      continue;
    }
    break;
  }
  return lineKeepsPara(cur, wasOpen);
}

// --- block quote and list --------------------------------------------------

function readQuote(lines, i, defs, srcEndsWithNL) {
  if (quoteOf(lines[i].txt) === null) return null;
  const inner = [];
  let j = i;
  let open = false;
  let prevWasLazy = false;
  // Fence state in the inner text: a lazy line never continues a
  // fence (only a paragraph), so while a fence is open the quote
  // ends at the first lazy line.
  let fenceCh = null;
  let fenceLen = 0;
  while (j < lines.length) {
    const line = lines[j].txt;
    const stripped = quoteOf(line);
    if (stripped !== null) {
      inner.push({ txt: stripped, lazy: lines[j].lazy });
      if (fenceCh !== null) {
        // Inside a fence: a closing fence ends it; anything else
        // is fence content, never a paragraph.
        const ind = indentOf(stripped);
        const closeRe = new RegExp('^' + (fenceCh === '`' ? '`' : '~') + '{' + fenceLen + ',}[ \\t]*$');
        if (!blankLine(stripped) && ind <= 3 && closeRe.test(dropCols(stripped, ind))) {
          fenceCh = null;
        }
        open = false;
      } else {
        const fi = fenceOf(stripped);
        if (fi) { fenceCh = fi.ch; fenceLen = fi.len; open = false; }
        else open = paraOpen(stripped, open);
      }
      prevWasLazy = false;
      j++;
      continue;
    }
    if (blankLine(line)) break;
    if (open && !breaksPara(line, true)) {
      // A lazy setext line that follows another lazy line is indented
      // by four spaces, so it cannot form a heading.
      let text = line;
      if (prevWasLazy && setextOf(line) > 0) {
        text = '    ' + dropCols(line, indentOf(line));
      }
      inner.push({ txt: text, lazy: true });
      open = true;
      prevWasLazy = true;
      j++;
      continue;
    }
    break;
  }
  // The inner text ends with a newline only when its last line is an
  // exactly empty line (a lone '>' line): drop it and record the
  // newline, so the inner text is preserved exactly. A line of spaces
  // is paragraph content, not a blank line to drop.
  let innerEndsNL = false;
  if (inner.length > 0 && inner[inner.length - 1].txt === '') {
    inner.pop();
    innerEndsNL = true;
  }
  const sub = lexBlocks(inner, defs, innerEndsNL, true);
  return { node: { ty: 'quote', kids: sub.nodes }, next: j };
}

function readList(lines, i, defs, srcEndsWithNL) {
  const first = markerOf(lines[i].txt);
  if (!first) return null;
  const ordered = first.ordered;
  const bullet = first.bullet;
  const delim = first.delim;
  const items = [];
  let spacious = false;
  let j = i;
  while (j < lines.length) {
    const mk = markerOf(lines[j].txt);
    if (!mk) break;
    if (mk.ordered !== ordered) break;
    if (ordered ? mk.delim !== delim : mk.bullet !== bullet) break;
    const contentCols = mk.contentCols;
    const itemLines = [{ txt: mk.rest, lazy: false }];
    let open = !mk.empty && paraOpen(mk.rest, false);
    j++;
    let pendingBlanks = 0;
    while (j < lines.length) {
      const line = lines[j].txt;
      if (blankLine(line)) { pendingBlanks++; j++; continue; }
      // An empty item does not continue past a blank line; the blank
      // line separates it from the next item, so the list is loose.
      if (mk.empty && pendingBlanks > 0) { spacious = true; break; }
      // A line indented to the item's content level belongs to this
      // item (a nested list), even if it looks like a list item.
      if (indentOf(line) >= contentCols) {
        for (let b = 0; b < pendingBlanks; b++) itemLines.push({ txt: '', lazy: false });
        pendingBlanks = 0;
        const stripped = dropItemIndent(line, contentCols);
        itemLines.push({ txt: stripped, lazy: lines[j].lazy });
        open = paraOpen(stripped, open);
        j++;
        continue;
      }
      const nm = markerOf(line);
      // A list marker of a different kind (other bullet, other
      // delimiter) ends this list; a new list starts there.
      if (nm && (nm.ordered !== ordered || (ordered ? nm.delim !== delim : nm.bullet !== bullet))) break;
      // A line that is both a list item and a thematic break ends the
      // list; the break is parsed as its own block.
      if (nm && nm.ordered === ordered && (ordered ? nm.delim === delim : nm.bullet === bullet)
        && !isRule(line)) {
        if (pendingBlanks > 0) spacious = true;
        break;
      }
      if (open && pendingBlanks === 0 && !breaksPara(line, false)) {
        itemLines.push({ txt: line, lazy: true });
        open = true;
        j++;
        continue;
      }
      break;
    }
    while (itemLines.length > 0 && blankLine(itemLines[itemLines.length - 1].txt)) itemLines.pop();
    // Blank lines that did not separate two items of this list are
    // not consumed: leave them for the enclosing block parser (a
    // blank line inside a list item, before a paragraph, is what
    // makes the list loose).
    if (pendingBlanks > 0) {
      const nmAtJ = j < lines.length ? markerOf(lines[j].txt) : null;
      const isNewItem = nmAtJ && nmAtJ.ordered === ordered
        && (ordered ? nmAtJ.delim === delim : nmAtJ.bullet === bullet)
        && !isRule(lines[j].txt);
      if (!isNewItem) {
        j -= pendingBlanks;
        pendingBlanks = 0;
      }
    }
    // Trailing blank lines are dropped, so the item text never ends
    // with a newline.
    const sub = lexBlocks(itemLines, defs, false, false);
    if (sub.blankSep) spacious = true;
    items.push({ parts: sub.nodes });
    if (j >= lines.length) break;
    const nm2 = markerOf(lines[j].txt);
    if (!nm2 || nm2.ordered !== ordered || (ordered ? nm2.delim !== delim : nm2.bullet !== bullet)
      || isRule(lines[j].txt)) break;
  }
  if (items.length === 0) return null;
  return { node: { ty: 'list', ordered, start: first.start, entries: items, spacious }, next: j };
}

// --- tables ---------------------------------------------------------------

// Split a table row line into cells on unescaped '|', dropping optional
// outer pipes. Backslash escapes are kept for inline parsing.
function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) {
    let bs = 0;
    let p = s.length - 2;
    while (p >= 0 && s[p] === '\\') { bs++; p--; }
    if (bs % 2 === 0) s = s.slice(0, -1);
  }
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += s.slice(i, i + 2); i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  // The cell split unescapes \|; every other escape is left for the
  // inline parser.
  return cells.map((cell) => cell.replace(/\\\|/g, '|'));
}

// Is this line a table-delimiter line that contains a pipe? Such a line
// in a paragraph blocks a setext heading.
function pipeDelimLine(line) {
  const ind = indentOf(line);
  if (ind > 3) return false;
  const s = dropCols(line, ind);
  return /^\|?(?:[:\- ]*\|)+[:\- ]*$/.test(s);
}

// Does this line match the table-delimiter pattern (the regex part,
// before the :/| check)? At most 3 spaces of indent, then dash cells
// separated by pipes, with optional outer pipes.
function delimPattern(line) {
  const ind = indentOf(line);
  if (ind > 3) return false;
  const s = dropCols(line, ind);
  return /^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(s);
}

// A real table delimiter: the pattern, and it must contain a ':' or a
// '|' (a bare '---' is a setext line).
function tableDelim(line) {
  if (!delimPattern(line)) return false;
  const ind = indentOf(line);
  const s = dropCols(line, ind);
  return s.indexOf(':') !== -1 || s.indexOf('|') !== -1;
}

// Do lines[k] and lines[k+1] form a table header plus delimiter? A
// paragraph stops before such a line.
function tableStarts(lines, k) {
  if (k + 1 >= lines.length) return false;
  if (blankLine(lines[k].txt)) return false;
  return delimPattern(lines[k + 1].txt);
}

// Table info for a paragraph whose second line is a delimiter, or null.
function tableOf(plines) {
  if (plines.length < 2) return null;
  if (!tableDelim(plines[1].txt)) return null;
  const head = splitCells(plines[0].txt);
  const delim = splitCells(plines[1].txt);
  if (head.length !== delim.length) return null;
  const aligns = delim.map((cell) => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.startsWith(':')) return 'left';
    if (cell.endsWith(':')) return 'right';
    return null;
  });
  return { head, aligns };
}

function makeTable(ti, plines) {
  const rows = [];
  for (let r = 2; r < plines.length; r++) {
    const cells = splitCells(plines[r].txt);
    while (cells.length < ti.head.length) cells.push('');
    rows.push(cells.slice(0, ti.head.length));
  }
  return { ty: 'table', aligns: ti.aligns, head: ti.head, rows };
}

// Does this line end a table body? An empty list item counts here.
// An indented-code line needs a character after the indent; a
// tab-only line has none, so it is a table row, not a code line.
function indentedCodeLine(line) {
  if (line.startsWith('    ')) return line.length > 4;
  const m = /^[ ]{0,3}\t/.exec(line);
  if (m) return line.length > m[0].length;
  return false;
}

function tableStops(line) {
  if (isRule(line) || atxOf(line) || fenceOf(line)) return true;
  if (quoteOf(line) !== null) return true;
  const ht = htmlKind(line);
  if (ht >= 1 && ht <= 6) return true;
  if (indentedCodeLine(line)) return true;
  const lm = markerOf(line);
  if (lm && (!lm.ordered || lm.start === 1)) return true;
  return false;
}

// --- paragraph -------------------------------------------------------------

function readPara(lines, i, defs, top, srcEndsWithNL) {
  let j = i;
  for (;;) {
    const d = defLines(lines, j, defs);
    if (d === -1) break;
    j = d;
  }
  if (j >= lines.length) return { node: null, next: j };
  const line0 = lines[j].txt;
  if (blankLine(line0)) return { node: null, next: j };
  if (atxOf(line0) || fenceOf(line0) || isRule(line0)
    || (htmlKind(line0) >= 1 && htmlKind(line0) <= 6)
    || quoteOf(line0) !== null || markerOf(line0) || indentOf(line0) >= 4) {
    return { node: null, next: j };
  }
  // A continuation line that sits in a non-top context (a list item)
  // is lexed line by line: a line with an indent of 4 or more loses
  // one indented-code prefix. In a top context, lazy lines come in
  // chunks: a chunk whose first line is indented is a code chunk, so
  // every line in it loses the prefix; a chunk that starts with a
  // plain line keeps every line's indent verbatim. Top-level and
  // blockquote-marker lines keep their indent verbatim.
  let lazyChunkCode = false;
  const contText = (line, lazy, prevLazy) => {
    if (!top) {
      if (indentOf(line) >= 4) return dropCodeIndent(line);
      return line;
    }
    if (!lazy) return line;
    if (!prevLazy) lazyChunkCode = indentOf(line) >= 4;
    if (lazyChunkCode) return dropCodeIndent(line);
    return line;
  };
  const prevLazyAt = (k) => k > j && lines[k - 1].lazy;
  const plines = [lines[j]];
  let k = j + 1;
  while (k < lines.length) {
    const line = lines[k].txt;
    if (blankLine(line)) {
      // In a table, the body blank check is ` *\n` (spaces only):
      // a tab-only line is a row of empty cells, not a blank line.
      const ti0 = tableOf(plines);
      if (ti0 && !/^ *$/.test(line) && !tableStops(line)) {
        plines.push(lines[k]);
        k++;
        continue;
      }
      // A trailing line of only spaces, with no newline after it, is
      // paragraph text (the blank-line lookahead needs a newline
      // after the spaces); any other blank line ends the paragraph.
      if (k === lines.length - 1 && !srcEndsWithNL) {
        plines.push({ txt: line, lazy: lines[k].lazy });
        k++;
      }
      break;
    }
    const st = setextOf(line);
    if (st) {
      const ti = tableOf(plines);
      if (ti) {
        // The paragraph is a table: an HR line ends it, any other
        // setext line is a table row.
        if (isRule(line)) return { node: makeTable(ti, plines), next: k };
        plines.push(lines[k]);
        k++;
        continue;
      }
      // A setext heading is blocked when the paragraph text contains
      // a pipe-delimiter line: the line is plain paragraph text.
      if (plines.some((l) => pipeDelimLine(l.txt))) {
        plines.push({ txt: contText(line, lines[k].lazy, prevLazyAt(k)), lazy: lines[k].lazy });
        k++;
        continue;
      }
      if (lines[k].lazy) { plines.push({ txt: contText(line, true, prevLazyAt(k)), lazy: true }); k++; continue; }
      return {
        node: { ty: 'head', depth: st, txt: plines.map((l) => l.txt).join('\n').trim() },
        next: k + 1,
      };
    }
    const ti = tableOf(plines);
    if (ti) {
      if (tableStops(line)) break;
      plines.push(lines[k]);
      k++;
      continue;
    }
    if (breaksPara(line, top)) break;
    // A delimiter line with matching cell counts makes this a table.
    if (plines.length === 1 && tableDelim(line)
      && splitCells(plines[0].txt).length === splitCells(line).length) {
      plines.push(lines[k]);
      k++;
      continue;
    }
    // A line that starts a table (header plus delimiter) ends the
    // paragraph; the table is parsed as its own block — unless a
    // setext line follows and the heading text is valid, in which
    // case the lheading rule wins.
    if (tableStarts(lines, k)) {
      const st2 = k + 1 < lines.length ? setextOf(lines[k + 1].txt) : 0;
      if (st2 && !plines.some((l) => pipeDelimLine(l.txt)) && !pipeDelimLine(line)) {
        plines.push({ txt: contText(line, lines[k].lazy, prevLazyAt(k)), lazy: lines[k].lazy });
        k++;
        continue;
      }
      break;
    }
    plines.push({ txt: contText(line, lines[k].lazy, prevLazyAt(k)), lazy: lines[k].lazy });
    k++;
  }
  const ti = tableOf(plines);
  if (ti) return { node: makeTable(ti, plines), next: k };
  return { node: { ty: 'para', lines: plines.map((l) => l.txt) }, next: k };
}

// --- main block lexer -------------------------------------------------------

function lexBlocks(lines, defs, srcEndsWithNL, top) {
  const nodes = [];
  let blankSep = false;
  let sawBlank = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].txt;
    if (blankLine(line)) {
      if (nodes.length > 0) sawBlank = true;
      i++;
      continue;
    }
    const d = defLines(lines, i, defs);
    if (d !== -1) {
      // A definition is not a block, but a blank line before one still
      // separates blocks inside a list item (it makes the list loose).
      if (sawBlank) blankSep = true;
      i = d;
      continue;
    }
    let r = readAtx(lines, i);
    if (!r) r = readFence(lines, i);
    if (!r) r = readIndented(lines, i);
    if (!r && isRule(line)) r = { node: { ty: 'rule' }, next: i + 1 };
    if (!r) r = readHtml(lines, i, srcEndsWithNL);
    if (!r) r = readQuote(lines, i, defs, srcEndsWithNL);
    if (!r) r = readList(lines, i, defs, srcEndsWithNL);
    if (!r) r = readPara(lines, i, defs, top, srcEndsWithNL);
    if (!r || !r.node) {
      i = r && r.next > i ? r.next : i + 1;
      continue;
    }
    if (sawBlank) blankSep = true;
    sawBlank = false;
    nodes.push(r.node);
    i = r.next;
  }
  return { nodes, blankSep };
}

// --- inline: link labels ---------------------------------------------------
//
// Inline pieces (atoms) are plain objects; ty is one of:
//   'text'  {txt, esc?}        raw text run (esc = escaped &, keep apart)
//   'code'  {txt}              code span content (newlines -> spaces)
//   'br'                      hard line break
//   'raw'   {txt}              raw inline HTML
//   'link'  {href, title, kids, raw?}   raw = autolink, href kept verbatim
//   'img'   {href, title, alt}
//   'delim' {mark, run, whole, canOpen, canClose}  emphasis / strike run
//   'em' | 'strong' | 'del'  {kids}

// Find the end of a link label starting at src[i] === '[' (the complex
// rules: nested brackets, escapes, code spans). Returns the index just
// past the matching ']', or -1. A ']' inside a code span does not close
// the label; a backtick run with no closing run makes the whole label
// invalid, unless the run sits right before the closing ']'.
function labelClose(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\' && j + 1 < src.length) { j++; continue; }
    if (c === '`') {
      let run = 1;
      while (j + run < src.length && src[j + run] === '`') run++;
      // A run of 2+ backticks immediately before ']' is literal
      // text in a label, not a code-span opener: do not scan past
      // the ']' for a closer.
      if (run >= 2 && src[j + run] === ']') { j += run - 1; continue; }
      // The closing run is the first backtick run after this one —
      // the span's content may hold ']' characters, so the scan does
      // not stop at a ']'.
      let k = j + run;
      let closed = -1;
      while (k < src.length) {
        if (src[k] === '`') {
          let r = 1;
          while (k + r < src.length && src[k + r] === '`') r++;
          closed = k + r;
          break;
        }
        k++;
      }
      if (closed === -1) {
        // no closing run: valid only if the run sits right before ']'
        if (src[j + run] === ']') { j += run - 1; continue; }
        return -1;
      }
      j = closed - 1;
      continue;
    }
    if (c === '[') { depth++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

// Like labelClose, but code spans pair by MATCHING backtick-run length.
// A label that is invalid in the original source can be valid in the
// masked source, and marked's blockSkip then masks the whole
// [label](...) as a link, hiding the _/* inside it from emphasis.
// Returns the position after the closing ']', or -1.
function labelCloseMasked(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\' && j + 1 < src.length) { j++; continue; }
    if (c === '`') {
      let run = 1;
      while (j + run < src.length && src[j + run] === '`') run++;
      // The closing run is the next run of the SAME length; shorter
      // runs in between are inner backticks and ']' characters are
      // span content.
      let k = j + run;
      let closed = -1;
      while (k < src.length) {
        if (src[k] === '`') {
          let r = 1;
          while (k + r < src.length && src[k + r] === '`') r++;
          if (r === run) { closed = k + r; break; }
          k += r;
          continue;
        }
        k++;
      }
      if (closed === -1) {
        if (run >= 2 && src[j + run] === ']') { j += run - 1; continue; }
        return -1;
      }
      j = closed - 1;
      continue;
    }
    if (c === '[') { depth++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

// If the '[' at src[i] starts a link that is valid in marked's masked
// source (label valid per labelCloseMasked, followed by an inline
// (...) or a [ref]), return the label span and the link end; otherwise
// null. Used to suppress emphasis inside a link whose label is invalid
// in the original source but valid when masked.
function maskedLinkSpan(src, i) {
  const labelEnd = labelCloseMasked(src, i);
  if (labelEnd === -1) return null;
  if (src[labelEnd] === '(') {
    const p = readParens(src, labelEnd);
    if (p) return { labelStart: i + 1, labelEnd: labelEnd - 1, end: p.end };
    // readParens may reject a malformed href; a closing ')' still
    // marks the end of the failed link attempt.
    let depth = 0;
    for (let j = labelEnd; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) return { labelStart: i + 1, labelEnd: labelEnd - 1, end: j + 1 }; }
      else if (src[j] === '\n') {
        let k = j + 1;
        while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
        if (k >= src.length || src[k] === '\n') return null;
      }
    }
    return null;
  }
  return null;
}

// Parse "(dest title)" / "(<dest> title)" after a link text or label.
// src[k] === '('. Returns {href, title, end} or null; end is just past ')'.
function readParens(src, k) {
  let i = k + 1;
  const n = src.length;
  let j = i;
  while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
  if (j < n && src[j] === '\n') {
    let m = j + 1;
    while (m < n && (src[m] === ' ' || src[m] === '\t')) m++;
    if (m < n && src[m] !== '\n') j = m;
  }
  i = j;
  if (i >= n) return null;
  let href = '';
  if (src[i] === '<') {
    let e = i + 1;
    while (e < n && src[e] !== '>' && src[e] !== '\n') {
      if (src[e] === '\\' && e + 1 < n) e += 2;
      else e++;
    }
    if (e >= n || src[e] !== '>') return null;
    href = src.slice(i + 1, e);
    i = e + 1;
  } else if (src[i] === ')') {
    href = '';
  } else {
    let depth = 0;
    let e = i;
    while (e < n) {
      const c = src[e];
      if (c === '\\' && e + 1 < n) { e += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '\0') break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      e++;
    }
    if (e === i) return null;
    href = src.slice(i, e);
    i = e;
  }
  // optional title
  let title = null;
  let m = i;
  while (m < n && (src[m] === ' ' || src[m] === '\t')) m++;
  let hadSpace = m > i;
  if (m < n && src[m] === '\n') {
    let p = m + 1;
    while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
    if (p < n && src[p] !== '\n' && (src[p] === '"' || src[p] === "'" || src[p] === '(')) {
      hadSpace = true;
      m = p;
    }
  }
  if (hadSpace && m < n && (src[m] === '"' || src[m] === "'" || src[m] === '(')) {
    const q = src[m];
    const close = q === '(' ? ')' : q;
    let e = m + 1;
    let ok = false;
    while (e < n) {
      const c = src[e];
      if (c === '\\' && e + 1 < n) { e += 2; continue; }
      if (c === close) { ok = true; break; }
      if (q !== '"' && c === '\n' && src[e + 1] === '\n') break;
      e++;
    }
    if (!ok) return null;
    title = src.slice(m + 1, e);
    m = e + 1;
  }
  while (m < n && (src[m] === ' ' || src[m] === '\t')) m++;
  if (m < n && src[m] === '\n') {
    let p = m + 1;
    while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
    if (p < n && src[p] === ')') m = p;
  }
  if (m >= n || src[m] !== ')') return null;
  return { href, title, end: m + 1 };
}

// Does this text contain a link (inline or reference) that would
// resolve? marked rejects an outer link whose text contains one: the
// inner link wins and the outer brackets stay literal.
function labelHasInnerLink(text, defs) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) { i++; continue; }
    if (c === '`') {
      let run = 1;
      while (i + run < text.length && text[i + run] === '`') run++;
      let k = i + run;
      let closed = -1;
      while (k < text.length) {
        if (text[k] === '`') {
          let r = 1;
          while (k + r < text.length && text[k + r] === '`') r++;
          if (r === run) { closed = k + r; break; }
          k += r;
        } else k++;
      }
      if (closed === -1) return false;
      i = closed - 1;
      continue;
    }
    if (c === '[') {
      const isImg = i > 0 && text[i - 1] === '!';
      const end = labelClose(text, i);
      if (end === -1) continue;
      const inner = text.slice(i + 1, end - 1);
      if (labelHasInnerLink(inner, defs)) return true;
      let skipTo = end;
      if (text[end] === '(') {
        const p = readParens(text, end);
        if (!isImg && p) return true;
        if (p) skipTo = p.end;
      } else if (text[end] === '[') {
        const le = labelClose(text, end);
        if (le !== -1) {
          if (!isImg) {
            const lab = le === end + 2 ? inner : text.slice(end + 1, le - 1);
            if (defs.has(foldRef(lab))) return true;
          }
          skipTo = le;
        }
      } else if (!isImg) {
        if (defs.has(foldRef(inner))) return true;
      }
      i = skipTo - 1;
    }
  }
  return false;
}

// marked's rule: a link text holding a <tag> or <autolink> that runs
// past the end of the label kills the outer link. src is the full
// inline source, labelStart the offset of the label, label the text.
function labelHasRunaway(src, labelStart, label) {
  if (label.indexOf('<') === -1) return false;
  const labelEnd = labelStart + label.length;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\' && s + 1 < label.length) { s++; continue; }
    if (label[s] === '`') {
      const m = /^(?:`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const at = labelStart + s;
    const rest = src.slice(at);
    const m = AUTO_RE.exec(rest) || TAG_OPEN_RE.exec(rest) || TAG_CLOSE_RE.exec(rest)
      || COMMENT_RE.exec(rest) || PI_RE.exec(rest) || DECL_RE.exec(rest) || CDATA_RE.exec(rest);
    if (m && at + m[0].length > labelEnd) return true;
  }
  return false;
}

// Try to parse a link or image starting at src[i] === '['.
// Returns {atom, end} or null. end is just past the whole construct.
function readLink(src, i, defs, isImage, inLink) {
  const end = labelClose(src, i);
  if (end === -1) return null;
  const label = src.slice(i + 1, end - 1);
  let href = null;
  let title = null;
  let after = end;
  let matched = false;
  if (src[end] === '(') {
    const p = readParens(src, end);
    if (p) {
      href = p.href;
      title = p.title;
      after = p.end;
      matched = true;
    }
    // If the inline link does not parse, the label may still be a
    // shortcut reference link (fall through to the shortcut below).
  } else if (src[end] === '[') {
    const le = labelClose(src, end);
    if (le === -1) return null;
    const lab = le === end + 2 ? label : src.slice(end + 1, le - 1);
    const def = defs.get(foldRef(lab));
    if (!def) return null;
    href = def.href;
    title = def.title;
    after = le;
    matched = true;
    // A full reference link that does not resolve is not a link at
    // all; it does not fall back to the shortcut.
  }
  if (!matched) {
    const def = defs.get(foldRef(label));
    if (!def) return null;
    href = def.href;
    title = def.title;
  }
  if (!isImage) {
    if (labelHasInnerLink(label, defs)) return null;
    if (labelHasRunaway(src, i + 1, label)) return null;
  }
  const kids = scanText(label, defs, true);
  // Emphasis inside link and image text resolves within the label.
  settleDelims(kids);
  if (isImage) {
    return { atom: { ty: 'img', href, title, alt: flatText(kids) }, end: after };
  }
  return { atom: { ty: 'link', href, title, kids }, end: after };
}

// --- flanking rules --------------------------------------------------------

// The code point ending just before i, and the one starting at i.
function prevCp(src, i) {
  if (i <= 0) return '';
  let j = i - 1;
  if (j > 0 && src.charCodeAt(j) >= 0xdc00 && src.charCodeAt(j) <= 0xdfff
    && src.charCodeAt(j - 1) >= 0xd800 && src.charCodeAt(j - 1) <= 0xdbff) j--;
  return src.slice(j, i);
}
function nextCp(src, i) {
  if (i >= src.length) return '';
  let j = i + 1;
  if (j < src.length && src.charCodeAt(i) >= 0xd800 && src.charCodeAt(i) <= 0xdbff
    && src.charCodeAt(j) >= 0xdc00 && src.charCodeAt(j) <= 0xdfff) j++;
  return src.slice(i, j);
}

// Left/right flanking of a delimiter run starting at i with length len.
function flankOf(src, i, len) {
  const before = prevCp(src, i);
  const after = nextCp(src, i + len);
  const beforeWs = before === '' || strIsSpace(before);
  const afterWs = after === '' || strIsSpace(after);
  const beforePunct = strIsPunct(before);
  const afterPunct = strIsPunct(after);
  return {
    leftFlank: !afterWs && (!afterPunct || beforeWs || beforePunct),
    rightFlank: !beforeWs && (!beforePunct || afterWs || afterPunct),
    beforePunct,
    afterPunct,
  };
}

// --- extended autolinks ----------------------------------------------------

function wwwOkBefore(src, i) {
  if (i === 0) return true;
  const p = src[i - 1];
  return p === ' ' || p === '\t' || p === '\n' || p === '(' || p === '_' || p === '*' || p === '~' || p === '>';
}

function urlTail(src, i) {
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '<') break;
    j++;
  }
  return src.slice(i, j);
}

// Trim the end of an extended autolink (www. / http(s):// / ftp://).
// marked's backpedal: keep trimming until stable. A URL may not end in
// punctuation, in an unbalanced ')', inside a paren group, or inside a
// trailing &word; entity.
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

function trimUrlEnd(url) {
  let end = url;
  let prev;
  do {
    prev = end;
    const m = BACKPEDAL_RE.exec(end);
    end = m ? m[0] : '';
  } while (end !== prev);
  return end;
}

// Sticky (y-flag) copies of the anchored patterns above, so the scanner
// can match them at a position inside the full source without slicing.
function stickyOf(re, flags) {
  return new RegExp(re.source.slice(1), flags);
}
const AUTO_Y = stickyOf(AUTO_RE, 'y');
const TAG_OPEN_Y = stickyOf(TAG_OPEN_RE, 'y');
const TAG_CLOSE_Y = stickyOf(TAG_CLOSE_RE, 'y');
const COMMENT_Y = stickyOf(COMMENT_RE, 'y');
const PI_Y = stickyOf(PI_RE, 'y');
const DECL_Y = stickyOf(DECL_RE, 'y');
const CDATA_Y = stickyOf(CDATA_RE, 'y');
// GFM extended-autolink email domain: labels may hold _ and -, must end
// in an alnum, and must not be followed by a word char or -.
const GFM_DOMAIN_RE = /^[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![A-Za-z0-9_-])/;
// The same domain without the trailing lookahead, for bare emails
// whose domain is followed by an emphasis delimiter run (`__`, `**`)
// that will be consumed as emphasis: the lookahead would reject the
// full domain, but the delimiter is not part of it.
const GFM_DOMAIN_NOLOOK_RE = /^[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+/;
const GFM_DOMAIN_Y = stickyOf(GFM_DOMAIN_RE, 'y');
const GFM_DOMAIN_NOLOOK_Y = stickyOf(GFM_DOMAIN_NOLOOK_RE, 'y');
const PROTO_Y = stickyOf(/^(?:https?|ftp):\/\//i, 'iy');
const MAILTO_Y = stickyOf(/^mailto:([A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![A-Za-z0-9_-]))/, 'y');
const XMPP_Y = stickyOf(/^xmpp:([A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![A-Za-z0-9_-])(?:\/[A-Za-z0-9@.]+)?)/, 'y');
const EMAIL_LOCAL_WIDE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
const EMAIL_LOCAL_NARROW = /[A-Za-z0-9._+-]/;

// Document-level inLink state: an unclosed inline `<a ...>` tag sets
// it, a `</a>` clears it, and it persists across blocks for the rest of
// the document. While it is set, bare-email and bare-URL autolinks are
// suppressed. `<...>` autolinks and explicit `[text](url)` links are
// NOT suppressed. It is reset at the start of every parse() call.
// Tags inside a link's text never touch it (marked saves and restores
// it around link text).
let linkOpen = false;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;

// Bulk skip for the inline scanner: the next spot where anything can
// happen — a structural char, an @ (bare email), a newline (hard
// break), or the start of a www. / scheme / mailto: / xmpp: autolink.
// The plain-text path jumps straight there instead of stepping a
// character at a time.
const NEXT_INTERESTING = /[\\`<!\[*_~@\n]|https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:/gi;

function readWww(src, i) {
  const raw = urlTail(src, i);
  const trimmed = trimUrlEnd(raw);
  if (trimmed.length <= 4) return null;
  return { href: 'http://' + trimmed, text: trimmed, end: i + trimmed.length };
}

function readScheme(src, i) {
  PROTO_Y.lastIndex = i;
  const pm = PROTO_Y.exec(src);
  if (!pm) return null;
  const raw = urlTail(src, i);
  const trimmed = trimUrlEnd(raw);
  if (trimmed.length <= pm[0].length) return null;
  return { href: trimmed, text: trimmed, end: i + trimmed.length };
}

// Ranges of code spans as marked's masking pass pairs them: a stray
// backtick run that forms no code span is consumed as a bare run, so a
// later backtick can pair with an even later one across a link boundary.
const MASK_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/gu;
function maskedSpansOf(src) {
  const ranges = [];
  MASK_CODE_RE.lastIndex = 0;
  let m;
  while ((m = MASK_CODE_RE.exec(src)) !== null) {
    if (m[1]) ranges.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) MASK_CODE_RE.lastIndex++;
  }
  return ranges;
}

function scanText(src, defs, inLink) {
  const atoms = [];
  let text = '';
  // Index in `text` where the current plain-text run starts. A
  // backslash-escaped character breaks the run, so a bare-email
  // autolink can never span an escape (e.g. `foo\+@bar` is no email).
  let plainStart = 0;
  const n = src.length;
  let i = 0;
  // marked masks code spans before scanning for emphasis, and that
  // pairing can join a stray backtick inside a link to a later code
  // span's backtick, hiding the emphasis between them. Suppress
  // emphasis delimiters that fall inside such a masked code span.
  const maskedSpans = src.includes('`') ? maskedSpansOf(src) : null;
  const inMaskedSpan = (pos) => {
    if (!maskedSpans) return false;
    for (let s = 0; s < maskedSpans.length; s++) {
      const r = maskedSpans[s];
      if (pos >= r[0] && pos < r[1]) return true;
      if (r[0] > pos) break;
    }
    return false;
  };
  // Label spans of links that are valid only in marked's masked
  // source: emphasis delimiters inside them are literal text.
  const noEmRanges = [];
  const inNoEmRange = (pos) => {
    for (let s = 0; s < noEmRanges.length; s++) {
      const r = noEmRanges[s];
      if (pos >= r[0] && pos < r[1]) return true;
      if (r[0] > pos) break;
    }
    return false;
  };
  const flush = () => {
    if (text !== '') { atoms.push({ ty: 'text', txt: text }); text = ''; }
    plainStart = 0;
  };
  while (i < n) {
    if (!inLink && !linkOpen) {
      if (src[i] === 'w' && src.startsWith('www.', i) && wwwOkBefore(src, i)) {
        const u = readWww(src, i);
        if (u) {
          flush();
          atoms.push({ ty: 'link', href: u.href, title: null, raw: true, kids: [{ ty: 'text', txt: u.text }] });
          i = u.end;
          continue;
        }
      }
      const ch0 = src[i];
      if (ch0 === 'h' || ch0 === 'H' || ch0 === 'f' || ch0 === 'F') {
        const u = readScheme(src, i);
        if (u) {
          flush();
          atoms.push({ ty: 'link', href: u.href, title: null, raw: true, kids: [{ ty: 'text', txt: u.text }] });
          i = u.end;
          continue;
        }
      }
      if (ch0 === 'm' && src.startsWith('mailto:', i)) {
        MAILTO_Y.lastIndex = i;
        const mm = MAILTO_Y.exec(src);
        if (mm) {
          flush();
          atoms.push({ ty: 'link', href: mm[0], title: null, raw: true, kids: [{ ty: 'text', txt: mm[0] }] });
          i += mm[0].length;
          continue;
        }
      }
      if (ch0 === 'x' && src.startsWith('xmpp:', i)) {
        XMPP_Y.lastIndex = i;
        const mm = XMPP_Y.exec(src);
        if (mm) {
          flush();
          atoms.push({ ty: 'link', href: mm[0], title: null, raw: true, kids: [{ ty: 'text', txt: mm[0] }] });
          i += mm[0].length;
          continue;
        }
      }
    }
    const c = src[i];
    if (c === '`') {
      let run = 1;
      while (i + run < n && src[i + run] === '`') run++;
      let k = i + run;
      let closed = -1;
      while (k < n) {
        if (src[k] === '`') {
          let r = 1;
          while (k + r < n && src[k + r] === '`') r++;
          if (r === run) { closed = k; break; }
          k += r;
        } else k++;
      }
      if (closed === -1) {
        text += src.slice(i, i + run);
        i += run;
        continue;
      }
      let content = src.slice(i + run, closed).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      atoms.push({ ty: 'code', txt: content });
      i = closed + run;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < n && src[i + 1] === '\n') {
        flush();
        atoms.push({ ty: 'br' });
        i += 2;
        // A hard break swallows the next line's leading spaces/tabs.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (i + 1 < n && asciiPunctCh(src[i + 1])) {
        const ch = src[i + 1];
        if (ch === '&') {
          // An escaped & is a literal &, never an entity: keep it in
          // its own atom so the entity check cannot see past it.
          flush();
          atoms.push({ ty: 'text', txt: '&', esc: true });
        } else {
          text += ch;
          plainStart = text.length;
        }
        i += 2;
        continue;
      }
      text += '\\';
      i++;
      continue;
    }
    if (c === '<') {
      AUTO_Y.lastIndex = i;
      const am = AUTO_Y.exec(src);
      if (am) {
        const inner = am[1];
        const isEmail = inner.indexOf(':') === -1;
        flush();
        atoms.push({
          ty: 'link',
          href: isEmail ? 'mailto:' + inner : inner,
          title: null,
          raw: true,
          kids: [{ ty: 'text', txt: inner }],
        });
        i += am[0].length;
        continue;
      }
      let hm = null;
      COMMENT_Y.lastIndex = i; hm = COMMENT_Y.exec(src);
      if (!hm) { PI_Y.lastIndex = i; hm = PI_Y.exec(src); }
      if (!hm) { CDATA_Y.lastIndex = i; hm = CDATA_Y.exec(src); }
      if (!hm) { DECL_Y.lastIndex = i; hm = DECL_Y.exec(src); }
      if (!hm) { TAG_CLOSE_Y.lastIndex = i; hm = TAG_CLOSE_Y.exec(src); }
      if (!hm) { TAG_OPEN_Y.lastIndex = i; hm = TAG_OPEN_Y.exec(src); }
      if (hm) {
        flush();
        atoms.push({ ty: 'raw', txt: hm[0] });
        if (!inLink) {
          // An inline <a ...> tag opens the document-level inLink
          // state; a </a> tag closes it.
          if (!linkOpen && START_A_TAG.test(hm[0])) linkOpen = true;
          else if (linkOpen && END_A_TAG.test(hm[0])) linkOpen = false;
        }
        i += hm[0].length;
        continue;
      }
      text += '<';
      i++;
      continue;
    }
    if (c === '[') {
      const r = readLink(src, i, defs, false, inLink);
      if (r) {
        flush();
        atoms.push(r.atom);
        i = r.end;
        continue;
      }
      // The link failed in the original source; if its label is
      // invalid there but valid in marked's masked source, its
      // label's emphasis is suppressed.
      if (src.includes('`', i) && labelClose(src, i) === -1) {
        const ml = maskedLinkSpan(src, i);
        if (ml) noEmRanges.push([ml.labelStart, ml.labelEnd]);
      }
      text += '[';
      i++;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const r = readLink(src, i + 1, defs, true, inLink);
      if (r) {
        flush();
        atoms.push(r.atom);
        i = r.end;
        continue;
      }
      text += '!';
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let run = 1;
      while (i + run < n && src[i + run] === c) run++;
      if (c === '~' && run >= 3) {
        // A run of three or more tildes never delimits.
        text += src.slice(i, i + run);
        i += run;
        continue;
      }
      const fl = flankOf(src, i, run);
      let canOpen;
      let canClose;
      if (c === '_') {
        canOpen = fl.leftFlank && (!fl.rightFlank || fl.beforePunct);
        canClose = fl.rightFlank && (!fl.leftFlank || fl.afterPunct);
      } else {
        canOpen = fl.leftFlank;
        canClose = fl.rightFlank;
      }
      if (!canOpen && !canClose) {
        // A delimiter that can neither open nor close is literal
        // text (an intra-word _ stays in the text run, so a bare
        // email can span it).
        text += src.slice(i, i + run);
        i += run;
        continue;
      }
      if (inMaskedSpan(i) || inNoEmRange(i)) {
        // Inside a masked code span, or inside a link label that
        // is valid only in marked's masked source: the delimiters
        // are literal.
        text += src.slice(i, i + run);
        i += run;
        continue;
      }
      flush();
      atoms.push({ ty: 'delim', mark: c, run, whole: run, canOpen, canClose });
      i += run;
      continue;
    }
    if (c === '@' && !inLink && !linkOpen) {
      let s = text.length - 1;
      while (s >= plainStart && EMAIL_LOCAL_NARROW.test(text[s])) s--;
      const local = text.slice(s + 1);
      if (local !== '') {
        GFM_DOMAIN_NOLOOK_Y.lastIndex = i + 1;
        const dm = GFM_DOMAIN_NOLOOK_Y.exec(src);
        if (dm) {
          const after = src[i + 1 + dm[0].length];
          // The domain must not be followed by a word char or '-'
          // (an incomplete domain). A following '_' blocks it too —
          // unless it closes an emphasis span that encloses this
          // email (an opening '_' delimiter already scanned), in
          // which case marked lexes the email inside the emphasis
          // text after the delimiter is consumed. A '*' never
          // blocks (it is not in the lookahead class).
          let ok = true;
          if (after !== undefined) {
            if (after === '-' || /[A-Za-z0-9]/.test(after)) ok = false;
            else if (after === '_') {
              let hasOpener = false;
              for (let a = atoms.length - 1; a >= 0; a--) {
                const at = atoms[a];
                if (at.ty === 'delim' && at.mark === '_' && at.canOpen) { hasOpener = true; break; }
              }
              if (!hasOpener) ok = false;
            }
          }
          if (ok) {
            const email = local + '@' + dm[0];
            text = text.slice(0, s + 1);
            flush();
            atoms.push({ ty: 'link', href: 'mailto:' + email, title: null, raw: true, kids: [{ ty: 'text', txt: email }] });
            i += 1 + dm[0].length;
            continue;
          }
        }
      }
      text += '@';
      i++;
      continue;
    }
    if (c === '\n') {
      if (text.length >= 2 && text[text.length - 1] === ' ' && text[text.length - 2] === ' ') {
        let e = text.length;
        while (e > 0 && text[e - 1] === ' ') e--;
        text = text.slice(0, e);
        flush();
        atoms.push({ ty: 'br' });
        i++;
        // A hard break swallows the next line's leading spaces/tabs.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      text += '\n';
      i++;
      continue;
    }
    // Ordinary text: jump to the next interesting position.
    NEXT_INTERESTING.lastIndex = i;
    const m = NEXT_INTERESTING.exec(src);
    let next = m ? m.index : n;
    if (next <= i) next = i + 1;
    text += src.slice(i, next);
    i = next;
  }
  flush();
  return atoms;
}

// --- emphasis / strikethrough resolution ----------------------------------
//
// For `*` and `_`, a greedy opener-driven pass mirroring marked's
// emStrong (not the CommonMark stack). For each opener, scan forward
// with a mask: delimTotal starts at the opener's length. A pure opener
// (can open, cannot close) ADDS its length; a pure closer (can close,
// cannot open) SUBTRACTS; an ambiguous run (can both open and close)
// also SUBTRACTS unless the rule of 3 applies (then it is skipped and
// counted in midDelimTotal). The closer is the first run where
// delimTotal drops to <= 0. `~` (strikethrough) keeps the stack /
// equal-length rule below.

function settleDelims(atoms) {
  let idx = 0;
  while (idx < atoms.length) {
    const a = atoms[idx];
    if (a.ty !== 'delim' || a.run === 0 || a.mark === '~' || !a.canOpen) { idx++; continue; }
    const mark = a.mark;
    const lLength = a.run;
    // whole is the WHOLE opener run (including delimiters already
    // emitted as text by a mid-run split).
    const wholeRun = a.whole || a.run;
    const openerCanClose = a.canClose;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    let closerIdx = -1;
    let closerUse = 0;
    let closerRLen = 0;
    // marked's emStrongRDelim first alternative skips an "orphan"
    // delimiter inside a strong of the other character: a `*`
    // inside __...__ (or a `_` inside **...**) does not count in
    // the scan. It only applies to the first delimiter of the
    // scan's own character.
    const otherMark = mark === '*' ? '_' : '*';
    let checkedOrphan = false;
    const isOrphan = (j) => {
      // The regex is ^[^_*]*?__[^_*]*?\*[^_*]*?(?=__): the strong
      // runs are EXACTLY two delimiters and the orphan is EXACTLY
      // one (a longer run breaks the [^_*]*? segments).
      if (atoms[j].run !== 1) return false;
      // A literal * or _ inside a text atom breaks the [^_*]*?
      // segments of the regex, so such text ends the pattern.
      const hasStarOrUnd = (x) => x.ty === 'text' && (x.txt.includes('*') || x.txt.includes('_'));
      // backward: the FIRST other-char delimiter after the opener
      // must be a double run (the strong opener), and no scan-char
      // delimiter may come before it.
      let back = -1;
      for (let b = idx + 1; b < j; b++) {
        const x = atoms[b];
        if (x.ty !== 'delim') { if (hasStarOrUnd(x)) return false; continue; }
        if (x.mark === mark) return false;
        if (x.mark === otherMark) { back = b; break; }
      }
      if (back === -1) return false;
      if (atoms[back].run !== 2) return false;
      // middle: between the strong opener (back) and the orphan
      // (j) there must be no delimiter of either character and no
      // text containing * or _ (the [^_*]*? segment). In particular
      // the strong's own closing run breaks the pattern.
      for (let m = back + 1; m < j; m++) {
        const x = atoms[m];
        if (x.ty === 'delim') return false;
        if (hasStarOrUnd(x)) return false;
      }
      // forward: nearest other-char delimiter after j must be a
      // double run (the strong closer), with no delimiter of either
      // character between.
      for (let f = j + 1; f < atoms.length; f++) {
        const x = atoms[f];
        if (x.ty !== 'delim') { if (hasStarOrUnd(x)) return false; continue; }
        if (x.mark === otherMark) return x.run === 2;
        if (x.mark === mark) return false;
      }
      return false;
    };
    for (let j = idx + 1; j < atoms.length; j++) {
      const d = atoms[j];
      if (d.ty !== 'delim' || d.mark !== mark || d.run === 0) continue;
      if (!checkedOrphan) {
        checkedOrphan = true;
        if (isOrphan(j)) continue;
      }
      const rLength = d.run;
      if (d.canOpen && !d.canClose) {
        // pure opener (another left delim)
        delimTotal += rLength;
        continue;
      }
      // pure closer, or ambiguous (can both open and close)
      if ((d.canOpen && d.canClose) || openerCanClose) {
        // CommonMark rules 9-10: skip this delimiter
        if (wholeRun % 3 !== 0 && (wholeRun + rLength) % 3 === 0) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      closerIdx = j;
      // The closer run may contribute more delimiters than this
      // level needs; only rLen of them belong to this span.
      closerRLen = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      closerUse = Math.min(lLength, closerRLen) % 2 === 1 ? 1 : 2;
      if (closerUse > Math.min(lLength, closerRLen)) closerUse = Math.min(lLength, closerRLen);
      break;
    }
    if (closerIdx === -1) {
      // emStrong failed for this run: the first delimiter is
      // literal text; retry the remainder as a mid-run opener
      // (e.g. **foo* -> * + <em>foo</em>).
      if (a.run > 1) {
        atoms.splice(idx, 1,
          { ty: 'text', txt: mark },
          { ty: 'delim', mark, run: a.run - 1, whole: wholeRun, canOpen: a.canOpen, canClose: a.canClose });
        idx++;
        continue;
      }
      idx++;
      continue;
    }
    const c = atoms[closerIdx];
    const use = closerUse;
    const kind = use === 2 ? 'strong' : 'em';
    // marked re-lexes the node's inner text, so the opener remainder
    // and the CONSUMED part of the closer remainder are children of
    // the node. Any closer delimiters beyond closerRLen stay outside,
    // after the node.
    const openerInside = lLength - use;
    const closerInside = closerRLen - use;
    const closerOutside = c.run - closerRLen;
    const kids = [];
    if (openerInside > 0) {
      a.run = openerInside;
      kids.push(a);
    }
    kids.push(...atoms.slice(idx + 1, closerIdx));
    if (closerInside > 0) {
      kids.push({ ty: 'delim', mark, run: closerInside, whole: c.whole || c.run, canOpen: c.canOpen, canClose: c.canClose });
    }
    settleDelims(kids);
    const node = { ty: kind, kids };
    const after = [];
    after.push(node);
    if (closerOutside > 0) {
      after.push({ ty: 'delim', mark, run: closerOutside, whole: c.whole || c.run, canOpen: c.canOpen, canClose: c.canClose });
    }
    atoms.splice(idx, closerIdx - idx + 1, ...after);
    idx++;
    continue;
  }
  // Strikethrough: stack rule, opener and closer must have equal
  // lengths (one tilde with one, two with two).
  const stack = [];
  let i2 = 0;
  while (i2 < atoms.length) {
    const a = atoms[i2];
    if (a.ty !== 'delim' || a.mark !== '~') { i2++; continue; }
    if (a.canClose && a.run > 0) {
      let si = stack.length - 1;
      let openerIdx = -1;
      while (si >= 0) {
        const oi = stack[si];
        if (oi >= i2) { si--; continue; }
        const o = atoms[oi];
        if (o.mark === '~' && o.canOpen && o.run > 0 && o.run === a.run) {
          openerIdx = oi;
          break;
        }
        si--;
      }
      if (openerIdx !== -1) {
        const o = atoms[openerIdx];
        const use = o.run;
        const kids = atoms.slice(openerIdx + 1, i2);
        settleDelims(kids);
        const node = { ty: 'del', kids };
        o.run -= use;
        a.run -= use;
        const replacement = [];
        if (o.run > 0) replacement.push(o);
        replacement.push(node);
        const closerPos = replacement.length;
        if (a.run > 0) replacement.push(a);
        atoms.splice(openerIdx, i2 - openerIdx + 1, ...replacement);
        while (stack.length > 0 && stack[stack.length - 1] >= openerIdx) stack.pop();
        if (o.run > 0) stack.push(openerIdx);
        if (a.run > 0 && a.canOpen) stack.push(openerIdx + closerPos);
        i2 = openerIdx + closerPos - 1;
        continue;
      }
    }
    if (a.canOpen && a.run > 0) stack.push(i2);
    i2++;
  }
}

// --- rendering atoms ---------------------------------------------------------

function emitAtoms(atoms) {
  const parts = [];
  for (let t = 0; t < atoms.length; t++) {
    const a = atoms[t];
    switch (a.ty) {
      case 'text':
        parts.push(a.esc ? textOutStrict(a.txt) : textOut(a.txt));
        break;
      case 'code':
        parts.push('<code>' + escCode(a.txt) + '</code>');
        break;
      case 'br':
        parts.push('<br>');
        break;
      case 'raw':
        parts.push(a.txt);
        break;
      case 'link': {
        // Autolink hrefs keep their backslashes (they are encoded, not
        // stripped); ordinary link hrefs have escapes removed first.
        const href = cleanUrl(a.raw ? a.href : stripSlashes(a.href));
        let s = '<a href="' + escHtml(href === null ? '' : href) + '"';
        if (a.title !== null && a.title !== undefined) {
          s += ' title="' + escHtml(stripSlashes(a.title)) + '"';
        }
        s += '>' + emitAtoms(a.kids) + '</a>';
        parts.push(s);
        break;
      }
      case 'img': {
        const href = cleanUrl(stripSlashes(a.href));
        let s = '<img src="' + escHtml(href === null ? '' : href) + '" alt="' + escHtml(a.alt) + '"';
        if (a.title !== null && a.title !== undefined) {
          s += ' title="' + escHtml(stripSlashes(a.title)) + '"';
        }
        s += '>';
        parts.push(s);
        break;
      }
      case 'delim':
        parts.push(a.mark.repeat(a.run));
        break;
      case 'em':
        parts.push('<em>' + emitAtoms(a.kids) + '</em>');
        break;
      case 'strong':
        parts.push('<strong>' + emitAtoms(a.kids) + '</strong>');
        break;
      case 'del':
        parts.push('<del>' + emitAtoms(a.kids) + '</del>');
        break;
    }
  }
  return parts.join('');
}

// Plain text of atoms, for image alt attributes: text is unescaped
// (backslash escapes and numeric references resolved), code keeps its
// raw content, HTML keeps its raw text, breaks vanish, emphasis and
// links collapse to their children's text.
function flatText(atoms) {
  const parts = [];
  for (let t = 0; t < atoms.length; t++) {
    const a = atoms[t];
    switch (a.ty) {
      case 'text': parts.push(unesc(a.txt)); break;
      case 'code': parts.push(a.txt); break;
      case 'raw': parts.push(a.txt); break;
      case 'link': parts.push(flatText(a.kids)); break;
      case 'img': parts.push(a.alt); break;
      case 'delim': parts.push(a.mark.repeat(a.run)); break;
      case 'em':
      case 'strong':
      case 'del': parts.push(flatText(a.kids)); break;
    }
  }
  return parts.join('');
}

// Parse inline markdown to HTML.
function inlineOut(src, defs) {
  const atoms = scanText(src, defs, false);
  settleDelims(atoms);
  return emitAtoms(atoms);
}

// --- rendering blocks -----------------------------------------------------------

const TASK_RE = /^\[([ xX])\][ \t]+\S/;

function emitItem(item, spacious, defs) {
  const parts = [];
  const blocks = item.parts;
  let checkbox = '';
  if (blocks.length > 0 && blocks[0].ty === 'para' && blocks[0].lines.length > 0) {
    const m = TASK_RE.exec(blocks[0].lines[0]);
    if (m) {
      // The marker and all following whitespace are removed; the
      // renderer puts exactly one space after the checkbox.
      checkbox = (m[1] === ' ' ? '<input disabled="" type="checkbox">' : '<input checked="" disabled="" type="checkbox">') + ' ';
      blocks[0].lines[0] = blocks[0].lines[0].replace(/^\[[ xX]\][ \t]+/, '');
    }
  }
  for (let b = 0; b < blocks.length; b++) {
    const blk = blocks[b];
    if (blk.ty === 'para' && !spacious && b === 0) {
      parts.push(checkbox + inlineOut(blk.lines.join('\n'), defs));
    } else if (blk.ty === 'para' && spacious) {
      parts.push('<p>' + (b === 0 ? checkbox : '') + inlineOut(blk.lines.join('\n'), defs) + '</p>\n');
    } else if (blk.ty === 'para') {
      parts.push(inlineOut(blk.lines.join('\n'), defs));
    } else {
      parts.push(emitBlocks([blk], defs));
    }
  }
  return parts.join('');
}

function emitBlocks(nodes, defs) {
  const parts = [];
  for (let n = 0; n < nodes.length; n++) {
    const blk = nodes[n];
    switch (blk.ty) {
      case 'para':
        parts.push('<p>' + inlineOut(blk.lines.join('\n'), defs) + '</p>\n');
        break;
      case 'head':
        parts.push('<h' + blk.depth + '>' + inlineOut(blk.txt, defs) + '</h' + blk.depth + '>\n');
        break;
      case 'rule':
        parts.push('<hr>\n');
        break;
      case 'code':
        parts.push('<pre><code' + (blk.lang ? ' class="language-' + escHtml(blk.lang) + '"' : '') + '>'
          + escCode(blk.txt) + '</code></pre>\n');
        break;
      case 'html':
        parts.push(blk.txt);
        break;
      case 'quote':
        parts.push('<blockquote>\n' + emitBlocks(blk.kids, defs) + '</blockquote>\n');
        break;
      case 'list': {
        parts.push(blk.ordered
          ? '<ol' + (blk.start !== 1 ? ' start="' + blk.start + '"' : '') + '>\n'
          : '<ul>\n');
        for (const item of blk.entries) {
          parts.push('<li>' + emitItem(item, blk.spacious, defs) + '</li>\n');
        }
        parts.push(blk.ordered ? '</ol>\n' : '</ul>\n');
        break;
      }
      case 'table': {
        parts.push('<table>\n<thead>\n<tr>\n');
        for (let c = 0; c < blk.head.length; c++) {
          parts.push('<th' + (blk.aligns[c] ? ' align="' + blk.aligns[c] + '"' : '') + '>'
            + inlineOut(blk.head[c], defs) + '</th>\n');
        }
        parts.push('</tr>\n</thead>\n');
        if (blk.rows.length > 0) {
          parts.push('<tbody>');
          for (const row of blk.rows) {
            parts.push('<tr>\n');
            for (let c = 0; c < row.length; c++) {
              parts.push('<td' + (blk.aligns[c] ? ' align="' + blk.aligns[c] + '"' : '') + '>'
                + inlineOut(row[c], defs) + '</td>\n');
            }
            parts.push('</tr>\n');
          }
          parts.push('</tbody>');
        }
        parts.push('</table>\n');
        break;
      }
    }
  }
  return parts.join('');
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  if (src === '') return '';
  linkOpen = false;
  const endsWithNL = src.endsWith('\n');
  const rawLines = src.split('\n');
  if (endsWithNL) rawLines.pop();
  const lines = rawLines.map((t) => ({ txt: t, lazy: false }));
  const defs = new Map();
  const { nodes } = lexBlocks(lines, defs, endsWithNL, true);
  return emitBlocks(nodes, defs);
}

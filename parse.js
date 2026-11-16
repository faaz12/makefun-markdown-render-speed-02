// parse.js — a fast CommonMark 0.31.2 + GFM Markdown renderer.
//
// Written from scratch for the make.fun "Make Markdown rendering faster"
// bounty. parse(markdown) returns exactly the HTML that marked 18.1.3
// renders with its default options (gfm on, breaks off, pedantic off,
// async off). No dependencies, no I/O, no state kept between calls.
//
// Design: a block lexer turns the source into small block tokens, an
// inline scanner turns inline source into atoms (text, code, links,
// emphasis delimiters, ...), a delimiter-stack pass resolves emphasis
// and strikethrough, and small renderers build the HTML strings.

const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

// Unicode punctuation (CommonMark flanking rules use Unicode P/S).
function isPunct(ch) {
  return ch !== undefined && /[\p{P}\p{S}]/u.test(ch);
}
// ASCII punctuation only (backslash escapes use this).
function isAsciiPunct(ch) {
  return ch !== undefined && ASCII_PUNCT.indexOf(ch) !== -1;
}
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
function isWhite(ch) {
  // Unicode whitespace (what the CommonMark flanking rules use).
  return ch !== undefined && /\s/.test(ch);
}
function isAlnum(ch) {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

// ---------------------------------------------------------------------------
// HTML escaping and character-reference decoding.
//
// Text is rendered as escape(decodeNumeric(raw)): numeric character
// references are decoded first (&#35; -> #, &#0; -> U+FFFD), then the
// result is escaped. A bare & is escaped unless it already starts a
// plausible reference (&word; or &#...;), which is left alone — named
// entities are NOT decoded, they pass through unchanged.
const ESC_RE = /&(?!(?:#\d{1,7}|#[Xx][A-Fa-f0-9]{1,6}|\w+);)|[<>"']/g;
const NUMREF_RE = /&(?:#(\d{1,7})|#[Xx]([A-Fa-f0-9]{1,6}));/g;

function esc(s) {
  return s.replace(ESC_RE, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function decodeNumeric(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(NUMREF_RE, (_, dec, hex) => {
    let cp;
    if (dec !== undefined) cp = parseInt(dec, 10);
    else cp = parseInt(hex, 16);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    return String.fromCodePoint(cp);
  });
}

// Render a raw text run: decode numeric references, then escape.
function renderText(s) {
  return esc(decodeNumeric(s));
}

// Remove backslash escapes (backslash before ASCII punctuation only)
// and decode numeric references — used for link destinations and titles.
function unescape(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += c;
    }
  }
  return decodeNumeric(out);
}

// Encode a link destination the way marked does: encodeURI, keeping
// literal % signs intact (%25 is turned back into %).
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch (_) { return null; }
  return href;
}

// Normalize a link label for reference lookup: collapse whitespace,
// trim, case-fold.
function normLabel(label) {
  // marked's label fold: trim, collapse whitespace, lower, UPPER, lower
  // (so ẞ and SS fold to the same label).
  return label.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

// ---------------------------------------------------------------------------
// Inline parsing.
//
// Atoms:
//   {k:'t', s}        raw text run
//   {k:'code', s}     code span content (raw, newlines already folded)
//   {k:'br'}          hard line break
//   {k:'html', s}     raw inline HTML
//   {k:'link', href, title, c}   c = child atoms
//   {k:'img', href, title, alt}  alt = plain text
//   {k:'em'|'strong'|'del', c}   created by the delimiter passes
//   {k:'d', ch, len, open, close}  emphasis/strikethrough delimiter run

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
// GFM extended-autolink domain: labels may contain _ and -, must end
// in an alnum, and must not be followed by a word char or -.
const EMAIL_DOMAIN_RE = /^[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![A-Za-z0-9_-])/;
// GFM extended-autolink local part (narrower than the <...> one).
const EMAIL_LOCAL_GFM = /[A-Za-z0-9._+-]/;
const TAG_OPEN_RE = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^ \t\n"'=<>`]+))?)*\s*\/?>/;
const TAG_CLOSE_RE = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/;
const COMMENT_RE = /^<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const PI_RE = /^<\?[\s\S]*?(?:\?>|$)/;
const DECL_RE = /^<![A-Za-z][\s\S]*?(?:>|$)/;
const CDATA_RE = /^<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/;

// Sticky (y-flag) variants of the inline regexes, derived from the
// anchored originals so the patterns stay byte-identical. They match
// at a given index in the full source, avoiding src.slice(i)
// allocations in the hot inline scanner. (The leading ^ is stripped:
// with the y flag the match is already anchored at lastIndex.)
const _sticky = (re, flags) => new RegExp(re.source.slice(1), flags);
const AUTOLINK_RE = /^([A-Za-z][A-Za-z0-9+.-]{1,31}:[^ \t\n<>]*|[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
const AUTOLINK_Y = _sticky(AUTOLINK_RE, 'y');
const PROTO_Y = _sticky(/^(?:https?|ftp):\/\//i, 'iy');
const MAILTO_Y = _sticky(/^mailto:([A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![A-Za-z0-9_-]))/, 'y');
const XMPP_Y = _sticky(/^xmpp:([A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![A-Za-z0-9_-])(?:\/[A-Za-z0-9@.]+)?)/, 'y');
const EMAIL_DOMAIN_Y = _sticky(EMAIL_DOMAIN_RE, 'y');
const COMMENT_Y = _sticky(COMMENT_RE, 'y');
const PI_Y = _sticky(PI_RE, 'y');
const DECL_Y = _sticky(DECL_RE, 'y');
const CDATA_Y = _sticky(CDATA_RE, 'y');
const TAG_CLOSE_Y = _sticky(TAG_CLOSE_RE, 'y');
const TAG_OPEN_Y = _sticky(TAG_OPEN_RE, 'y');

// Bulk-skip for the inline scanner: the next position where something
// can happen — a structural char, an @ (bare email), a newline (hard
// break), or the start of a URL scheme / www. / mailto: / xmpp:.
// The plain-text fallthrough jumps straight there instead of stepping
// character by character. Case-insensitive so HTTP:// and FTP://
// (accepted by the proto branch) are found; www./mailto:/xmpp: are
// lowercase-only in the branches, so an uppercase hit just falls
// through again (the branch's own checks still gate the autolink).
const NEXT_SPECIAL_RE = /[\\`<!\[*_~@\n]|https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:/gi;



// Trim trailing punctuation off an extended autolink (www. / http(s)://).
// marked's _backpedal: repeatedly trim an extended-autolink URL until
// it is stable. A URL may not end in punctuation, in an unbalanced
// ')', inside a paren group, or inside a trailing &word; entity.
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

function trimUrlEnd(url) {
  let end = url;
  let prev;
  do {
    prev = end;
    end = BACKPEDAL_RE.exec(end)?.[0] ?? '';
  } while (end !== prev);
  return end.length;
}

// Find the end of a bracketed link text starting at src[i] === '['.
// Returns the index just past the matching ']', or -1. Backslash
// escapes are skipped, and a ']' inside a code span does not close.
// A backtick run with no closing run makes the whole text invalid
// (marked's label regex cannot match across it).
// marked's complex label (link/reflink group 1): nested brackets, escapes,
// code spans (which close with any backtick run), a backtick run right
// before ], or any char except [ ] \ `. An unbalanced backtick run (e.g.
// `` a ` b `` leaving a lone `` `` ``) makes the whole label unmatchable,
// so the inline/reflink forms fail and only the shortcut form applies.
const COMPLEX_LABEL_RE = /^(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*\]$/;
// marked's nolink/reflink-second label: escapes, any char except [ ] \
// and newline (a newline is allowed only when not followed by a blank
// line). Backticks are ordinary characters here.
const SIMPLE_LABEL_RE = /^(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+$/;

// Find the end of a link label starting at src[i] ('[') using the
// complex label rules: scan for ] candidates (tracking bracket depth
// and backslash escapes) and return the first whose label text is a
// valid complex label, or -1. The regex is the arbiter — a code span
// that would swallow the label-ending ] (doc-22) makes every candidate
// invalid, so the inline/reflink forms fail.
function findComplexLabelEnd(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\' && j + 1 < src.length) { j++; continue; }
    if (c === '[') { depth++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) {
        const label = src.slice(i + 1, j);
        if (COMPLEX_LABEL_RE.test(label + ']')) return j + 1;
        // the ] is inside the label text (e.g. swallowed by a code
        // span) — keep scanning for a later ] that validates
        depth = 1;
      }
    }
  }
  return -1;
}

// Find the end of a shortcut (nolink) label starting at src[i] ('['):
// the first ] whose label text is a valid simple label, or -1.
function findSimpleLabelEnd(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\' && j + 1 < src.length) { j += 2; continue; }
    if (c === '[' || c === '\n') {
      if (c === '\n') {
        // a newline is allowed only when not followed by a blank line
        let k = j + 1;
        while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
        if (k >= src.length || src[k] === '\n') return -1;
        j++;
        continue;
      }
      return -1;
    }
    if (c === ']') {
      const label = src.slice(i + 1, j);
      if (label.trim() !== '' && SIMPLE_LABEL_RE.test(label)) return j + 1;
      return -1;
    }
    j++;
  }
  return -1;
}

function findLinkTextEnd(src, i) {
  return findComplexLabelEnd(src, i);
}

// Parse "(dest title)" / "(<dest> title)" after a link text or label.
// src[k] === '('. Returns {href, title, end} or null. end is just past ')'.
function parseLinkParens(src, k) {
  let i = k + 1;
  const n = src.length;
  // skip spaces/newlines (but not a blank line)
  let j = i;
  while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
  if (j < n && src[j] === '\n') {
    let m = j + 1;
    while (m < n && (src[m] === ' ' || src[m] === '\t')) m++;
    if (m < n && src[m] !== '\n') { j = m; }
  }
  i = j;
  if (i >= n) return null;
  let href = '';
  if (src[i] === '<') {
    // angle destination: no <, >, or newline inside; backslash
    // escapes are skipped, so <foo\>> is a destination foo\>.
    let e = i + 1;
    while (e < n && src[e] !== '>' && src[e] !== '\n') {
      if (src[e] === '\\' && e + 1 < n) e += 2;
      else e++;
    }
    if (e >= n || src[e] !== '>') return null;
    href = src.slice(i + 1, e);
    i = e + 1;
  } else if (src[i] === ')') {
    // empty destination: [link]()
    href = '';
  } else {
    // bare destination: balanced parens, backslash escapes, no spaces
    let depth = 0;
    let e = i;
    while (e < n) {
      const c = src[e];
      if (c === '\\' && e + 1 < n) { e += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '\u0000') break;
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
      if (q !== '"' && c === '\n') {
        // single-quote / paren titles may span lines but not blank lines
        if (src[e + 1] === '\n') break;
      }
      e++;
    }
    if (!ok) return null;
    title = src.slice(m + 1, e);
    m = e + 1;
  }
  // skip trailing spaces, expect ')'
  while (m < n && (src[m] === ' ' || src[m] === '\t')) m++;
  if (m < n && src[m] === '\n') {
    let p = m + 1;
    while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
    if (p < n && src[p] === ')') m = p;
  }
  if (m >= n || src[m] !== ')') return null;
  return { href, title, end: m + 1 };
}

// Does text contain a link (inline or reference) that would resolve?
// marked rejects an outer link whose text contains a link: the inner
// link takes precedence and the outer brackets stay literal.
function containsLink(text, defs) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) { i++; continue; }
    if (c === '`') {
      let run = 1;
      while (i + run < text.length && text[i + run] === '`') run++;
      let k = i + run;
      while (k < text.length && text[k] !== '`') k++;
      if (k >= text.length) return false;
      i = k;
      continue;
    }
    if (c === '[') {
      const isImg = i > 0 && text[i - 1] === '!';
      const end = findLinkTextEnd(text, i);
      if (end === -1) continue;
      const inner = text.slice(i + 1, end - 1);
      if (containsLink(inner, defs)) return true;
      const j = end;
      let skipTo = end;
      if (text[j] === '(') {
        const p = parseLinkParens(text, j);
        if (!isImg && p) return true;
        if (p) skipTo = p.end;
      } else if (text[j] === '[') {
        const le = findLinkTextEnd(text, j);
        if (le !== -1) {
          if (!isImg) {
            const label = le === j + 2 ? inner : text.slice(j + 1, le - 1);
            if (defs.has(normLabel(label))) return true;
          }
          skipTo = le;
        }
      } else if (!isImg) {
        if (defs.has(normLabel(inner))) return true;
      }
      i = skipTo - 1;
    }
  }
  return false;
}

// marked's Be(): a link text containing a <tag> or <autolink> that runs
// past the end of the label kills the outer link. src is the full inline
// source, labelStart the offset of the label, label the label text.
function labelHasTagPastEnd(src, labelStart, label) {
  if (label.indexOf('<') === -1) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\' && s + 1 < label.length) { s++; continue; }
    if (label[s] === '`') {
      const m = /^(?:`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(labelStart + s);
    let hm = COMMENT_RE.exec(rest);
    if (!hm) hm = PI_RE.exec(rest);
    if (!hm) hm = DECL_RE.exec(rest);
    if (!hm) hm = CDATA_RE.exec(rest);
    if (!hm) hm = TAG_CLOSE_RE.exec(rest);
    if (!hm) hm = TAG_OPEN_RE.exec(rest);
    if (!hm) {
      const am = /^([A-Za-z][A-Za-z0-9+.-]{1,31}:[^ \t\n<>]*|[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/.exec(rest.slice(1));
      if (am) hm = { 0: '<' + am[0] };
    }
    if (hm && hm[0].length > label.length - s) return true;
    if (hm) s += hm[0].length - 1;
  }
  return false;
}

// Try to parse a link/image starting at src[i] ('[' or '![').
// Returns {atom, end} or null. marked tries the inline form, then the
// full reference form, then the shortcut form — each with its own label
// scan. When the inline form's parens are invalid, the shortcut is
// retried with the SIMPLE label (doc-22: the complex label fails on
// the unbalanced `` a ` b ``, so only the shortcut applies).
function tryLink(src, i, defs, isImage) {
  const textStart = isImage ? i + 2 : i + 1;
  const textEnd = findLinkTextEnd(src, isImage ? i + 1 : i);
  let rawText = null;
  let j = -1;
  let href = null;
  let title = null;
  if (textEnd !== -1) {
    rawText = src.slice(textStart, textEnd - 1);
    j = textEnd;
    if (src[j] === '(') {
      const p = parseLinkParens(src, j);
      if (p) {
        href = p.href;
        title = p.title;
        j = p.end;
      } else {
        // not a valid inline link: fall through to the shortcut form
        rawText = null;
      }
    } else if (src[j] === '[') {
      // [text][label] or [text][] (collapsed); the second label uses
      // the simple scan (marked's reflink group 2). If the reflink
      // matches but the label is not a def, marked consumes only the
      // '[' as text and does NOT fall through to the shortcut
      // (cm-571: [foo][bar][baz] leaves [foo] literal).
      const le = findSimpleLabelEnd(src, j);
      if (le === -1) {
        rawText = null;
      } else {
        const label = le === j + 2 ? rawText : src.slice(j + 1, le - 1);
        const def = defs.get(normLabel(label));
        if (!def) return null;
        href = def.href; title = def.title; j = le;
      }
    } else {
      // not followed by ( or [: the shortcut form, which marked scans
      // with the SIMPLE label — fall through to it below
      rawText = null;
    }
  }
  if (rawText === null) {
    // shortcut form with the simple label scan; a collapsed [text][]
    // is the nolink form with the optional [] suffix consumed
    const se = findSimpleLabelEnd(src, isImage ? i + 1 : i);
    if (se === -1) return null;
    rawText = src.slice(textStart, se - 1);
    const def = defs.get(normLabel(rawText));
    if (!def) return null;
    href = def.href;
    title = def.title;
    j = (src[se] === '[' && src[se + 1] === ']') ? se + 2 : se;
  }
  // A link whose text contains a resolvable link, or a <tag>/<autolink>
  // running past the label, is not a link (the inner one wins).
  if (!isImage && containsLink(rawText, defs)) return null;
  if (labelHasTagPastEnd(src, textStart, rawText)) return null;
  href = unescape(href);
  if (title !== null) title = unescape(title);
  if (isImage) {
    const alt = plainText(parseInline(rawText, defs, true, { inLink: false }));
    return { atom: { k: 'img', href, title, alt }, end: j };
  }
  const children = parseInline(rawText, defs, true, { inLink: false });
  return { atom: { k: 'link', href, title, c: children }, end: j };
}

// Plain text of an atom list (for image alt text).
function plainText(atoms) {
  let out = '';
  for (const a of atoms) {
    if (a.k === 't') out += decodeNumeric(a.s);
    else if (a.k === 'code') out += a.s;
    else if (a.k === 'br') out += '\n';
    else if (a.k === 'html') out += '';
    else if (a.k === 'img') out += a.alt;
    else if (a.c) out += plainText(a.c);
    else if (a.k === 'd') out += a.ch.repeat(a.len);
  }
  return out;
}

// marked's emStrong mask (#n): the emStrong/del scans see a masked
// string where code spans, links and tags are replaced by placeholder
// characters, so delimiters inside them are invisible to the scans.
// anyPunctuationOutsideCode matches code spans (the opening run length
// sets the closing run length, so an unbalanced `` ``url` `` pairs with
// a later `` `` `` run and swallows the text between, doc-09) and
// backslash escapes; its replacement keeps the backtick runs but turns
// inner backticks into '+'. blockSkip then masks [...] (...) links
// (even ones whose destination is invalid, doc-16), code spans and
// <...> tags to [aaa...]. Both regexes are copied from marked 18.1.3.
const ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
function emStrongMask(src) {
  let t = src;
  // anyPunctuationOutsideCode only matches backtick runs and
  // backslash escapes; blockSkip only matches [...] links, code spans
  // and <...> tags. Skip a replace when its trigger chars are absent.
  if (src.indexOf('`') !== -1 || src.indexOf('\\') !== -1) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  }
  if (src.indexOf('[') !== -1 || src.indexOf('<') !== -1 || src.indexOf('`') !== -1) {
    t = t.replace(BLOCK_SKIP, (n, s, r) => { const o = r ? r.length : 0; return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']'; });
  }
  return t;
}

// Flanking helpers for emphasis delimiters (CommonMark rules).
function leftFlanking(before, after) {
  if (after === undefined || isWhite(after)) return false;
  if (isPunct(after)) return before === undefined || isWhite(before) || isPunct(before);
  return true;
}
function rightFlanking(before, after) {
  if (before === undefined || isWhite(before)) return false;
  if (isPunct(before)) return after === undefined || isWhite(after) || isPunct(after);
  return true;
}

// Open/close flags for a delimiter run of `ch` with the given flanking
// neighbours (marked's emStrongLDelim / del rules).
function delimOpenClose(before, after, ch) {
  const lf = leftFlanking(before, after);
  const rf = rightFlanking(before, after);
  if (ch === '*') return { open: lf, close: rf };
  if (ch === '_') {
    return {
      open: lf && (!rf || isPunct(before)),
      close: rf && (!lf || isPunct(after)),
    };
  }
  return {
    open: after !== undefined && !isWhite(after),
    close: before !== undefined && !isWhite(before),
  };
}

// A delimiter atom for the run of `ch` starting at `pos` with length
// `len` inside the run of total length `runLen` (the run's full length
// is what marked's rule of 3 uses as the opener length). `before` /
// `after` override the flanking neighbours: pass null for a string
// boundary (undefined neighbour), a character to force it, or omit to
// read it from src. Leftover delimiters inside an emphasis node are
// re-lexed by marked with the node's text as a fresh string, so the
// opener leftover sees a boundary before it and the closer leftover
// sees a boundary after it.
function makeDelimAtom(src, pos, len, ch, runLen, before, after) {
  if (before === undefined) before = pos > 0 ? src[pos - 1] : null;
  if (after === undefined) after = pos + len < src.length ? src[pos + len] : null;
  const { open, close } = delimOpenClose(
    before === null ? undefined : before,
    after === null ? undefined : after, ch);
  return { k: 'd', ch, len, open, close, pos, runLen: runLen === undefined ? len : runLen };
}

// marked's emStrong: openers are processed in document order; for each
// opener the resolver scans forward counting intervening openers
// (m += len) and closers (m -= len, with the rule of 3 diverting
// both-open-and-close runs into f). When m <= 0 the closer is found,
// using b = min(len, len + m + f) of its delimiters; the node is em iff
// min(openerLen, b) is odd, else strong. Leftover opener/closer
// delimiters stay INSIDE the node (re-resolved) and after it.
function scanEmStrongCloser(atoms, idx, src) {
  const d = atoms[idx];
  const ch = d.ch;
  const y = d.runLen; // full run length: marked's rule-of-3 opener length
  let m = d.len;
  let f = 0;
  // o: the char before the opener is the same delimiter char (the
  // opener continues a run whose head was already consumed)
  const o = d.pos > 0 && src[d.pos - 1] === ch;
  // marked's RDelim first alternative: a __...*...__ span (for *) or a
  // **..._...** span (for _) right after the opener is skipped whole —
  // its inner delimiter belongs to the strong, not to this scan
  // (cm-470: *foo __bar *baz bim__ bam*).
  let skipEnd = -1;
  const afterOpener = src.slice(d.pos + d.len);
  const skipM = ch === '*'
    ? /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/.exec(afterOpener)
    : /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/.exec(afterOpener);
  if (skipM) skipEnd = d.pos + d.len + skipM[0].length;
  for (let j = idx + 1; j < atoms.length; j++) {
    const a = atoms[j];
    if (a.k !== 'd' || a.ch !== ch || a.hid) continue;
    if (a.pos < skipEnd) continue; // inside the skipped span
    if (!a.open && !a.close) continue;
    const b = a.len;
    if (a.open && !a.close) { m += b; continue; } // opener only
    if (a.open && a.close) { // both: rule of 3 may divert it
      if (o) return null;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    // closer (closer-only, or both passing the rule of 3)
    m -= b;
    if (m > 0) continue;
    return { closerIdx: j, b: Math.min(b, b + m + f) };
  }
  return null;
}

function resolveEmphasis(atoms, src) {
  let idx = 0;
  while (idx < atoms.length) {
    const d = atoms[idx];
    if (d.k !== 'd' || d.hid || (d.ch !== '*' && d.ch !== '_') || !d.open) { idx++; continue; }
    const found = scanEmStrongCloser(atoms, idx, src);
    if (!found) {
      if (d.len > 1) {
        // marked's lexer consumes one delimiter as text and retries the
        // rest of the run as a fresh opener (cm-442: **foo* -> *<em>foo</em>)
        atoms.splice(idx, 1,
          { k: 't', s: d.ch },
          makeDelimAtom(src, d.pos + 1, d.len - 1, d.ch, d.runLen));
        idx++;
        continue;
      }
      idx++;
      continue;
    }
    const c = atoms[found.closerIdx];
    const k = d.len;
    const b = found.b;
    const use = (Math.min(k, b) % 2 === 1) ? 1 : 2;
    const children = [];
    // leftover delimiters are re-lexed with the node's text as a fresh
    // string: the opener leftover sees a boundary before it, the closer
    // leftover a boundary after it (cm-416: foo***bar***baz)
    if (k - use > 0) children.push(makeDelimAtom(src, d.pos, k - use, d.ch, d.runLen, null, d.ch));
    children.push(...atoms.slice(idx + 1, found.closerIdx));
    if (b - use > 0) children.push(makeDelimAtom(src, c.pos + use, b - use, c.ch, c.runLen, c.ch, null));
    resolveEmphasis(children, src);
    resolveDel(children);
    const node = { k: use === 2 ? 'strong' : 'em', c: children };
    const repl = [node];
    if (c.len - b > 0) repl.push(makeDelimAtom(src, c.pos + b, c.len - b, c.ch, c.runLen));
    atoms.splice(idx, found.closerIdx - idx + 1, ...repl);
    idx++;
  }
  return atoms;
}

// Resolve ~ strikethrough delimiters in an atom list (recursively,
// so ~ inside emphasis also resolves). A run of tildes is one unit;
// the closer must have the same length as the opener.
function resolveDel(atoms) {
  const stack = [];
  for (let idx = 0; idx < atoms.length; idx++) {
    const a = atoms[idx];
    if (a.c) resolveDel(a.c);
    if (a.k !== 'd' || a.ch !== '~' || a.hid) continue;
    if (a.close) {
      let j = stack.length - 1;
      let opener = null;
      while (j >= 0) {
        if (atoms.indexOf(stack[j]) === -1) { j--; continue; }
        if (stack[j].open && stack[j].len === a.len) { opener = stack[j]; break; }
        j--;
      }
      if (opener) {
        const oi = atoms.indexOf(opener);
        const di = atoms.indexOf(a);
        const inner = atoms.slice(oi + 1, di);
        const node = { k: 'del', c: inner };
        atoms.splice(oi, di - oi + 1, node);
        stack.splice(stack.indexOf(opener), 1);
        idx = atoms.indexOf(node);
        continue;
      }
    }
    if (a.len > 0 && a.open && stack.indexOf(a) === -1) stack.push(a);
  }
  return atoms;
}

// Turn leftover delimiter atoms into literal text runs.
function delimsToText(atoms) {
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.c) delimsToText(a.c);
    else if (a.k === 'd') atoms[i] = { k: 't', s: a.ch.repeat(a.len) };
  }
  return atoms;
}

// Merge adjacent text atoms (keeps the atom list short).
function mergeText(atoms) {
  const out = [];
  for (const a of atoms) {
    if (a.k === 't' && out.length && out[out.length - 1].k === 't') {
      out[out.length - 1].s += a.s;
    } else {
      out.push(a);
    }
  }
  return out;
}

// Rewind the atoms list so it ends at source position `start` (the
// start of an email local part), removing/truncating the atoms that
// cover [start, end). Only text and delimiter atoms can be rewound;
// any other atom in the way (code, link, html, br) fails the rewind.
// Returns true on success (atoms mutated), false otherwise (untouched).
function rewindForEmail(atoms, start, end) {
  let pos = end;
  const actions = []; // [index, newText|null(remove)]
  for (let idx = atoms.length - 1; idx >= 0; idx--) {
    if (pos <= start) break;
    const a = atoms[idx];
    let len = -1;
    if (a.k === 't') len = a.s.length;
    else if (a.k === 'd') len = a.len;
    else return false;
    if (pos - len < start) {
      if (a.k !== 't') return false;
      actions.push([idx, a.s.slice(0, start - (pos - len))]);
      pos = start;
      break;
    }
    actions.push([idx, null]);
    pos -= len;
  }
  if (pos > start) return false;
  for (const [idx, nt] of actions) {
    if (nt === null) atoms.splice(idx, 1);
    else atoms[idx].s = nt;
  }
  return true;
}

// The inline scanner. Returns the atom list for src.
// inLink: inside a link label (or image alt) — extended autolinks
// (www./http/email) do not form there, but <...> ones still do.
// st: document-level inline state; an opening <a ...> tag sets
// st.inLink (suppressing later bare-URL/email autolinks, marked's tag
// tokenizer) until a closing </a> clears it.
function parseInline(src, defs, inLink, st) {
  if (!st) st = { inLink: false };
  const atoms = [];
  const n = src.length;
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) atoms.push({ k: 't', s: src.slice(textStart, end) });
  };

  while (i < n) {
    const ch = src[i];

    // --- backslash escape / hard break -------------------------------
    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flushText(i);
        atoms.push({ k: 'br' });
        i += 2;
        // marked's br regex eats following spaces/tabs
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        flushText(i);
        atoms.push({ k: 'e', s: nx });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // --- code span ----------------------------------------------------
    if (ch === '`') {
      let run = 1;
      while (i + run < n && src[i + run] === '`') run++;
      // find a closing run of exactly `run` backticks
      let close = -1;
      let j = i + run;
      while (j < n) {
        if (src[j] === '`') {
          let r2 = 1;
          while (j + r2 < n && src[j + r2] === '`') r2++;
          if (r2 === run) { close = j; break; }
          j += r2;
        } else {
          j++;
        }
      }
      if (close !== -1) {
        let content = src.slice(i + run, close);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && !/^[ ]+$/.test(content)) {
          content = content.slice(1, -1);
        }
        flushText(i);
        atoms.push({ k: 'code', s: content });
        i = close + run;
        textStart = i;
        continue;
      }
      i += run;
      continue;
    }

    // --- < autolink / inline HTML -------------------------------------
    if (ch === '<') {
      // autolink <scheme:...> or <email>
      AUTOLINK_Y.lastIndex = i + 1;
      const m = AUTOLINK_Y.exec(src);
      if (m) {
        const target = m[1];
        flushText(i);
        if (target.indexOf('@') !== -1 && !SCHEME_RE.test(target)) {
          atoms.push({ k: 'link', href: 'mailto:' + target, title: null, c: [{ k: 't', s: target }], auto: true });
        } else {
          atoms.push({ k: 'link', href: target, title: null, c: [{ k: 't', s: target }], auto: true });
        }
        i += 1 + m[0].length;
        textStart = i;
        continue;
      }
      // inline HTML: comment, PI, declaration, CDATA, open/close tag
      COMMENT_Y.lastIndex = i; let hm = COMMENT_Y.exec(src);
      if (!hm) { PI_Y.lastIndex = i; hm = PI_Y.exec(src); }
      if (!hm) { DECL_Y.lastIndex = i; hm = DECL_Y.exec(src); }
      if (!hm) { CDATA_Y.lastIndex = i; hm = CDATA_Y.exec(src); }
      if (!hm) { TAG_CLOSE_Y.lastIndex = i; hm = TAG_CLOSE_Y.exec(src); }
      if (!hm) { TAG_OPEN_Y.lastIndex = i; hm = TAG_OPEN_Y.exec(src); }
      if (hm) {
        flushText(i);
        atoms.push({ k: 'html', s: hm[0] });
        // marked's tag tokenizer: <a ...> opens a link context (later
        // bare-URL/email autolinks are suppressed), </a> closes it.
        // The state persists across blocks until the closing tag.
        if (!st.inLink && /^<a /i.test(hm[0])) st.inLink = true;
        else if (st.inLink && /^<\/a>/i.test(hm[0])) st.inLink = false;
        i += hm[0].length;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // --- image / link --------------------------------------------------
    if (ch === '!' && src[i + 1] === '[') {
      const r = tryLink(src, i, defs, true);
      if (r) {
        flushText(i);
        atoms.push(r.atom);
        i = r.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '[') {
      const r = tryLink(src, i, defs, false);
      if (r) {
        flushText(i);
        atoms.push(r.atom);
        i = r.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // --- emphasis / strikethrough delimiters ---------------------------
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 1;
      while (i + run < n && src[i + run] === ch) run++;
      // A ~ run of 3+ is never a strikethrough delimiter (marked's
      // del regex only matches one or two tildes).
      if (ch === '~' && run >= 3) { i += run; continue; }
      const before = i > 0 ? src[i - 1] : undefined;
      const after = i + run < n ? src[i + run] : undefined;
      const { open, close } = delimOpenClose(before, after, ch);
      flushText(i);
      // pos/runLen let the emphasis resolver recompute flanking for
      // leftover delimiter runs (marked's emStrong re-lexing).
      atoms.push({ k: 'd', ch, len: run, open, close, pos: i, runLen: run });
      i += run;
      textStart = i;
      continue;
    }

    // --- extended autolinks: http(s)://, ftp:// and www. ---------------
    // (not inside a link label). Protocols need no boundary (marked's
    // text tokenizer stops before them anywhere); www. needs the
    // preceding char to be start, whitespace, *, _, ~ or (.
    if (!inLink && !st.inLink && (ch === 'h' || ch === 'H' || ch === 'w' || ch === 'f' || ch === 'F')) {
      let proto = null;
      let start = -1;
      PROTO_Y.lastIndex = i;
      const pm = PROTO_Y.exec(src);
      if (pm && i + pm[0].length < n && /[A-Za-z0-9-]/.test(src[i + pm[0].length])) {
        proto = '';
        start = i;
      } else if (ch === 'w' && src.startsWith('www.', i)) {
        const prev = i > 0 ? src[i - 1] : undefined;
        const wBoundary = prev === undefined || isWhite(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(';
        if (wBoundary && i + 4 < n && /[A-Za-z0-9-]/.test(src[i + 4])) {
          proto = 'http://';
          start = i;
        }
      }
      if (proto !== null) {
        let j = start;
        while (j < n && !isWhite(src[j]) && src[j] !== '<') j++;
        const end = trimUrlEnd(src.slice(start, j));
        if (end > 0) {
          const url = src.slice(start, start + end);
          flushText(start);
          atoms.push({ k: 'link', href: proto + url, title: null, c: [{ k: 't', s: url }], auto: true });
          i = start + end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    // --- extended mailto:/xmpp: autolinks -----------------------------
    // (not inside a link label)
    if (!inLink && !st.inLink && (ch === 'm' || ch === 'x')) {
      const prev = i > 0 ? src[i - 1] : undefined;
      // mailto:/xmpp: form unless preceded by an alnum (marked's text
      // tokenizer only stops before a scheme after a non-alnum).
      const boundary = prev === undefined || !isAlnum(prev);
      if (boundary) {
        let mm = null;
        let kind = 0;
        MAILTO_Y.lastIndex = i;
        mm = MAILTO_Y.exec(src);
        if (mm) kind = 1;
        else { XMPP_Y.lastIndex = i; mm = XMPP_Y.exec(src); if (mm) kind = 2; }
        if (mm) {
          flushText(i);
          const target = (kind === 1 ? 'mailto:' : 'xmpp:') + mm[1];
          atoms.push({ k: 'link', href: target, title: null, c: [{ k: 't', s: target }], auto: true });
          i += (kind === 1 ? 7 : 5) + mm[1].length;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    // --- extended email autolink ---------------------------------------
    // (not inside a link label)
    if (!inLink && !st.inLink && ch === '@') {
      // The local part may span delimiter atoms (e.g. _): scan it back
      // in the raw source, then rewind the atoms covering it.
      let s = i - 1;
      while (s >= 0 && EMAIL_LOCAL_GFM.test(src[s])) s--;
      const local = src.slice(s + 1, i);
      if (local.length > 0) {
        EMAIL_DOMAIN_Y.lastIndex = i + 1;
        const dm = EMAIL_DOMAIN_Y.exec(src);
        if (dm) {
          const beforeLocal = s >= 0 ? src[s] : undefined;
          const okPrev = beforeLocal === undefined || isWhite(beforeLocal) || isPunct(beforeLocal);
          // a mailto:/xmpp: prefix blocks the bare email only when the
          // scheme itself is at a boundary (otherwise the scheme never
          // formed a link and the email still links: xmailto:foo@bar).
          let prefixed = false;
          for (const [scheme, slen] of [['mailto:', 7], ['xmpp:', 5]]) {
            if (s + 1 >= slen && src.slice(s + 1 - slen, s + 1) === scheme) {
              const beforeScheme = s + 1 - slen > 0 ? src[s - slen] : undefined;
              if (beforeScheme === undefined || !isAlnum(beforeScheme)) prefixed = true;
            }
          }
          if (okPrev && !prefixed) {
            if (s + 1 >= textStart) {
              flushText(s + 1);
              const addr = local + '@' + dm[0];
              atoms.push({ k: 'link', href: 'mailto:' + addr, title: null, c: [{ k: 't', s: addr }], auto: true });
              i += 1 + dm[0].length;
              textStart = i;
              continue;
            }
            if (rewindForEmail(atoms, s + 1, textStart)) {
              const addr = local + '@' + dm[0];
              atoms.push({ k: 'link', href: 'mailto:' + addr, title: null, c: [{ k: 't', s: addr }], auto: true });
              i += 1 + dm[0].length;
              textStart = i;
              continue;
            }
          }
        }
      }
      i++;
      continue;
    }

    // --- hard break (two or more spaces + newline) / newline ------------
    if (ch === '\n') {
      // count trailing spaces in the pending text run
      let sp = i - 1;
      while (sp >= textStart && src[sp] === ' ') sp--;
      if (i - 1 - sp >= 2) {
        flushText(sp + 1);
        atoms.push({ k: 'br' });
        i++;
        // marked's br regex eats following spaces/tabs
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // Plain character: skip ahead to the next position where a
    // token can start (structural char, @, newline, or a URL prefix).
    NEXT_SPECIAL_RE.lastIndex = i + 1;
    const sm = NEXT_SPECIAL_RE.exec(src);
    i = sm ? sm.index : n;
  }
  flushText(n);

  let out = mergeText(atoms);
  // marked's emStrong mask: delimiters the mask replaced (inside code
  // spans, links, tags) are invisible to the emphasis/del scans.
  if (out.some(a => a.k === 'd')) {
    // Fast path: with no backtick, [, < or backslash in the source the
    // mask is the identity (nothing can hide a delimiter), so skip it.
    if (src.indexOf('`') !== -1 || src.indexOf('[') !== -1 || src.indexOf('<') !== -1 || src.indexOf('\\') !== -1) {
      const mask = emStrongMask(src);
      for (const a of out) if (a.k === 'd' && mask[a.pos] !== a.ch) a.hid = true;
    }
  }
  out = resolveEmphasis(out, src);
  out = resolveDel(out);
  // The merge only applies to a truncated mailto:/xmpp: autolink
  // inside emphasis, which requires an @ in the source.
  if (src.indexOf('@') !== -1) mergeEmailInEmphasis(out);
  out = delimsToText(out);
  return mergeText(out);
}

// Render an atom list to HTML.
// marked re-lexes emphasis content without the delimiters, so an email
// autolink inside emphasis sees end-of-string where our single-pass
// scanner saw the closing delimiter and truncated the domain
// (doc-04: __...because@mark.example.com__). Merge a truncated
// mailto:/xmpp: autolink with the domain continuation that follows it
// inside the same emphasis node.
function mergeEmailInEmphasis(atoms) {
  for (const a of atoms) {
    if (!a.c) continue;
    if (a.k !== 'em' && a.k !== 'strong' && a.k !== 'del') continue;
    mergeEmailInEmphasis(a.c);
    for (let i = 0; i + 1 < a.c.length; i++) {
      const l = a.c[i];
      if (l.k !== 'link' || !l.auto) continue;
      const href = l.href;
      if (!href.startsWith('mailto:') && !href.startsWith('xmpp:')) continue;
      const nxt = a.c[i + 1];
      if (!nxt || nxt.k !== 't') continue;
      const m = /^\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/.exec(nxt.s);
      if (!m) continue;
      const addr = href.replace(/^(?:mailto:|xmpp:)/, '') + m[0];
      if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+$/.test(addr)) continue;
      const rest = nxt.s.slice(m[0].length);
      if (rest !== '' && /[A-Za-z0-9_-]/.test(rest[0])) continue;
      l.href = href + m[0];
      l.c = [{ k: 't', s: l.c.map((t) => t.s).join('') + m[0] }];
      if (rest === '') a.c.splice(i + 1, 1);
      else nxt.s = rest;
    }
  }
}

function renderInlineAtoms(atoms) {
  let out = '';
  for (const a of atoms) {
    switch (a.k) {
      case 't': out += renderText(a.s); break;
      case 'e': out += escPlain(a.s); break;
      case 'code': out += '<code>' + escPlain(a.s) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'html': out += a.s; break;
      case 'em': out += '<em>' + renderInlineAtoms(a.c) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlineAtoms(a.c) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlineAtoms(a.c) + '</del>'; break;
      case 'link': {
        // marked escapes autolink hrefs fully (encode=true) but normal
        // link hrefs entity-aware; a bad href drops the <a> entirely.
        const rawHref = cleanUrl(a.href);
        if (rawHref === null) {
          out += a.auto ? escPlain(a.c.map((t) => t.s).join('')) : renderInlineAtoms(a.c);
          break;
        }
        const href = a.auto ? escPlain(rawHref) : esc(rawHref);
        out += '<a href="' + href + '"';
        if (a.title !== null && a.title !== undefined) out += ' title="' + esc(a.title) + '"';
        out += '>' + (a.auto ? escPlain(a.c.map((t) => t.s).join('')) : renderInlineAtoms(a.c)) + '</a>';
        break;
      }
      case 'img': {
        const rawSrc = cleanUrl(a.href);
        if (rawSrc === null) {
          out += esc(a.alt);
          break;
        }
        out += '<img src="' + esc(rawSrc) + '" alt="' + esc(a.alt) + '"';
        if (a.title !== null && a.title !== undefined) out += ' title="' + esc(a.title) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

function renderInline(src, defs, st) {
  return renderInlineAtoms(parseInline(src, defs, false, st));
}

// ---------------------------------------------------------------------------
// Block parsing.
//
// Tokens:
//   {t:'code', lang, text}   fenced (lang) or indented (lang null); text ends with \n
//   {t:'heading', level, text}  text = inline source
//   {t:'hr'}
//   {t:'quote', items}      items = block tokens
//   {t:'list', ordered, start, loose, items}  items = {task:-1|0|1, blocks}
//   {t:'html', text}        raw HTML block (no trailing blank line)
//   {t:'table', header, align, rows}  cells = inline source strings
//   {t:'para', text}        text = inline source

const BLOCK_TAGS = new Set(('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul').split('|'));
const PRE_TAGS = new Set(['script', 'pre', 'style', 'textarea']);

function lineEnd(src, pos) {
  const e = src.indexOf('\n', pos);
  return e === -1 ? src.length : e;
}
function isBlankLine(s) {
  return /^[ \t]*$/.test(s);
}
// columns of leading whitespace (tab advances to the next multiple of 4)
function indentCols(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === ' ') { col++; i++; }
    else if (line[i] === '\t') { col = (col | 3) + 1; i++; }
    else break;
  }
  return col;
}
// remove `cols` columns of leading whitespace; a straddling tab becomes spaces
function stripCols(line, cols) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    if (line[i] === ' ') { col++; i++; }
    else if (line[i] === '\t') {
      const nc = (col | 3) + 1;
      if (nc <= cols) { col = nc; i++; }
      else return ' '.repeat(nc - cols) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

// marked clamps the list-item break tests (next bullet / hr / fence /
// heading / html / blockquote) to an indent of clamp(R-1, 0, 3), where R
// is the item's content column: a marker at indent >= R belongs to the
// item (sublist), not to the outer list.
function clampInd(n) { return n < 0 ? 0 : n > 3 ? 3 : n; }
const BULLET_CLAMP_RE = [0, 1, 2, 3].map((k) => new RegExp('^ {0,' + k + '}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]+|$)'));
const HR_CLAMP_RE = [0, 1, 2, 3].map((k) => new RegExp('^ {0,' + k + '}(?:(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})[ \\t]*$'));
const FENCE_CLAMP_RE = [0, 1, 2, 3].map((k) => new RegExp('^ {0,' + k + '}(?:`{3,}|~{3,})'));
const ATX_CLAMP_RE = [0, 1, 2, 3].map((k) => new RegExp('^ {0,' + k + '}#{1,6}(?:[ \\t]|$)'));
const QUOTE_CLAMP_RE = [0, 1, 2, 3].map((k) => new RegExp('^ {0,' + k + '}>'));

// Expand the leading tabs of `str` to spaces, as if the whitespace run
// started at column `startCol` (marked's J()).
function expandTabs(str, startCol) {
  let col = startCol;
  let i = 0;
  let out = '';
  while (i < str.length && (str[i] === ' ' || str[i] === '\t')) {
    if (str[i] === ' ') { col++; out += ' '; i++; }
    else { const nc = (col | 3) + 1; out += ' '.repeat(nc - col); col = nc; i++; }
  }
  return out + str.slice(i);
}

const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+|[ \t]*$)/;
const HR_RE = /^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$|^ {0,3}(?:\*[ \t]*){3,}$/;
const FENCE_START_RE = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})/;
const LIST_MARKER_RE = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$)/;
const DELIM_CELL_RE = /^:?-+:?$/;
const TABLE_DELIM_RE = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)[ \t]*$/;

// Split a table row on unescaped pipes (leading/trailing edge pipes removed).
function splitCells(row) {
  row = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
  const cells = [];
  let cur = '';
  let escaped = false;
  for (let j = 0; j < row.length; j++) {
    const c = row[j];
    if (escaped) { cur += c; escaped = false; continue; }
    // \| is an escaped pipe: the cell split unescapes it to | (so a
    // code span in the cell sees |, not \|); other backslashes stay.
    if (c === '\\') { if (row[j + 1] === '|') { escaped = true; continue; } cur += c; escaped = true; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// Does the line at src[pos] start an HTML block (types 1-6, which can
// interrupt a paragraph)? Returns the type (1..6) or 0. `maxIndent`
// caps the leading spaces (marked's list break tests clamp it).
function htmlBlockStart(line, maxIndent) {
  if (maxIndent !== undefined && maxIndent < 3) {
    const sp = /^ */.exec(line)[0].length;
    if (sp > maxIndent) return 0;
  }
  const m = /^ {0,3}</.exec(line);
  if (!m) return 0;
  const s = line.slice(0, 4).length; // not used; keep the regexes simple
  if (/^ {0,3}<(script|pre|style|textarea)(?:[\s>]|$)/i.test(line)) return 1;
  if (/^ {0,3}<!--/.test(line)) return 2;
  if (/^ {0,3}<\?/.test(line)) return 3;
  if (/^ {0,3}<![A-Za-z]/.test(line)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return 5;
  const tag = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(line);
  if (tag && BLOCK_TAGS.has(tag[1].toLowerCase())) {
    // must be followed by space, end, /> or >
    const rest = line.slice(tag[0].length);
    if (rest === '' || rest[0] === ' ' || rest[0] === '\t' || rest[0] === '\n' || rest[0] === '>' || rest.startsWith('/>')) return 6;
  }
  return 0;
}

// Type 7: a line that is a complete open or closing tag (any tag name
// except pre/script/style/textarea), followed only by whitespace.
// A closing tag takes NO attributes: </a href="foo"> is not a tag.
function htmlType7(line) {
  const close = /^ {0,3}<\/([A-Za-z][A-Za-z0-9-]*)[ \t]*>[ \t]*$/.exec(line);
  if (close) {
    const name = close[1].toLowerCase();
    if (PRE_TAGS.has(name)) return false;
    if (BLOCK_TAGS.has(name)) return false;
    return true;
  }
  const m = /^ {0,3}(<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^ \t\n"'=<>`]+))?)*\s*\/?>)[ \t]*$/.exec(line);
  if (!m) return false;
  const tag = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(m[1]);
  if (!tag) return false;
  const name = tag[1].toLowerCase();
  if (PRE_TAGS.has(name)) return false;
  if (BLOCK_TAGS.has(name)) return false;
  return true;
}

// Does the line at src[pos] start a table (header + delimiter, regex
// level only — no cell-count check)? Used to stop a paragraph.
function isTableStart(src, pos) {
  const le1 = lineEnd(src, pos);
  const line1 = src.slice(pos, le1);
  if (isBlankLine(line1) || indentCols(line1) >= 4) return false;
  // a table needs a pipe in the header or the delimiter row
  if (line1.indexOf('|') === -1) {
    const next = le1 < src.length ? le1 + 1 : src.length;
    if (next >= src.length) return false;
    const le2 = lineEnd(src, next);
    if (src.slice(next, le2).indexOf('|') === -1) return false;
  }
  const next = le1 < src.length ? le1 + 1 : src.length;
  if (next >= src.length) return false;
  const le2 = lineEnd(src, next);
  const line2 = src.slice(next, le2);
  return TABLE_DELIM_RE.test(line2);
}

// Does this line start a block that interrupts a paragraph?
// (ATX, fence, hr, blockquote, list item, html types 1-6, table start)
function interruptsParagraph(src, pos) {
  const le = lineEnd(src, pos);
  const line = src.slice(pos, le);
  if (ATX_RE.test(line)) return true;
  if (FENCE_START_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (LIST_MARKER_RE.test(line)) {
    // only a non-empty first item, and ordered only from 1
    const m = /^ {0,3}([*+-]|\d{1,9}[.)])[ \t]+([^ \t\n])/.exec(line);
    if (m) {
      if (m[1] === '*' || m[1] === '+' || m[1] === '-') return true;
      const num = parseInt(m[1].slice(0, -1), 10);
      if (num === 1) return true;
    }
    return false;
  }
  if (htmlBlockStart(line)) return true;
  if (isTableStart(src, pos)) return true;
  return false;
}

// Ke-style interruption test for lazy continuation lines inside
// blockquotes: ANY list marker interrupts (not just `1.` for ordered),
// and an empty item marker counts too.
function lazyInterrupts(line, src, pos) {
  if (ATX_RE.test(line)) return true;
  if (FENCE_START_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)) return true;
  if (htmlBlockStart(line)) return true;
  if (isTableStart(src, pos)) return true;
  return false;
}

// Would `m\nf` (previous line + setext-looking line) be a setext heading
// (marked's lheading test)? Used for the lazy-line setext guard.
function isLheading(m, f) {
  if (!m || !m.trim()) return false;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(m)) return false;
  if (/^(?: {4}| {0,3}\t)/.test(m)) return false;
  if (FENCE_START_RE.test(m)) return false;
  if (/^ {0,3}>/.test(m)) return false;
  if (ATX_RE.test(m)) return false;
  if (htmlBlockStart(m)) return false;
  // a pipe header + delimiter row is a table, not a setext heading
  if (TABLE_DELIM_RE.test(f) && m.indexOf('|') !== -1) return false;
  return true;
}

// --- link reference definitions ------------------------------------------
// label: balanced brackets, escapes, may span one line (no blank line)
const LABEL_RE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF_RE = new RegExp(
  '^ {0,3}\\[((' + LABEL_RE.source + '))\\]:[ \\t]*(?:\\n[ \\t]*)?' +
  '(?:<([^<>\\n]*)>|([^< \\t\\n][^ \\t\\n]*))' +
  '(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(?:"((?:\\\\[\\s\\S]|[^"\\\\])*)"|\'((?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*)\\\'|\\(((?:\\\\[\\s\\S]|[^()\\\\])*)\\)))?' +
  '[ \\t]*(?:\\n+|$)'
);

// marked's ke(): paren balance of a destination. -1 = balanced (or no
// parens), -2 = unclosed '(', >= 0 = index of an extra ')'.
function parenBalance(a) {
  let t = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') n++;
    else if (a[n] === '(') t++;
    else if (a[n] === ')' && (--t < 0)) return n;
  }
  return t > 0 ? -2 : -1;
}

// Try a link reference definition at src[pos]. Returns {next} or null.
function tryDef(src, pos, defs) {
  const m = DEF_RE.exec(src.slice(pos));
  if (!m) return null;
  // a bare destination with unbalanced parens is not a definition
  if (m[4] !== undefined && parenBalance(m[4]) !== -1) return null;
  const label = normLabel(m[1]);
  if (label === '' || defs.has(label)) {
    // still consumed even if it is a duplicate
    if (label === '') return null;
    return { next: pos + m[0].length };
  }
  const href = m[3] !== undefined ? m[3] : m[4];
  const title = m[5] !== undefined ? m[5] : m[6] !== undefined ? m[6] : m[7] !== undefined ? m[7] : null;
  defs.set(label, { href, title });
  return { next: pos + m[0].length };
}

// --- fenced code ------------------------------------------------------------
function tryFence(src, pos) {
  const le = lineEnd(src, pos);
  const line = src.slice(pos, le);
  const m = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)$/.exec(line);
  if (!m) return null;
  const marker = m[1];
  const ch = marker[0];
  const info = m[2].trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
  const lang = info === '' ? null : info.split(/[ \t]+/)[0];
  // marked's Dt (indentCodeCompensation /^(\s+)(?:```)/): only a
  // backtick fence strips indent, and it strips up to the fence line's
  // leading-whitespace length in CHARACTERS (a tab counts as 1 char,
  // not 4 columns) from every content line.
  const fenceIndentChars = ch === '`' ? /^[ \t]*/.exec(line)[0].length : 0;
  // find the closing fence
  let p = le < src.length ? le + 1 : src.length;
  let contentEnd = src.length;
  let next = src.length;
  const closeRe = new RegExp('^ {0,3}' + ch + '{' + marker.length + ',}[ \\t]*$');
  while (p < src.length) {
    const e = lineEnd(src, p);
    const l = src.slice(p, e);
    if (closeRe.test(l)) {
      contentEnd = p;
      next = e < src.length ? e + 1 : e;
      break;
    }
    p = e < src.length ? e + 1 : e;
  }
  let text = src.slice(le < src.length ? le + 1 : src.length, contentEnd);
  if (fenceIndentChars > 0 && text !== '') {
    // strip the opening fence's indent (in characters) from every
    // content line — a leading tab counts as one character
    const parts = text.split('\n');
    for (let k = 0; k < parts.length; k++) {
      const ws = /^[ \t]*/.exec(parts[k])[0].length;
      parts[k] = parts[k].slice(Math.min(ws, fenceIndentChars));
    }
    text = parts.join('\n');
  }
  // marked's fence regex consumes exactly one newline after the content
  // (the separator before the closing fence / EOF), so drop one trailing
  // newline here; the renderer wants exactly one trailing newline.
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text !== '' && !text.endsWith('\n')) text += '\n';
  return { tok: { t: 'code', lang, text }, next };
}

// --- indented code ----------------------------------------------------------
function tryIndentedCode(src, pos) {
  const lines = [];
  let p = pos;
  let lastNonBlank = -1;
  while (p < src.length) {
    const le = lineEnd(src, p);
    const line = src.slice(p, le);
    const nextP = le < src.length ? le + 1 : le;
    if (isBlankLine(line)) {
      lines.push({ text: stripCols(line, 4), blank: true });
      p = nextP;
      continue;
    }
    if (indentCols(line) >= 4) {
      lines.push({ text: stripCols(line, 4), blank: false });
      lastNonBlank = lines.length - 1;
      p = nextP;
      continue;
    }
    break;
  }
  if (lastNonBlank === -1) return null;
  const content = lines.slice(0, lastNonBlank + 1).map((l) => l.text).join('\n') + '\n';
  // next = position after the last non-blank code line
  let np = pos;
  for (let k = 0; k <= lastNonBlank; k++) {
    const e = lineEnd(src, np);
    np = e < src.length ? e + 1 : e;
  }
  return { tok: { t: 'code', lang: null, text: content }, next: np };
}

// --- ATX heading ------------------------------------------------------------
function tryAtx(src, pos) {
  const le = lineEnd(src, pos);
  const line = src.slice(pos, le);
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (!m) return null;
  let text = m[2] === undefined ? '' : m[2];
  text = text.replace(/(?:[ \t]+#+|^[ \t]*#+)[ \t]*$/, '').replace(/^[ \t]+|[ \t]+$/g, '');
  return { tok: { t: 'heading', level: m[1].length, text }, next: le < src.length ? le + 1 : le };
}

// marked's ge(): the html block's text keeps at most one trailing
// blank line — if the raw ends with two or more trailing blank lines
// they are all dropped (and with them the trailing newline).
function trimHtmlTrailing(text) {
  const lines = text.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? text : lines.slice(0, t + 1).join('\n');
}

// --- HTML block ---------------------------------------------------------------
// marked's rule: the block's raw text ends after the closing line plus
// all consecutive newlines that follow it (types 1-5: the regex's
// [^\n]*(\n+|$) / [^\n]*\n*; types 6-7: the regex's (?:\n[ \t]*)+\n,
// which swallows the run of blank lines). The rendered text is then
// ge() of that raw. A spaces/tabs-only line after the block does NOT
// end the raw (the \n+ run stops at the space), so it keeps its \n.
function tryHtml(src, pos) {
  const le = lineEnd(src, pos);
  const line = src.slice(pos, le);
  const type = htmlBlockStart(line);
  let end = src.length;
  let next = src.length;
  if (type === 0) {
    if (!htmlType7(line)) return null;
    // type 7: until a blank line; the raw swallows the blank-line run
    let p = pos;
    while (p < src.length) {
      const e = lineEnd(src, p);
      const l = src.slice(p, e);
      if (isBlankLine(l)) { end = e < src.length ? e + 1 : e; next = end; break; }
      p = e < src.length ? e + 1 : e;
    }
    // swallow any further blank lines
    while (end < src.length) {
      const e = lineEnd(src, end);
      if (!isBlankLine(src.slice(end, e))) break;
      end = e < src.length ? e + 1 : e;
      next = end;
    }
  } else if (type === 1) {
    const tag = /^ {0,3}<(script|pre|style|textarea)/i.exec(line)[1].toLowerCase();
    const closeRe = new RegExp('</' + tag + '[^\\n]*', 'i');
    let p = pos;
    while (p < src.length) {
      const e = lineEnd(src, p);
      const l = src.slice(p, e);
      if (closeRe.test(l)) {
        end = e < src.length ? e + 1 : e;
        next = end;
        break;
      }
      p = e < src.length ? e + 1 : e;
    }
  } else if (type === 2) {
    let p = pos;
    while (p < src.length) {
      const e = lineEnd(src, p);
      const l = src.slice(p, e);
      if (l.indexOf('-->') !== -1) { end = e < src.length ? e + 1 : e; next = end; break; }
      p = e < src.length ? e + 1 : e;
    }
  } else if (type === 3) {
    let p = pos;
    while (p < src.length) {
      const e = lineEnd(src, p);
      const l = src.slice(p, e);
      if (l.indexOf('?>') !== -1) { end = e < src.length ? e + 1 : e; next = end; break; }
      p = e < src.length ? e + 1 : e;
    }
  } else if (type === 4) {
    let p = pos;
    while (p < src.length) {
      const e = lineEnd(src, p);
      const l = src.slice(p, e);
      if (l.indexOf('>') !== -1) { end = e < src.length ? e + 1 : e; next = end; break; }
      p = e < src.length ? e + 1 : e;
    }
  } else if (type === 5) {
    let p = pos;
    while (p < src.length) {
      const e = lineEnd(src, p);
      const l = src.slice(p, e);
      if (l.indexOf(']]>') !== -1) { end = e < src.length ? e + 1 : e; next = end; break; }
      p = e < src.length ? e + 1 : e;
    }
  } else {
    // type 6: until a blank line; the raw swallows the blank-line run
    let p = pos;
    while (p < src.length) {
      const e = lineEnd(src, p);
      const l = src.slice(p, e);
      if (isBlankLine(l)) { end = e < src.length ? e + 1 : e; next = end; break; }
      p = e < src.length ? e + 1 : e;
    }
    // swallow any further blank lines
    while (end < src.length) {
      const e = lineEnd(src, end);
      if (!isBlankLine(src.slice(end, e))) break;
      end = e < src.length ? e + 1 : e;
      next = end;
    }
  }
  // types 1-5: the regex's trailing \n+ / \n* swallows all consecutive
  // newlines after the closing line
  if (type >= 1 && type <= 5) {
    while (end < src.length && src[end] === '\n') end++;
    next = end;
  }
  const text = trimHtmlTrailing(src.slice(pos, end));
  return { tok: { t: 'html', text }, next };
}

// --- blockquote ---------------------------------------------------------------
function blockquoteMarker(line) {
  // Returns the content after the `>` marker, or null if there is none.
  // The whitespace after `>` is tab-expanded from the `>` column and
  // then exactly one space is dropped (marked's blockquoteMarkerWhitespace
  // + blockquoteSetextReplace2).
  const m = /^ {0,3}>/.exec(line);
  if (!m) return null;
  const gtCol = m[0].length - 1;
  const expanded = expandTabs(line.slice(m[0].length), gtCol + 1);
  return expanded[0] === ' ' ? expanded.slice(1) : expanded;
}

// Next block kind inside a blockquote after pushing a `>` line with
// content `c` (marked's chunking: a lazy line may only continue a
// paragraph, a list or a nested quote — never code, a fence, a heading,
// an hr, html or a table).
function quoteNextKind(kind, c, prevLine) {
  if (kind === 'fence') return 'fence';
  if (isBlankLine(c)) return kind === 'code' ? 'code' : 'none';
  if (kind === 'para' || kind === 'list' || kind === 'quote') {
    if (FENCE_START_RE.test(c)) return 'fence';
    if (ATX_RE.test(c) || HR_RE.test(c) || htmlBlockStart(c)) return 'other';
    if (/^ {0,3}>/.test(c)) return 'quote';
    if (kind === 'para' && listItemStart(c)) return 'list';
    if (kind === 'para' && SETEXT_RE.test(c)) return 'other';
    if (kind === 'para' && TABLE_DELIM_RE.test(c) && prevLine !== undefined && prevLine !== '' && !isBlankLine(prevLine)) return 'other';
    return kind;
  }
  if (FENCE_START_RE.test(c)) return 'fence';
  if (indentCols(c) >= 4) return 'code';
  if (ATX_RE.test(c) || HR_RE.test(c) || htmlBlockStart(c)) return 'other';
  if (/^ {0,3}>/.test(c)) return 'quote';
  if (listItemStart(c)) return 'list';
  return 'para';
}

function tryBlockquote(src, pos, defs, lazySet) {
  const inner = [];
  const innerLazy = new Set();
  let p = pos;
  let innerPos = 0;
  const pushInner = (text, lazy) => {
    if (lazy) innerLazy.add(innerPos);
    inner.push(text);
    innerPos += text.length + 1;
  };
  let kind = 'none';
  let fenceCh = '';
  let fenceLen = 0;
  let fenceCloseRe = null;
  while (p < src.length) {
    const le = lineEnd(src, p);
    const line = src.slice(p, le);
    const nextP = le < src.length ? le + 1 : le;
    const marked = blockquoteMarker(line);
    if (marked !== null) {
      if (kind === 'fence') {
        // fence content until the closing fence
        pushInner(marked, false);
        if (fenceCloseRe && fenceCloseRe.test(marked)) kind = 'other';
        p = nextP;
        continue;
      }
      const prevLine = inner.length > 0 ? inner[inner.length - 1] : undefined;
      pushInner(marked, false);
      kind = quoteNextKind(kind, marked, prevLine);
      if (kind === 'fence') {
        const fm = /^ {0,3}(`{3,}|~{3,})/.exec(marked);
        fenceCh = fm[1][0];
        fenceLen = fm[1].length;
        fenceCloseRe = new RegExp('^ {0,3}' + (fenceCh === '`' ? '`' : '~') + '{' + fenceLen + ',}[ \\t]*$');
      }
      p = nextP;
      continue;
    }
    // a truly blank line (no `>`) ends the quote (cm-242, cm-252)
    if (isBlankLine(line)) break;
    // lazy continuation: only after a paragraph, list or nested quote,
    // and only if the line starts no block (Ke-style interruption)
    if ((kind === 'para' || kind === 'list' || kind === 'quote') &&
        inner.length > 0 && inner[inner.length - 1] !== '' &&
        !lazyInterrupts(line, src, p)) {
      // a lazy setext underline stays in the paragraph as text; the
      // 4-space guard is applied when the paragraph is rendered
      // (tryParagraph, quote mode) so inner lists see the raw line
      pushInner(line, true);
      p = nextP;
      continue;
    }
    break;
  }
  if (inner.length === 0) return null;
  // no artificial trailing newline: marked's inner source ends at the
  // last line, so an html block ending at EOF keeps no trailing \n here
  const innerSrc = inner.join('\n');
  const items = lexBlocks(innerSrc, defs, innerLazy, 'quote');
  return { tok: { t: 'quote', items }, next: p };
}

// --- lists --------------------------------------------------------------------
function listItemStart(line) {
  // returns {bullet, num, delim, contentCol, content, empty} or null
  const m = /^ {0,3}([*+-]|\d{1,9}[.)])/.exec(line);
  if (!m) return null;
  const marker = m[1];
  const markerCol = m[0].length - (m[0].startsWith(' ') ? 0 : 0);
  // column of the marker end
  let col = 0;
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    col = line[i] === ' ' ? col + 1 : (col | 3) + 1;
    i++;
  }
  const markerEndCol = col + marker.length;
  const rest = line.slice(i + marker.length);
  // whitespace after the marker
  let j = i + marker.length;
  let wsCol = markerEndCol;
  let wsCount = 0;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    const nc = line[j] === ' ' ? wsCol + 1 : (wsCol | 3) + 1;
    wsCol = nc;
    wsCount++;
    j++;
  }
  const empty = j >= line.length;
  if (!empty && wsCount === 0) return null;
  let contentCol;
  let content;
  if (empty) {
    contentCol = markerEndCol + 1;
    content = '';
  } else if (wsCol - markerEndCol >= 5) {
    // 5+ spaces: only one counts toward the indent
    contentCol = markerEndCol + 1;
    content = ' '.repeat(wsCol - markerEndCol - 1) + line.slice(j);
  } else {
    contentCol = wsCol;
    content = line.slice(j);
  }
  const bullet = marker === '*' || marker === '+' || marker === '-' ? marker : null;
  const num = bullet ? null : parseInt(marker.slice(0, -1), 10);
  const delim = bullet ? null : marker[marker.length - 1];
  return { bullet, num, delim, contentCol, content, empty, marker, markerEndCol, rest };
}

function tryList(src, pos, defs, lazySet) {
  const first = listItemStart(src.slice(pos, lineEnd(src, pos)));
  if (!first) return null;
  const ordered = first.bullet === null;
  const start = ordered ? first.num : null;
  const items = [];
  let p = pos;
  let loose = false;
  let prevItemEndBlank = false;
  // end of the last item's content (before any trailing blank lines):
  // marked's list raw is trimEnd'ed, so the blanks after the last item
  // belong to the outer level — the caller must see them (cm-325:
  // the blank between a sublist and a following paragraph makes the
  // outer item loose)
  let listEnd = pos;
  while (p < src.length) {
    const le = lineEnd(src, p);
    const line = src.slice(p, le);
    const nextP = le < src.length ? le + 1 : le;
    // a blank line between items does not end the list: skip it and
    // keep looking for the next item (the list turns loose)
    if (isBlankLine(line)) { p = nextP; continue; }
    if (HR_RE.test(line)) break;
    const st = listItemStart(line);
    if (!st) break;
    // same list type? bullet char / ordered delimiter must match
    if (ordered) {
      if (st.bullet !== null || st.delim !== first.delim) break;
    } else {
      if (st.bullet !== first.bullet) break;
    }
    if (prevItemEndBlank) loose = true;
    // collect this item's lines
    const itemLines = [];
    const itemLazy = new Set();
    let itemPos = 0;
    const pushItem = (text, lazy) => {
      if (lazy) itemLazy.add(itemPos);
      itemLines.push(text);
      itemPos += text.length + 1;
    };
    pushItem(st.content, false);
    const contentCol = st.contentCol;
    const cl = clampInd(contentCol - 1);
    // marked's `m`: the previous line's content after the content column
    // (the marker line's remainder, tab-expanded, at first)
    let prevContent = expandTabs(st.rest, st.markerEndCol);
    let prevBlank = false;
    p = nextP;
    let itemEndedByBlank = false;
    // an empty item followed by a blank line ends the item (cm-280)
    if (st.empty && p < src.length) {
      const fe = lineEnd(src, p);
      if (isBlankLine(src.slice(p, fe))) {
        itemEndedByBlank = true;
      }
    }
    while (!itemEndedByBlank && p < src.length) {
      const e2 = lineEnd(src, p);
      const l2 = src.slice(p, e2);
      const n2 = e2 < src.length ? e2 + 1 : e2;
      if (isBlankLine(l2)) {
        // peek at the next non-blank line
        let q = n2;
        let nxt = null;
        while (q < src.length) {
          const e3 = lineEnd(src, q);
          const l3 = src.slice(q, e3);
          if (!isBlankLine(l3)) { nxt = l3; break; }
          q = e3 < src.length ? e3 + 1 : e3;
        }
        if (nxt === null) { itemEndedByBlank = true; break; }
        const nst = listItemStart(nxt);
        const isNewItem = nst && indentCols(nxt) <= cl &&
          ((ordered && nst.bullet === null && nst.delim === first.delim) ||
           (!ordered && nst.bullet === first.bullet));
        if (isNewItem) { itemEndedByBlank = true; break; }
        if (indentCols(nxt) >= contentCol) {
          // blank line inside the item; more content follows
          pushItem('', false);
          prevContent = '';
          prevBlank = true;
          p = n2;
          continue;
        }
        // blank line ends the item
        itemEndedByBlank = true;
        break;
      }
      // clamped break tests: a block start at indent <= R-1 ends the
      // item; at indent >= R it is item content (sublist, fence, ...)
      if (BULLET_CLAMP_RE[cl].test(l2) || HR_CLAMP_RE[cl].test(l2) ||
          FENCE_CLAMP_RE[cl].test(l2) || ATX_CLAMP_RE[cl].test(l2) ||
          QUOTE_CLAMP_RE[cl].test(l2) || htmlBlockStart(l2, cl)) break;
      // tab-expanded line (marked's Z); content starts at the content col
      const Z = expandTabs(l2, 0);
      if (Z.search(/[^ ]/) >= contentCol) {
        pushItem(Z.slice(contentCol), false);
        prevContent = Z.slice(contentCol);
        prevBlank = false;
        p = n2;
        continue;
      }
      // lazy continuation: rejected after a blank line, after an
      // indented-code-like line, or after a block-starting line
      if (prevBlank ||
          prevContent.replace(/\t/g, '    ').search(/[^ ]/) >= 4 ||
          FENCE_CLAMP_RE[cl].test(prevContent) ||
          ATX_CLAMP_RE[cl].test(prevContent) ||
          htmlBlockStart(prevContent, cl) ||
          HR_CLAMP_RE[cl].test(prevContent)) break;
      // a lazy setext underline stays in the paragraph as text, with
      // four spaces prepended so it is not read as a heading
      if (/^ {0,3}(?:=+|-+) *$/.test(l2) && isLheading(prevContent, l2)) {
        pushItem('    ' + Z.replace(/^ {0,3}/, ''), true);
      } else {
        pushItem(l2, true);
      }
      prevContent = Z.slice(contentCol);
      prevBlank = false;
      p = n2;
    }
    listEnd = p;
    const itemSrc = itemLines.join('\n');
    // task checkbox (marked's listIsTask: needs a non-space after it)
    let task = -1;
    let blocksSrc = itemSrc;
    let blocksLazy = itemLazy;
    const taskM = /^\[([ xX])\][ \t]+(?=\S)/.exec(itemLines[0] || '');
    if (!ordered && taskM) {
      task = taskM[1] === ' ' ? 0 : 1;
      const firstLine = itemLines[0].slice(taskM[0].length);
      const restLines = [firstLine, ...itemLines.slice(1)];
      blocksSrc = restLines.join('\n');
      // shift lazy positions: the first line lost taskM[0].length chars
      blocksLazy = new Set();
      for (const pos of itemLazy) blocksLazy.add(pos === 0 ? 0 : pos - taskM[0].length);
    }
    // looseness (marked): a blank line between two top-level blocks of
    // the item — blank lines inside a sublist/fence do not count
    const info = { blankSep: false };
    const blocks = lexBlocks(blocksSrc, defs, blocksLazy, 'list', info);
    if (info.blankSep) loose = true;
    items.push({ task, blocks });
    prevItemEndBlank = itemEndedByBlank;
  }
  if (items.length === 0) return null;
  return { tok: { t: 'list', ordered, start, loose, items }, next: listEnd };
}

// --- tables ---------------------------------------------------------------------
// marked's table-row exclusions: a spaces-only line ends the table (a
// tab-only line IS a row of empty cells), as do hr / ATX / blockquote /
// indented code / fence / list (`*+-` or `1.`/`1)` + space/tab) / html
// block starts. Any other line is a row, even without a pipe.
function tableRowEnds(line) {
  if (/^ *$/.test(line)) return true;
  if (indentCols(line) >= 4 && line.trim() !== '') return true;
  if (ATX_RE.test(line) || FENCE_START_RE.test(line) || HR_RE.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(line)) return true;
  if (htmlBlockStart(line)) return true;
  return false;
}

function tryTable(src, pos, defs) {
  const le1 = lineEnd(src, pos);
  const line1 = src.slice(pos, le1);
  if (isBlankLine(line1) || indentCols(line1) >= 4) return null;
  const next = le1 < src.length ? le1 + 1 : src.length;
  if (next >= src.length) return null;
  const le2 = lineEnd(src, next);
  const line2 = src.slice(next, le2);
  if (!TABLE_DELIM_RE.test(line2)) return null;
  // A delimiter with no pipe (and a header with no pipe) is a setext
  // underline, not a table: marked only forms a table when a pipe
  // appears in the header or the delimiter row.
  if (line1.indexOf('|') === -1 && line2.indexOf('|') === -1) return null;
  const header = splitCells(line1);
  const delimCells = splitCells(line2);
  if (header.length !== delimCells.length) return null;
  const align = [];
  for (const c of delimCells) {
    const cell = c.trim();
    if (!DELIM_CELL_RE.test(cell)) return null;
    if (cell[0] === ':' && cell[cell.length - 1] === ':') align.push('center');
    else if (cell[cell.length - 1] === ':') align.push('right');
    else if (cell[0] === ':') align.push('left');
    else align.push(null);
  }
  // body rows
  const rows = [];
  let p = le2 < src.length ? le2 + 1 : le2;
  while (p < src.length) {
    const e = lineEnd(src, p);
    const l = src.slice(p, e);
    const n2 = e < src.length ? e + 1 : e;
    if (tableRowEnds(l)) break;
    const cells = splitCells(l);
    while (cells.length < header.length) cells.push('');
    rows.push(cells.slice(0, header.length));
    p = n2;
  }
  return { tok: { t: 'table', header, align, rows }, next: p };
}

// --- paragraph (handles setext headings) -----------------------------------------
// mode: 'top' (a paragraph keeps its lines verbatim), 'list' / 'quote'
// (marked's text-mode/code-merge: a continuation line indented >= 4 loses
// 4 columns, and a run of such lines followed by another line leaves an
// extra blank line in the text).
function tryParagraph(src, pos, defs, lazySet, mode) {
  const lines = [];
  let p = pos;
  let endedByBlock = false;
  const interrupts = (line, pp) => {
    if (mode === 'list') {
      // any list marker interrupts a paragraph inside a list item
      if (ATX_RE.test(line) || FENCE_START_RE.test(line) || HR_RE.test(line)) return true;
      if (/^ {0,3}>/.test(line)) return true;
      if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$)/.test(line)) return true;
      if (htmlBlockStart(line)) return true;
      if (isTableStart(src, pp)) return true;
      return false;
    }
    return interruptsParagraph(src, pp);
  };
  while (p < src.length) {
    const le = lineEnd(src, p);
    const line = src.slice(p, le);
    const nextP = le < src.length ? le + 1 : le;
    if (lines.length === 0) {
      lines.push({ text: line, start: p, strip4: false });
      p = nextP;
      continue;
    }
    if (isBlankLine(line)) {
      // a spaces-only line with no trailing newline is paragraph content
      // (cm-241: `>  ` contributes a single space)
      if (line.length > 0 && le === src.length) {
        lines.push({ text: line, start: p, strip4: false });
        p = nextP;
      }
      break;
    }
    if (SETEXT_RE.test(line)) {
      // a setext underline that is a lazy line stays in the paragraph
      if (lazySet && lazySet.has(p)) {
        if (mode === 'quote') {
          // guard form: four spaces prepended (cm-093)
          lines.push({ text: '    ' + line.replace(/^ {0,3}/, ''), start: p, strip4: false });
        } else {
          lines.push({ text: line, start: p, strip4: false });
        }
        p = nextP;
        continue;
      }
      const level = line.trim()[0] === '=' ? 1 : 2;
      const text = lines.map((l) => l.text).join('\n').trim();
      return { tok: { t: 'heading', level, text }, next: nextP };
    }
    if (interrupts(line, p)) { endedByBlock = true; break; }
    if (indentCols(line) >= 4 && (mode === 'list' || (mode === 'quote' && lazySet && lazySet.has(p)))) {
      // an indented continuation line is lexed as an indented code block
      // and merged back into the paragraph (4 cols stripped) — in a list
      // item for every such line, in a blockquote only for LAZY lines
      // (no > prefix, cm-238: > foo / '    - bar' -> 'foo\n- bar'); a
      // > line keeps its spaces (doc-21: > >     indented four)
      lines.push({ text: stripCols(line, 4), start: p, strip4: true });
    } else {
      lines.push({ text: line, start: p, strip4: false });
    }
    p = nextP;
  }
  // assemble the text, applying the code-run trailing-newline quirk: a
  // run of indented (strip4) lines followed by another line leaves an
  // extra blank line in the text (marked's code token keeps its \n)
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    parts.push(lines[i].text);
    if (mode !== 'top' && lines[i].strip4) {
      const nextIsStrip4 = i + 1 < lines.length && lines[i + 1].strip4;
      if (!nextIsStrip4 && (i + 1 < lines.length || endedByBlock)) parts.push('');
    }
  }
  const text = parts.join('\n');
  return { tok: { t: 'para', text }, next: p };
}

// --- main block lexer --------------------------------------------------------------
function lexBlocks(src, defs, lazySet, mode, info) {
  if (mode === undefined) mode = 'top';
  const toks = [];
  let pos = 0;
  const n = src.length;
  // blank-line separation tracking (marked's looseness rule): a blank
  // line skipped between two emitted tokens
  let blankPending = false;
  const notePush = () => {
    if (blankPending) {
      if (info) info.blankSep = true;
      blankPending = false;
    }
  };
  while (pos < n) {
    const le = lineEnd(src, pos);
    const line = src.slice(pos, le);
    const nextPos = le < src.length ? le + 1 : le;
    if (isBlankLine(line)) {
      if (toks.length > 0) blankPending = true;
      pos = nextPos;
      continue;
    }
    // indented code (not if the line is a list/blockquote start etc. —
    // indent >= 4 wins for non-container lines)
    if (indentCols(line) >= 4) {
      const r = tryIndentedCode(src, pos);
      if (r) { notePush(); toks.push(r.tok); pos = r.next; continue; }
    }
    let r = tryFence(src, pos);
    if (r) { notePush(); toks.push(r.tok); pos = r.next; continue; }
    if (HR_RE.test(line)) { notePush(); toks.push({ t: 'hr' }); pos = nextPos; continue; }
    r = tryAtx(src, pos);
    if (r) { notePush(); toks.push(r.tok); pos = r.next; continue; }
    r = tryBlockquote(src, pos, defs, lazySet);
    if (r) { notePush(); toks.push(r.tok); pos = r.next; continue; }
    r = tryList(src, pos, defs, lazySet);
    if (r) { notePush(); toks.push(r.tok); pos = r.next; continue; }
    r = tryHtml(src, pos);
    if (r) { notePush(); toks.push(r.tok); pos = r.next; continue; }
    r = tryDef(src, pos, defs);
    if (r) {
      // marked emits the def as a token after a space token, so a blank
      // line before a def counts as block separation (cm-317).
      if (blankPending && info) { info.blankSep = true; blankPending = false; }
      pos = r.next; continue;
    }
    // setext heading: paragraph lines + underline (checked inside the
    // paragraph routine, which also handles tables)
    r = tryTable(src, pos, defs);
    if (r) { notePush(); toks.push(r.tok); pos = r.next; continue; }
    r = tryParagraph(src, pos, defs, lazySet, mode);
    if (r) { notePush(); toks.push(r.tok); pos = r.next; continue; }
    // fallback: consume one line as text (should not happen)
    pos = nextPos;
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Rendering.

// Plain escape (no entity lookahead) for code spans and code blocks.
const ESC_PLAIN_RE = /[&<>"']/g;
function escPlain(s) {
  return s.replace(ESC_PLAIN_RE, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function renderBlocks(toks, defs, tight, st) {
  let out = '';
  for (const tok of toks) {
    switch (tok.t) {
      case 'code': {
        out += '<pre><code';
        if (tok.lang !== null) out += ' class="language-' + esc(tok.lang) + '"';
        out += '>' + escPlain(tok.text) + '</code></pre>\n';
        break;
      }
      case 'heading':
        out += '<h' + tok.level + '>' + renderInline(tok.text, defs, st) + '</h' + tok.level + '>\n';
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'quote':
        out += '<blockquote>\n' + renderBlocks(tok.items, defs, false, st) + '</blockquote>\n';
        break;
      case 'list': {
        out += tok.ordered ? '<ol' + (tok.start !== 1 ? ' start="' + tok.start + '"' : '') + '>\n' : '<ul>\n';
        for (const item of tok.items) {
          let body = '';
          // marked's task rule: the checkbox is only a task when the
          // item's first token is text/paragraph; in a loose list it is
          // unshifted into that paragraph's inline tokens (inside <p>),
          // in a tight list it goes before the item's text.
          const firstIsPara = item.blocks.length > 0 && item.blocks[0].t === 'para';
          if (item.task >= 0 && firstIsPara) {
            const cb = item.task === 1
              ? '<input checked="" disabled="" type="checkbox"> '
              : '<input disabled="" type="checkbox"> ';
            if (tok.loose) {
              const first = item.blocks[0];
              body += '<p>' + cb + renderInline(first.text, defs, st) + '</p>\n';
              body += renderBlocks(item.blocks.slice(1), defs, false, st);
            } else {
              body += cb + renderBlocks(item.blocks, defs, true, st);
            }
          } else {
            body += renderBlocks(item.blocks, defs, !tok.loose, st);
          }
          out += '<li>' + body + '</li>\n';
        }
        out += tok.ordered ? '</ol>\n' : '</ul>\n';
        break;
      }
      case 'html':
        out += tok.text;
        break;
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let i = 0; i < tok.header.length; i++) {
          const a = tok.align[i];
          out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(tok.header[i], defs, st) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (tok.rows.length > 0) {
          out += '<tbody>';
          for (const row of tok.rows) {
            out += '<tr>\n';
            for (let i = 0; i < row.length; i++) {
              const a = tok.align[i];
              out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(row[i], defs, st) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
      case 'para': {
        if (tight) out += renderInline(tok.text, defs, st);
        else out += '<p>' + renderInline(tok.text, defs, st) + '</p>\n';
        break;
      }
    }
  }
  return out;
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const defs = new Map();
  const toks = lexBlocks(src, defs, null);
  // document-level inline state (marked's Lexer state): an opening
  // <a ...> tag suppresses later bare-URL/email autolinks until </a>
  const st = { inLink: false };
  return renderBlocks(toks, defs, false, st);
}

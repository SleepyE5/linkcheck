/**
 * Markdown link extraction.
 *
 * The job is not "find things that look like URLs". It is: find the links a
 * reader would actually follow, and nothing else. That distinction is where
 * the bugs live — a link inside a fenced code block is documentation of a
 * syntax, not a promise that the file exists, and reporting it makes the tool
 * noise people switch off.
 *
 * Strategy: mask the regions that must not be scanned (front matter, fenced
 * code, inline code, HTML comments) by replacing their characters with spaces
 * of exactly the same length. Offsets and line numbers therefore stay valid
 * for every position the scanner reports, and the scanner itself never has to
 * think about what it is standing in.
 */

const isSpace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/** Blank out `start..end` without changing the length of the text. */
function mask(src, out, start, end) {
  for (let i = start; i < end && i < out.length; i++) {
    // newlines must survive, or every line number below the region is wrong
    out[i] = src[i] === '\n' ? '\n' : ' ';
  }
}

/**
 * Return a space-padded copy of `src` with all non-scannable regions blanked.
 * Exported separately so the masking can be tested on its own — when a line
 * number is wrong, the mask is almost always why.
 */
export function maskable(src) {
  const out = src.split('');
  const len = src.length;

  // --- YAML front matter: only when the very first line is exactly ---
  if (src.startsWith('---\n') || src.startsWith('---\r\n')) {
    const close = src.indexOf('\n---', 4);
    const endLine = src.indexOf('\n', 4);
    if (close !== -1 && (src.indexOf('\n---', endLine + 1) === close)) {
      const tail = src.indexOf('\n', close + 1);
      mask(src, out, 0, tail === -1 ? len : tail + 1);
    } else {
      // unterminated front matter: treat the whole file as front matter rather
      // than inventing links out of a config block
      mask(src, out, 0, len);
    }
  }

  // --- fenced code blocks: ``` or ~~~, three or more, with an info string ---
  const fenceRe = /^([ \t]*)(`{3,}|~{3,})[ \t]*(.*)$/gm;
  let m;
  while ((m = fenceRe.exec(src)) !== null) {
    // skip a fence that is already inside a masked region: the closing fence of
    // the block before it looks exactly like an opening one
    if (out[m.index + m[1].length] === ' ') continue;
    const marker = m[2][0];
    const width = m[2].length;
    const bodyStart = m.index + m[0].length + 1;
    // the closing fence must use the same character and be at least as wide
    const closeRe = new RegExp(`^[ \\t]{0,3}${marker === '`' ? '`' : '~'}{${width},}[ \\t]*$`, 'gm');
    closeRe.lastIndex = bodyStart;
    let c;
    let end = len;
    while ((c = closeRe.exec(src)) !== null) {
      if (c.index >= bodyStart) { end = c.index; break; }
    }
    // an unclosed fence swallows the rest of the file, which is what a
    // renderer does, so a stray ``` cannot leak fake links
    mask(src, out, m.index, end === len ? len : src.indexOf('\n', end) === -1 ? len : src.indexOf('\n', end) + 1);
    if (end === len) break;
  }

  // --- HTML comments ---
  let from = 0;
  while ((from = src.indexOf('<!--', from)) !== -1) {
    const to = src.indexOf('-->', from + 4);
    if (to === -1) { mask(src, out, from, len); break; }
    mask(src, out, from, to + 3);
    from = to + 3;
  }

  // --- inline code spans: a run of backticks closes a run of the same length ---
  let i = 0;
  while (i < len) {
    if (src[i] !== '`' || out[i] === ' ') { i++; continue; }
    let run = 0;
    while (src[i + run] === '`') run++;
    const open = i;
    let j = i + run;
    let closed = -1;
    while (j < len) {
      if (src[j] === '`') {
        let r2 = 0;
        while (src[j + r2] === '`') r2++;
        if (r2 === run) { closed = j + run; break; }
        j += r2;
      } else j++;
    }
    if (closed === -1) { mask(src, out, open, len); break; }
    mask(src, out, open, closed);
    i = closed;
  }

  return out.join('');
}

/**
 * Find the end of a balanced `(...)` group starting at `open`.
 * Handles nesting, escapes, and angle-bracket destinations that may contain
 * spaces and parentheses. Returns the index just past the closing paren, or -1.
 */
function matchParens(src, open) {
  let depth = 0;
  let i = open;
  let angle = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '<') { angle = true; }
    else if (ch === '>') { angle = false; }
    else if (!angle) {
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return i + 1; }
      // a newline inside the destination means this is not a link
      else if (ch === '\n') return -1;
    }
    i++;
  }
  return -1;
}

/** Strip a `"title"` or `'title'` or `(title)` suffix off a destination. */
function splitDestination(raw) {
  let s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) return { dest: s.slice(1, -1).trim(), title: '' };
  // strip a trailing quoted or parenthesised title, anchored at the end so an
  // apostrophe inside the destination itself cannot be mistaken for one
  const title = s.match(/[ \t]+("(?:[^"]*)"|'(?:[^']*)'|\((?:[^)]*)\))$/);
  if (title) {
    const dest = s.slice(0, title.index).trim();
    if (dest) return { dest, title: title[1] };
  }
  return { dest: s, title: '' };
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src[i] === '\n') line++;
  return line;
}

/**
 * Extract every link a reader could follow.
 *
 * Returns objects of the shape
 *   { kind, text, dest, line, raw }
 * where kind is 'link' | 'image' | 'autolink' | 'html-a' | 'html-img' |
 * 'reference-def'.
 */
export function extractLinks(markdown) {
  const src = maskable(markdown);
  const found = [];
  const seen = new Set();
  const push = (kind, text, dest, index, raw) => {
    const key = `${kind}:${index}:${dest}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind, text, dest, line: lineOf(markdown, index), raw });
  };

  // --- reference definitions: [label]: destination "title" ---
  const defRe = /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(\S.*?)[ \t]*$/gm;
  let d;
  while ((d = defRe.exec(src)) !== null) {
    const { dest } = splitDestination(d[2]);
    push('reference-def', d[1], dest, d.index, d[0]);
  }

  // --- inline links and images: !?[text](dest) ---
  const linkRe = /(!?)\[((?:[^\[\]\\]|\\.)*)\]\(/g;
  let l;
  while ((l = linkRe.exec(src)) !== null) {
    const open = l.index + l[0].length - 1;
    const close = matchParens(src, open);
    if (close === -1) continue;
    const { dest } = splitDestination(src.slice(open + 1, close - 1));
    push(l[1] ? 'image' : 'link', l[2], dest, l.index, l[0] + src.slice(open + 1, close - 1) + ')');
    linkRe.lastIndex = close;
  }

  // --- reference links: [text][label], [label][], [label] ---
  const refRe = /(!?)\[((?:[^\[\]\\]|\\.)*)\](?:[ \t\n]{0,3}\[([^\]\n]*)\])?/g;
  let r;
  while ((r = refRe.exec(src)) !== null) {
    // an inline link was already handled; a following ( means it is not a reference
    const after = src[r.index + r[0].length];
    if (after === '(') continue;
    const label = (r[3] && r[3].length) ? r[3] : r[2];
    if (!label.trim()) continue;
    push(r[1] ? 'image-ref' : 'link-ref', r[2], label, r.index, r[0]);
  }

  // --- autolinks: <https://example.com> ---
  const autoRe = /<((?:https?|ftp):\/\/[^\s<>]+)>/g;
  let a;
  while ((a = autoRe.exec(src)) !== null) push('autolink', a[1], a[1], a.index, a[0]);

  // --- raw HTML anchors and images ---
  const htmlA = /<a\b[^>]*?href[ \t]*=[ \t]*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let h;
  while ((h = htmlA.exec(src)) !== null) {
    push('html-a', '', h[2] ?? h[3] ?? h[4] ?? '', h.index, h[0]);
  }
  const htmlImg = /<img\b[^>]*?src[ \t]*=[ \t]*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  while ((h = htmlImg.exec(src)) !== null) {
    push('html-img', '', h[2] ?? h[3] ?? h[4] ?? '', h.index, h[0]);
  }

  return found.sort((x, y) => x.line - y.line);
}

/** Every heading in the document, lowercased and slugified the way GitHub does. */
export function headingAnchors(markdown) {
  const src = maskable(markdown);
  const anchors = new Set();
  const re = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const slug = m[1]
      .toLowerCase()
      .replace(/`/g, '')
      .replace(/[^\w\u00c0-\uffff \-]/g, '')
      .trim()
      .replace(/ /g, '-');
    if (slug) anchors.add(slug);
  }
  // explicit {#anchor} and <a id="..."> targets
  const explicit = /\{#([\w-]+)\}|<a[^>]*?\bid[ \t]*=[ \t]*"([^"]+)"/gi;
  while ((m = explicit.exec(src)) !== null) anchors.add((m[1] || m[2]).toLowerCase());
  return anchors;
}

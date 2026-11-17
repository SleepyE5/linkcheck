import { REASON_HINT } from './reasons.js';

/**
 * Turning a run into something a person reads.
 *
 * Two rules shape this file. CI logs are read at terminal width, so the
 * destination column has to survive 80 columns: long URLs are cut in the
 * middle, where the part that distinguishes them stays visible, and never at
 * the end. And the last line has to answer "how bad is this" without scrolling
 * up, which is why unreachable URLs get their own sentence rather than being
 * folded in with the broken ones.
 */

const ESC = String.fromCharCode(27);
const wrap = (code) => (text) => ESC + '[' + code + 'm' + text + ESC + '[0m';
const styles = {
  on: { head: wrap('1;36'), dest: wrap('36'), bad: wrap('31'), dim: wrap('90') },
  off: { head: (s) => s, dest: (s) => s, bad: (s) => s, dim: (s) => s },
};

/**
 * Shorten without hiding the ending. Truncating a URL at the back turns
 * /docs/v1/intro.md and /docs/v1/other.md into the same string, which is the
 * one thing a report must not do.
 */
export function middle(dest, room) {
  if (dest.length <= room) return dest;
  const ELLIPSIS = String.fromCharCode(8230);
  const keep = room - 1;
  // For a URL the host and the last path segment are the two halves that
  // identify it, and everything in between is decoration.
  const origin = dest.match(/^https?:\/\/[^/]+/)?.[0];
  if (origin && origin.length < keep) return origin + ELLIPSIS + dest.slice(dest.length - (keep - origin.length));
  const head = Math.ceil(keep * 0.55);
  return dest.slice(0, head) + ELLIPSIS + dest.slice(dest.length - (keep - head));
}

const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

/** One block per file, so a reader fixes a file at a time instead of hunting. */
export function formatText(result, { color = false, width = 80, quiet = false } = {}) {
  const c = color ? styles.on : styles.off;
  const problems = result.findings;

  if (quiet) return describeCounts(result, c) + EOL;
  if (problems.length === 0) return clean(result, c) + EOL;

  // the longest reason is `unusable-image-url`; past that the column is wasting
  // room the destination needs
  const reasonWidth = Math.min(18, Math.max(...problems.map(p => p.reason.length)));
  const rowStart = 2 + 4 + 2 + reasonWidth + 2; // indent, line number, gaps

  const lines = [];
  let current = null;
  for (const p of problems) {
    if (p.file !== current) {
      if (current !== null) lines.push('');
      current = p.file;
      lines.push(c.head(current));
    }
    const dest = p.dest ?? '';
    let hint = REASON_HINT[p.reason] ?? '';
    // The hint is a courtesy; it never gets to push the destination off the
    // screen, and a destination is never cut to make room for one.
    let room = width - rowStart - hint.length - 2;
    if (room < 16) { hint = ''; room = width - rowStart - 2; }
    lines.push('  ' + String(p.line).padStart(4) + '  ' + c.bad(p.reason.padEnd(reasonWidth)) +
      '  ' + c.dest(middle(dest, Math.max(12, room))) + (hint ? '  ' + c.dim(hint) : ''));
  }
  lines.push('');
  lines.push(describeCounts(result, c));
  return lines.join(EOL) + EOL;
}

const EOL = String.fromCharCode(10);

function clean(result, c) {
  return c.dest('no broken links') + '  ' + c.dim(counts(result) + footnote(result));
}

function describeCounts(result, c) {
  const n = result.findings.length;
  const files = new Set(result.findings.map(f => f.file)).size;
  const head = n === 0
    ? 'no broken links'
    : c.bad(plural(n, 'problem')) + ' in ' + plural(files, 'file');
  return head + '  ·  ' + c.dim(counts(result) + footnote(result));
}

/** The part of the summary that is about the run rather than the verdict. */
function counts(result) {
  const scanned = 'checked ' + plural(result.files.length, 'file') + ', ' + plural(result.links, 'link');
  const urls = result.checkedUrls ? ', ' + plural(result.checkedUrls, 'URL') + ' over the network' : '';
  return scanned + urls;
}

function footnote(result) {
  if (!result.unreachable?.length) return '';
  return '  ·  ' + plural(result.unreachable.length, 'URL') + ' unreachable, not counted as broken';
}

/** Stable, line-oriented, and complete: nothing a fix needs is left out. */
export function formatJson(result) {
  return JSON.stringify({
    tool: 'linkcheck',
    version: result.version,
    root: result.root,
    summary: {
      files: result.files.length,
      links: result.links,
      problems: result.findings.length,
      urlsChecked: result.checkedUrls ?? 0,
      unreachable: (result.unreachable ?? []).map(u => ({ url: u.url, detail: u.detail })),
    },
    unreadable: result.unreadable,
    problems: result.findings.map(f => ({
      file: f.file,
      line: f.line,
      kind: f.kind,
      destination: f.dest,
      reason: f.reason,
      message: f.detail,
      hint: REASON_HINT[f.reason],
    })),
  }, null, 2) + EOL;
}

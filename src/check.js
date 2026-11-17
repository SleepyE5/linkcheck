import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath, relative, isAbsolute } from 'node:path';
import { extractLinks, headingAnchors } from './markdown.js';

/**
 * Resolving extracted links against the filesystem.
 *
 * Everything that decides "is this broken?" lives here, and nothing that
 * touches disk without saying so. The vocabulary of reasons is the tool's
 * contract with the reader, so each one is written to name the mistake and the
 * place to fix it.
 */

/** Schemes no browser can load as an image. */
const DEAD_IMAGE_SCHEMES = new Set(['mailto', 'tel', 'sms', 'javascript', 'blob']);

const IMAGE_KINDS = new Set(['image', 'image-ref', 'html-img']);

/**
 * Sort one destination into the thing it actually is.
 * The categories are not stylistic: each one has a different definition of
 * "broken", and getting the category wrong is how a checker ends up
 * complaining about mailto links.
 */
export function classify(dest) {
  if (dest === '' || dest === '#') return { type: 'empty' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(dest) && !/^file:/i.test(dest)) {
    const scheme = dest.slice(0, dest.indexOf(':')).toLowerCase();
    if (scheme === 'http' || scheme === 'https') return { type: 'external', url: dest };
    // data: is a real inline image, mailto:/tel:/ftp:/sms: are real links.
    // None of them can be checked on disk, and calling them broken is a bug.
    return { type: 'other', scheme };
  }
  if (dest.startsWith('//')) return { type: 'external', url: 'https:' + dest };
  const hashAt = dest.indexOf('#');
  const path = hashAt === -1 ? dest : dest.slice(0, hashAt);
  const anchor = hashAt === -1 ? '' : dest.slice(hashAt + 1);
  if (path === '') return { type: 'anchor', anchor };
  return { type: 'path', path, anchor, rootRelative: path.startsWith('/') };
}

/** Percent-decode, reporting a malformed escape instead of throwing. */
export function decodePath(p) {
  try {
    return { ok: true, value: decodeURIComponent(p) };
  } catch {
    // a stray % in a filename is common enough that it must not crash the run
    return { ok: false, value: p };
  }
}

const anchorCache = new Map();

/** Lexical containment — `..` has already been folded away by resolvePath. */
function inside(abs, dir) {
  if (!dir) return true;
  const rel = relative(dir, abs);
  // '' means the link points at the tree itself, which is inside it
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Heading targets of a markdown file, cached because one file is often linked to many times. */
export function anchorsFor(absFile) {
  if (anchorCache.has(absFile)) return anchorCache.get(absFile);
  let set = new Set();
  try {
    if (/\.mdx?$/i.test(absFile)) set = headingAnchors(readFileSync(absFile, 'utf8'));
  } catch { /* unreadable: the file check already reports it */ }
  anchorCache.set(absFile, set);
  return set;
}

/** Callers that re-check a tree after editing it must not read stale anchors. */
export function clearAnchorCache() { anchorCache.clear(); }

/**
 * Check one file's links against the filesystem.
 *
 * `file` only has to exist as a path: pass `markdown` to check text you already
 * hold, which is what the tests and any editor integration do.
 *
 * `root` is the directory links that start with / resolve against — normally
 * the repository root, because that is what GitHub does.
 */
export function checkFile(file, { root, definitions, markdown }) {
  const text = markdown ?? readFileSync(file, 'utf8');
  const links = extractLinks(text);
  const findings = [];
  const ownAnchors = headingAnchors(text);
  const base = dirname(file);

  const report = (link, reason, detail) =>
    findings.push({ file, line: link.line, kind: link.kind, dest: link.dest, reason, detail });

  /*
   * Reference definitions. The first definition of a label wins, the way a
   * renderer reads them.
   *
   * A broken definition is reported at the definition and not again at every
   * use: one dead URL in a README's footer would otherwise produce one error
   * per mention, which is noise that teaches people to ignore the tool.
   */
  const defs = new Map();
  for (const link of links) {
    if (link.kind !== 'reference-def') continue;
    const label = link.text.toLowerCase();
    if (!defs.has(label)) defs.set(label, { dest: link.dest, link, dead: false });
  }
  for (const def of defs.values()) {
    const before = findings.length;
    verify(def.link, def.dest, base);
    def.dead = findings.length > before;
  }

  for (const link of links) {
    if (link.kind === 'reference-def') continue;

    if (link.kind === 'link-ref' || link.kind === 'image-ref') {
      const label = link.dest.toLowerCase();
      const def = defs.get(label) ?? definitions?.get(label);
      if (!def) {
        // A single-bracket shortcut reference with no definition is not a
        // broken link — GitHub renders it as literal text, and so do readers.
        // Reporting every [sic] or [1] in prose would make the tool useless.
        if (link.raw.includes('][') || link.raw.endsWith('][]')) {
          report(link, 'missing-reference', `no definition for [${link.dest}]`);
        }
        continue;
      }
      // a local definition already reported its own failure, at its own line
      if (def.link) continue;
      verify(link, def.dest, base);
      continue;
    }
    verify(link, link.dest, base);
  }

  function verify(link, dest, fromDir) {
    const cls = classify(dest);
    switch (cls.type) {
      case 'empty':
        report(link, 'empty-destination', 'a link with nothing in it goes nowhere');
        return;
      case 'other':
        if (IMAGE_KINDS.has(link.kind) && DEAD_IMAGE_SCHEMES.has(cls.scheme))
          report(link, 'unusable-image-url', `${cls.scheme}: cannot be loaded as an image`);
        return;
      case 'external':
        // existence of an external URL is not knowable here; --external does that
        return;
      case 'anchor': {
        const a = decodePath(cls.anchor);
        if (!a.ok) { report(link, 'malformed-anchor', `bad percent-encoding in #${cls.anchor}`); return; }
        if (!ownAnchors.has(a.value.toLowerCase()))
          report(link, 'missing-anchor', `no heading matches #${cls.anchor}`);
        return;
      }
      case 'path': {
        const dec = decodePath(cls.path);
        if (!dec.ok) { report(link, 'malformed-url', `bad percent-encoding in ${cls.path}`); return; }
        // resolvePath would treat a leading / as an absolute filesystem path
        // and walk straight out of the repository, so strip it first
        const rel = cls.rootRelative ? dec.value.replace(/^\/+/, '') : dec.value;
        const abs = resolvePath(cls.rootRelative ? root : fromDir, rel);
        if (!existsSync(abs)) {
          report(link, cls.rootRelative ? 'missing-from-root' : 'missing-file',
            `${dest} does not exist${cls.rootRelative ? ` under ${root}` : ''}`);
          return;
        }
        if (!inside(abs, root)) {
          // real on your laptop, dead on GitHub: the target is outside the tree
          // a reader gets served from, so no host can resolve it
          report(link, 'outside-root', `${dest} leaves ${root}`);
          return;
        }
        if (!cls.anchor) return;
        let isDir = false;
        try { isDir = statSync(abs).isDirectory(); } catch { /* reported above */ }
        // a directory link is legitimate on GitHub; only markdown files have
        // headings to be missing, and a file with no headings at all is not
        // proof that the anchor is wrong
        if (cls.anchor && !isDir && /\.mdx?$/i.test(abs)) {
          const a = decodePath(cls.anchor);
          const set = anchorsFor(abs);
          if (a.ok && set.size && !set.has(a.value.toLowerCase()))
            report(link, 'missing-anchor', `${dec.value} has no heading matching #${cls.anchor}`);
        }
        return;
      }
    }
  }

  return findings.sort((x, y) => x.line - y.line);
}

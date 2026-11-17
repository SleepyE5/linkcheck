import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Deciding which files to read.
 *
 * The interesting part is not the recursion, it is agreeing with git about what
 * counts as source. Vendored code, a build output, a node_modules full of other
 * people's READMEs — checking those produces errors you cannot fix, which is
 * the fastest way to make a lint tool unused.
 *
 * So: ask git when git is available (tracked plus untracked-but-not-ignored is
 * exactly the set of files you are about to commit), and fall back to a manual
 * walk with a conservative ignore list when it is not.
 */

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.mdx'];

/** Directory names that are never the user's own prose. */
export const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', '.jj',
  'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.astro', '.cache', '.parcel-cache', '.venv', 'venv',
  '__pycache__', '.tox', 'site-packages',
  '.idea', '.vscode', '.obsidian',
]);

/** Files whose links belong to a tool, not to a person. */
export const SKIP_FILES = new Set(['CHANGELOG.generated.md', 'package-lock.json']);

/** Extensions that are not text at all. */
const BINARY = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.pdf', '.zip',
  '.gz', '.bz2', '.7z', '.jar', '.dll', '.so', '.dylib', '.woff', '.woff2',
  '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.webm', '.exe', '.dmg',
]);

const ext = (p) => {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
};

/**
 * Match a `/`-separated relative path against the user's ignore patterns.
 *
 * The rules are gitignore's, because that is what people type:
 *   node_modules   a name with no slash matches at any depth, and takes
 *                  everything under it with it
 *   /docs/*        a slash anchors the pattern to the root of the tree, and *
 *                  then matches one segment and no more
 *   docs/**        ** crosses separators
 *   *.{js,map}     braces expand
 */
export function matchesIgnore(relPath, patterns) {
  for (const raw of patterns ?? []) {
    const pattern = raw.replace(/\/+$/, '');
    if (!pattern) continue;
    const body = pattern.startsWith('/') ? pattern.slice(1) : pattern;
    if (body.includes('/')) {
      if (globToRe(body).test(relPath)) return true;
    } else {
      // a bare name: match the file itself or any directory above it, which is
      // how `docs` comes to ignore a whole subtree
      const re = globToRe(body);
      if (relPath.split('/').some(seg => re.test(seg))) return true;
    }
  }
  return false;
}

function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        // `**/` may span zero directories, so `docs/**/x` matches `docs/x`
        i += 2;
        re += '(?:[^/]*/)*';
      } else {
        // a trailing `**` reaches everything below it
        i++;
        re += '.*';
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{' && glob.includes('}', i)) {
      const close = glob.indexOf('}', i);
      const opts = glob.slice(i + 1, close).split(',');
      re += '(?:' + opts.map(escapeRe).join('|') + ')';
      i = close;
    } else if (c === '[' && glob.includes(']', i)) {
      const close = glob.indexOf(']', i);
      re += glob.slice(i, close + 1);
      i = close;
    } else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ask git for the files it considers part of the work. Null when it cannot answer. */
function fromGit(root) {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** Manual walk, for a plain directory or an unpacked tarball. */
function fromDisk(root) {
  const found = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue; // unreadable directory: not our business
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // a symlinked tree can cycle back on itself
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(child);
      } else if (e.isFile() && !SKIP_FILES.has(e.name)) {
        found.push(child);
      }
    }
  }
  return found;
}

/**
 * List every path to check, `/`-separated and relative to `root`, sorted.
 *
 * `what` selects markdown ('md'), everything that is not obviously binary
 * ('all'), or an explicit extension list.
 */
export function walkFiles(root, { ignore = [], extensions = MARKDOWN_EXTENSIONS, source } = {}) {
  const wanted = extensions === 'all' ? null : new Set(extensions);
  const list = (source ?? fromGit(root)) ?? fromDisk(root);
  const out = [];
  for (const rel of list) {
    const path = rel.split(sep).join('/');
    if (path.split('/').some(seg => SKIP_DIRS.has(seg))) continue;
    if (SKIP_FILES.has(path.slice(path.lastIndexOf('/') + 1))) continue;
    if (wanted ? !wanted.has(ext(path)) : BINARY.has(ext(path))) continue;
    if (matchesIgnore(path, ignore)) continue;
    out.push(path);
  }
  return out.sort();
}

/** True when `dir` is inside a git work tree, for the report's provenance line. */
export function isGitRepo(dir) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** Cheap gate the CLI uses before spending a read on a file. */
export function looksTextual(path) {
  return !BINARY.has(ext(path));
}

export function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

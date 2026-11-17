#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { checkFile, clearAnchorCache } from './check.js';
import { walkFiles, matchesIgnore, isDirectory } from './walk.js';
import { checkUrls } from './external.js';
import { extractLinks } from './markdown.js';
import { formatText, formatJson } from './report.js';

export const VERSION = '0.1.0';

export const USAGE = `linkcheck ${VERSION} - find broken relative links and missing images in Markdown

  linkcheck [path ...] [options]

Reads every markdown file under the given paths (the current directory when
none are given) and reports the links that do not resolve.

Options
  --root <dir>        directory that /links resolve against
                      (default: the git top-level, else the first path given)
  -e, --external      also ask the network about http(s) URLs
  --concurrency <n>   parallel external checks (default 8)
  --timeout <ms>      per-URL timeout (default 10000)
  -i, --ignore <glob> skip files matching a gitignore-style pattern; repeatable
  -x, --exclude <glob> skip links whose destination matches; repeatable
  -a, --allow <reason> drop one reason from the report; repeatable
      --no-anchors    do not check #fragment targets
      --config <file> read this instead of ./.linkcheck.json
      --json          machine-readable output on stdout
      --no-color      never colourise
  -q, --quiet         only the summary line
  -h, --help          this text
  -V, --version       print the version

Exit status
  0 nothing broken    1 findings    2 the tool could not run

Reasons
  missing-file, missing-from-root, missing-anchor, missing-reference,
  empty-destination, malformed-url, malformed-anchor, unusable-image-url,
  outside-root, broken-url
`;

const SHORT = {
  '-i': '--ignore', '-x': '--exclude', '-a': '--allow', '-e': '--external',
  '-h': '--help', '-V': '--version', '-q': '--quiet', '-r': '--root',
};

/**
 * Split argv into options.
 *
 * Hand-rolled on purpose: this is forty lines with no dependency, where the
 * alternative is pulling in someone else's help formatter for a tool that
 * advertises zero runtime dependencies. `--flag value` and `--flag=value` both
 * work, `--` ends the flags, and anything else is a path.
 */
export function parseArgs(argv) {
  const opts = {
    paths: [], ignore: [], exclude: [], allow: [],
    external: false, anchors: true, json: false, quiet: false, color: undefined,
    concurrency: 8, timeout: 10000, root: null, config: null, help: false, version: false,
  };
  const errors = [];
  let onlyPaths = false;

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (onlyPaths) { opts.paths.push(arg); continue; }
    if (arg === '--') { onlyPaths = true; continue; }

    let inline = null;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 0) { inline = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    arg = SHORT[arg] ?? arg;

    const takeValue = () => {
      if (inline !== null) return inline;
      const next = argv[++i];
      if (next === undefined) { errors.push(`${arg} needs a value`); return undefined; }
      if (next.startsWith('-') && next !== '-') { errors.push(`${arg} needs a value, not another flag`); return undefined; }
      return next;
    };
    const pushList = (key) => { const v = takeValue(); if (v !== undefined) opts[key].push(v); };

    switch (arg) {
      case '--root': { const v = takeValue(); if (v !== undefined) opts.root = resolve(v); break; }
      case '--config': { const v = takeValue(); if (v !== undefined) opts.config = v; break; }
      case '--concurrency': { const v = takeValue(); if (v !== undefined) opts.concurrency = Number(v); break; }
      case '--timeout': { const v = takeValue(); if (v !== undefined) opts.timeout = Number(v); break; }
      case '--ignore': pushList('ignore'); break;
      case '--exclude': pushList('exclude'); break;
      case '--allow': pushList('allow'); break;
      case '--external': opts.external = true; break;
      case '--no-anchors': opts.anchors = false; break;
      case '--json': opts.json = true; break;
      case '--color': opts.color = true; break;
      case '--no-color': opts.color = false; break;
      case '--quiet': opts.quiet = true; break;
      case '--help': opts.help = true; break;
      case '--version': opts.version = true; break;
      default:
        if (arg.startsWith('-') && arg !== '-') errors.push(`unknown option: ${arg}`);
        else opts.paths.push(arg);
    }
  }

  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) errors.push('--concurrency must be a positive whole number');
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1) errors.push('--timeout must be a positive whole number');
  if (opts.paths.length > 1 && opts.root === null)
    errors.push('with more than one path, --root has to say what a /link means');
  for (const p of [...opts.ignore, ...opts.exclude])
    if (!p?.trim()) errors.push('empty pattern: --ignore and --exclude need something to match');

  return { opts, errors };
}

/** `.linkcheck.json`: the settings a whole team should not have to repeat. */
export function loadConfig(cwd, explicitPath) {
  const file = explicitPath ? resolve(cwd, explicitPath) : join(cwd, '.linkcheck.json');
  if (!existsSync(file)) {
    if (explicitPath) throw new Error(`no config at ${file}`);
    return { file: null, config: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not readable JSON: ${err.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} must contain an object`);
  const known = new Set(['ignore', 'exclude', 'allow', 'external', 'root', 'concurrency', 'timeout', 'anchors']);
  for (const key of Object.keys(parsed)) {
    // a typo in a config key would switch a rule off silently, which is worse
    // than failing: the build goes green for the wrong reason
    if (!known.has(key)) throw new Error(`${file}: unknown key "${key}"`);
    if (['ignore', 'exclude', 'allow'].includes(key) && !Array.isArray(parsed[key]))
      throw new Error(`${file}: "${key}" must be an array`);
    if (['timeout', 'concurrency'].includes(key) && !Number.isInteger(parsed[key]))
      throw new Error(`${file}: "${key}" must be an integer`);
  }
  return { file, config: parsed };
}

/** Command line wins over the file, the file wins over the defaults. */
export function merge(opts, config) {
  const out = { ...opts };
  out.ignore = [...(config.ignore ?? []), ...opts.ignore];
  out.exclude = [...(config.exclude ?? []), ...opts.exclude];
  out.allow = [...(config.allow ?? []), ...opts.allow];
  if (config.external === true) out.external = true;
  if (config.anchors === false) out.anchors = false;
  if (out.root === null && config.root) out.root = resolve(process.cwd(), config.root);
  if (opts.concurrency === 8 && config.concurrency) out.concurrency = config.concurrency;
  if (opts.timeout === 10000 && config.timeout) out.timeout = config.timeout;
  return out;
}

function gitTopLevel(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

/**
 * Where /links resolve from, and therefore what the report calls a path.
 * Both come out of one decision: a report whose paths disagree with the
 * resolution root is a report nobody can act on.
 */
export function planTargets({ paths, root: chosen }, cwd = process.cwd()) {
  const abs = (paths.length ? paths : ['.']).map(p => resolve(cwd, p));
  const missing = abs.filter(p => !existsSync(p));
  if (missing.length) throw new Error(`no such file or directory: ${missing.join(', ')}`);
  const dirs = abs.filter(isDirectory);
  const root = chosen ?? (dirs.length === 1 ? (gitTopLevel(dirs[0]) ?? dirs[0]) : cwd);
  return { root, inputs: abs };
}

const isExternalDest = (dest = '') => /^https?:\/\//i.test(dest) || dest.startsWith('//');

/**
 * Read the files, resolve the links, optionally ask the network.
 *
 * Returns plain data: the terminal writer, --json and any later editor
 * integration all read the same run, and the whole thing is testable without a
 * child process.
 */
export async function run(argv, { cwd = process.cwd(), isTty = false, fetchImpl } = {}) {
  const { opts: parsed, errors } = parseArgs(argv);
  if (errors.length) return { usageError: errors.join('\n') };
  if (parsed.help) return { help: true };
  if (parsed.version) return { printVersion: VERSION };

  let opts;
  try {
    const { file, config } = loadConfig(cwd, parsed.config);
    opts = { ...merge(parsed, config), configFile: file };
  } catch (err) {
    return { usageError: err.message };
  }

  let plan;
  try { plan = planTargets(opts, cwd); } catch (err) { return { usageError: err.message }; }

  const listed = [];
  for (const input of plan.inputs) {
    if (isDirectory(input)) listed.push(...walkFiles(input, { ignore: opts.ignore }));
    else listed.push(relative(plan.root, input) || input);
  }
  const files = [...new Set(listed)].sort();

  const findings = [];
  const unreadable = [];
  const uses = new Map(); // external url -> every place it is linked from
  let links = 0;

  for (const file of files) {
    const abs = resolve(plan.root, file);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (err) {
      // a file git listed that the disk will not open is worth saying out loud
      unreadable.push({ file, detail: err.code ?? err.message });
      continue;
    }
    if (/^\s*(<\?xml|<!doctype html|<svg)/i.test(text)) continue; // not markdown, whatever it is called
    const extracted = extractLinks(text);
    links += extracted.length;

    for (const link of extracted) {
      if (!opts.external || !isExternalDest(link.dest)) continue;
      if (!uses.has(link.dest)) uses.set(link.dest, []);
      uses.get(link.dest).push({ file, line: link.line, kind: link.kind });
    }

    for (const f of checkFile(abs, { root: plan.root, markdown: text })) {
      if (f.reason === 'missing-anchor' && !opts.anchors) continue;
      if (opts.allow.includes(f.reason)) continue;
      if (opts.exclude.some(p => f.dest === p || matchesIgnore(f.dest, [p]) || f.dest.includes(p))) continue;
      findings.push({ ...f, file });
    }
  }

  let urls = [];
  if (uses.size) {
    urls = await checkUrls([...uses.keys()], { concurrency: opts.concurrency, timeoutMs: opts.timeout, fetchImpl });
    for (const r of urls) {
      if (r.result !== 'broken') continue;
      // one finding per document, at its first mention: the fix is one edit no
      // matter how many times the same dead URL was pasted in
      const byFile = new Map();
      for (const use of uses.get(r.url)) {
        const seen = byFile.get(use.file);
        if (!seen || use.line < seen.line) byFile.set(use.file, use);
      }
      for (const use of byFile.values()) {
        findings.push({ ...use, dest: r.url, reason: 'broken-url', detail: r.detail });
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  clearAnchorCache();

  const visible = findings;
  return {
    version: VERSION,
    root: plan.root,
    configFile: opts.configFile,
    files,
    links,
    findings: visible,
    unreachable: urls.filter(r => r.result === 'unreachable'),
    checkedUrls: urls.length,
    unreadable,
    opts,
    isTty,
  };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const sink = (stream) => (text) => {
    try { stream.write(text); }
    // EPIPE here means the reader downstream stopped early (`| head`), which is
    // a normal thing to do to this tool and not an error by it
    catch (err) { if (err?.code !== 'EPIPE') throw err; }
  };
  const write = io.write ?? sink(process.stdout);
  const fail = io.fail ?? sink(process.stderr);
  const result = await run(argv, { cwd: io.cwd ?? process.cwd(), isTty: io.isTty ?? Boolean(process.stdout.isTTY), fetchImpl: io.fetchImpl });

  if (result.usageError) {
    fail(`linkcheck: ${result.usageError}\n\nRun \`linkcheck --help\` for the options.\n`);
    return 2;
  }
  if (result.help) { write(USAGE); return 0; }
  // a finished run also carries result.version, so this branch has to key off a
  // shape only --help and --version produce
  if (result.printVersion) { write(VERSION + String.fromCharCode(10)); return 0; }

  const color = result.opts.color ?? result.isTty;
  const width = io.columns ?? (result.isTty ? process.stdout.columns : 80) ?? 80;
  if (result.opts.json) write(formatJson(result));
  else write(formatText(result, { color, width, quiet: result.opts.quiet }));

  return result.findings.length ? 1 : 0;
}

// `npm link` and a global install both put a symlink in PATH, so the entry test
// has to compare real paths, not the string argv was handed.
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`linkcheck: ${err?.stack ?? err}\n`);
    process.exitCode = 2;
  });
}

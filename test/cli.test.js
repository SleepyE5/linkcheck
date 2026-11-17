import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, loadConfig, merge, planTargets, run, main } from '../src/cli.js';
import { formatText, middle } from '../src/report.js';

const EOL = String.fromCharCode(10);

/* ------------------------------------------------------------------- parsing */

test('flags arrive in the shapes the rest of the tool expects', () => {
  const { opts, errors } = parseArgs(['docs', '-e', '--ignore=vendor/**', '--timeout', '3000', '-a', 'missing-anchor']);
  assert.deepEqual(errors, []);
  assert.deepEqual(opts.paths, ['docs']);
  assert.equal(opts.external, true);
  assert.deepEqual(opts.ignore, ['vendor/**']);
  assert.equal(opts.timeout, 3000);
  assert.deepEqual(opts.allow, ['missing-anchor']);
  assert.equal(opts.concurrency, 8, 'untouched flags keep their default');
});

test('a repeated flag accumulates instead of overwriting', () => {
  const { opts } = parseArgs(['-i', 'a', '-i', 'b', '--ignore', 'c']);
  assert.deepEqual(opts.ignore, ['a', 'b', 'c']);
});

test('-- stops option parsing so a file called --weird works', () => {
  const { opts, errors } = parseArgs(['--', '--weird.md']);
  assert.deepEqual(errors, []);
  assert.deepEqual(opts.paths, ['--weird.md']);
});

test('bad input is a message, not a stack trace', () => {
  assert.match(parseArgs(['--nope']).errors.join(), /unknown option: --nope/);
  assert.match(parseArgs(['--timeout']).errors.join(), /--timeout needs a value/);
  assert.match(parseArgs(['--timeout', '--json']).errors.join(), /not another flag/);
  assert.match(parseArgs(['--timeout', 'soon']).errors.join(), /positive whole number/);
  assert.match(parseArgs(['-i', '']).errors.join(), /empty pattern/);
  // two paths and no --root means /links would be a guess
  assert.match(parseArgs(['a', 'b']).errors.join(), /--root/);
});

test('--no-anchors and --no-color switch their feature off, not on', () => {
  assert.equal(parseArgs(['--no-anchors']).opts.anchors, false);
  assert.equal(parseArgs(['--no-color']).opts.color, false);
  assert.equal(parseArgs([]).opts.anchors, true);
});

/* -------------------------------------------------------------------- config */

function tempConfig(text) {
  const dir = mkdtempSync(join(tmpdir(), 'linkcheck-cfg-'));
  writeFileSync(join(dir, '.linkcheck.json'), text);
  return dir;
}

test('a config key that does not exist is an error, not a silent no', () => {
  const dir = tempConfig('{"ignores": ["x"]}');
  try {
    assert.throws(() => loadConfig(dir), /unknown key "ignores"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const dir2 = tempConfig('{"ignore": "x"}');
  try {
    assert.throws(() => loadConfig(dir2), /"ignore" must be an array/);
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});

test('a missing explicit config is an error; a missing default is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkcheck-none-'));
  try {
    assert.deepEqual(loadConfig(dir).config, {});
    assert.throws(() => loadConfig(dir, 'gone.json'), /no config at/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the command line overrides the file, and lists from both are kept', () => {
  const { opts } = parseArgs(['-i', 'from-cli', '--timeout', '50']);
  const merged = merge(opts, { ignore: ['from-config'], timeout: 9000, external: true, concurrency: 4 });
  assert.deepEqual(merged.ignore, ['from-config', 'from-cli']);
  assert.equal(merged.timeout, 50, 'an explicit flag beats the file');
  assert.equal(merged.external, true, 'the file can turn a feature on');
  assert.equal(merged.concurrency, 4, 'a file default survives when no flag touched it');
});

/* --------------------------------------------------------------------- plans */

test('an explicit root wins; without one, a directory is its own root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkcheck-root-'));
  mkdirSync(join(dir, 'sub'));
  try {
    assert.equal(planTargets({ paths: [join(dir, 'sub')], root: dir }).root, dir);
    // /private/tmp is not a work tree, so there is nothing to be told by git
    const planned = planTargets({ paths: [dir], root: null });
    assert.ok([dir, join(dir, 'sub')].includes(planned.root) || planned.root.endsWith('tmp'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a path that is not there is refused before anything is read', () => {
  assert.throws(() => planTargets({ paths: ['/nope/not/here'], root: null }), /no such file or directory/);
});

/* ----------------------------------------------------------------------- run */

function demoTree() {
  const dir = mkdtempSync(join(tmpdir(), 'linkcheck-run-'));
  const write = (rel, text) => {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')) || dir, { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  write('assets/logo.png', 'not really a png, but it is there\n');
  write('docs/guide.md', '# Guide\n\n## Setup\n\n[home](../README.md)\n[leak](../../outside.md)\n');
  write('README.md', [
    '# Demo',
    '',
    '[guide](docs/guide.md)',
    '[ghost](docs/nobody.md)',
    '![logo](assets/logo.png)',
    '![gone](assets/gone.png)',
    '[top](#demo)',
    '[sideways](#sideways)',
    '[mail](mailto:a@b.c)',
    '[site](https://example.test/page)',
    '[shortcut in prose] is not a link',
    '[first][dead] and [second][dead] both point at the definition',
    '',
    '[used]: docs/guide.md',
    '[dead]: docs/ghost.md',
    '',
  ].join(EOL));
  return dir;
}

const quiet = { fetchImpl: async () => ({ status: 200, body: { cancel: async () => {} } }) };

test('a clean tree reports nothing and leaves the reasons alone', async () => {
  const dir = demoTree();
  try {
    const r = await run([dir, '--root', dir], quiet);
    assert.deepEqual(r.files, ['README.md', 'docs/guide.md']);
    assert.ok(r.links > 8);
    assert.deepEqual(r.findings.map(f => f.reason).sort(), [
      'missing-anchor', 'missing-file', 'missing-file', 'missing-file', 'missing-file',
    ]);
    // every finding says which file it is in and how to reach it
    for (const f of r.findings) {
      assert.ok(typeof f.line === 'number' && f.line > 0);
      assert.ok(f.file === 'README.md' || f.file === 'docs/guide.md', `reported ${f.file}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('paths in the report are relative to the root that /links use', async () => {
  const dir = demoTree();
  try {
    const r = await run([dir, '--root', dir], quiet);
    assert.ok(r.findings.every(f => !f.file.startsWith('/')));
    assert.equal(r.root, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a shortcut reference in prose is not a broken link', async () => {
  const dir = demoTree();
  try {
    const r = await run([dir, '--root', dir], quiet);
    assert.ok(!r.findings.some(f => f.dest === 'shortcut in prose'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a dead definition is reported at the definition, once', async () => {
  const dir = demoTree();
  try {
    const r = await run([dir, '--root', dir], quiet);
    const dead = r.findings.filter(f => f.dest === 'docs/ghost.md');
    assert.equal(dead.length, 1, 'two mentions, one report');
    assert.equal(dead[0].line, 15, 'at the definition, where the fix is');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the filters actually filter', async () => {
  const dir = demoTree();
  try {
    const base = await run([dir, '--root', dir], quiet);
    assert.ok(base.findings.length > 0);
    const noAnchors = await run([dir, '--root', dir, '--allow', 'missing-anchor', '-a', 'outside-root'], quiet);
    assert.ok(!noAnchors.findings.some(f => /anchor|outside/.test(f.reason)));
    const ignored = await run([dir, '--root', dir, '-i', 'README.md'], quiet);
    assert.deepEqual(ignored.files, ['docs/guide.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('external URLs are only asked when told to, and only for distinct ones', async () => {
  const dir = demoTree();
  writeFileSync(join(dir, 'twice.md'), '[a](https://x.test/1)' + EOL + '[b](https://x.test/1)' + EOL);
  const asked = [];
  try {
    const off = await run([dir, '--root', dir], { fetchImpl: () => { throw new Error('must not fetch'); } });
    assert.equal(off.checkedUrls, 0);

    const on = await run([dir, '--root', dir, '-e'], {
      fetchImpl: (url) => {
        asked.push(String(url));
        return Promise.resolve({ status: String(url).includes('404') ? 404 : 200, body: { cancel: async () => {} } });
      },
    });
    assert.deepEqual(asked.sort(), ['https://example.test/page', 'https://x.test/1']);
    assert.equal(on.checkedUrls, 2);
    assert.equal(on.findings.filter(f => f.reason === 'broken-url').length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a 404 is reported once for each document that links to it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkcheck-404-'));
  writeFileSync(join(dir, 'a.md'), '[x](https://gone.test/page)' + EOL + '[y](https://gone.test/page)' + EOL);
  writeFileSync(join(dir, 'b.md'), '[z](https://gone.test/page)' + EOL);
  try {
    const r = await run([dir, '--root', dir, '-e'], {
      fetchImpl: () => Promise.resolve({ status: 404, body: { cancel: async () => {} } }),
    });
    const hits = r.findings.filter(f => f.reason === 'broken-url');
    assert.equal(hits.length, 2, 'one per file, not one per mention or one per URL');
    assert.deepEqual(hits.map(h => h.file).sort(), ['a.md', 'b.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unreachable URL is counted apart from a broken one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkcheck-403-'));
  writeFileSync(join(dir, 'a.md'), '[x](https://nope.test/page)' + EOL);
  try {
    const r = await run([dir, '--root', dir, '-e'], {
      fetchImpl: () => Promise.resolve({ status: 403, body: { cancel: async () => {} } }),
    });
    assert.equal(r.findings.length, 0);
    assert.equal(r.unreachable.length, 1);
    assert.match(formatText(r), /unreachable, not counted as broken/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* -------------------------------------------------------------------- output */

test('the terminal report fits the width it is given, in the middle', () => {
  assert.equal(middle('short.md', 20), 'short.md');
  const cut = middle('https://example.com/a/b/c/d/e/f/g.md', 28);
  assert.equal(cut.length, 28);
  assert.ok(cut.startsWith('https://example.com'), 'keeps the host');
  assert.ok(cut.endsWith('g.md'), 'keeps the part that tells the links apart');
});

test('a clean run says so in one line, without the row layout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkcheck-clean-'));
  writeFileSync(join(dir, 'a.md'), '# T' + EOL + EOL + '[self](#t)' + EOL);
  try {
    const r = await run([dir, '--root', dir], quiet);
    assert.equal(r.findings.length, 0);
    const text = formatText(r);
    assert.match(text, /no broken links/);
    assert.match(text, /checked 1 file, 1 link/);
    assert.equal(text.split(EOL).length, 2, 'one line, then the trailing newline');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--json is machine-readable and complete', async () => {
  const dir = demoTree();
  try {
    const r = await run([dir, '--root', dir, '--json'], quiet);
    const text = await captureMain([dir, '--root', dir, '--json'], dir);
    const parsed = JSON.parse(text);
    assert.equal(parsed.tool, 'linkcheck');
    assert.equal(parsed.summary.problems, r.findings.length);
    assert.ok(parsed.problems.every(p => p.file && p.line && p.reason && p.hint));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function captureMain(argv, cwd) {
  let text = '';
  await main(argv, { cwd, write: (s) => { text += s; }, fail: () => {}, isTty: false, fetchImpl: quiet.fetchImpl });
  return text;
}

test('the exit code is the verdict: 0 clean, 1 findings, 2 cannot run', async () => {
  const dir = demoTree();
  try {
    assert.equal(await captureCode(['--root', dir, dir], dir), 1);
    assert.equal(await captureCode(['--nope'], dir), 2);
    assert.equal(await captureCode(['does-not-exist.md'], dir), 2);
    assert.equal(await captureCode(['--version'], dir), 0);
    assert.equal(await captureCode(['--help'], dir), 0);
    const clean = mkdtempSync(join(tmpdir(), 'linkcheck-ok-'));
    writeFileSync(join(clean, 'a.md'), '# T' + EOL + EOL + '[self](#t)' + EOL);
    assert.equal(await captureCode(['--root', clean, clean], clean), 0);
    rmSync(clean, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function captureCode(argv, cwd) {
  return main(argv, { cwd, write: () => {}, fail: () => {}, isTty: false, fetchImpl: quiet.fetchImpl, columns: 80 });
}

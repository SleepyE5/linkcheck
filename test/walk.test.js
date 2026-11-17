import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { walkFiles, matchesIgnore, isGitRepo, MARKDOWN_EXTENSIONS } from '../src/walk.js';

const here = dirname(fileURLToPath(import.meta.url));

const has = (p, patterns) => assert.ok(matchesIgnore(p, patterns), `${p} should match ${patterns}`);
const lacks = (p, patterns) => assert.ok(!matchesIgnore(p, patterns), `${p} should not match ${patterns}`);

test('ignore patterns: a name without a slash matches at any depth', () => {
  has('notes.md', ['*.md']);
  has('a/b/scratch.md', ['*.md']);
  has('a/b/node/index.md', ['node']);
  has('a/TODO', ['TODO']);
  lacks('a/b/readme.txt', ['*.md']);
});

test('ignore patterns: a slash anchors the pattern to the root', () => {
  has('docs/a.md', ['/docs/*']);
  lacks('lib/docs/a.md', ['/docs/*']);
  // the gitignore-style leading slash and a trailing slash both normalise away
  has('docs/a/b.md', ['docs/**']);
  has('docs/a/b.md', ['docs/']);
});

test('ignore patterns: * stops at a separator, ** does not', () => {
  // the regression this locks: `a/*` used to swallow a/b/c.md, which silently
  // hides files a user never asked to skip
  lacks('a/b/c.md', ['a/*']);
  has('a/b.md', ['a']);
  has('a/b.md', ['a/']);
  lacks('a/b.md', ['b']);
  lacks('lib/docs/a.md', ['docs/*']);
  has('a/b/c.md', ['a/**']);
  has('a/b/c.md', ['**/c.md']);
  has('a/c.md', ['**/c.md']);
  has('c.md', ['**/c.md']);
  has('a/x/c.md', ['a/**/c.md']);
  has('a/c.md', ['a/**/c.md']);
  lacks('a/b.md', ['a/*/c.md']);
});

test('ignore patterns: braces and single characters', () => {
  has('dist/app.js', ['*.{js,map}']);
  has('dist/app.map', ['*.{js,map}']);
  lacks('dist/app.css', ['*.{js,map}']);
  has('a1.md', ['a?.md']);
});

test('an empty pattern list matches nothing and never throws', () => {
  lacks('a/b.md', []);
  lacks('a/b.md', undefined);
  lacks('a/b.md', ['']);
});

/* ------------------------------------------------------------------ walking */

function tempTree(withGit) {
  const dir = mkdtempSync(join(tmpdir(), 'linkcheck-'));
  const write = (rel, text = 'x\n') => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  write('README.md', '# t\n');
  write('docs/guide.md', '# g\n');
  write('docs/deep/nested.md', '# n\n');
  write('notes.txt', 'not markdown\n');
  write('node_modules/pkg/README.md', 'not mine\n');
  write('dist/README.md', 'generated\n');
  if (withGit) {
    const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    run('init', '-q');
    writeFileSync(join(dir, '.gitignore'), 'ignored.md\ndocs/deep/\n');
    write('ignored.md', '# hidden from git\n');
    write('docs/deep/nested.md', '# ignored by .gitignore\n');
    run('add', '.gitignore', 'README.md', 'node_modules/pkg/README.md');
    run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed');
  }
  return dir;
}

const tracked = hasGit => {
  if (!hasGit) return null;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
};

test('a walk reads the tree once and returns sorted, /-separated relative paths', () => {
  const dir = tempTree(false);
  try {
    assert.equal(isGitRepo(dir), false);
    const files = walkFiles(dir);
    assert.deepEqual(files, ['README.md', 'docs/deep/nested.md', 'docs/guide.md']);
    assert.ok(!files.some(f => f.includes('node_modules')), 'vendored READMEs are not our prose');
    assert.ok(!files.includes('dist/README.md'), 'build output is not our prose');
    assert.ok(!files.includes('notes.txt'));
    assert.ok(files.every(f => MARKDOWN_EXTENSIONS.includes(f.slice(f.lastIndexOf('.')))));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('git decides what counts as source when it can', { skip: !tracked(true) }, () => {
  const dir = tempTree(true);
  try {
    assert.equal(isGitRepo(dir), true);
    const files = walkFiles(dir);
    assert.ok(files.includes('README.md'));
    assert.ok(files.includes('docs/guide.md'), 'untracked-but-not-ignored is still source');
    assert.ok(!files.includes('ignored.md'), '.gitignore is honoured');
    assert.ok(!files.includes('docs/deep/nested.md'), 'an ignored directory stays ignored');
    assert.ok(!files.includes('node_modules/pkg/README.md'), 'committed by accident, still skipped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--ignore takes off what the listing put on', () => {
  const dir = tempTree(false);
  try {
    assert.deepEqual(walkFiles(dir, { ignore: ['docs/**'] }), ['README.md']);
    assert.deepEqual(walkFiles(dir, { ignore: ['guide.md'] }), ['README.md', 'docs/deep/nested.md']);
    // a pattern naming an already-skipped directory changes nothing, but must not throw
    assert.deepEqual(walkFiles(dir, { ignore: ['node_modules'] }),
      ['README.md', 'docs/deep/nested.md', 'docs/guide.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the extension list is the caller’s to choose', () => {
  const dir = tempTree(false);
  try {
    assert.ok(walkFiles(dir, { extensions: ['.txt'] }).includes('notes.txt'));
    // 'all' means "everything that is not obviously binary", which still has to
    // leave the vendored and generated trees alone
    const everything = walkFiles(dir, { extensions: 'all' });
    assert.ok(everything.includes('notes.txt'));
    assert.ok(everything.includes('README.md'));
    assert.ok(!everything.some(f => f.includes('node_modules')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a directory that is not there yields nothing instead of crashing', () => {
  assert.deepEqual(walkFiles('/definitely/not/here/linkcheck'), []);
});

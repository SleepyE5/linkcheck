import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classify, decodePath, checkFile } from '../src/check.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'fixtures');
const readme = join(root, 'README.md');

/** Reasons only — line numbers are asserted separately where they matter. */
const reasons = (findings) => findings.map(f => f.reason);
const check = (markdown) => checkFile(readme, { root, markdown });

test('classify: everything that is not a path is not a path', () => {
  assert.equal(classify('').type, 'empty');
  assert.equal(classify('#').type, 'empty');
  assert.equal(classify('https://example.com').type, 'external');
  assert.equal(classify('//cdn.example.com/x.png').type, 'external');
  for (const dest of ['mailto:a@b.c', 'tel:+1', 'ftp://x', 'data:image/png;base64,AAA', 'sms:123']) {
    const c = classify(dest);
    assert.equal(c.type, 'other', `${dest} must never be checked on disk`);
  }
  assert.equal(classify('#heading').type, 'anchor');
  assert.equal(classify('./a.md').type, 'path');
  assert.equal(classify('/docs/a.md').type, 'path');
  assert.equal(classify('/docs/a.md').rootRelative, true);
});

test('classify: a scheme-looking path is still a path', () => {
  // "file:" is what a link to a local absolute path looks like when someone
  // pastes one; treating it as "other" would silently skip it.
  assert.equal(classify('file:///tmp/x.md').type, 'path');
});

test('decodePath: a stray percent reports instead of throwing', () => {
  assert.deepEqual(decodePath('a%20b.md'), { ok: true, value: 'a b.md' });
  assert.equal(decodePath('100%.md').ok, false);
});

test('paths that exist produce nothing', () => {
  assert.deepEqual(check('[ok](assets/logo.png)'), []);
  assert.deepEqual(check('[ok](docs/guide.md)'), []);
  assert.deepEqual(check('[ok](./assets/logo.png)'), []);
  assert.deepEqual(check('[ok](assets/../assets/logo.png)'), []);
});

test('paths that do not exist are reported with the destination', () => {
  const f = check('[gone](assets/nope.png)');
  assert.deepEqual(reasons(f), ['missing-file']);
  assert.match(f[0].detail, /assets\/nope\.png/);
});

test('root-relative links resolve against the root, not the file', () => {
  assert.deepEqual(check('[ok](/assets/logo.png)'), []);
  assert.deepEqual(reasons(check('[gone](/assets/nope.png)')), ['missing-from-root']);
});

test('percent-encoded and unicode destinations are decoded', () => {
  assert.deepEqual(check('[ok](assets/logo.png)'), []);
  assert.deepEqual(check('[ok](assets/logo%2Epng)'), []);
  assert.deepEqual(reasons(check('[x](assets/no%20pe.png)')), ['missing-file']);
});

test('anchors are checked in the same file and across files', () => {
  const md = '# Real Title Here\n\n[a](#real-title-here)\n[b](#nope)\n[c](docs/guide.md#real-title-here)\n[d](docs/guide.md#fantasy)\n';
  assert.deepEqual(reasons(check(md)), ['missing-anchor', 'missing-anchor']);
});

test('an anchor into a non-markdown file is not an anchor problem', () => {
  assert.deepEqual(check('[x](assets/logo.png#top)'), []);
});

test('reference definitions are resolved', () => {
  const md = '![logo][l]\n\n[l]: assets/logo.png "a title"\n';
  assert.deepEqual(check(md), []);
});

test('a broken reference is reported once, at the definition', () => {
  const md = '[a][l]\n\n[b][l]\n\n[c][l]\n\n[l]: assets/nope.png\n';
  const f = check(md);
  assert.deepEqual(reasons(f), ['missing-file']);
  assert.equal(f[0].line, 7, 'the definition is the line to fix');
});

test('an explicit [text][label] with no definition is missing-reference', () => {
  assert.deepEqual(reasons(check('see [the docs][d2]\n')), ['missing-reference']);
});

test('a bare [word] in prose is not a broken link', () => {
  // GitHub renders an undefined shortcut reference as literal text. Reporting
  // it would flag every [sic] and [1] ever written.
  assert.deepEqual(check('as noted [sic] in [1] above\n'), []);
});

test('a defined shortcut reference is still checked', () => {
  assert.deepEqual(reasons(check('[l]: assets/nope.png\n\nsee [l] here\n')), ['missing-file']);
});

test('empty destinations go nowhere', () => {
  assert.deepEqual(reasons(check('[a]()\n[b](#)\n[c]( )')),
    ['empty-destination', 'empty-destination', 'empty-destination']);
});

test('malformed percent-encoding is reported, not swallowed', () => {
  assert.deepEqual(reasons(check('[x](assets/100%.png)')), ['malformed-url']);
  assert.deepEqual(reasons(check('[x](#100%zz)')), ['malformed-anchor']);
});

test('images that cannot be loaded are reported, links are not', () => {
  assert.deepEqual(reasons(check('![x](mailto:a@b.c)')), ['unusable-image-url']);
  assert.deepEqual(reasons(check('<img src="tel:+1">')), ['unusable-image-url']);
  // a browser can fetch these; flagging them would be a false positive
  assert.deepEqual(check('![x](ftp://host/a.png)'), []);
  assert.deepEqual(check('![x](data:image/png;base64,AAA)'), []);
  assert.deepEqual(check('[x](mailto:a@b.c)'), []);
});

test('html anchors and images are checked like markdown ones', () => {
  const md = '<a href="docs/guide.md">ok</a>\n<img src="assets/ghost.png">\n<a href="mailto:a@b.c">mail</a>\n';
  assert.deepEqual(reasons(check(md)), ['missing-file']);
});

test('line numbers survive a fenced code block above them', () => {
  const md = '```md\n[fake](nowhere.md)\n```\n\n[real](assets/nope.png)\n';
  const f = check(md);
  assert.deepEqual(reasons(f), ['missing-file']);
  assert.equal(f[0].line, 5);
});

test('the definitions a caller supplies win over the ones in the file', () => {
  // the CLI resolves a document's references against the definitions of every
  // document that shares its dir; a test has to be able to do the same
  const md = '[a][l]\n';
  const defs = new Map([['l', 'assets/logo.png']]);
  assert.deepEqual(checkFile(readme, { root, markdown: md, definitions: defs }), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, headingAnchors, maskable } from '../src/markdown.js';

const dests = md => extractLinks(md).filter(l => !l.kind.endsWith('-ref') && l.kind !== 'reference-def').map(l => l.dest);
const all = md => extractLinks(md);

test('inline links and images', () => {
  assert.deepEqual(dests('[a](b.md)'), ['b.md']);
  assert.deepEqual(dests('![a](img/x.png)'), ['img/x.png']);
  assert.deepEqual(dests('[a](./b.md) [c](../d.md)'), ['./b.md', '../d.md']);
});

test('a link inside a fenced code block is documentation, not a promise', () => {
  const md = 'Example:\n\n```md\n[not a link](missing.md)\n```\n\nReal: [yes](there.md)\n';
  assert.deepEqual(dests(md), ['there.md']);
});

test('an unclosed fence swallows the rest of the file, as a renderer does', () => {
  const md = 'before.md\n\n```\n[oops](gone.md)\n';
  assert.deepEqual(dests(md), []);
});

test('tildes fence too, and a longer fence closes a shorter one', () => {
  assert.deepEqual(dests('~~~\n[x](gone.md)\n~~~\n'), []);
  // ```` contains ``` as content, so the inner one must not close the outer
  assert.deepEqual(dests('````\n```\n[x](gone.md)\n```\n````\n'), []);
});

test('inline code spans are not links', () => {
  assert.deepEqual(dests('use `[x](gone.md)` in your file'), []);
  assert.deepEqual(dests('a ``double`` backtick `[y](gone.md)` span'), []);
});

test('html comments are not links', () => {
  assert.deepEqual(dests('<!-- [x](gone.md) -->\n'), []);
});

test('front matter is not content', () => {
  const md = '---\ntitle: [x](gone.md)\nurl: gone.md\n---\n\nReal: [ok](there.md)\n';
  assert.deepEqual(dests(md), ['there.md']);
});

test('destinations with titles, angle brackets and nested parentheses', () => {
  assert.deepEqual(dests('[a](b.md "the title")'), ['b.md']);
  assert.deepEqual(dests('[a](<b c.md>)'), ['b c.md']);
  assert.deepEqual(dests('[a](<b(c).md>)'), ['b(c).md']);
  assert.deepEqual(dests('[a](http://x.com/(y)/z)'), ['http://x.com/(y)/z']);
});

test('escaped brackets do not end the label', () => {
  assert.deepEqual(dests('[a \\] b](c.md)'), ['c.md']);
});

test('a newline inside the destination means it is not a link', () => {
  assert.deepEqual(dests('[a](b\n.md)'), []);
});

test('autolinks', () => {
  assert.deepEqual(dests('<https://example.com/x>'), ['https://example.com/x']);
});

test('raw html anchors and images', () => {
  const md = '<a href="one.md">x</a> <img src="two.png"> <a href=\'three.md\'>y</a>';
  assert.deepEqual(dests(md).sort(), ['one.md', 'three.md', 'two.png']);
});

test('reference definitions and reference links resolve through the label', () => {
  const md = '[text][lbl]\n\n[lbl]: target.md "title"\n';
  const found = all(md);
  const def = found.find(f => f.kind === 'reference-def');
  const use = found.find(f => f.kind === 'link-ref');
  assert.equal(def.dest, 'target.md');
  assert.equal(use.dest, 'lbl');
});

test('collapsed and shortcut references', () => {
  const md = '[lbl][]\n\n[lbl]\n\n[lbl]: x.md\n';
  assert.equal(all(md).filter(f => f.kind === 'link-ref').length, 2);
});

test('an inline link is not also reported as a reference', () => {
  const md = '[text](target.md)\n';
  assert.equal(all(md).filter(f => f.kind === 'link').length, 1);
  assert.equal(all(md).filter(f => f.kind === 'link-ref').length, 0);
});

test('line numbers survive masking', () => {
  const md = '```\n[x](a.md)\n```\n\nreal: [y](b.md)\n';
  const found = all(md).filter(f => f.kind === 'link');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 5, 'line 5, not line 1: the fenced block must not shift numbering');
});

test('masking never changes the length of the text', () => {
  for (const md of ['```\na\n```\n', '<!-- x -->\n', '---\na: 1\n---\n', '`code`\n']) {
    assert.equal(maskable(md).length, md.length);
  }
});

test('heading anchors follow the GitHub slug rules', () => {
  const md = '# Getting Started\n## API Reference\n### Deep Dive: Part 2\n';
  const a = headingAnchors(md);
  assert.ok(a.has('getting-started'));
  assert.ok(a.has('api-reference'));
  assert.ok(a.has('deep-dive-part-2'));
});

test('a heading inside a code fence is not an anchor', () => {
  assert.equal(headingAnchors('```\n# fake\n```\n').has('fake'), false);
});

test('explicit anchors and html ids are targets', () => {
  const md = '## Section {#custom}\n<a id="legacy"></a>\n';
  const a = headingAnchors(md);
  assert.ok(a.has('custom'));
  assert.ok(a.has('legacy'));
});

test('duplicate links on the same line are reported once, not thrice', () => {
  assert.equal(all('[a](x.md) and [b](x.md)\n').filter(f => f.kind === 'link').length, 2);
});

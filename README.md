# linkcheck

Finds Markdown links that do not resolve: the image you renamed, the
document you moved without following the references to it, the heading you
retitled last week.

It checks the files, not the website. No build, no server, no browser, and
it runs in well under a second on a repository the size of most README
collections. Zero dependencies, Node 20 or newer.

```
$ linkcheck

README.md
     4  missing-file    docs/CHANGELOG.md  nothing at that path
     5  missing-file    assets/banner.png  nothing at that path
     6  missing-anchor  docs/guide.md#instal  no heading of that name
    14  missing-file    docs/old-report.md  nothing at that path

4 problems in 1 file  ·  checked 2 files, 13 links
```

Exit status is the verdict: `0` nothing broken, `1` findings, `2` the tool
could not run.

## Install

```sh
git clone https://github.com/SleepyE5/linkcheck
cd linkcheck && npm link      # puts `linkcheck` on your PATH
```

It is a plain `bin` in `package.json`, so `npm i` from a tarball or a checkout
works the same way; there is no build step to get wrong. It is not on the npm
registry.

## What it checks

Relative paths, root-relative paths (`/docs/x.md`, resolved the way GitHub
resolves them), `#anchors` in the same file and in others, reference
definitions, `<a href>` and `<img src>` in raw HTML, autolinks, and
percent-encoded or spaced filenames. Every destination is decoded before it
is resolved, so `the%20guide.md` and `the guide.md` are both understood.

Anchors are matched against the headings of the target file, slugged the way
GitHub slugs them, including `{#explicit}` markers and `<a id="...">`.

External links are left alone unless you ask:

```
$ linkcheck --external

README.md
     9  broken-url      https://example.com/spec  the server says it is gone
    16  broken-url      https://example.com…uch-page  the server says it is gone

6 problems in 1 file  ·  checked 2 files, 15 links, 3 URLs over the network
```

Only `404`, `410` and `451` are called broken. A `403` or `429` or a timeout
is reported as *unreachable* and counted in its own sentence, because a link
checker that cries wolf about live sites gets switched off, and I would
rather not be that tool.

## What it deliberately does not report

These are the rules that decide whether a lint tool gets used, and each one
exists because the alternative is noise.

- A link inside a fenced code block. It is documentation of a syntax, not a
  promise that the file exists.
- A bare `[shortcut]` in prose with no definition anywhere. GitHub renders it
  as literal text, so `[sic]` and `[1]` are not errors. A `[text][label]`
  with no definition *is* an error, since the author plainly meant a link.
- A dead reference definition reported once per mention. It is reported once,
  at the definition, which is the line you edit.
- `mailto:`, `tel:`, `data:` and friends. They are not checkable on disk and
  pretending otherwise fails a build over a link that works.
- The absence of headings in a Markdown file that has no headings at all. That
  is absence of evidence.
- An unknown key in `.linkcheck.json`. It is an error, not a silent no, since
  a typo there would switch a rule off and turn the build green for the wrong
  reason.

## Options

```
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
```

The reasons are `missing-file`, `missing-from-root`, `missing-anchor`,
`missing-reference`, `empty-destination`, `malformed-url`,
`malformed-anchor`, `unusable-image-url`, `outside-root` and `broken-url`.
They are stable names, so `--allow` in a CI config keeps meaning the same
thing after an upgrade.

## Which files get read

`git ls-files --cached --others --exclude-standard`, which is exactly the set
of files you are about to commit, with `.gitignore` already honoured. Outside
a git work tree it walks the directory instead, skipping `node_modules`,
`dist`, `build`, `vendor`, `.git` and the usual generated and cache
directories. `--ignore` takes gitignore-style patterns, so `docs/**`,
`drafts` and `*.draft.md` mean what you would expect.

## Configuration

`.linkcheck.json` in the directory you run from, for the settings a whole
team should not repeat:

```json
{
  "root": ".",
  "ignore": ["vendor/**", "CHANGELOG.generated.md"],
  "exclude": ["https://fonts.gstatic.com/**"],
  "allow": ["outside-root"],
  "external": false,
  "timeout": 8000
}
```

Flags override the file. Lists from both are kept.

## In CI

The workflow in this repository runs `node --test test/` and then points the
tool at its own README, which is the only way I know of to notice that a lint
tool has stopped linting. For another repository:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
- uses: actions/checkout@v4
  with:
    repository: SleepyE5/linkcheck
    path: .linkcheck
- run: node .linkcheck/src/cli.js .
```

Checking the files costs a few milliseconds and never needs the network;
`--external` adds the URLs, and with it you take on every flaky server between
you and the link. If you do use it in CI, `--timeout 5000 --concurrency 4`
keeps a run honest without letting one slow host hold the job open.

## Limits

It parses Markdown itself rather than running a renderer, so it follows the
CommonMark rules for the constructs that matter here (fences, front matter,
inline code, comments, balanced parentheses in destinations, titles, angle
brackets, escaped brackets) and not the whole specification. A link inside a
directive that only a specific static site generator understands may be read
as ordinary text.

It will not tell you that a page it fetched is a soft 404, that a redirect
landed somewhere unrelated, or that a GitHub anchor generated from a heading
with inline formatting came out differently than the tool guessed. When it is
unsure it says *unreachable* rather than *broken*.

## Tests

```sh
node --test test/
```

84 tests, no network. The parser layer is tested against the constructs it
masks, the resolver against a real fixture directory, the URL layer against a
stubbed `fetch` that records what was asked, and the CLI against temporary
trees so the exit codes and the report format are covered too.

## License

MIT.

# makefun-markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/faaz12/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/faaz12/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A from-scratch Markdown renderer with no dependencies. It handles CommonMark 0.31.2 plus the GitHub-flavored extensions — tables, task lists, strikethrough, extended autolinks and disallowed raw HTML — and returns byte-for-byte the same HTML as marked 18.1.3 with its default options, only quicker. On the kit's practice set it passes all 720 cases and renders them about 1.5x faster than marked.

## How it is built

`parse.js` works in three passes. First the source is normalised to `\n` line endings and a block lexer walks the lines into a small tree of paragraphs, headings, fences, lists, block quotes, tables, raw HTML and code blocks, collecting link reference definitions as it goes. Then each leaf's text is scanned into a flat list of inline pieces — text runs, code spans, links, images, raw tags and delimiter runs — with the delimiter runs settled into emphasis, strong emphasis and strikethrough. Finally the pieces are emitted directly to HTML strings. Nothing is kept between calls: `parse` is a pure function of its input.

## Running it

```sh
node main.ts
```

That reads `/input/cases.json` and writes the rendered HTML strings, in case order, to `/output/html.json`. To run against a different case set or output location, set `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`.

## Files

- `parse.js` — the renderer: `parse(markdown)` returns the HTML string. No dependencies, no I/O, no state between calls.
- `main.ts` — the driver the harness runs: loads the cases, renders each one through `parse`, and writes the results.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9q44mekh&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>

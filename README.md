# makefun-markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/faaz12/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/faaz12/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown renderer written from scratch. It covers CommonMark 0.31.2 and the GitHub-flavored extensions (tables, task lists, strikethrough, extended autolinks, disallowed raw HTML) and produces byte-for-byte the same HTML as marked 18.1.3 with default options — only faster. Against the kit's practice set it passes all 720 cases and renders them faster than marked.

## Running it

```sh
node main.ts
```

That reads `/input/cases.json` and writes the rendered HTML strings, in case order, to `/output/html.json`. Point `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` at other folders to run against a different case set or output location.

## Files

- `parse.js` — the renderer itself: `parse(markdown)` returns the HTML string. No dependencies, no I/O, and no state kept between calls.
- `main.ts` — the driver the harness runs: reads the cases, renders each one through `parse`, and writes the results.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9q44mekh&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>

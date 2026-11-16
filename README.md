# makefun-markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/faaz12/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/faaz12/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A hand-written, dependency-free Markdown renderer. It implements CommonMark 0.31.2 plus the GitHub-flavored extensions (tables, task lists, strikethrough, extended autolinks, disallowed raw HTML) and returns byte-for-byte the HTML that marked 18.1.3 produces with its default options — only faster. On the kit's practice set it passes all 720 cases and beats marked on speed.

## How to run it

```sh
node main.ts
```

That reads `/input/cases.json` and writes the rendered HTML strings, in case order, to `/output/html.json`. To run against a different case set or output folder, set `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`.

## Layout

- `parse.js` — the renderer: `parse(markdown)` returns the HTML string. No dependencies, no I/O, no state kept between calls.
- `main.ts` — the driver the harness runs: reads the cases, renders each one with `parse`, writes the results.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9q44mekh&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>

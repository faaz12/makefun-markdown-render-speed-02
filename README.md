# makefun-markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/faaz12/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/faaz12/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown renderer written in plain JavaScript. It covers CommonMark 0.31.2 and the GitHub-flavored extensions, produces exactly the HTML that marked 18.1.3 gives with its default options, and does it faster than marked on all 720 practice cases.

## Running it

```sh
node main.ts
```

That reads `/input/cases.json` and writes the array of rendered HTML strings to `/output/html.json`. Point `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` somewhere else to run it against a different case set or output folder.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9q44mekh&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>

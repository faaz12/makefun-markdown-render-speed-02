// Entry point for the make.fun markdown-render-speed-02 bounty.
//
// The grading harness runs `node /bot/main.ts` on Node 22. It places the
// test cases in /input/cases.json (a JSON array of { id, markdown }) and
// expects the rendered HTML strings, in the same order, as a JSON array
// in /output/html.json. MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override
// those two directories when run outside the grading container.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));

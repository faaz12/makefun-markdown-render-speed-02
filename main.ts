// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts` on Node 22. It places the case
// set at /input/cases.json — a JSON array of { id, markdown } objects —
// and expects the rendered HTML back in /output/html.json as a JSON
// array of strings, in the same order as the cases. The two
// MAKEFUN_* variables let a local run point the driver at different
// input and output directories instead of the /input and /output
// defaults used by the grader.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const html = cases.map((entry) => parse(entry.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));

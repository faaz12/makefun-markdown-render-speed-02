// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts` on Node 22. It places the case
// set at /input/cases.json — a JSON array of { id, markdown } objects —
// and expects the rendered HTML at /output/html.json, one string per
// case, in the same order as the input. This file only connects those
// two ends: it reads the cases, hands each markdown string to parse()
// from ./parse.js, and writes the results out.
//
// For a local check, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR can
// redirect the driver to a different input folder and output folder;
// without them it uses the /input and /output paths the grader mounts.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const html = cases.map((entry) => parse(entry.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));

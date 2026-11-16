// Entry point for the markdown-render-speed-02 submission.
//
// The grader invokes `node /bot/main.ts` under Node 22. It mounts the
// case set at /input/cases.json — an array of { id, markdown } entries —
// and collects the rendered HTML from /output/html.json, one string per
// case, in the same order. This driver just wires those two files
// together through parse() from ./parse.js.
//
// For a local run, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR can point
// the driver at a different input folder and output folder; otherwise
// it uses the /input and /output paths the grader provides.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const html = cases.map((entry) => parse(entry.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));

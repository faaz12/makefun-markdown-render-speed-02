// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts` on Node 22. It mounts the case
// set at /input/cases.json — a JSON array of { id, markdown } objects —
// and expects the rendered HTML at /output/html.json, one string per
// case, in the same order as the input. This file is only the plumbing
// between those two files: it loads the cases, renders each one with
// parse() from ./parse.js, and writes the results back out.
//
// For a local run, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR can point
// the driver at different input and output folders; without them it
// uses the /input and /output paths the grader mounts.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function loadCases(dir) {
  const raw = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));
  if (!Array.isArray(raw)) throw new Error('cases.json is not an array');
  return raw;
}

function renderAll(cases) {
  const out = new Array(cases.length);
  for (let n = 0; n < cases.length; n++) {
    const entry = cases[n];
    if (typeof entry.markdown !== 'string') throw new Error(`case ${n} has no markdown string`);
    out[n] = parse(entry.markdown);
  }
  return out;
}

const cases = loadCases(inputDir);
const html = renderAll(cases);

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));

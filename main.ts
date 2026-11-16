// Runner for the markdown-render-speed-02 entry on make.fun.
//
// The grader invokes `node /bot/main.ts` under Node 22. It drops the
// cases at /input/cases.json — a JSON array whose items look like
// { id, markdown } — and reads back /output/html.json, a JSON array
// of rendered HTML strings in exactly the same order. When the two
// MAKEFUN_* environment variables are set they take over from the
// /input and /output defaults, which is handy for local runs.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const suite = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8'));

const rendered = suite.map((c) => parse(c.markdown));

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(rendered));

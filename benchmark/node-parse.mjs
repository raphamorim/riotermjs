// Pure parser throughput, no DOM and no rendering: @xterm/headless vs
// rioterm's headless Terminal in Node. Isolates the VT engine cost from
// renderer cost.

import { readFileSync } from 'node:fs';
import xtermHeadless from '@xterm/headless';
const { Terminal: XtermHeadless } = xtermHeadless;
import { Terminal as RioTerminal, initWasm } from 'rioterm';
import { plainChunks, ansiChunks } from './src/workloads.mjs';

const COLS = 120;
const ROWS = 40;
const BYTES = 32 * 1024 * 1024;

await initWasm(
  readFileSync(new URL('./node_modules/rioterm/wasm/librio_wasm_bg.wasm', import.meta.url)),
);

async function xtermRun(chunks) {
  const term = new XtermHeadless({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  const start = performance.now();
  await new Promise((resolve) => {
    for (let i = 0; i < chunks.length; i++) {
      term.write(chunks[i], i === chunks.length - 1 ? resolve : undefined);
    }
  });
  const ms = performance.now() - start;
  term.dispose();
  return ms;
}

function riotermRun(chunks) {
  const term = new RioTerminal({ cols: COLS, rows: ROWS, scrollback: 2000 });
  const start = performance.now();
  for (const chunk of chunks) term.write(chunk);
  const ms = performance.now() - start;
  term.dispose();
  return ms;
}

const mbs = (ms, bytes) => (bytes / 1024 / 1024 / (ms / 1000)).toFixed(0);

for (const [name, maker] of [
  ['plain', plainChunks],
  ['ansi', ansiChunks],
]) {
  const { chunks, bytes } = maker(BYTES);
  // Warmup + best-of-3.
  await xtermRun(chunks);
  riotermRun(chunks);
  const x = Math.min(await xtermRun(chunks), await xtermRun(chunks), await xtermRun(chunks));
  const r = Math.min(riotermRun(chunks), riotermRun(chunks), riotermRun(chunks));
  console.log(
    `${name.padEnd(6)} ${(bytes / 1024 / 1024).toFixed(0)}MB   xterm/headless ${mbs(x, bytes)} MB/s   rioterm ${mbs(r, bytes)} MB/s`,
  );
}

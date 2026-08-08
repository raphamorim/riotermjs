// Playwright driver: runs every scenario on both engines in a fresh page,
// repeats each RUNS times, reports medians side by side, and writes
// results.json. Uses the installed Chrome (channel) so numbers reflect a
// real browser.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 4499;
const RUNS = 3;
const ENGINES = ['xterm', 'rioterm'];
const SCENARIOS = ['plainThroughput', 'ansiThroughput', 'altScreenFps', 'scrollbackScroll'];

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: new URL('.', import.meta.url).pathname,
  stdio: 'ignore',
  detached: true,
});
process.on('exit', () => {
  try {
    process.kill(-vite.pid);
  } catch {
    /* gone already */
  }
});

// Wait for the dev server.
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`http://localhost:${PORT}/`);
    if (res.ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-precise-memory-info'],
});

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = {};

for (const engine of ENGINES) {
  results[engine] = {};

  // Cold init, fresh page each time.
  const initTimes = [];
  for (let i = 0; i < RUNS; i++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    initTimes.push(await page.evaluate((e) => window.benchInit(e), engine));
    await page.close();
  }
  results[engine].initMs = median(initTimes);
  console.log(`${engine} init: ${results[engine].initMs.toFixed(1)}ms`);

  for (const scenario of SCENARIOS) {
    const runs = [];
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.evaluate((e) => window.benchInit(e), engine);
    // Warmup, then measured runs.
    await page.evaluate(([e, s]) => window.bench(e, s), [engine, scenario]);
    for (let i = 0; i < RUNS; i++) {
      runs.push(await page.evaluate(([e, s]) => window.bench(e, s), [engine, scenario]));
    }
    const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    await page.close();

    const merged = {};
    for (const key of Object.keys(runs[0])) {
      merged[key] = median(runs.map((r) => r[key]));
    }
    merged.heapMB = heap / 1024 / 1024;
    results[engine][scenario] = merged;
    console.log(`${engine} ${scenario}:`, JSON.stringify(merged));
  }
}

await browser.close();

// Side-by-side table.
const fmt = (v) => (typeof v === 'number' ? v.toFixed(1) : String(v));
console.log('\n=== rioterm vs xterm.js (medians) ===');
const rows = [
  ['init ms', results.xterm.initMs, results.rioterm.initMs],
  ['plain MB/s', results.xterm.plainThroughput.mbPerSec, results.rioterm.plainThroughput.mbPerSec],
  ['ansi MB/s', results.xterm.ansiThroughput.mbPerSec, results.rioterm.ansiThroughput.mbPerSec],
  ['altscreen fps', results.xterm.altScreenFps.fps, results.rioterm.altScreenFps.fps],
  ['altscreen p95 ms', results.xterm.altScreenFps.frameP95Ms, results.rioterm.altScreenFps.frameP95Ms],
  ['scrollback p95 ms', results.xterm.scrollbackScroll.frameP95Ms, results.rioterm.scrollbackScroll.frameP95Ms],
  ['heap after plain MB', results.xterm.plainThroughput.heapMB, results.rioterm.plainThroughput.heapMB],
];
console.log('metric'.padEnd(22) + 'xterm'.padStart(12) + 'rioterm'.padStart(12));
for (const [name, x, r] of rows) {
  console.log(name.padEnd(22) + fmt(x).padStart(12) + fmt(r).padStart(12));
}

writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2));
console.log('\nwrote results.json');
process.exit(0);

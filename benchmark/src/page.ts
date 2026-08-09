// Bench page: exposes window.bench(engine, scenario) to the playwright
// driver. Every engine gets a fixed 120x40 grid, the same font, and
// byte-identical workloads. xterm runs with its WebGL addon (its fastest
// renderer); rioterm runs its canvas renderer; wterm runs its DOM
// renderer (the only one it ships).

import { Terminal as XTerm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as RioTerminal, CanvasRenderer, initWasm } from 'rioterm';
import { WTerm } from '@wterm/dom';
import '@wterm/dom/css';

import { plainChunks, ansiChunks, altScreenFrame, ALT_ENTER, ALT_LEAVE } from './workloads.mjs';

const COLS = 120;
const ROWS = 40;
const FONT = 'Menlo, Consolas, monospace';
const decoder = new TextDecoder();

const raf = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

interface Engine {
  name: string;
  /** Write bytes; resolves when the engine has fully parsed them. */
  write: (bytes: Uint8Array) => Promise<void>;
  scroll: (lines: number) => void;
  dispose: () => void;
}

async function makeXterm(host: HTMLElement): Promise<Engine> {
  const term = new XTerm({
    cols: COLS,
    rows: ROWS,
    fontSize: 14,
    fontFamily: FONT,
    scrollback: 10000,
    allowProposedApi: true,
  });
  term.open(host);
  try {
    term.loadAddon(new WebglAddon());
  } catch {
    // canvas fallback
  }
  return {
    name: 'xterm',
    write: (bytes) => new Promise((resolve) => term.write(bytes, resolve)),
    scroll: (lines) => term.scrollLines(lines),
    dispose: () => term.dispose(),
  };
}

async function makeRioterm(host: HTMLElement): Promise<Engine> {
  await initWasm();
  const term = new RioTerminal({ cols: COLS, rows: ROWS, scrollback: 10000 });
  const renderer = new CanvasRenderer(term, { fontSize: 14, fontFamily: FONT });
  host.appendChild(renderer.element);
  return {
    name: 'rioterm',
    // rioterm parses synchronously; resolve on the next microtask to keep
    // the await structure identical for both engines.
    write: (bytes) => {
      term.write(bytes);
      return Promise.resolve();
    },
    scroll: (lines) => term.scrollLines(lines),
    dispose: () => {
      renderer.dispose();
      term.dispose();
    },
  };
}

async function makeWterm(host: HTMLElement): Promise<Engine> {
  const container = document.createElement('div');
  container.style.width = '1100px';
  container.style.height = '640px';
  container.style.fontFamily = FONT;
  container.style.fontSize = '14px';
  host.appendChild(container);
  const term = new WTerm(container, { cols: COLS, rows: ROWS, autoResize: false });
  await term.init();
  return {
    name: 'wterm',
    // wterm writes into the wasm core synchronously and schedules its
    // render; same await shape as rioterm.
    write: (bytes) => {
      term.write(bytes);
      return Promise.resolve();
    },
    scroll: (lines) => {
      // wterm scrolls its scrollback natively in the DOM: nudge whichever
      // descendant actually overflows, by whole rows.
      const nodes = [container, ...Array.from(container.querySelectorAll<HTMLElement>('*'))];
      const scroller = nodes.find((el) => el.scrollHeight > el.clientHeight + 1) ?? container;
      const rowPx = scroller.scrollHeight / Math.max(1, scroller.childElementCount);
      scroller.scrollTop -= lines * (Number.isFinite(rowPx) && rowPx > 4 ? rowPx : 16);
    },
    dispose: () => term.destroy(),
  };
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    avg: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50: pick(0.5),
    p95: pick(0.95),
    worst: sorted[sorted.length - 1],
  };
}

async function settle(engine: Engine): Promise<void> {
  await engine.write(new Uint8Array(0));
  await raf();
  await raf();
}

const scenarios: Record<string, (engine: Engine) => Promise<Record<string, number>>> = {
  // MB/s from first byte submitted to everything parsed and a frame painted.
  async plainThroughput(engine) {
    const { chunks, bytes } = plainChunks(8 * 1024 * 1024);
    const start = performance.now();
    for (const chunk of chunks) void engine.write(chunk);
    await settle(engine);
    const ms = performance.now() - start;
    return { mbPerSec: bytes / 1024 / 1024 / (ms / 1000), ms };
  },

  async ansiThroughput(engine) {
    const { chunks, bytes } = ansiChunks(8 * 1024 * 1024);
    const start = performance.now();
    for (const chunk of chunks) void engine.write(chunk);
    await settle(engine);
    const ms = performance.now() - start;
    return { mbPerSec: bytes / 1024 / 1024 / (ms / 1000), ms };
  },

  // A TUI redrawing the whole screen every frame: submit frame, await
  // parse, await paint. Reports achieved frame rate and frame time stats.
  async altScreenFps(engine) {
    await engine.write(ALT_ENTER);
    await settle(engine);
    const FRAMES = 240;
    const times: number[] = [];
    let last = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      await engine.write(altScreenFrame(COLS, ROWS, i));
      await raf();
      const now = performance.now();
      times.push(now - last);
      last = now;
    }
    await engine.write(ALT_LEAVE);
    const s = stats(times);
    return { fps: 1000 / s.avg, frameAvgMs: s.avg, frameP95Ms: s.p95, frameWorstMs: s.worst };
  },

  // Scrollback navigation with a full buffer.
  async scrollbackScroll(engine) {
    const { chunks } = plainChunks(4 * 1024 * 1024);
    for (const chunk of chunks) void engine.write(chunk);
    await settle(engine);
    const times: number[] = [];
    let direction = 3;
    let last = performance.now();
    for (let i = 0; i < 240; i++) {
      engine.scroll(direction);
      if (i % 40 === 39) direction = -direction;
      await raf();
      const now = performance.now();
      times.push(now - last);
      last = now;
    }
    const s = stats(times);
    return { frameAvgMs: s.avg, frameP95Ms: s.p95, frameWorstMs: s.worst };
  },
};

type EngineName = 'xterm' | 'rioterm' | 'wterm';

declare global {
  interface Window {
    bench: (engine: EngineName, scenario: string) => Promise<Record<string, number>>;
    benchInit: (engine: EngineName) => Promise<number>;
  }
}

let current: Engine | null = null;
const host = () => document.getElementById('host')!;

const makers: Record<EngineName, (host: HTMLElement) => Promise<Engine>> = {
  xterm: makeXterm,
  rioterm: makeRioterm,
  wterm: makeWterm,
};

window.benchInit = async (which) => {
  current?.dispose();
  host().textContent = '';
  const start = performance.now();
  current = await makers[which](host());
  await settle(current);
  return performance.now() - start;
};

window.bench = async (which, scenario) => {
  if (!current || current.name !== which) await window.benchInit(which);
  const run = scenarios[scenario];
  if (!run) throw new Error(`unknown scenario ${scenario}`);
  return run(current!);
};

// Keep the decoder referenced so bundlers don't tree-shake it away when
// scenarios evolve to read text back.
void decoder;

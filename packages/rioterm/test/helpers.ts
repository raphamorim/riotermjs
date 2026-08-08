import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Terminal, initWasm, type TerminalOptions } from '../src/index.js';

let loaded = false;

/** Load the wasm once per worker; Node gets the bytes explicitly. */
export async function ensureWasm(): Promise<void> {
  if (loaded) return;
  const wasm = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../wasm/librio_wasm_bg.wasm'),
  );
  await initWasm(wasm);
  loaded = true;
}

export function makeTerminal(options: TerminalOptions = {}): Terminal {
  return new Terminal({ cols: 40, rows: 10, scrollback: 200, ...options });
}

export interface DataCollector {
  chunks: Uint8Array[];
  /** Everything received, decoded as latin1 so control bytes survive. */
  text(): string;
  clear(): void;
}

export function collectData(term: Terminal): DataCollector {
  const chunks: Uint8Array[] = [];
  term.onData((bytes) => chunks.push(bytes.slice()));
  return {
    chunks,
    text: () => chunks.map((c) => String.fromCharCode(...c)).join(''),
    clear: () => {
      chunks.length = 0;
    },
  };
}

/** All viewport rows as trimmed text. */
export function screen(term: Terminal, rows = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows; i++) out.push(term.textRow(i));
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

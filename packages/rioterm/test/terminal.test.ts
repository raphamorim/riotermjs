import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  Terminal,
  initWasm,
  CELL_WORDS,
  COLOR_NAMED,
  STYLE_BOLD,
  KEY_ENTER,
  KEY_ACTION_PRESS,
  KEY_CHAR,
  MOD_CTRL,
} from '../src/index.js';

beforeAll(async () => {
  // Node cannot fetch the binary next to the glue; hand it the bytes.
  const wasm = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../wasm/librio_wasm_bg.wasm'),
  );
  await initWasm(wasm);
});

function collect(term: Terminal): { data: number[][]; text(): string } {
  const data: number[][] = [];
  term.onData((bytes) => data.push([...bytes]));
  return {
    data,
    text: () => data.map((chunk) => String.fromCharCode(...chunk)).join(''),
  };
}

describe('Terminal', () => {
  it('parses child output into the grid', () => {
    const term = new Terminal({ cols: 40, rows: 10 });
    term.write('hello\r\nworld\r\n');
    expect(term.textRow(0)).toBe('hello');
    expect(term.textRow(1)).toBe('world');
    term.dispose();
  });

  it('exposes resolved colors and style flags in packed cells', () => {
    const term = new Terminal({ cols: 20, rows: 5 });
    term.write('\x1b[1;31mX\x1b[0m');
    const snap = term.snapshot();
    const word0 = snap.cells[0];
    expect(String.fromCodePoint(word0 & 0x1fffff)).toBe('X');
    const fg = snap.cells[1];
    expect(fg >>> 24).toBe(COLOR_NAMED);
    expect(fg & 0xffffff).toBe(1); // NamedColor::Red
    expect(snap.cells[3] & STYLE_BOLD).toBeTruthy();
    term.dispose();
  });

  it('routes key encodings to onData', () => {
    const term = new Terminal();
    const out = collect(term);
    const handled = term.key(KEY_ACTION_PRESS, KEY_ENTER, 0, 0, 0, 0, false, undefined);
    expect(handled).toBe(true);
    expect(out.text()).toBe('\r');
    term.dispose();
  });

  it('encodes ctrl+c', () => {
    const term = new Terminal();
    const out = collect(term);
    term.key(KEY_ACTION_PRESS, KEY_CHAR, 0x63, 0, MOD_CTRL, 0, false, undefined);
    expect(out.text()).toBe('\x03');
    term.dispose();
  });

  it('answers DA1 through onData', () => {
    const term = new Terminal();
    const out = collect(term);
    term.write('\x1b[c');
    expect(out.text()).toMatch(/^\x1b\[\?\d/);
    term.dispose();
  });

  it('tracks selection and returns its text', () => {
    const term = new Terminal({ cols: 40, rows: 10 });
    term.write('grab this text');
    term.selectionBegin(0, 0);
    term.selectionUpdate(0, 3, true);
    expect(term.getSelection()).toBe('grab');
    term.clearSelection();
    expect(term.getSelection()).toBeUndefined();
    term.dispose();
  });

  it('scrolls into history and snaps back on input', () => {
    const term = new Terminal({ cols: 20, rows: 5 });
    for (let i = 0; i < 30; i++) term.write(`line ${i}\r\n`);
    term.scrollLines(5);
    expect(term.snapshot().displayOffset).toBe(5);
    term.input('x');
    expect(term.snapshot().displayOffset).toBe(0);
    term.dispose();
  });

  it('resizes the grid', () => {
    const term = new Terminal({ cols: 20, rows: 5 });
    term.resize(60, 20);
    const snap = term.snapshot();
    expect(snap.cols).toBe(60);
    expect(snap.rows).toBe(20);
    expect(snap.cells.length).toBe(60 * 20 * CELL_WORDS);
    term.dispose();
  });

  it('reports the wheel to mouse-mode programs instead of scrolling', () => {
    const term = new Terminal();
    const out = collect(term);
    term.write('\x1b[?1000h\x1b[?1006h');
    const consumed = term.scrollWheel(1, 4, 2, 0);
    expect(consumed).toBe(true);
    expect(out.text()).toBe('\x1b[<64;5;3M');
    term.dispose();
  });

  it('allows onData handlers to write back synchronously (shell echo)', () => {
    const term = new Terminal({ cols: 40, rows: 10 });
    const decoder = new TextDecoder();
    term.onData((bytes) => {
      // Echo, exactly like an in-page shell: re-enters the wasm object
      // while key() is still on the stack.
      term.write(decoder.decode(bytes));
    });
    const handled = term.key(KEY_ACTION_PRESS, KEY_CHAR, 0x68, 0, 0, 0, false, 'h');
    expect(handled).toBe(true);
    expect(term.textRow(0)).toBe('h');
    term.dispose();
  });

  it('converts bare LF to CRLF when convertEol is set', () => {
    const term = new Terminal({ cols: 20, rows: 6, convertEol: true });
    term.write('one\ntwo\n');
    expect(term.textRow(0)).toBe('one');
    expect(term.textRow(1)).toBe('two');
    // CRLF split across chunks must not double-convert.
    term.write('three\r');
    term.write('\nfour');
    expect(term.textRow(2)).toBe('three');
    expect(term.textRow(3)).toBe('four');
    term.dispose();
  });

  it('leaves newlines alone without convertEol', () => {
    const term = new Terminal({ cols: 20, rows: 6 });
    term.write('a\nb');
    expect(term.textRow(1)).toBe(' b');
    term.dispose();
  });

  it('brackets pastes when the program asks and reports modes', () => {
    const term = new Terminal({ cols: 40, rows: 10 });
    const out = collect(term);
    expect(term.modes().bracketedPaste).toBe(false);
    term.paste('plain\n');
    expect(out.text()).toBe('plain\r');

    out.data.length = 0;
    term.write('\x1b[?2004h');
    expect(term.modes().bracketedPaste).toBe(true);
    term.paste('safe');
    expect(out.text()).toBe('\x1b[200~safe\x1b[201~');

    term.write('\x1b[?1000h\x1b[?1h\x1b[?1049h');
    const modes = term.modes();
    expect(modes.mouseTracking).toBe(true);
    expect(modes.applicationCursorKeys).toBe(true);
    expect(modes.altScreen).toBe(true);
    term.dispose();
  });

  it('resolves osc8 links with their hover runs', () => {
    const term = new Terminal({ cols: 40, rows: 10 });
    term.write('pre \x1b]8;;https://rioterm.com\x1b\\rio link\x1b]8;;\x1b\\ post');
    term.snapshot();
    expect(term.linkAt(0, 0)).toBeUndefined();
    expect(term.linkAt(0, 6)).toEqual({
      uri: 'https://rioterm.com',
      startCol: 4,
      endCol: 11,
    });
    expect(term.linkAt(0, 13)).toBeUndefined();
    term.dispose();
  });

  it('dumps scrollback plus screen as plain text', () => {
    const term = new Terminal({ cols: 20, rows: 5 });
    term.write('one\r\ntwo\r\n');
    expect(term.dump()).toContain('one');
    expect(term.dump()).toContain('two');
    term.dispose();
  });
});

// VT and grid semantics through the public Terminal API: cursor motion,
// wrapping, wide characters, erase operations, scrollback, alt screen,
// and resize. Everything runs headless in Node against the real wasm.

import { beforeAll, describe, expect, it } from 'vitest';

import { CELL_WORDS, WIDE_SPACER, WIDE_WIDE } from '../src/index.js';
import { ensureWasm, makeTerminal, screen } from './helpers.js';

beforeAll(ensureWasm);

describe('cursor and line discipline', () => {
  it('carriage return and line feed position the cursor', () => {
    const term = makeTerminal();
    term.write('abc\r\ndef');
    const snap = term.snapshot();
    expect(term.textRow(0)).toBe('abc');
    expect(term.textRow(1)).toBe('def');
    expect(snap.cursorLine).toBe(1);
    expect(snap.cursorCol).toBe(3);
    term.dispose();
  });

  it('bare LF keeps the column (no ONLCR without convertEol)', () => {
    const term = makeTerminal();
    term.write('ab\ncd');
    expect(term.textRow(0)).toBe('ab');
    expect(term.textRow(1)).toBe('  cd');
    term.dispose();
  });

  it('backspace moves left without erasing', () => {
    const term = makeTerminal();
    term.write('abc\bX');
    expect(term.textRow(0)).toBe('abX');
    term.dispose();
  });

  it('tab advances to the next tab stop', () => {
    const term = makeTerminal();
    term.write('a\tb');
    const snap = term.snapshot();
    expect(term.textRow(0).indexOf('b')).toBe(8);
    expect(snap.cursorCol).toBe(9);
    term.dispose();
  });

  it('cursor addressing via CUP is 1-based', () => {
    const term = makeTerminal();
    term.write('\x1b[3;5HX');
    expect(term.textRow(2)).toBe('    X');
    term.dispose();
  });

  it('wraps at the right margin and marks continuation', () => {
    const term = makeTerminal({ cols: 10 });
    term.write('0123456789abc');
    expect(term.textRow(0)).toBe('0123456789');
    expect(term.textRow(1)).toBe('abc');
    term.dispose();
  });

  it('DECAWM off stops the wrap', () => {
    const term = makeTerminal({ cols: 10 });
    term.write('\x1b[?7l0123456789abc\x1b[?7h');
    expect(term.textRow(0)).toBe('012345678c');
    expect(term.textRow(1)).toBe('');
    term.dispose();
  });
});

describe('wide characters', () => {
  it('CJK occupies two cells with a spacer', () => {
    const term = makeTerminal();
    term.write('你a');
    const snap = term.snapshot();
    const wideBits = (i: number) => (snap.cells[i * CELL_WORDS] >>> 21) & 0b11;
    expect(String.fromCodePoint(snap.cells[0] & 0x1fffff)).toBe('你');
    expect(wideBits(0)).toBe(WIDE_WIDE);
    expect(wideBits(1)).toBe(WIDE_SPACER);
    expect(String.fromCodePoint(snap.cells[2 * CELL_WORDS] & 0x1fffff)).toBe('a');
    expect(snap.cursorCol).toBe(3);
    term.dispose();
  });

  it('a wide char that does not fit wraps whole', () => {
    const term = makeTerminal({ cols: 5 });
    term.write('abcd你');
    expect(term.textRow(0)).toBe('abcd');
    expect(term.textRow(1)).toBe('你');
    term.dispose();
  });
});

describe('erase operations', () => {
  it('EL clears to end of line from the cursor', () => {
    const term = makeTerminal();
    term.write('abcdef\x1b[3G\x1b[K');
    expect(term.textRow(0)).toBe('ab');
    term.dispose();
  });

  it('ED 2 clears the screen but not scrollback', () => {
    const term = makeTerminal({ rows: 4 });
    term.write('one\r\ntwo\r\nthree\r\nfour\r\nfive');
    term.write('\x1b[2J');
    expect(term.textRow(0)).toBe('');
    term.scrollLines(2);
    expect(term.snapshot().displayOffset).toBeGreaterThan(0);
    term.dispose();
  });

  it('ED 3 clears scrollback too', () => {
    const term = makeTerminal({ rows: 4 });
    for (let i = 0; i < 12; i++) term.write(`line ${i}\r\n`);
    term.write('\x1b[2J\x1b[3J');
    term.scrollLines(5);
    expect(term.snapshot().displayOffset).toBe(0);
    term.dispose();
  });

  it('DCH deletes characters and shifts the rest left', () => {
    const term = makeTerminal();
    term.write('abcdef\x1b[1G\x1b[2P');
    expect(term.textRow(0)).toBe('cdef');
    term.dispose();
  });

  it('ICH inserts blanks at the cursor', () => {
    const term = makeTerminal();
    term.write('abcd\x1b[1G\x1b[2@');
    expect(term.textRow(0)).toBe('  abcd');
    term.dispose();
  });
});

describe('scrollback and viewport', () => {
  it('accumulates history and clamps the offset', () => {
    const term = makeTerminal({ rows: 5, scrollback: 50 });
    for (let i = 0; i < 30; i++) term.write(`l${i}\r\n`);
    term.scrollLines(1000);
    const max = term.snapshot().displayOffset;
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(50);
    term.scrollLines(-2000);
    expect(term.snapshot().displayOffset).toBe(0);
    term.dispose();
  });

  it('keeps the viewport while scrolled and snaps back on input', () => {
    const term = makeTerminal({ rows: 5 });
    for (let i = 0; i < 20; i++) term.write(`l${i}\r\n`);
    term.scrollLines(5);
    const frozen = term.textRow(0);
    term.write('more output\r\n');
    // The viewport stays anchored to content: the offset from the live
    // bottom grows as new lines arrive underneath.
    expect(term.snapshot().displayOffset).toBe(6);
    expect(term.textRow(0)).toBe(frozen);
    term.input('x');
    expect(term.snapshot().displayOffset).toBe(0);
    term.dispose();
  });

  it('scrollback is capped at the configured length', () => {
    const term = makeTerminal({ rows: 5, scrollback: 10 });
    for (let i = 0; i < 40; i++) term.write(`l${i}\r\n`);
    term.scrollLines(1000);
    expect(term.snapshot().displayOffset).toBeLessThanOrEqual(10);
    term.dispose();
  });
});

describe('alternate screen', () => {
  it('switches, restores, and reports through the snapshot', () => {
    const term = makeTerminal();
    term.write('primary');
    term.write('\x1b[?1049h');
    expect(term.snapshot().altScreen).toBe(true);
    term.write('alt content');
    expect(term.textRow(0)).toContain('alt');
    term.write('\x1b[?1049l');
    expect(term.snapshot().altScreen).toBe(false);
    expect(term.textRow(0)).toBe('primary');
    term.dispose();
  });

  it('alt screen has no scrollback to move', () => {
    const term = makeTerminal({ rows: 5 });
    term.write('\x1b[?1049h');
    for (let i = 0; i < 20; i++) term.write(`alt ${i}\r\n`);
    term.scrollLines(5);
    expect(term.snapshot().displayOffset).toBe(0);
    term.dispose();
  });
});

describe('cursor visibility', () => {
  it('DECTCEM hides and shows the cursor in the snapshot', () => {
    const term = makeTerminal();
    expect(term.snapshot().cursorVisible).toBe(true);
    term.write('\x1b[?25l');
    expect(term.snapshot().cursorVisible).toBe(false);
    term.write('\x1b[?25h');
    expect(term.snapshot().cursorVisible).toBe(true);
    term.dispose();
  });

  it('a scrolled viewport reports the cursor hidden', () => {
    const term = makeTerminal({ rows: 5 });
    for (let i = 0; i < 20; i++) term.write(`l${i}\r\n`);
    term.scrollLines(3);
    expect(term.snapshot().cursorVisible).toBe(false);
    term.scrollLines(-100);
    expect(term.snapshot().cursorVisible).toBe(true);
    term.dispose();
  });
});

describe('reset and resize', () => {
  it('RIS returns to a default grid', () => {
    const term = makeTerminal();
    term.write('\x1b[31mred\x1b[?1049h');
    term.write('\x1bc');
    const snap = term.snapshot();
    expect(snap.altScreen).toBe(false);
    expect(term.textRow(0)).toBe('');
    expect(snap.cursorLine).toBe(0);
    expect(snap.cursorCol).toBe(0);
    term.dispose();
  });

  it('resize preserves content and reports new dimensions', () => {
    const term = makeTerminal({ cols: 20, rows: 6 });
    term.write('keep me\r\nsecond');
    term.resize(30, 8);
    const snap = term.snapshot();
    expect(snap.cols).toBe(30);
    expect(snap.rows).toBe(8);
    expect(screen(term, 8)).toEqual(['keep me', 'second']);
    expect(snap.cells.length).toBe(30 * 8 * CELL_WORDS);
    term.dispose();
  });

  it('narrowing reflows wrapped content, cursor anchored', () => {
    const term = makeTerminal({ cols: 20, rows: 6 });
    term.write('abcdefghij');
    term.resize(5, 6);
    // Reflow keeps the cursor line in view; the first half moves to
    // history but the full text survives in order.
    expect(term.textRow(0)).toBe('fghij');
    expect(term.dump()).toContain('abcdefghij');
    term.scrollLines(1);
    expect(term.textRow(0)).toBe('abcde');
    term.dispose();
  });
});

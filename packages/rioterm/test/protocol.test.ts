// Query auto-responses, OSC events, selection, links, and the snapshot
// contract renderers depend on.

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { CELL_WORDS } from '../src/index.js';
import { collectData, ensureWasm, makeTerminal } from './helpers.js';

beforeAll(ensureWasm);

describe('query auto-responses', () => {
  it('answers DA1 and DSR cursor position', () => {
    const term = makeTerminal();
    const out = collectData(term);
    term.write('\x1b[c');
    expect(out.text()).toMatch(/^\x1b\[\?\d/);
    out.clear();
    term.write('abc\x1b[6n');
    expect(out.text()).toBe('\x1b[1;4R');
    term.dispose();
  });

  it('reports mode state via DECRQM', () => {
    const term = makeTerminal();
    const out = collectData(term);
    term.write('\x1b[?2004$p');
    expect(out.text()).toBe('\x1b[?2004;2$y');
    out.clear();
    term.write('\x1b[?2004h\x1b[?2004$p');
    expect(out.text()).toBe('\x1b[?2004;1$y');
    term.dispose();
  });

  it('suppresses replayed query responses via write-time gating', () => {
    // The lovable adapter pattern: consumers wrap write() with a flag and
    // drop onData during replay. Verify responses fire synchronously
    // inside write() so that gate is sound.
    const term = makeTerminal();
    let during = 0;
    let writing = false;
    term.onData(() => {
      if (writing) during++;
    });
    writing = true;
    term.write('\x1b[c\x1b[6n');
    writing = false;
    expect(during).toBe(2);
    term.dispose();
  });
});

describe('OSC events', () => {
  it('title changes fire onTitleChange', () => {
    const term = makeTerminal();
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.write('\x1b]0;hello\x07\x1b]2;world\x1b\\');
    expect(titles).toEqual(['hello', 'world']);
    term.dispose();
  });

  it('OSC 52 writes decode base64 to the clipboard callback', () => {
    const term = makeTerminal();
    const clip = vi.fn();
    term.onClipboardWrite(clip);
    term.write(`\x1b]52;c;${Buffer.from('copied!').toString('base64')}\x07`);
    expect(clip).toHaveBeenCalledWith('copied!');
    term.dispose();
  });

  it('bell and progress reports reach their callbacks', () => {
    const term = makeTerminal();
    const bell = vi.fn();
    const progress = vi.fn();
    term.onBell(bell);
    term.onProgress(progress);
    term.write('\x07\x1b]9;4;1;42\x07\x1b]9;4;0\x07');
    expect(bell).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenNthCalledWith(1, 1, 42);
    expect(progress).toHaveBeenNthCalledWith(2, 0, 0);
    term.dispose();
  });
});

describe('bracketed paste', () => {
  it('wraps exactly when the program enabled the mode', () => {
    const term = makeTerminal();
    const out = collectData(term);
    term.paste('a\r\nb\nc');
    expect(out.text()).toBe('a\rb\rc');
    out.clear();
    term.write('\x1b[?2004h');
    term.paste('danger\n');
    expect(out.text()).toBe('\x1b[200~danger\r\x1b[201~');
    out.clear();
    term.write('\x1b[?2004l');
    term.paste('plain');
    expect(out.text()).toBe('plain');
    term.dispose();
  });
});

describe('selection', () => {
  it('word selection grabs semantic chunks', () => {
    const term = makeTerminal();
    term.write('alpha beta-gamma delta');
    term.selectionBegin(0, 7, 'word');
    expect(term.getSelection()).toContain('beta');
    term.dispose();
  });

  it('line selection takes the whole row', () => {
    const term = makeTerminal();
    term.write('first line\r\nsecond');
    term.selectionBegin(0, 3, 'line');
    expect(term.getSelection()?.trimEnd()).toBe('first line');
    term.dispose();
  });

  it('block selection is rectangular', () => {
    const term = makeTerminal();
    term.write('abcd\r\nefgh\r\nijkl');
    term.selectionBegin(0, 1, 'block');
    term.selectionUpdate(2, 2, true);
    expect(term.getSelection()).toBe('bc\nfg\njk');
    term.dispose();
  });

  it('selection spans wrapped lines without a break', () => {
    const term = makeTerminal({ cols: 5 });
    term.write('abcdefgh');
    term.selectionBegin(0, 0);
    term.selectionUpdate(1, 2, true);
    expect(term.getSelection()).toBe('abcdefgh');
    term.dispose();
  });

  it('appears in the snapshot and clears on demand', () => {
    const term = makeTerminal();
    term.write('select me');
    term.selectionBegin(0, 0);
    term.selectionUpdate(0, 5, true);
    const sel = term.snapshot().selection;
    expect(sel).toEqual({ startLine: 0, startCol: 0, endLine: 0, endCol: 5, isBlock: false });
    term.clearSelection();
    expect(term.snapshot().selection).toBeNull();
    term.dispose();
  });
});

describe('OSC 8 links', () => {
  it('wrapped links resolve as one URI with per-row runs', () => {
    const term = makeTerminal({ cols: 8 });
    term.write('->\x1b]8;;https://x.dev\x1b\\0123456789\x1b]8;;\x1b\\');
    expect(term.linkAt(0, 4)?.uri).toBe('https://x.dev');
    expect(term.linkAt(1, 1)?.uri).toBe('https://x.dev');
    expect(term.linkAt(0, 4)).toMatchObject({ startCol: 2, endCol: 7 });
    expect(term.linkAt(1, 1)).toMatchObject({ startCol: 0, endCol: 3 });
    expect(term.linkAt(0, 0)).toBeUndefined();
    term.dispose();
  });

  it('distinct links stay distinct even when adjacent', () => {
    const term = makeTerminal();
    term.write('\x1b]8;;https://a.dev\x1b\\AA\x1b]8;;https://b.dev\x1b\\BB\x1b]8;;\x1b\\');
    expect(term.linkAt(0, 1)?.uri).toBe('https://a.dev');
    expect(term.linkAt(0, 2)?.uri).toBe('https://b.dev');
    expect(term.linkAt(0, 1)?.endCol).toBe(1);
    expect(term.linkAt(0, 2)?.startCol).toBe(2);
    term.dispose();
  });
});

describe('snapshot contract', () => {
  it('dirty rows track writes and reset per snapshot', () => {
    const term = makeTerminal();
    term.write('a');
    let snap = term.snapshot();
    expect(snap.dirtyRows[0]).toBe(true);
    snap = term.snapshot();
    expect(snap.dirtyRows[0]).toBe(false);
    term.write('\x1b[5;1Hb');
    snap = term.snapshot();
    expect(snap.dirtyRows[4]).toBe(true);
    expect(snap.dirtyRows[8]).toBe(false);
    term.dispose();
  });

  it('write is reentrant from onData handlers', () => {
    const term = makeTerminal();
    const decoder = new TextDecoder();
    term.onData((bytes) => term.write(decoder.decode(bytes)));
    term.key(0, 0, 0x68, 0, 0, 0, false, 'h');
    expect(term.textRow(0)).toBe('h');
    term.dispose();
  });

  it('write_row equals the matching slice of write_cells', () => {
    const term = makeTerminal({ cols: 8, rows: 3 });
    term.write('ab\x1b[31mc\r\nxyz');
    const snap = term.snapshot();
    // textRow and packed cells must agree.
    expect(term.textRow(1)).toBe('xyz');
    const row1 = snap.cells.slice(1 * snap.cols * CELL_WORDS, 2 * snap.cols * CELL_WORDS);
    expect(String.fromCodePoint(row1[0] & 0x1fffff)).toBe('x');
    term.dispose();
  });

  it('disposing twice is safe', () => {
    const term = makeTerminal();
    term.dispose();
    expect(() => term.dispose()).not.toThrow();
  });
});

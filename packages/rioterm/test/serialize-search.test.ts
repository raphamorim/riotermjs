// serialize(): the reconnect story. A dump with styles that a fresh
// same-width terminal replays into identical state. search(): regex over
// scrollback + screen in buffer coordinates, with findNext/findPrevious
// cycling, selection, and scroll-into-view.

import { beforeAll, describe, expect, it } from 'vitest';

import { CELL_WORDS, COLOR_RGB, STYLE_BOLD } from '../src/index.js';
import { ensureWasm, makeTerminal, screen } from './helpers.js';

beforeAll(ensureWasm);

describe('serialize', () => {
  it('round-trips text into an identical replica', () => {
    const term = makeTerminal();
    term.write('first line\r\nsecond line\r\n$ ');
    const replica = makeTerminal();
    replica.write(term.serialize());
    expect(screen(replica)).toEqual(screen(term));
    expect(replica.snapshot().cursorCol).toBe(2);
    term.dispose();
    replica.dispose();
  });

  it('preserves SGR styles cell for cell', () => {
    const term = makeTerminal();
    term.write('\x1b[1;31mbold red\x1b[0m plain \x1b[38;2;1;2;3mrgb\x1b[0m');
    const replica = makeTerminal();
    replica.write(term.serialize());
    const a = term.snapshot();
    const b = replica.snapshot();
    expect(Array.from(b.cells)).toEqual(Array.from(a.cells));
    // Sanity: the styles under test are actually present.
    expect(b.cells[3] & STYLE_BOLD).toBe(STYLE_BOLD);
    expect(b.cells[16 * CELL_WORDS + 1] >>> 24).toBe(COLOR_RGB);
    term.dispose();
    replica.dispose();
  });

  it('serializing the replica is a fixed point', () => {
    const term = makeTerminal();
    term.write('\x1b[7;4mstyled\x1b[0m ok\r\nnext');
    const first = term.serialize();
    const replica = makeTerminal();
    replica.write(first);
    expect(replica.serialize()).toBe(first);
    term.dispose();
    replica.dispose();
  });

  it('covers scrollback and re-wraps long lines at the same width', () => {
    const term = makeTerminal({ cols: 20, rows: 5 });
    for (let i = 0; i < 12; i++) term.write(`history line ${i}\r\n`);
    term.write('abcdefghijklmnopqrstuvwxyz');
    expect(term.historySize()).toBeGreaterThan(0);
    const replica = makeTerminal({ cols: 20, rows: 5 });
    replica.write(term.serialize());
    expect(replica.dump()).toBe(term.dump());
    expect(replica.historySize()).toBe(term.historySize());
    expect(replica.textRow(4)).toBe('uvwxyz');
    term.dispose();
    replica.dispose();
  });

  it('keeps wide characters and OSC 8 links', () => {
    const term = makeTerminal();
    term.write('宽字 \x1b]8;;https://rioterm.com\x1b\\link\x1b]8;;\x1b\\ end');
    const out = term.serialize();
    expect(out).toContain('\x1b]8;;https://rioterm.com\x1b\\');
    const replica = makeTerminal();
    replica.write(out);
    expect(replica.textRow(0)).toBe(term.textRow(0));
    expect(replica.linkAt(0, 6)?.uri).toBe('https://rioterm.com');
    expect(replica.linkAt(0, 10)).toBeUndefined();
    term.dispose();
    replica.dispose();
  });
});

describe('search', () => {
  it('finds matches in buffer coordinates across scrollback', () => {
    const term = makeTerminal({ cols: 40, rows: 5 });
    for (let i = 0; i < 8; i++) term.write(`filler ${i}\r\n`);
    term.write('needle at last');
    const fillers = term.search('filler');
    expect(fillers).toHaveLength(8);
    expect(fillers[0].startLine).toBe(0);
    expect(fillers[7].startLine).toBe(7);
    const [hit] = term.search('needle');
    expect(hit).toEqual({
      startLine: term.historySize() + 4,
      startCol: 0,
      endLine: term.historySize() + 4,
      endCol: 5,
    });
    term.dispose();
  });

  it('supports regex patterns and honors max', () => {
    const term = makeTerminal();
    term.write('error 12\r\nwarn 3\r\nerror 45');
    expect(term.search('(error|warn) \\d+')).toHaveLength(3);
    expect(term.search('error \\d+', 1)).toHaveLength(1);
    term.dispose();
  });

  it('an invalid pattern matches nothing', () => {
    const term = makeTerminal();
    term.write('anything');
    expect(term.search('[')).toEqual([]);
    term.dispose();
  });

  it('findNext cycles forward with wrap-around and selects the match', () => {
    const term = makeTerminal({ cols: 40, rows: 5 });
    term.write('one match\r\ntwo match\r\nthree match');
    const first = term.findNext('match')!;
    expect(first.startLine).toBe(0);
    expect(term.getSelection()).toBe('match');
    expect(term.findNext('match')!.startLine).toBe(1);
    expect(term.findNext('match')!.startLine).toBe(2);
    expect(term.findNext('match')!.startLine).toBe(0);
    term.dispose();
  });

  it('findPrevious starts from the last match and wraps backward', () => {
    const term = makeTerminal({ cols: 40, rows: 5 });
    term.write('a needle\r\nb needle');
    expect(term.findPrevious('needle')!.startLine).toBe(1);
    expect(term.findPrevious('needle')!.startLine).toBe(0);
    expect(term.findPrevious('needle')!.startLine).toBe(1);
    term.dispose();
  });

  it('scrolls a scrollback match into view', () => {
    const term = makeTerminal({ cols: 40, rows: 5 });
    term.write('target here\r\n');
    for (let i = 0; i < 20; i++) term.write(`noise ${i}\r\n`);
    expect(term.displayOffset()).toBe(0);
    const hit = term.findNext('target')!;
    expect(hit.startLine).toBe(0);
    const snap = term.snapshot();
    expect(snap.displayOffset).toBeGreaterThan(0);
    // The match row is inside the viewport and selected.
    const viewportLine = hit.startLine - term.historySize() + snap.displayOffset;
    expect(viewportLine).toBeGreaterThanOrEqual(0);
    expect(viewportLine).toBeLessThan(5);
    expect(term.textRow(viewportLine)).toBe('target here');
    expect(term.getSelection()).toBe('target');
    term.dispose();
  });

  it('a new pattern resets the cycle', () => {
    const term = makeTerminal();
    term.write('alpha beta alpha beta');
    expect(term.findNext('alpha')!.startCol).toBe(0);
    expect(term.findNext('beta')!.startCol).toBe(6);
    expect(term.findNext('beta')!.startCol).toBe(17);
    term.dispose();
  });

  it('no match clears state and returns undefined', () => {
    const term = makeTerminal();
    term.write('nothing to see');
    expect(term.findNext('absent')).toBeUndefined();
    term.dispose();
  });
});

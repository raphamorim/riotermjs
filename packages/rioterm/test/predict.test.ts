// Predictive local echo: feed keystrokes to the engine, simulate the
// server's echo with term.write(), and assert the overlay the renderer
// would composite. No DOM/canvas needed.

import { beforeAll, describe, expect, it } from 'vitest';

import { PredictionEngine } from '../src/index.js';
import { ensureWasm, makeTerminal } from './helpers.js';

beforeAll(ensureWasm);

const enc = (s: string) => new TextEncoder().encode(s);
const BACKSPACE = new Uint8Array([0x7f]);
const ENTER = new Uint8Array([0x0d]);
const TAB = new Uint8Array([0x09]);

/** A terminal sitting at a shell prompt "$ " with the cursor at col 2. */
function atPrompt() {
  const term = makeTerminal();
  term.write('$ ');
  return term;
}

describe('predictive echo', () => {
  it('paints a typed char at the cursor before the server echoes', () => {
    const term = atPrompt();
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });
    eng.onInput(enc('a'));
    const ov = eng.overlay(term.snapshot());
    expect(ov.cells).toHaveLength(1);
    expect(ov.cells[0]).toMatchObject({ row: 0, col: 2, codepoint: 0x61 });
    expect(ov.cursor).toEqual({ row: 0, col: 3 });
  });

  it('retires a prediction once the server echoes the same char', () => {
    const term = atPrompt();
    let t = 1000;
    const eng = new PredictionEngine(term, { latencyThreshold: 0, now: () => t });
    eng.onInput(enc('a'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(1);

    t = 1005;
    term.write('a'); // server echo lands the real glyph
    const ov = eng.overlay(term.snapshot());
    expect(ov.cells).toHaveLength(0);
    expect(ov.cursor).toBeNull();
  });

  it('clears everything when the echo diverges (e.g. a password mask)', () => {
    const term = atPrompt();
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });
    eng.onInput(enc('a'));
    term.write('*'); // the shell echoed something other than what we guessed
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0);
  });

  it('backspace removes the most recent prediction', () => {
    const term = atPrompt();
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });
    eng.onInput(enc('a'));
    eng.onInput(enc('b'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(2);

    eng.onInput(BACKSPACE);
    const ov = eng.overlay(term.snapshot());
    expect(ov.cells).toHaveLength(1);
    expect(ov.cells[0].codepoint).toBe(0x61);
    expect(ov.cursor).toEqual({ row: 0, col: 3 });
  });

  it('does not predict Enter, Tab, control, or wide chars', () => {
    const term = atPrompt();
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });

    eng.onInput(enc('a'));
    eng.onInput(ENTER);
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0);

    eng.onInput(TAB);
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0);

    eng.onInput(enc('世')); // wide CJK: shifts the grid ambiguously
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0);
  });

  it('does not predict on the alternate screen (full-screen apps)', () => {
    const term = atPrompt();
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });
    term.write('\x1b[?1049h'); // enter alt screen (vim/less/...)
    eng.onInput(enc('a'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0);
  });

  it('hides predictions once the link proves fast (latency gating)', () => {
    const term = atPrompt();
    let t = 0;
    const eng = new PredictionEngine(term, { latencyThreshold: 30, now: () => t });

    // No latency sample yet: predict optimistically.
    eng.onInput(enc('a'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(1);

    // Confirm in 5ms: well under the 30ms threshold.
    t = 5;
    term.write('a');
    eng.overlay(term.snapshot());

    // Next keystroke is still predicted internally but not shown.
    t = 6;
    eng.onInput(enc('b'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0);
  });

  it('keeps showing predictions on a slow link', () => {
    const term = atPrompt();
    let t = 0;
    const eng = new PredictionEngine(term, { latencyThreshold: 30, now: () => t });

    eng.onInput(enc('a'));
    eng.overlay(term.snapshot());
    t = 200; // 200ms round trip
    term.write('a');
    eng.overlay(term.snapshot());

    t = 210;
    eng.onInput(enc('b'));
    const ov = eng.overlay(term.snapshot());
    expect(ov.cells).toHaveLength(1);
    expect(ov.cells[0].flagged).toBe(true); // > 80ms: marked tentative
  });
});

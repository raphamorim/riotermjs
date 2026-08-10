// Predictive local echo: feed keystrokes to the engine, simulate the
// server's echo with term.write(), and assert the overlay the renderer
// would composite. No DOM/canvas needed.

import { beforeAll, describe, expect, it } from 'vitest';

import { KEY_ACTION_PRESS, KEY_CHAR, PredictionEngine, PredictionStats } from '../src/index.js';
import { collectData, ensureWasm, makeTerminal } from './helpers.js';

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

  it('setEnabled(false) clears and stops predicting (observer role flip)', () => {
    const term = atPrompt();
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });
    eng.onInput(enc('a'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(1);

    eng.setEnabled(false);
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0);
    eng.onInput(enc('b'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0);

    eng.setEnabled(true);
    eng.onInput(enc('c'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(1);
  });

  // Regression: predictive echo is fed from an onData listener registered
  // before the embedder's input listener. If a throw there aborted the emit
  // loop, the real keystroke never reached the backend and typing silently
  // broke. onData must isolate listener errors.
  it('a throwing onData listener never swallows input for other listeners', () => {
    const term = makeTerminal();
    const sink = collectData(term);
    term.onData(() => {
      throw new Error('broken enhancement listener');
    });
    // Re-collect after the thrower so we assert delivery past it.
    let afterThrower = '';
    term.onData((bytes) => {
      afterThrower += String.fromCharCode(...bytes);
    });
    term.key(KEY_ACTION_PRESS, KEY_CHAR, 0x61, 0, 0, 0, false, 'a');
    expect(sink.text()).toBe('a'); // listener before the thrower still fired
    expect(afterThrower).toBe('a'); // and the one after it too
  });

  it('confirms predictions in order across a multi-char burst', () => {
    const term = atPrompt();
    let t = 0;
    const eng = new PredictionEngine(term, { latencyThreshold: 0, now: () => t });
    eng.onInput(enc('a'));
    eng.onInput(enc('b'));
    eng.onInput(enc('c'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(3);

    t = 10;
    term.write('a'); // only the first char echoes so far
    let ov = eng.overlay(term.snapshot());
    expect(ov.cells).toHaveLength(2);
    expect(ov.cells.map((c) => c.codepoint)).toEqual([0x62, 0x63]);

    t = 20;
    term.write('bc'); // the rest catches up
    ov = eng.overlay(term.snapshot());
    expect(ov.cells).toHaveLength(0);
    expect(ov.cursor).toBeNull();
  });

  it('never predicts past the last column (wrap is ambiguous)', () => {
    const term = makeTerminal({ cols: 6, rows: 4 });
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });
    // Fill toward the edge; the engine must stop before column cols-1.
    for (const ch of 'abcdef') eng.onInput(enc(ch));
    const ov = eng.overlay(term.snapshot());
    for (const cell of ov.cells) expect(cell.col).toBeLessThan(term.options.cols - 1);
  });

  // Mosh's core guarantee: predictions are an overlay, never authoritative.
  it('overlay never mutates the authoritative snapshot', () => {
    const term = atPrompt();
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });
    eng.onInput(enc('a'));
    const snap = term.snapshot();
    const before = Uint32Array.from(snap.cells);
    eng.overlay(snap);
    expect(snap.cells).toEqual(before);
  });

  it('retires an unconfirmed prediction after the max age (never lingers)', () => {
    const term = atPrompt();
    let t = 0;
    const eng = new PredictionEngine(term, { latencyThreshold: 0, now: () => t });
    eng.onInput(enc('a'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(1);
    t = 2000; // past the ~1s max age with no echo
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0);
  });

  it('stops predicting after repeated wrong guesses (accuracy cooldown)', () => {
    const term = atPrompt();
    const eng = new PredictionEngine(term, { latencyThreshold: 0, now: () => 0 });
    for (let i = 0; i < 3; i++) {
      eng.onInput(enc('a'));
      term.write('*'); // server contradicts every time (e.g. a masked prompt)
      eng.overlay(term.snapshot());
    }
    eng.onInput(enc('a'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0); // in cooldown
  });

  it('does not predict, or throw, on combining/multibyte sequences', () => {
    const term = atPrompt();
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });
    expect(() => eng.onInput(enc('é'))).not.toThrow(); // e + combining acute
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0);
  });

  it('does not predict over existing content (no mid-line overwrite)', () => {
    const term = makeTerminal({ cols: 40, rows: 10 });
    term.write('abc\r'); // CR returns the cursor over the existing "abc"
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });
    eng.onInput(enc('x'));
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

  // --- Epochs / newline warm-up ---

  it('predicts through Enter but holds the new line until the newline is confirmed', () => {
    const term = atPrompt();
    let t = 0;
    const eng = new PredictionEngine(term, { latencyThreshold: 0, now: () => t });
    eng.onInput(ENTER);
    eng.onInput(enc('x')); // typed before the server processed the newline
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0); // held: tentative epoch

    t = 5;
    term.write('\r\n'); // server performs the newline: cursor -> row 1, col 0
    const ov = eng.overlay(term.snapshot());
    expect(ov.cells).toHaveLength(1);
    expect(ov.cells[0]).toMatchObject({ row: 1, col: 0, codepoint: 0x78 });
  });

  // --- Cursor prediction ---

  it('predicts left/right arrow cursor moves over confirmed text', () => {
    const term = atPrompt();
    let t = 0;
    const eng = new PredictionEngine(term, { latencyThreshold: 0, now: () => t });
    eng.onInput(enc('a'));
    eng.onInput(enc('b'));
    t = 5;
    term.write('ab'); // confirm; the real cursor is now at col 4
    eng.overlay(term.snapshot());

    eng.onInput(enc('\x1b[D')); // left arrow
    expect(eng.overlay(term.snapshot()).cursor).toEqual({ row: 0, col: 3 });
    eng.onInput(enc('\x1b[C')); // right arrow, back onto the real cursor
    expect(eng.overlay(term.snapshot()).cursor).toBeNull();
  });

  it('predicts a word-back cursor move over typed text (ESC b)', () => {
    const term = atPrompt();
    let t = 0;
    const eng = new PredictionEngine(term, { latencyThreshold: 0, now: () => t });
    for (const ch of 'ab.cd') eng.onInput(enc(ch));
    t = 5;
    term.write('ab.cd'); // confirm; cursor at col 7
    eng.overlay(term.snapshot());
    eng.onInput(enc('\x1bb')); // word-back -> start of "cd"
    expect(eng.overlay(term.snapshot()).cursor).toEqual({ row: 0, col: 5 });
  });

  it('does not predict a cursor move past the editable region', () => {
    const term = atPrompt();
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });
    // At the prompt with no typed text: left arrow must not walk into the prompt.
    eng.onInput(enc('\x1b[D'));
    expect(eng.overlay(term.snapshot()).cursor).toBeNull();
  });

  // --- Accuracy statistics + gating ---

  it('PredictionStats tracks accuracy and ages samples out of the ring', () => {
    const s = new PredictionStats();
    for (let i = 0; i < 5; i++) s.record(100, i < 3); // 3 correct, 2 wrong
    expect(s.sampleSize).toBe(5);
    expect(s.accuracy).toBeCloseTo(3 / 5);
    for (let i = 0; i < 24; i++) s.record(50, true); // overwrite the whole ring
    expect(s.sampleSize).toBe(24);
    expect(s.accuracy).toBe(1);
  });

  it('hides predictions when the accuracy window is mostly wrong', () => {
    const term = atPrompt();
    const eng = new PredictionEngine(term, { latencyThreshold: 0 });
    for (let i = 0; i < 6; i++) eng.stats.record(50, false); // window says we guess wrong
    eng.onInput(enc('a'));
    expect(eng.overlay(term.snapshot()).cells).toHaveLength(0);
  });
});

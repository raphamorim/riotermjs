// Predictive local echo: paint typed characters immediately as an overlay,
// then retire them when the server's real echo lands. This is mosh's
// terminaloverlay model (and VS Code's typeahead port of it): predictions
// live OUTSIDE the authoritative grid, so a confirmed prediction just stops
// drawing once the real glyph occupies the cell. Nothing is ever written
// into the wasm grid, so there is no double-echo to reconcile.
//
// On a low-latency link the echo arrives within a frame and the overlay is
// imperceptible; on a high-latency link you see your keystrokes instantly
// and they firm up when the round trip completes.

import { CELL_WORDS, type Snapshot, type Terminal } from './core.js';

export type PredictionStyle = 'underline' | 'dim';

export interface PredictionOptions {
  /** Master switch. Default true (the engine is only created when asked for). */
  enabled?: boolean;
  /**
   * Show predictions only once measured echo latency exceeds this many ms;
   * turn-off uses half the value (hysteresis), matching VS Code's 30ms
   * default and mosh's 30/20 SRTT trigger. 0 shows predictions always.
   */
  latencyThreshold?: number;
  /** How unconfirmed glyphs are marked: mosh underlines, VS Code dims. */
  style?: PredictionStyle;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

/** A drawable prediction the renderer composites over the grid. */
export interface OverlayCell {
  row: number;
  col: number;
  codepoint: number;
  /** Mark it tentative (underline/dim) because the link is slow. */
  flagged: boolean;
}

export interface Overlay {
  cells: OverlayCell[];
  /** The predicted cursor (frontier); null hands the cursor back to the grid. */
  cursor: { row: number; col: number } | null;
}

interface Prediction {
  row: number;
  col: number;
  codepoint: number;
  /** What occupied the cell when predicted; a real echo must differ from it. */
  original: number;
  /** When the prediction was made (ms), for latency measurement and expiry. */
  at: number;
}

const SP = 32;
const DEL = 0x7f;
const BS = 0x08;
const CR = 0x0d;

// A prediction the server never echoes (typed into a program that ignores
// input) is dropped after this so the overlay does not keep a stale ghost.
const PREDICTION_MAX_AGE = 1000;
// Above this measured latency, mark predictions tentative (mosh FLAG 80ms).
const FLAG_LATENCY = 80;
// Consecutive wrong guesses that trip a cooldown; stands in for VS Code's
// accuracy gate and quietly stops predicting in password/line-rewrite shells.
const FAILURE_LIMIT = 3;
const COOLDOWN_MS = 3000;
// SRTT smoothing (mosh uses 1/8).
const SRTT_ALPHA = 0.125;

function cellCodepoint(snap: Snapshot, row: number, col: number): number {
  return snap.cells[(row * snap.cols + col) * CELL_WORDS] & 0x1fffff;
}

/**
 * The single printable, width-1 codepoint an outgoing keystroke represents,
 * or null when the bytes are anything we must not predict (control chars,
 * ESC/CSI sequences, multi-codepoint chunks, wide/combining chars).
 */
function singlePrintable(bytes: Uint8Array): number | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const points = [...text];
  if (points.length !== 1) return null;
  const cp = points[0].codePointAt(0)!;
  if (cp < 0x20 || cp === DEL) return null; // control / delete
  if (isWide(cp)) return null; // width-2 glyphs shift the grid ambiguously
  return cp;
}

/** Coarse East-Asian-Wide / emoji test; conservative (unknown = not wide). */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK, Kangxi, ...
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji / symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  );
}

export class PredictionEngine {
  private term: Terminal;
  private enabled: boolean;
  private latencyThreshold: number;
  private style: PredictionStyle;
  private now: () => number;

  private preds: Prediction[] = [];
  /** The predicted cursor frontier; null means re-anchor on the next key. */
  private cursor: { row: number; col: number } | null = null;
  private srtt: number | undefined;
  /** Hysteresis latch for whether predictions are currently displayed. */
  private showing = false;
  private failures = 0;
  private cooldownUntil = 0;

  constructor(term: Terminal, options: PredictionOptions = {}) {
    this.term = term;
    this.enabled = options.enabled ?? true;
    this.latencyThreshold = options.latencyThreshold ?? 30;
    this.style = options.style ?? 'underline';
    this.now =
      options.now ??
      (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.reset();
  }

  /** Discard all predictions and re-anchor on the next keystroke (new epoch). */
  flush(): void {
    this.reset();
  }

  private reset(): void {
    this.preds = [];
    this.cursor = null;
  }

  /**
   * Feed one outgoing user keystroke (the already-encoded bytes from onData).
   * Only genuine keystrokes should reach this, not parser auto-responses.
   */
  onInput(bytes: Uint8Array): void {
    if (!this.enabled || bytes.length === 0) return;

    const now = this.now();
    if (now < this.cooldownUntil) {
      this.reset();
      return;
    }
    // The live screen only: full-screen apps (vim/less/...) repaint whole
    // frames, so cell prediction is meaningless there.
    if (this.term.modes().altScreen) {
      this.reset();
      return;
    }

    if (bytes.length === 1 && (bytes[0] === DEL || bytes[0] === BS)) {
      this.predictBackspace();
      return;
    }
    if (bytes.length === 1 && bytes[0] === CR) {
      // Enter: the echo (newline, next prompt) is unpredictable. New epoch.
      this.reset();
      return;
    }

    const cp = singlePrintable(bytes);
    if (cp === null) {
      this.reset(); // Tab, control, ESC/CSI, wide, multi-char: do not predict.
      return;
    }
    this.predictChar(cp, now);
  }

  private anchor(): void {
    if (this.cursor) return;
    const { line, col, visible } = this.term.cursorPosition();
    if (!visible || this.term.displayOffset() !== 0) return;
    this.cursor = { row: line, col };
  }

  private predictChar(cp: number, now: number): void {
    this.anchor();
    if (!this.cursor) return;

    const cols = this.term.options.cols;
    // Wrapping at the last column is ambiguous (shells overwrite, editors
    // show a marker), so stop the epoch rather than guess.
    if (this.cursor.col >= cols - 1) {
      this.reset();
      return;
    }

    // Only predict onto blank cells: overwriting existing content would be a
    // mid-line insert/edit, which we cannot model without the line editor.
    const row = this.term.textRow(this.cursor.row);
    const original = row.codePointAt(this.cursor.col) ?? SP;
    if (original !== 0 && original !== SP) {
      this.reset();
      return;
    }

    this.preds.push({ row: this.cursor.row, col: this.cursor.col, codepoint: cp, original, at: now });
    this.cursor = { row: this.cursor.row, col: this.cursor.col + 1 };
  }

  private predictBackspace(): void {
    // We can only predict erasing a char we ourselves predicted; erasing real
    // content needs the server's authority.
    const last = this.preds.pop();
    if (!last) {
      this.reset();
      return;
    }
    this.cursor = { row: last.row, col: last.col };
  }

  private diverge(now: number): void {
    this.reset();
    this.failures++;
    if (this.failures >= FAILURE_LIMIT) {
      this.cooldownUntil = now + COOLDOWN_MS;
      this.failures = 0;
    }
  }

  private recordLatency(sample: number): void {
    this.srtt =
      this.srtt === undefined ? sample : this.srtt * (1 - SRTT_ALPHA) + sample * SRTT_ALPHA;
  }

  private shouldShow(): boolean {
    if (this.latencyThreshold === 0) return true;
    if (this.srtt === undefined) return true; // no data yet: predict optimistically
    const t = this.latencyThreshold;
    this.showing = this.showing ? this.srtt > t * 0.5 : this.srtt > t;
    return this.showing;
  }

  /**
   * Reconcile against the frame and return what to draw. Confirmed predictions
   * (the grid now shows them) are retired; a live-epoch mismatch clears all
   * predictions and re-anchors. Called once per rendered frame.
   */
  overlay(snap: Snapshot): Overlay {
    const empty: Overlay = { cells: [], cursor: null };
    if (!this.enabled || snap.altScreen || !snap.cursorVisible || snap.displayOffset !== 0) {
      this.reset();
      return empty;
    }

    const now = this.now();
    while (this.preds.length > 0) {
      const p = this.preds[0];
      if (p.row >= snap.rows || p.col >= snap.cols) {
        this.diverge(now);
        return empty;
      }
      const real = cellCodepoint(snap, p.row, p.col);
      if (real === p.codepoint && real !== p.original) {
        // The server echoed exactly what we guessed: confirmed, retire it.
        this.recordLatency(now - p.at);
        this.failures = 0;
        this.preds.shift();
        continue;
      }
      if (real === 0 || real === SP) {
        // Not echoed yet. Everything after is also pending; expire if stale.
        if (now - p.at > PREDICTION_MAX_AGE) {
          this.reset();
          return empty;
        }
        break;
      }
      // The cell holds something else: our model is wrong, drop everything.
      this.diverge(now);
      return empty;
    }

    if (this.preds.length === 0) {
      // Fully caught up: hand the cursor back to the authoritative grid.
      this.cursor = null;
      return empty;
    }
    if (!this.shouldShow()) return empty;

    const flagged = (this.srtt ?? Infinity) > FLAG_LATENCY;
    const cells: OverlayCell[] = this.preds.map((p) => ({
      row: p.row,
      col: p.col,
      codepoint: p.codepoint,
      flagged,
    }));
    return { cells, cursor: this.cursor ? { ...this.cursor } : null };
  }

  /** Which visual treatment unconfirmed glyphs get (renderer reads this). */
  get markStyle(): PredictionStyle {
    return this.style;
  }
}

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
//
// Beyond simple character echo this engine ports mosh's epoch model (predict
// through Enter and hold new-line predictions until they are confirmed),
// cursor prediction for arrow / word navigation, a rolling accuracy window,
// and SRTT / glitch based display gating. All of it stays an overlay: the
// authoritative grid is only ever read, never mutated.

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
  /**
   * A predicted deletion: the renderer masks this cell with the theme
   * background instead of drawing a glyph (codepoint is 0). Never a grid write.
   */
  erase?: boolean;
}

export interface Overlay {
  cells: OverlayCell[];
  /** The predicted cursor (frontier); null hands the cursor back to the grid. */
  cursor: { row: number; col: number } | null;
}

/** One predicted glyph. Tagged with an epoch so tentative lines can be held. */
interface CellPrediction {
  row: number;
  col: number;
  codepoint: number;
  /** What occupied the cell when predicted; a real echo must differ from it. */
  original: number;
  /** The prediction epoch; held (not drawn) while epoch > confirmedEpoch. */
  epoch: number;
  /** When the prediction was made (ms), for latency measurement and expiry. */
  at: number;
  /**
   * An erase (backspace over confirmed content): masks the cell to blank.
   * Confirms when the grid cell blanks; diverges if it holds another glyph.
   */
  erase?: boolean;
}

/** A predicted cursor jump (Enter to next line, or an arrow / word move). */
interface CursorPrediction {
  row: number;
  col: number;
  epoch: number;
  at: number;
}

const SP = 32;
const DEL = 0x7f;
const BS = 0x08;
const CR = 0x0d;
const ESC = 0x1b;
const CTRL_A = 0x01; // readline home
const CTRL_E = 0x05; // readline end

// Grace period before giving up on an un-echoed prediction (see maxAge). It
// must comfortably exceed real round-trip time so a slow-but-real echo is never
// killed prematurely (that would suppress predictions on exactly the slow links
// they help most); only a true no-echo prompt should reach it. Wrong guesses do
// not wait for this - they clear immediately via the divergence path.
const PREDICTION_MIN_MAX_AGE = 1500;
// SRTT smoothing (mosh uses 1/8).
const SRTT_ALPHA = 0.125;
// Underline/dim predictions when the link is this slow, cure below the low
// mark (mosh FLAG 80/50 hysteresis).
const FLAG_HIGH = 80;
const FLAG_LOW = 50;
// Glitch triggers (mosh): a prediction outstanding this long forces display
// even on a fast link; a run of quick confirmations cures it again.
const GLITCH_THRESHOLD = 250;
const GLITCH_REPAIR_COUNT = 10;
const GLITCH_REPAIR_MININTERVAL = 150;
const GLITCH_FLAG_THRESHOLD = 5000;
// Consecutive contradictions (e.g. a password mask) trip a short cooldown.
// This backs up the accuracy window for the rapid-divergence case that never
// accumulates enough samples to gate on its own.
const FAILURE_LIMIT = 3;
const COOLDOWN_MS = 3000;
// Rolling accuracy window (VS Code PredictionStats).
const STATS_BUFFER_SIZE = 24;
const STATS_MIN_SAMPLES = 5;
const STATS_MIN_ACCURACY = 0.3;

// Arrow / word cursor moves. ESC[D / ESC[C, application-cursor ESC O D/C
// (the optional O), and modified ESC[1;3D (alt) / ESC[1;5D (ctrl) for words.
const CSI_MOVE_RE = /^\x1b\[?([0-9]*)(;[35])?O?([DC])/;
const NOT_WORD_RE = /[^a-z0-9]/i;

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

function isWordChar(cp: number): boolean {
  if (cp === 0 || cp === SP) return false;
  return !NOT_WORD_RE.test(String.fromCodePoint(cp));
}

/**
 * Rolling window of recent prediction outcomes (VS Code's PredictionStats):
 * a ring buffer of [latency, correct] used to decide, adaptively, whether
 * predicting is helping. Exposed so callers can read live accuracy.
 */
export class PredictionStats {
  private samples: Array<[latency: number, correct: boolean]> = [];
  private index = 0;

  /** Record one reconciled prediction and its round-trip latency (ms). */
  record(latency: number, correct: boolean): void {
    this.samples[this.index] = [latency, correct];
    this.index = (this.index + 1) % STATS_BUFFER_SIZE;
  }

  /** Fraction (0-1) of tracked predictions that matched the server echo. */
  get accuracy(): number {
    let correct = 0;
    for (const [, ok] of this.samples) if (ok) correct++;
    return correct / (this.samples.length || 1);
  }

  /** How many outcomes are currently in the window (caps at the ring size). */
  get sampleSize(): number {
    return this.samples.length;
  }

  /** Latency distribution over the correctly-predicted samples. */
  get latency(): { count: number; min: number; median: number; max: number } {
    const l = this.samples
      .filter(([, ok]) => ok)
      .map(([s]) => s)
      .sort((a, b) => a - b);
    return {
      count: l.length,
      min: l[0],
      median: l[Math.floor(l.length / 2)],
      max: l[l.length - 1],
    };
  }

  reset(): void {
    this.samples = [];
    this.index = 0;
  }
}

export class PredictionEngine {
  private term: Terminal;
  private enabled: boolean;
  private latencyThreshold: number;
  private style: PredictionStyle;
  private now: () => number;

  private cells: CellPrediction[] = [];
  /** The predicted cursor frontier; null means re-anchor on the next key. */
  private cursor: { row: number; col: number } | null = null;
  private cursorAt = 0;
  /** A held cursor jump to the next line after Enter, pending confirmation. */
  private pendingNewline: CursorPrediction | null = null;

  // Epoch model: a prediction made in `predEpoch` is tentative (held, not
  // drawn) until `confirmedEpoch` catches up to it. Pressing Enter bumps
  // predEpoch, so a fresh line is warmed up: its first char is held until the
  // server confirms it. The initial line starts already confirmed so the very
  // first keystroke of a session shows immediately.
  private predEpoch = 0;
  private confirmedEpoch = 0;

  // Editable bounds of the current line, so arrows / backspace cannot wander
  // into the prompt or past the typed text (VS Code's startingX / endingX).
  private lineRow = -1;
  private lineStartCol = 0;
  private lineMaxCol = 0;

  private srtt: number | undefined;
  /** Hysteresis latch for whether predictions are currently displayed. */
  private showing = false;
  /** Whether unconfirmed glyphs are underlined/dimmed (slow-link flag). */
  private flagging = false;
  /** Long-pending predictions force display even on a fast link. */
  private glitchTrigger = 0;
  private lastQuickConfirmation = 0;
  private failures = 0;
  private cooldownUntil = 0;

  private readonly _stats = new PredictionStats();

  constructor(term: Terminal, options: PredictionOptions = {}) {
    this.term = term;
    this.enabled = options.enabled ?? true;
    this.latencyThreshold = options.latencyThreshold ?? 30;
    this.style = options.style ?? 'underline';
    this.now =
      options.now ??
      (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }

  /** Live accuracy/latency window; readable for diagnostics and tests. */
  get stats(): PredictionStats {
    return this._stats;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.reset();
  }

  /** Discard all predictions and re-anchor on the next keystroke. */
  flush(): void {
    this.reset();
  }

  private reset(): void {
    this.cells = [];
    this.cursor = null;
    this.pendingNewline = null;
    this.lineRow = -1;
    // Re-predicting after a reset should show immediately, so drop back to the
    // confirmed epoch (Enter is what deliberately warms a fresh line up).
    this.predEpoch = this.confirmedEpoch;
  }

  /** Start a new, tentative epoch: its predictions are held until confirmed. */
  private becomeTentative(): void {
    this.predEpoch = Math.max(this.predEpoch, this.confirmedEpoch) + 1;
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
    // frames, so cell prediction is meaningless there. This subsumes VS Code's
    // program-name exclude list: alt-screen covers vim/less/tmux generically,
    // so we deliberately skip the fragile terminal-title matching.
    if (this.term.modes().altScreen) {
      this.reset();
      return;
    }

    if (bytes.length === 1) {
      const b = bytes[0];
      if (b === DEL || b === BS) {
        this.predictBackspace();
        return;
      }
      if (b === CR) {
        this.predictEnter(now);
        return;
      }
      if (b === CTRL_A) {
        this.predictHomeEnd('home', now); // Ctrl-A: jump to line start
        return;
      }
      if (b === CTRL_E) {
        this.predictHomeEnd('end', now); // Ctrl-E: jump to line end
        return;
      }
      if (b < 0x20) {
        // Other C0 control: kill keys (Ctrl-U/K/W), Tab, ^C and friends rewrite
        // or redraw the line unpredictably. Drop the line's predictions.
        this.reset();
        return;
      }
    }

    if (bytes[0] === ESC) {
      this.handleEscape(String.fromCharCode(...bytes), now);
      return;
    }

    const cp = singlePrintable(bytes);
    if (cp === null) {
      this.reset(); // multi-char / wide / combining: do not predict.
      return;
    }
    this.predictChar(cp, now);
  }

  private anchor(): boolean {
    if (this.cursor) return true;
    const { line, col, visible } = this.term.cursorPosition();
    if (!visible || this.term.displayOffset() !== 0) return false;
    this.cursor = { row: line, col };
    // Keep the editable region for the current line across re-anchors (so an
    // arrow can still walk back over already-confirmed text); reset it only
    // when we land on a different line.
    if (line !== this.lineRow) {
      this.lineRow = line;
      this.lineStartCol = col;
      this.lineMaxCol = col;
    } else {
      this.lineStartCol = Math.min(this.lineStartCol, col);
      this.lineMaxCol = Math.max(this.lineMaxCol, col);
    }
    return true;
  }

  private predictChar(cp: number, now: number): void {
    if (!this.anchor() || !this.cursor) return;

    const cols = this.term.options.cols;
    // Wrapping at the last column is ambiguous (shells overwrite, editors show
    // a marker). We do not implement LinewrapPrediction; stop predicting on
    // this line rather than guess. Existing predictions stay visible.
    if (this.cursor.col >= cols - 1) return;

    // Only append at the frontier: typing after an arrow move back would be a
    // mid-line insert, which we cannot model without the line editor.
    if (this.cursor.col < this.lineMaxCol) return;

    // Only predict onto blank cells: overwriting existing content would be a
    // mid-line insert/edit.
    const original = this.gridCell(this.cursor.row, this.cursor.col);
    if (original !== 0 && original !== SP) {
      this.reset();
      return;
    }

    this.cells.push({
      row: this.cursor.row,
      col: this.cursor.col,
      codepoint: cp,
      original,
      epoch: this.predEpoch,
      at: now,
    });
    this.cursor = { row: this.cursor.row, col: this.cursor.col + 1 };
    this.cursorAt = now;
    this.lineMaxCol = Math.max(this.lineMaxCol, this.cursor.col);
  }

  private predictBackspace(): void {
    // Fast path: pop a char we ourselves predicted and have not confirmed yet.
    const last = this.cells[this.cells.length - 1];
    if (last && !last.erase && this.cursor && last.col === this.cursor.col - 1) {
      this.cells.pop();
      this.cursor = { row: last.row, col: last.col };
      this.cursorAt = this.now();
      this.lineMaxCol = Math.max(this.lineStartCol, this.lineMaxCol - 1);
      return;
    }
    // Nothing of ours to pop: predict an erase of already-confirmed content at
    // the frontier. Non-destructive; the grid is only masked, never mutated.
    if (!this.anchor() || !this.cursor) {
      this.reset();
      return;
    }
    const target = this.cursor.col - 1;
    if (this.cursor.col === this.lineMaxCol && target >= this.lineStartCol) {
      const glyph = this.gridCell(this.cursor.row, target);
      if (glyph !== 0 && glyph !== SP) {
        this.cells.push({
          row: this.cursor.row,
          col: target,
          codepoint: 0,
          original: glyph,
          epoch: this.predEpoch,
          at: this.now(),
          erase: true,
        });
        this.cursor = { row: this.cursor.row, col: target };
        this.cursorAt = this.now();
        this.lineMaxCol = target;
        return;
      }
    }
    this.reset();
  }

  private predictEnter(now: number): void {
    if (!this.anchor() || !this.cursor) {
      this.reset();
      return;
    }
    const row = this.cursor.row;
    // Predict through Enter: commit the current line (its echo, a fresh prompt,
    // is unpredictable) and jump the cursor to column 0 of the next line in a
    // new, tentative epoch. Held until the server confirms the newline.
    this.cells = [];
    this.becomeTentative();
    if (row + 1 < this.term.options.rows) {
      this.pendingNewline = { row: row + 1, col: 0, epoch: this.predEpoch, at: now };
      this.cursor = { row: row + 1, col: 0 };
      this.cursorAt = now;
      this.lineRow = row + 1;
      this.lineStartCol = 0;
      this.lineMaxCol = 0;
    } else {
      // Last row: a real newline scrolls, which we do not model. Re-anchor.
      this.cursor = null;
      this.lineRow = -1;
    }
  }

  private handleEscape(text: string, now: number): void {
    const m = CSI_MOVE_RE.exec(text);
    if (m) {
      const delta = m[3] === 'D' ? -1 : 1;
      const byWords = !!m[2];
      const amount = Number(m[1]) || 1;
      this.predictCursorMove(delta, byWords, amount, now);
      return;
    }
    if (text === '\x1bb') {
      this.predictCursorMove(-1, true, 1, now);
      return;
    }
    if (text === '\x1bf') {
      this.predictCursorMove(1, true, 1, now);
      return;
    }
    // Home: CSI H, app-cursor SS3 H, or the VT ESC[1~.
    if (text === '\x1b[H' || text === '\x1bOH' || text === '\x1b[1~') {
      this.predictHomeEnd('home', now);
      return;
    }
    // End: CSI F, app-cursor SS3 F, or the VT ESC[4~.
    if (text === '\x1b[F' || text === '\x1bOF' || text === '\x1b[4~') {
      this.predictHomeEnd('end', now);
      return;
    }
    // Any other escape sequence (Up/Down arrows, bracketed paste, ...) is
    // unpredictable; drop the epoch so nothing stale flashes before the redraw.
    this.reset();
  }

  private predictHomeEnd(which: 'home' | 'end', now: number): void {
    if (!this.anchor() || !this.cursor) return;
    // Do not move a tentative (unconfirmed) line: the frontier is not real yet.
    if (this.predEpoch > this.confirmedEpoch) return;
    // Clamp to the editable region, same bounds predictCursorMove uses.
    const col = which === 'home' ? this.lineStartCol : this.lineMaxCol;
    if (col === this.cursor.col) return;
    this.cursor = { row: this.cursor.row, col };
    this.cursorAt = now;
  }

  private predictCursorMove(delta: -1 | 1, byWords: boolean, amount: number, now: number): void {
    if (!this.anchor() || !this.cursor) return;
    // Do not move a tentative (unconfirmed) line: the frontier is not real yet.
    if (this.predEpoch > this.confirmedEpoch) return;

    let col = this.cursor.col;
    if (byWords) {
      for (let i = 0; i < amount; i++) col = this.wordBoundary(this.cursor.row, col, delta);
    } else {
      col += delta * amount;
    }
    // Clamp within the editable region: never into the prompt, never past the
    // typed text (VS Code's startingX / endingX boundaries).
    col = Math.min(Math.max(col, this.lineStartCol), this.lineMaxCol);
    if (col === this.cursor.col) return;
    this.cursor = { row: this.cursor.row, col };
    this.cursorAt = now;
  }

  /** Next word boundary from `col` in `dir`, over grid + current predictions. */
  private wordBoundary(row: number, col: number, dir: -1 | 1): number {
    const at = (c: number): number => this.virtualCell(row, c);
    if (dir < 0) {
      col--;
      while (col > this.lineStartCol && !isWordChar(at(col))) col--;
      while (col > this.lineStartCol && isWordChar(at(col - 1))) col--;
    } else {
      while (col < this.lineMaxCol && isWordChar(at(col))) col++;
      while (col < this.lineMaxCol && !isWordChar(at(col))) col++;
    }
    return col;
  }

  /** Codepoint at a cell as the user perceives it: our prediction over grid. */
  private virtualCell(row: number, col: number): number {
    for (const c of this.cells) if (c.row === row && c.col === col) return c.codepoint;
    return this.gridCell(row, col);
  }

  // Read-only grid lookup for the input path. textRow() does not reset the
  // dirty-row bookkeeping the way snapshot() would, so it is safe per key.
  private gridCell(row: number, col: number): number {
    return this.term.textRow(row).codePointAt(col) ?? SP;
  }

  private diverge(now: number): void {
    this.reset();
    this.failures++;
    if (this.failures >= FAILURE_LIMIT) {
      this.cooldownUntil = now + COOLDOWN_MS;
      this.failures = 0;
    }
  }

  /** Drop only the tentative (future-epoch) predictions and re-warm the line. */
  private killEpoch(): void {
    this.cells = this.cells.filter((c) => c.epoch <= this.confirmedEpoch);
    this.cursor = null;
    this.pendingNewline = null;
    this.becomeTentative();
  }

  // How long to wait for an un-echoed prediction before giving up on it. Scaled
  // well above observed round-trip time (3x) so a slow-but-real echo always
  // confirms first; only a true no-echo prompt reaches the timeout. Wrong
  // guesses never wait for this: the divergence path clears them at once.
  private maxAge(): number {
    const lat = this._stats.latency;
    const observed = lat.count > 0 ? lat.max : (this.srtt ?? 0);
    return Math.max(PREDICTION_MIN_MAX_AGE, Math.round(3 * observed));
  }

  private recordLatency(sample: number): void {
    this.srtt =
      this.srtt === undefined ? sample : this.srtt * (1 - SRTT_ALPHA) + sample * SRTT_ALPHA;
    if (this.srtt > FLAG_HIGH) this.flagging = true;
    else if (this.srtt <= FLAG_LOW) this.flagging = false;
    // A run of quick confirmations slowly cures the glitch trigger.
    if (
      sample < GLITCH_THRESHOLD &&
      this.glitchTrigger > 0 &&
      this.now() - GLITCH_REPAIR_MININTERVAL >= this.lastQuickConfirmation
    ) {
      this.glitchTrigger--;
      this.lastQuickConfirmation = this.now();
    }
  }

  private notePending(outstanding: number): void {
    // A long-outstanding prediction activates display even on a fast link.
    if (outstanding >= GLITCH_FLAG_THRESHOLD) {
      this.glitchTrigger = GLITCH_REPAIR_COUNT * 2; // display and underline
    } else if (outstanding >= GLITCH_THRESHOLD && this.glitchTrigger < GLITCH_REPAIR_COUNT) {
      this.glitchTrigger = GLITCH_REPAIR_COUNT; // just display
    }
  }

  private shouldShow(): boolean {
    // Adaptive floor: once we have a real sample of outcomes, stop showing if
    // predictions are mostly wrong (a line-rewriting or masked prompt).
    if (this._stats.sampleSize >= STATS_MIN_SAMPLES && this._stats.accuracy < STATS_MIN_ACCURACY) {
      return false;
    }
    const glitch = this.glitchTrigger > 0;
    if (this.latencyThreshold === 0) return true;
    if (this.srtt === undefined) return true; // no data yet: predict optimistically
    const t = this.latencyThreshold;
    this.showing = this.showing ? this.srtt > t * 0.5 || glitch : this.srtt > t || glitch;
    return this.showing;
  }

  /**
   * Reconcile against the frame and return what to draw. Confirmed predictions
   * (the grid now shows them) are retired; a live-epoch mismatch clears all
   * predictions, a tentative-epoch mismatch kills just that epoch. Called once
   * per rendered frame.
   */
  overlay(snap: Snapshot): Overlay {
    const empty: Overlay = { cells: [], cursor: null };
    if (!this.enabled || snap.altScreen || !snap.cursorVisible || snap.displayOffset !== 0) {
      this.reset();
      return empty;
    }

    const now = this.now();

    // Confirm a held newline once the server's cursor reaches the next line.
    if (this.pendingNewline) {
      if (snap.cursorLine >= this.pendingNewline.row) {
        this.confirmedEpoch = Math.max(this.confirmedEpoch, this.pendingNewline.epoch);
        this.pendingNewline = null;
      } else if (now - this.pendingNewline.at > this.maxAge()) {
        this.reset();
        return empty;
      }
    }

    // Reconcile cell predictions front-to-back (they confirm left-to-right).
    while (this.cells.length > 0) {
      const p = this.cells[0];
      if (p.row >= snap.rows || p.col >= snap.cols) {
        this.diverge(now);
        return empty;
      }
      const real = cellCodepoint(snap, p.row, p.col);
      const blank = real === 0 || real === SP;
      if (p.erase) {
        // An erase confirms when the server blanks the cell (backspace applied),
        // stays pending while the old glyph remains, and diverges otherwise.
        if (blank) {
          this.recordLatency(now - p.at);
          this._stats.record(now - p.at, true);
          this.confirmedEpoch = Math.max(this.confirmedEpoch, p.epoch);
          this.failures = 0;
          this.cells.shift();
          continue;
        }
        if (real === p.original) {
          if (now - p.at > this.maxAge()) {
            this._stats.record(now - p.at, false); // no-echo: count a miss
            this.reset();
            return empty;
          }
          this.notePending(now - p.at);
          break;
        }
        this._stats.record(now - p.at, false);
        if (p.epoch > this.confirmedEpoch) this.killEpoch();
        else this.diverge(now);
        return empty;
      }
      if (real === p.codepoint && real !== p.original) {
        // The server echoed exactly what we guessed: confirmed, retire it.
        this.recordLatency(now - p.at);
        this._stats.record(now - p.at, true);
        this.confirmedEpoch = Math.max(this.confirmedEpoch, p.epoch);
        this.failures = 0;
        this.cells.shift();
        continue;
      }
      if (blank) {
        // Not echoed yet. Everything after is also pending; expire if stale.
        // A miss on expiry lets the accuracy floor auto-suppress local echo at a
        // no-echo prompt (sudo/ssh); a backend termios ECHO signal is the full fix.
        if (now - p.at > this.maxAge()) {
          this._stats.record(now - p.at, false);
          this.reset();
          return empty;
        }
        this.notePending(now - p.at);
        break;
      }
      // The cell holds something else: our model is wrong.
      this._stats.record(now - p.at, false);
      if (p.epoch > this.confirmedEpoch) {
        this.killEpoch(); // only a tentative guess was wrong
      } else {
        this.diverge(now); // a confirmed-epoch guess was wrong: reset all
      }
      return empty;
    }

    if (this.flagging || this.glitchTrigger > GLITCH_REPAIR_COUNT) this.flagging = true;

    if (this.cells.length === 0) {
      const tentative = this.predEpoch > this.confirmedEpoch;
      // A confirmed frontier ahead of the grid is a bare cursor prediction
      // (arrow / word move) worth drawing.
      if (
        this.cursor &&
        !tentative &&
        (this.cursor.row !== snap.cursorLine || this.cursor.col !== snap.cursorCol)
      ) {
        if (now - this.cursorAt > this.maxAge()) {
          this.reset();
          return empty;
        }
        if (!this.shouldShow()) return empty;
        return { cells: [], cursor: { ...this.cursor } };
      }
      // Keep a held frontier (post-Enter warm-up) so the next key anchors on
      // it; hand the cursor back only when a confirmed line has caught up.
      if (!tentative && !this.pendingNewline) this.cursor = null;
      return empty;
    }

    // Tentative line (warm-up, or a held post-Enter epoch): keep reconciling
    // but do not draw until the epoch is confirmed.
    if (this.predEpoch > this.confirmedEpoch) return empty;
    if (!this.shouldShow()) return empty;

    const flagged = this.flagging || this.glitchTrigger > GLITCH_REPAIR_COUNT;
    const cells: OverlayCell[] = this.cells.map((p) => ({
      row: p.row,
      col: p.col,
      codepoint: p.codepoint,
      flagged,
      erase: !!p.erase,
    }));
    return { cells, cursor: this.cursor ? { ...this.cursor } : null };
  }

  /** Which visual treatment unconfirmed glyphs get (renderer reads this). */
  get markStyle(): PredictionStyle {
    return this.style;
  }
}

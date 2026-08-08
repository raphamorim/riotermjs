// Headless terminal: the librio wasm surface plus a typed, xterm.js-shaped
// API. No DOM here; renderers (canvas.ts, react-rioterm's DOM renderer)
// consume snapshot() and subscribe to onUpdate.

import init, { RioTerm, type InitInput } from '../wasm/librio_wasm.js';

export const CELL_WORDS = 4;

// Color kinds in packed cell words (kind << 24 | payload).
export const COLOR_NAMED = 0;
export const COLOR_INDEXED = 1;
export const COLOR_RGB = 2;

// StyleFlags bits (rio-vt crosswords/style.rs).
export const STYLE_INVERSE = 1 << 0;
export const STYLE_BOLD = 1 << 1;
export const STYLE_ITALIC = 1 << 2;
export const STYLE_DIM = 1 << 3;
export const STYLE_HIDDEN = 1 << 4;
export const STYLE_STRIKEOUT = 1 << 5;
export const STYLE_UNDERLINE = 1 << 6;
export const STYLE_DOUBLE_UNDERLINE = 1 << 7;
export const STYLE_UNDERCURL = 1 << 8;
export const STYLE_DOTTED_UNDERLINE = 1 << 9;
export const STYLE_DASHED_UNDERLINE = 1 << 10;
export const STYLE_ANY_UNDERLINE =
  STYLE_UNDERLINE |
  STYLE_DOUBLE_UNDERLINE |
  STYLE_UNDERCURL |
  STYLE_DOTTED_UNDERLINE |
  STYLE_DASHED_UNDERLINE;

// Wide-char state in bits 21-22 of the codepoint word.
export const WIDE_NARROW = 0;
export const WIDE_WIDE = 1;
export const WIDE_SPACER = 2;

export interface TerminalOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
  /** Cell metrics in px; graphics protocols map pixels onto cells. */
  cellWidth?: number;
  cellHeight?: number;
  /**
   * Treat bare LF in write() as CRLF. For sources without a PTY line
   * discipline doing ONLCR (WASI programs, raw pipes); leave off for
   * real PTYs, which already send CRLF.
   */
  convertEol?: boolean;
  /**
   * Detect plain-text URLs (https://..., mailto:, ...) under the pointer
   * so linkAt() resolves them like OSC 8 links. Default true.
   */
  detectUrls?: boolean;
}

export interface Selection {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  isBlock: boolean;
}

export interface Snapshot {
  cols: number;
  rows: number;
  /** rows * cols * CELL_WORDS packed u32 words, row-major. */
  cells: Uint32Array;
  cursorLine: number;
  cursorCol: number;
  /** False when the program hid the cursor (CSI ?25l); don't paint it. */
  cursorVisible: boolean;
  displayOffset: number;
  altScreen: boolean;
  selection: Selection | null;
  /** Rows changed since the previous snapshot. */
  dirtyRows: boolean[];
}

/**
 * One search hit. Lines are buffer coordinates: 0 is the top of the
 * scrollback, `historySize()` is the first viewport row of the live
 * screen. `endCol` is inclusive.
 */
export interface SearchMatch {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export type Disposable = { dispose(): void };

let wasmReady: Promise<void> | undefined;

/**
 * Load and instantiate the wasm module. Browsers resolve the binary next
 * to the glue via import.meta.url; tests and Node pass bytes explicitly.
 */
export function initWasm(source?: InitInput): Promise<void> {
  wasmReady ??= init(source !== undefined ? { module_or_path: source } : undefined).then(
    () => undefined,
  );
  return wasmReady;
}

function listeners<T extends unknown[]>() {
  const set = new Set<(...args: T) => void>();
  return {
    add(fn: (...args: T) => void): Disposable {
      set.add(fn);
      return { dispose: () => set.delete(fn) };
    },
    emit(...args: T) {
      for (const fn of set) fn(...args);
    },
  };
}

export class Terminal {
  private raw: RioTerm;
  private cellBuf: Uint32Array;
  private encoder = new TextEncoder();
  private disposed = false;
  private convertEol: boolean;
  private searchPattern: string | undefined;
  private searchIndex = 0;
  /** Last byte of the previous write, so CRLF split across chunks stays CRLF. */
  private lastWritten = 0;

  readonly options: Required<TerminalOptions>;

  private dataListeners = listeners<[Uint8Array]>();
  private updateListeners = listeners<[]>();
  private titleListeners = listeners<[string, string | null]>();
  private bellListeners = listeners<[]>();
  private clipboardListeners = listeners<[string]>();
  private progressListeners = listeners<[number, number]>();

  /**
   * Requires initWasm() to have resolved; use Terminal.create() when you
   * do not manage wasm loading yourself.
   */
  constructor(options: TerminalOptions = {}) {
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const cellWidth = options.cellWidth ?? 9;
    const cellHeight = options.cellHeight ?? 18;
    const scrollback = options.scrollback ?? 10_000;
    const convertEol = options.convertEol ?? false;
    const detectUrls = options.detectUrls ?? true;
    this.options = { cols, rows, scrollback, cellWidth, cellHeight, convertEol, detectUrls };
    this.convertEol = convertEol;

    this.raw = new RioTerm(
      cols,
      rows,
      Math.round(cols * cellWidth),
      Math.round(rows * cellHeight),
      scrollback,
    );
    this.cellBuf = new Uint32Array(cols * rows * CELL_WORDS);

    this.raw.on_output((bytes: Uint8Array) => this.dataListeners.emit(bytes));
    this.raw.on_wakeup(() => this.updateListeners.emit());
    this.raw.on_title((title: string, subtitle: string | null) =>
      this.titleListeners.emit(title, subtitle),
    );
    this.raw.on_bell(() => this.bellListeners.emit());
    this.raw.on_clipboard((_kind: number, text: string) =>
      this.clipboardListeners.emit(text),
    );
    this.raw.on_progress((state: number, value: number) =>
      this.progressListeners.emit(state, value),
    );
  }

  static async create(options: TerminalOptions = {}): Promise<Terminal> {
    await initWasm();
    return new Terminal(options);
  }

  // ------------------------------------------------------------- events

  /** Bytes to deliver to the backend (keystrokes, mouse reports, DA). */
  onData(fn: (data: Uint8Array) => void): Disposable {
    return this.dataListeners.add(fn);
  }

  /** The grid changed; renderers should schedule a repaint. */
  onUpdate(fn: () => void): Disposable {
    return this.updateListeners.add(fn);
  }

  onTitleChange(fn: (title: string, subtitle: string | null) => void): Disposable {
    return this.titleListeners.add(fn);
  }

  onBell(fn: () => void): Disposable {
    return this.bellListeners.add(fn);
  }

  /** OSC 52: the program asked to write the system clipboard. */
  onClipboardWrite(fn: (text: string) => void): Disposable {
    return this.clipboardListeners.add(fn);
  }

  /** OSC 9;4 progress (state: 0 remove, 1 set, 2 error, 3 indeterminate, 4 paused). */
  onProgress(fn: (state: number, value: number) => void): Disposable {
    return this.progressListeners.add(fn);
  }

  // -------------------------------------------------------------- input

  /** Child/backend output to display (xterm.js write()). */
  write(data: string | Uint8Array): void {
    let bytes = typeof data === 'string' ? this.encoder.encode(data) : data;
    if (this.convertEol && bytes.length > 0) {
      bytes = this.withCrLf(bytes);
    }
    this.raw.feed(bytes);
    this.updateListeners.emit();
  }

  /** Expand bare LF to CRLF, tracking CR across chunk boundaries. */
  private withCrLf(bytes: Uint8Array): Uint8Array {
    const chunkPrev = this.lastWritten;
    let bare = 0;
    let prev = chunkPrev;
    for (const byte of bytes) {
      if (byte === 0x0a && prev !== 0x0d) bare++;
      prev = byte;
    }
    this.lastWritten = prev;
    if (bare === 0) return bytes;
    const out = new Uint8Array(bytes.length + bare);
    let at = 0;
    prev = chunkPrev;
    for (const byte of bytes) {
      if (byte === 0x0a && prev !== 0x0d) out[at++] = 0x0d;
      out[at++] = byte;
      prev = byte;
    }
    return out;
  }

  /** Send text to the backend as user input (reaches onData). */
  input(text: string): void {
    this.raw.send_text(text);
    this.updateListeners.emit();
  }

  /**
   * Paste text: newlines normalize to CR and the run is wrapped in
   * bracketed-paste markers when the program enabled the mode.
   */
  paste(text: string): void {
    this.raw.paste(text);
    this.updateListeners.emit();
  }

  /**
   * Terminal modes an embedder needs for its own input decisions
   * (touch scrolling, key bars, paste handling).
   */
  modes(): {
    mouseTracking: boolean;
    applicationCursorKeys: boolean;
    altScreen: boolean;
    bracketedPaste: boolean;
  } {
    const bits = this.raw.mode_bits();
    return {
      mouseTracking: (bits & 1) !== 0,
      applicationCursorKeys: (bits & 2) !== 0,
      altScreen: (bits & 4) !== 0,
      bracketedPaste: (bits & 8) !== 0,
    };
  }

  /**
   * Low-level key entry; prefer keys.ts handleKeyboardEvent in browsers.
   * Returns true when the key produced bytes for the backend.
   */
  key(
    action: number,
    tag: number,
    codepoint: number,
    functionKey: number,
    mods: number,
    consumedMods: number,
    composing: boolean,
    text: string | undefined,
  ): boolean {
    const handled = this.raw.key(
      action,
      tag,
      codepoint,
      functionKey,
      mods,
      consumedMods,
      composing,
      text,
    );
    this.updateListeners.emit();
    return handled;
  }

  /** Positive lines scroll towards history. Returns true when the program consumed it. */
  scrollWheel(lines: number, col: number, row: number, mods: number): boolean {
    const consumed = this.raw.scroll_wheel(lines | 0, col, row, mods);
    this.updateListeners.emit();
    return consumed;
  }

  scrollLines(delta: number): void {
    this.raw.scroll(delta | 0);
    this.updateListeners.emit();
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(2, Math.floor(cols));
    const r = Math.max(2, Math.floor(rows));
    this.options.cols = c;
    this.options.rows = r;
    this.raw.resize(
      c,
      r,
      Math.round(c * this.options.cellWidth),
      Math.round(r * this.options.cellHeight),
    );
    this.cellBuf = new Uint32Array(c * r * CELL_WORDS);
    this.updateListeners.emit();
  }

  /** Update the pixel cell metrics (font change); keeps cols/rows. */
  setCellSize(cellWidth: number, cellHeight: number): void {
    this.options.cellWidth = cellWidth;
    this.options.cellHeight = cellHeight;
    this.raw.resize(
      this.options.cols,
      this.options.rows,
      Math.round(this.options.cols * cellWidth),
      Math.round(this.options.rows * cellHeight),
    );
  }

  // ---------------------------------------------------------- selection

  selectionBegin(
    viewportLine: number,
    col: number,
    kind: 'simple' | 'word' | 'line' | 'block' = 'simple',
    sideRight = false,
  ): void {
    const kinds = { simple: 0, word: 1, line: 2, block: 3 } as const;
    this.raw.selection_begin(viewportLine | 0, col, kinds[kind], sideRight);
    this.updateListeners.emit();
  }

  selectionUpdate(viewportLine: number, col: number, sideRight = false): void {
    this.raw.selection_update(viewportLine | 0, col, sideRight);
    this.updateListeners.emit();
  }

  clearSelection(): void {
    this.raw.selection_clear();
    this.updateListeners.emit();
  }

  getSelection(): string | undefined {
    return this.raw.selection_text();
  }

  // ------------------------------------------------------- render state

  /** Pull a fresh grid snapshot. Call once per frame, then render it. */
  snapshot(): Snapshot {
    this.raw.update();
    const cols = this.raw.columns();
    const rows = this.raw.lines();
    if (this.cellBuf.length !== cols * rows * CELL_WORDS) {
      this.cellBuf = new Uint32Array(cols * rows * CELL_WORDS);
    }
    this.raw.write_cells(this.cellBuf);

    const dirtyRows: boolean[] = new Array(rows);
    for (let i = 0; i < rows; i++) dirtyRows[i] = this.raw.row_dirty(i);
    this.raw.reset_dirty();

    const sel = this.raw.viewport_selection();
    const selection: Selection | null =
      sel.length === 5
        ? {
            startLine: sel[0],
            startCol: sel[1],
            endLine: sel[2],
            endCol: sel[3],
            isBlock: sel[4] !== 0,
          }
        : null;

    return {
      cols,
      rows,
      cells: this.cellBuf,
      cursorLine: this.raw.cursor_line(),
      cursorCol: this.raw.cursor_col(),
      cursorVisible: this.raw.cursor_visible(),
      displayOffset: this.raw.display_offset(),
      altScreen: this.raw.alt_screen(),
      selection,
      dirtyRows,
    };
  }

  /** Lines the view is scrolled into history; 0 means the live screen. */
  displayOffset(): number {
    this.raw.update();
    return this.raw.display_offset();
  }

  /**
   * The link under a viewport cell, with the row-run to underline on
   * hover: an OSC 8 hyperlink when the program emitted one, else a
   * regex-detected plain-text URL (unless `detectUrls: false`). Wrapped
   * URLs resolve whole. Hit-test shaped: call it from pointer events.
   */
  linkAt(line: number, col: number): { uri: string; startCol: number; endCol: number } | undefined {
    this.raw.update();
    const uri = this.raw.link_at(line, col);
    if (uri !== undefined) {
      const run = this.raw.link_run(line, col);
      return { uri, startCol: run[0] ?? col, endCol: run[1] ?? col };
    }
    if (this.options.detectUrls === false) return undefined;
    const url = this.raw.url_at(line, col);
    if (url === undefined) return undefined;
    const run = this.raw.url_run(line, col);
    return { uri: url, startCol: run[0] ?? col, endCol: run[1] ?? col };
  }

  /** Plain text of one viewport row (testing/accessibility). */
  textRow(line: number): string {
    this.raw.update();
    return this.raw.text_row(line);
  }

  /** Whole buffer (scrollback + screen) as plain text. */
  dump(): string {
    return this.raw.dump();
  }

  /**
   * Whole buffer as a VT byte stream that reproduces content, styling,
   * and OSC 8 links when written into a fresh same-width terminal:
   * `replica.write(term.serialize())`. The reconnect/persistence story.
   */
  serialize(): string {
    return this.raw.serialize();
  }

  /** Lines currently held in scrollback (tops out at the ring size). */
  historySize(): number {
    return this.raw.history_lines();
  }

  /**
   * All regex matches over scrollback + screen, top to bottom, in
   * buffer coordinates. An invalid pattern matches nothing.
   */
  search(pattern: string, max = 1000): SearchMatch[] {
    const flat = this.raw.search(pattern, max);
    const matches: SearchMatch[] = [];
    for (let i = 0; i + 3 < flat.length; i += 4) {
      matches.push({
        startLine: flat[i],
        startCol: flat[i + 1],
        endLine: flat[i + 2],
        endCol: flat[i + 3],
      });
    }
    return matches;
  }

  /** Select the next match and scroll it into view. Wraps around. */
  findNext(pattern: string): SearchMatch | undefined {
    return this.findStep(pattern, 1);
  }

  /** Select the previous match and scroll it into view. Wraps around. */
  findPrevious(pattern: string): SearchMatch | undefined {
    return this.findStep(pattern, -1);
  }

  private findStep(pattern: string, dir: 1 | -1): SearchMatch | undefined {
    const matches = this.search(pattern);
    if (matches.length === 0) {
      this.searchPattern = undefined;
      return undefined;
    }
    if (pattern === this.searchPattern) {
      this.searchIndex =
        (this.searchIndex + dir + matches.length) % matches.length;
    } else {
      this.searchPattern = pattern;
      this.searchIndex = dir === 1 ? 0 : matches.length - 1;
    }
    const match = matches[Math.min(this.searchIndex, matches.length - 1)];

    // Scroll the match into view (centered) if it isn't visible, then
    // select it so renderers highlight it.
    this.raw.update();
    const rows = this.raw.lines();
    const history = this.raw.history_lines();
    const offset = this.raw.display_offset();
    const gridLine = match.startLine - history;
    let target = offset;
    const viewportLine = gridLine + offset;
    if (viewportLine < 0 || viewportLine >= rows) {
      target = Math.min(Math.max(Math.floor(rows / 2) - gridLine, 0), history);
      this.scrollLines(target - offset);
    }
    this.selectionBegin(match.startLine - history + target, match.startCol);
    this.selectionUpdate(match.endLine - history + target, match.endCol, true);
    return match;
  }

  setAltIsMeta(enabled: boolean): void {
    this.raw.set_alt_is_meta(enabled);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.raw.free();
  }
}

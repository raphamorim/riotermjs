// DOM renderer: one div per row, spans per style run, cursor and metrics
// in absolute px. Framework-free; both the vanilla open() and react-rioterm
// use it when renderer: 'dom' is chosen. Rows rebuild only when librio
// marks them dirty (or the cursor/selection touches them), so a busy line
// does not redraw the screen.

import {
  CELL_WORDS,
  STYLE_BOLD,
  STYLE_DIM,
  STYLE_HIDDEN,
  STYLE_INVERSE,
  STYLE_ITALIC,
  STYLE_STRIKEOUT,
  STYLE_ANY_UNDERLINE,
  WIDE_SPACER,
  CELL_HAS_CLUSTER,
  type Snapshot,
  type Terminal,
} from './core.js';
import { ColorResolver, defaultTheme, type Theme } from './theme.js';

export interface DOMRendererOptions {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  theme?: Theme;
}

export class DOMRenderer {
  /** Mount point handed to the host; rows and cursor live inside. */
  readonly element: HTMLElement;
  readonly cellWidth: number;
  readonly cellHeight: number;

  private term: Terminal;
  private colors: ColorResolver;
  private theme: Theme;
  private rowsHost: HTMLElement;
  private cursorEl: HTMLElement;
  private rowEls: HTMLElement[] = [];
  private prevCursorRow = -1;
  private prevSelRows: [number, number] | null = null;
  private hoverLink: { line: number; startCol: number; endCol: number } | null = null;
  private hoverDirtyRows = new Set<number>();
  private raf = 0;
  private sub: { dispose(): void };

  constructor(term: Terminal, options: DOMRendererOptions = {}) {
    this.term = term;
    this.theme = options.theme ?? defaultTheme;
    this.colors = new ColorResolver(this.theme);
    const fontFamily =
      options.fontFamily ??
      'ui-monospace, "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
    const fontSize = options.fontSize ?? 14;
    const lineHeight = options.lineHeight ?? 1.3;

    this.element = document.createElement('div');
    Object.assign(this.element.style, {
      position: 'relative',
      fontFamily,
      fontSize: `${fontSize}px`,
      lineHeight: String(lineHeight),
      backgroundColor: this.theme.background,
      color: this.theme.foreground,
      overflow: 'hidden',
      cursor: 'text',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    // Measure the cell from the font itself.
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(10);
    Object.assign(probe.style, {
      position: 'absolute',
      visibility: 'hidden',
      whiteSpace: 'pre',
      fontFamily,
      fontSize: `${fontSize}px`,
      lineHeight: String(lineHeight),
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    this.cellWidth = rect.width / 10 || fontSize * 0.6;
    this.cellHeight = rect.height || fontSize * lineHeight;
    probe.remove();

    this.rowsHost = document.createElement('div');
    this.element.appendChild(this.rowsHost);

    this.cursorEl = document.createElement('div');
    Object.assign(this.cursorEl.style, {
      position: 'absolute',
      width: `${this.cellWidth}px`,
      height: `${this.cellHeight}px`,
      backgroundColor: this.theme.cursor,
      opacity: '0.8',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    this.element.appendChild(this.cursorEl);

    term.setCellSize(this.cellWidth, this.cellHeight);
    this.sub = term.onUpdate(() => this.schedule());
    this.schedule();
  }

  schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  /** Underline the hovered OSC 8 link run (null clears it). */
  setHoverLink(link: { line: number; startCol: number; endCol: number } | null): void {
    const same =
      link === this.hoverLink ||
      (link !== null &&
        this.hoverLink !== null &&
        link.line === this.hoverLink.line &&
        link.startCol === this.hoverLink.startCol &&
        link.endCol === this.hoverLink.endCol);
    if (same) return;
    if (this.hoverLink) this.hoverDirtyRows.add(this.hoverLink.line);
    if (link) this.hoverDirtyRows.add(link.line);
    this.hoverLink = link;
    this.schedule();
  }

  fit(width: number, height: number): void {
    // A hidden or collapsed container (display: none, zero-sized tab)
    // must not fold the grid down and churn a reflow; wait for space.
    if (width < this.cellWidth || height < this.cellHeight) return;
    const cols = Math.max(2, Math.floor(width / this.cellWidth));
    const rows = Math.max(2, Math.floor(height / this.cellHeight));
    if (cols !== this.term.options.cols || rows !== this.term.options.rows) {
      this.term.resize(cols, rows);
      this.rowEls.forEach((el) => el.remove());
      this.rowEls = [];
    }
  }

  cellAt(clientX: number, clientY: number): { col: number; row: number; sideRight: boolean } {
    const rect = this.element.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const col = Math.min(
      Math.max(0, Math.floor(x / this.cellWidth)),
      this.term.options.cols - 1,
    );
    const row = Math.min(
      Math.max(0, Math.floor(y / this.cellHeight)),
      this.term.options.rows - 1,
    );
    return { col, row, sideRight: x - col * this.cellWidth > this.cellWidth / 2 };
  }

  render(): void {
    const snap = this.term.snapshot();

    while (this.rowEls.length < snap.rows) {
      const el = document.createElement('div');
      el.style.whiteSpace = 'pre';
      el.style.height = `${this.cellHeight}px`;
      this.rowsHost.appendChild(el);
      this.rowEls.push(el);
      // A fresh element must paint whatever the grid holds.
      this.buildRow(snap, this.rowEls.length - 1);
    }
    while (this.rowEls.length > snap.rows) {
      this.rowEls.pop()!.remove();
    }

    const selRows: [number, number] | null = snap.selection
      ? [snap.selection.startLine, snap.selection.endLine]
      : null;
    for (let i = 0; i < snap.rows; i++) {
      const touched =
        snap.dirtyRows[i] ||
        i === this.prevCursorRow ||
        i === snap.cursorLine ||
        this.hoverDirtyRows.has(i) ||
        (this.prevSelRows !== null && i >= this.prevSelRows[0] && i <= this.prevSelRows[1]) ||
        (selRows !== null && i >= selRows[0] && i <= selRows[1]);
      if (touched) this.buildRow(snap, i);
    }
    this.hoverDirtyRows.clear();
    this.prevCursorRow = snap.cursorLine;
    this.prevSelRows = selRows;

    if (snap.cursorVisible && snap.displayOffset === 0) {
      this.cursorEl.style.display = '';
      this.cursorEl.style.left = `${snap.cursorCol * this.cellWidth}px`;
      this.cursorEl.style.top = `${snap.cursorLine * this.cellHeight}px`;
    } else {
      this.cursorEl.style.display = 'none';
    }
  }

  private inSelection(snap: Snapshot, row: number, col: number): boolean {
    const sel = snap.selection;
    if (!sel) return false;
    if (row < sel.startLine || row > sel.endLine) return false;
    if (sel.isBlock) return col >= sel.startCol && col <= sel.endCol;
    if (row === sel.startLine && col < sel.startCol) return false;
    if (row === sel.endLine && col > sel.endCol) return false;
    return true;
  }

  private buildRow(snap: Snapshot, row: number): void {
    const el = this.rowEls[row];
    if (!el) return;
    el.textContent = '';
    const base = row * snap.cols * CELL_WORDS;

    let text = '';
    let key = '';
    let css = '';

    const flush = () => {
      if (!text) return;
      if (css) {
        const span = document.createElement('span');
        span.style.cssText = css;
        span.textContent = text;
        el.appendChild(span);
      } else {
        el.appendChild(document.createTextNode(text));
      }
      text = '';
    };

    for (let col = 0; col < snap.cols; col++) {
      const idx = base + col * CELL_WORDS;
      const word = snap.cells[idx];
      if (((word >>> 21) & 0b11) === WIDE_SPACER) continue;
      const codepoint = word & 0x1fffff;
      const flags = snap.cells[idx + 3];

      const selected = this.inSelection(snap, row, col);
      const hovered =
        this.hoverLink !== null &&
        this.hoverLink.line === row &&
        col >= this.hoverLink.startCol &&
        col <= this.hoverLink.endCol;
      const inverse = (flags & STYLE_INVERSE) !== 0;
      let fg = this.colors.resolve(snap.cells[idx + (inverse ? 2 : 1)], !inverse);
      let bg = this.colors.resolve(snap.cells[idx + (inverse ? 1 : 2)], inverse);
      if (selected) {
        fg = this.theme.selectionForeground;
        bg = this.theme.selectionBackground;
      }

      const cellKey = `${fg}|${bg}|${flags}|${selected ? 1 : 0}|${hovered ? 1 : 0}`;
      if (cellKey !== key) {
        flush();
        key = cellKey;
        const parts: string[] = [];
        if (fg !== this.theme.foreground) parts.push(`color:${fg}`);
        if (bg !== this.theme.background) parts.push(`background-color:${bg}`);
        if (flags & STYLE_BOLD) parts.push('font-weight:bold');
        if (flags & STYLE_ITALIC) parts.push('font-style:italic');
        if (flags & STYLE_DIM) parts.push('opacity:0.6');
        if (flags & STYLE_HIDDEN) parts.push('visibility:hidden');
        const deco = [
          flags & STYLE_ANY_UNDERLINE || hovered ? 'underline' : '',
          flags & STYLE_STRIKEOUT ? 'line-through' : '',
        ]
          .filter(Boolean)
          .join(' ');
        if (deco) parts.push(`text-decoration:${deco}`);
        css = parts.join(';');
      }
      // A cluster cell's word holds only the base codepoint; emit the
      // full text (ZWJ emoji, decomposed accents) in its place.
      text +=
        codepoint === 0
          ? ' '
          : word & CELL_HAS_CLUSTER
            ? (this.term.clusterText(row, col) ?? String.fromCodePoint(codepoint))
            : String.fromCodePoint(codepoint);
    }
    flush();
  }

  dispose(): void {
    this.sub.dispose();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.element.remove();
  }
}

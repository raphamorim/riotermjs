// Canvas2D renderer for the vanilla API. react-rioterm does not use this;
// it renders DOM from the same snapshots.

import {
  CELL_WORDS,
  STYLE_BOLD,
  STYLE_DIM,
  STYLE_HIDDEN,
  STYLE_INVERSE,
  STYLE_ITALIC,
  STYLE_ANY_UNDERLINE,
  STYLE_STRIKEOUT,
  WIDE_SPACER,
  type Snapshot,
  type Terminal,
} from './core.js';
import { ColorResolver, defaultTheme, type Theme } from './theme.js';

export interface CanvasRendererOptions {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  theme?: Theme;
  cursorStyle?: 'block' | 'bar' | 'underline';
}

export class CanvasRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly cellWidth: number;
  readonly cellHeight: number;

  /** Common mount point across renderers (see DOMRenderer.element). */
  get element(): HTMLElement {
    return this.canvas;
  }

  private term: Terminal;
  private ctx: CanvasRenderingContext2D;
  private colors: ColorResolver;
  private opts: Required<CanvasRendererOptions>;
  private dpr: number;
  private baseline: number;
  private raf = 0;
  private sub: { dispose(): void };
  private hoverLink: { line: number; startCol: number; endCol: number } | null = null;

  constructor(term: Terminal, options: CanvasRendererOptions = {}) {
    this.term = term;
    this.opts = {
      fontFamily:
        options.fontFamily ??
        'ui-monospace, "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: options.fontSize ?? 14,
      lineHeight: options.lineHeight ?? 1.3,
      theme: options.theme ?? defaultTheme,
      cursorStyle: options.cursorStyle ?? 'block',
    };
    this.colors = new ColorResolver(this.opts.theme);
    this.dpr = globalThis.devicePixelRatio || 1;

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;

    const probe = this.ctx;
    probe.font = this.font();
    const metrics = probe.measureText('W');
    this.cellWidth = Math.ceil(metrics.width);
    this.cellHeight = Math.ceil(this.opts.fontSize * this.opts.lineHeight);
    this.baseline = Math.round(
      (this.cellHeight + metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2,
    );

    term.setCellSize(this.cellWidth, this.cellHeight);
    this.resizeCanvas();
    this.sub = term.onUpdate(() => this.schedule());
    this.schedule();
  }

  /** All layout runs in CSS px; the context transform carries the dpr. */
  private font(flags = 0): string {
    const italic = flags & STYLE_ITALIC ? 'italic ' : '';
    const bold = flags & STYLE_BOLD ? 'bold ' : '';
    return `${italic}${bold}${this.opts.fontSize}px ${this.opts.fontFamily}`;
  }

  private resizeCanvas(): void {
    const { cols, rows } = this.term.options;
    this.canvas.width = Math.round(cols * this.cellWidth * this.dpr);
    this.canvas.height = Math.round(rows * this.cellHeight * this.dpr);
    this.canvas.style.width = `${cols * this.cellWidth}px`;
    this.canvas.style.height = `${rows * this.cellHeight}px`;
    // Setting width/height resets the context state.
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Resize the grid to fill `width` x `height` CSS pixels. */
  fit(width: number, height: number): void {
    const cols = Math.max(2, Math.floor(width / this.cellWidth));
    const rows = Math.max(2, Math.floor(height / this.cellHeight));
    if (cols !== this.term.options.cols || rows !== this.term.options.rows) {
      this.term.resize(cols, rows);
      this.resizeCanvas();
    }
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
    this.hoverLink = link;
    this.schedule();
  }

  cellAt(clientX: number, clientY: number): { col: number; row: number; sideRight: boolean } {
    const rect = this.canvas.getBoundingClientRect();
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
    const sideRight = x - col * this.cellWidth > this.cellWidth / 2;
    return { col, row, sideRight };
  }

  render(): void {
    const snap = this.term.snapshot();
    if (
      this.canvas.width !== Math.round(snap.cols * this.cellWidth * this.dpr) ||
      this.canvas.height !== Math.round(snap.rows * this.cellHeight * this.dpr)
    ) {
      this.resizeCanvas();
    }
    const ctx = this.ctx;
    const cw = this.cellWidth;
    const ch = this.cellHeight;
    ctx.textBaseline = 'alphabetic';

    for (let row = 0; row < snap.rows; row++) {
      this.renderRow(snap, row, cw, ch);
    }
    if (this.hoverLink && this.hoverLink.line < snap.rows) {
      const { line, startCol, endCol } = this.hoverLink;
      ctx.fillStyle = this.opts.theme.foreground;
      ctx.fillRect(startCol * cw, line * ch + ch - 2, (endCol - startCol + 1) * cw, 1);
    }
    this.renderCursor(snap, cw, ch);
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

  private renderRow(snap: Snapshot, row: number, cw: number, ch: number): void {
    const ctx = this.ctx;
    const y = row * ch;
    const base = row * snap.cols * CELL_WORDS;

    // Background pass, merging equal-color runs.
    let runStart = 0;
    let runColor = '';
    const flushBg = (end: number) => {
      if (runColor) {
        ctx.fillStyle = runColor;
        ctx.fillRect(runStart * cw, y, (end - runStart) * cw, ch);
      }
    };
    for (let col = 0; col < snap.cols; col++) {
      const flags = snap.cells[base + col * CELL_WORDS + 3];
      const inverse = (flags & STYLE_INVERSE) !== 0;
      const selected = this.inSelection(snap, row, col);
      let bg = this.colors.resolve(
        snap.cells[base + col * CELL_WORDS + (inverse ? 1 : 2)],
        inverse,
      );
      if (selected) bg = this.opts.theme.selectionBackground;
      if (bg !== runColor) {
        flushBg(col);
        runStart = col;
        runColor = bg;
      }
    }
    flushBg(snap.cols);

    // Glyph pass.
    let currentFont = '';
    for (let col = 0; col < snap.cols; col++) {
      const idx = base + col * CELL_WORDS;
      const word = snap.cells[idx];
      const wide = (word >>> 21) & 0b11;
      if (wide === WIDE_SPACER) continue;
      const codepoint = word & 0x1fffff;
      if (codepoint === 0 || codepoint === 32) continue;
      const flags = snap.cells[idx + 3];
      if (flags & STYLE_HIDDEN) continue;

      const inverse = (flags & STYLE_INVERSE) !== 0;
      const selected = this.inSelection(snap, row, col);
      let fg = this.colors.resolve(snap.cells[idx + (inverse ? 2 : 1)], !inverse);
      if (selected) fg = this.opts.theme.selectionForeground;

      const font = this.font(flags);
      if (font !== currentFont) {
        ctx.font = font;
        currentFont = font;
      }
      ctx.fillStyle = fg;
      ctx.globalAlpha = flags & STYLE_DIM ? 0.6 : 1;
      ctx.fillText(String.fromCodePoint(codepoint), col * cw, y + this.baseline);
      ctx.globalAlpha = 1;

      if (flags & STYLE_ANY_UNDERLINE) {
        ctx.fillRect(col * cw, y + ch - 2, cw * (wide ? 2 : 1), 1);
      }
      if (flags & STYLE_STRIKEOUT) {
        ctx.fillRect(col * cw, y + Math.round(ch / 2), cw * (wide ? 2 : 1), 1);
      }
    }
  }

  private renderCursor(snap: Snapshot, cw: number, ch: number): void {
    if (snap.displayOffset !== 0) return;
    const ctx = this.ctx;
    const x = snap.cursorCol * cw;
    const y = snap.cursorLine * ch;
    ctx.fillStyle = this.opts.theme.cursor;
    switch (this.opts.cursorStyle) {
      case 'bar':
        ctx.fillRect(x, y, 2, ch);
        break;
      case 'underline':
        ctx.fillRect(x, y + ch - 2, cw, 2);
        break;
      default: {
        ctx.fillRect(x, y, cw, ch);
        // Repaint the glyph under the block in background color.
        const idx = (snap.cursorLine * snap.cols + snap.cursorCol) * CELL_WORDS;
        const codepoint = snap.cells[idx] & 0x1fffff;
        if (codepoint > 32) {
          ctx.font = this.font(snap.cells[idx + 3]);
          ctx.fillStyle = this.opts.theme.background;
          ctx.fillText(
            String.fromCodePoint(codepoint),
            x,
            y + this.baseline,
          );
        }
      }
    }
  }

  dispose(): void {
    this.sub.dispose();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }
}

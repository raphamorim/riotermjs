export {
  Terminal,
  initWasm,
  CELL_WORDS,
  COLOR_NAMED,
  COLOR_INDEXED,
  COLOR_RGB,
  STYLE_INVERSE,
  STYLE_BOLD,
  STYLE_ITALIC,
  STYLE_DIM,
  STYLE_HIDDEN,
  STYLE_STRIKEOUT,
  STYLE_UNDERLINE,
  STYLE_DOUBLE_UNDERLINE,
  STYLE_UNDERCURL,
  STYLE_DOTTED_UNDERLINE,
  STYLE_DASHED_UNDERLINE,
  STYLE_ANY_UNDERLINE,
  WIDE_NARROW,
  WIDE_WIDE,
  WIDE_SPACER,
} from './core.js';
export type {
  TerminalOptions,
  Snapshot,
  Selection,
  SearchMatch,
  Disposable,
} from './core.js';

export { ColorResolver, buildPalette, defaultTheme } from './theme.js';
export type { Theme } from './theme.js';

export * from './keys.js';

export { CanvasRenderer } from './canvas.js';
export type { CanvasRendererOptions } from './canvas.js';

export { DOMRenderer } from './dom-renderer.js';
export type { DOMRendererOptions } from './dom-renderer.js';

export { open } from './dom.js';
export type { OpenOptions, RioTermHandle, LinkHandler } from './dom.js';

export { PredictionEngine } from './predict.js';
export type { PredictionOptions, PredictionStyle, Overlay, OverlayCell } from './predict.js';

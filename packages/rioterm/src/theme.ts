// Packed cell colors -> CSS. The wasm side never resolves named/indexed
// colors; the theme lives here (matching how canario resolves them on the
// Swift side). Named payloads are rio-vt NamedColor discriminants.

import { COLOR_INDEXED, COLOR_NAMED, COLOR_RGB } from './core.js';

export interface Theme {
  foreground: string;
  background: string;
  cursor: string;
  selectionForeground: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Rio's default color scheme (rio-vt config/colors/defaults.rs). */
export const defaultTheme: Theme = {
  foreground: '#FFFFFF',
  background: '#0F0D0E',
  cursor: '#F712FF',
  selectionForeground: '#44C9F0',
  selectionBackground: '#1C191A',
  black: '#393A3D',
  red: '#FF1261',
  green: '#2AD947',
  yellow: '#FCBA28',
  blue: '#2D9AFF',
  magenta: '#DD30FF',
  cyan: '#17D5DF',
  white: '#E7E7E7',
  brightBlack: '#6B6B6B',
  brightRed: '#C55555',
  brightGreen: '#AAC474',
  brightYellow: '#FECA88',
  brightBlue: '#82B8C8',
  brightMagenta: '#C28CB8',
  brightCyan: '#93D3C3',
  brightWhite: '#F8F8F8',
};

// NamedColor discriminants past the 16 ANSI entries.
const NAMED_FOREGROUND = 256;
const NAMED_BACKGROUND = 257;
const NAMED_CURSOR = 258;
const NAMED_DIM_BLACK = 259; // ..266 = DimWhite
const NAMED_LIGHT_FOREGROUND = 267;
const NAMED_DIM_FOREGROUND = 268;

function hexChannel(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function dim(color: string): string {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `#${hexChannel((r * 2 / 3) | 0)}${hexChannel((g * 2 / 3) | 0)}${hexChannel((b * 2 / 3) | 0)}`;
}

/** The standard xterm 256-color palette, with slots 0-15 from the theme. */
export function buildPalette(theme: Theme): string[] {
  const palette: string[] = [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ];
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        palette.push(`#${hexChannel(steps[r])}${hexChannel(steps[g])}${hexChannel(steps[b])}`);
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    palette.push(`#${hexChannel(v)}${hexChannel(v)}${hexChannel(v)}`);
  }
  return palette;
}

export class ColorResolver {
  readonly theme: Theme;
  private palette: string[];

  constructor(theme: Theme = defaultTheme) {
    this.theme = theme;
    this.palette = buildPalette(theme);
  }

  /** Resolve one packed color word to a CSS color. */
  resolve(packed: number, isForeground: boolean): string {
    const kind = packed >>> 24;
    const payload = packed & 0xffffff;
    switch (kind) {
      case COLOR_RGB:
        return `#${hexChannel((payload >> 16) & 0xff)}${hexChannel((payload >> 8) & 0xff)}${hexChannel(payload & 0xff)}`;
      case COLOR_INDEXED:
        return this.palette[payload] ?? this.theme.foreground;
      case COLOR_NAMED:
      default:
        return this.named(payload, isForeground);
    }
  }

  private named(value: number, isForeground: boolean): string {
    if (value < 16) return this.palette[value];
    switch (value) {
      case NAMED_FOREGROUND:
        return this.theme.foreground;
      case NAMED_BACKGROUND:
        return this.theme.background;
      case NAMED_CURSOR:
        return this.theme.cursor;
      case NAMED_LIGHT_FOREGROUND:
        return this.theme.brightWhite;
      case NAMED_DIM_FOREGROUND:
        return dim(this.theme.foreground);
      default:
        if (value >= NAMED_DIM_BLACK && value <= NAMED_DIM_BLACK + 7) {
          return dim(this.palette[value - NAMED_DIM_BLACK]);
        }
        return isForeground ? this.theme.foreground : this.theme.background;
    }
  }
}

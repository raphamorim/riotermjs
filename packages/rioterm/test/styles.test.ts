// SGR attributes as they land in the packed cell snapshot: color kinds,
// style flags, inline erase fills, and the theme resolver.

import { beforeAll, describe, expect, it } from 'vitest';

import {
  CELL_WORDS,
  COLOR_INDEXED,
  COLOR_NAMED,
  COLOR_RGB,
  ColorResolver,
  STYLE_BOLD,
  STYLE_DIM,
  STYLE_INVERSE,
  STYLE_ITALIC,
  STYLE_STRIKEOUT,
  STYLE_UNDERCURL,
  STYLE_UNDERLINE,
  buildPalette,
  defaultTheme,
} from '../src/index.js';
import { ensureWasm, makeTerminal } from './helpers.js';

beforeAll(ensureWasm);

function cell(term: ReturnType<typeof makeTerminal>, line: number, col: number) {
  const snap = term.snapshot();
  const base = (line * snap.cols + col) * CELL_WORDS;
  return {
    ch: String.fromCodePoint(snap.cells[base] & 0x1fffff),
    fg: snap.cells[base + 1],
    bg: snap.cells[base + 2],
    flags: snap.cells[base + 3],
  };
}

describe('SGR colors', () => {
  it('named 16-color foreground and background', () => {
    const term = makeTerminal();
    term.write('\x1b[31;42mX');
    const c = cell(term, 0, 0);
    expect(c.fg >>> 24).toBe(COLOR_NAMED);
    expect(c.fg & 0xffffff).toBe(1); // red
    expect(c.bg >>> 24).toBe(COLOR_NAMED);
    expect(c.bg & 0xffffff).toBe(2); // green
    term.dispose();
  });

  it('bright variants map to the light range', () => {
    const term = makeTerminal();
    term.write('\x1b[91mX');
    const c = cell(term, 0, 0);
    expect(c.fg >>> 24).toBe(COLOR_NAMED);
    expect(c.fg & 0xffffff).toBe(9); // light red
    term.dispose();
  });

  it('256-color palette entries', () => {
    const term = makeTerminal();
    term.write('\x1b[38;5;123m\x1b[48;5;200mX');
    const c = cell(term, 0, 0);
    expect(c.fg >>> 24).toBe(COLOR_INDEXED);
    expect(c.fg & 0xffffff).toBe(123);
    expect(c.bg >>> 24).toBe(COLOR_INDEXED);
    expect(c.bg & 0xffffff).toBe(200);
    term.dispose();
  });

  it('truecolor packs rgb into the payload', () => {
    const term = makeTerminal();
    term.write('\x1b[38;2;10;20;30mX');
    const c = cell(term, 0, 0);
    expect(c.fg >>> 24).toBe(COLOR_RGB);
    expect(c.fg & 0xffffff).toBe((10 << 16) | (20 << 8) | 30);
    term.dispose();
  });

  it('SGR 0 resets to default colors', () => {
    const term = makeTerminal();
    term.write('\x1b[31mA\x1b[0mB');
    const a = cell(term, 0, 0);
    const b = cell(term, 0, 1);
    expect(a.fg & 0xffffff).toBe(1);
    expect(b.fg >>> 24).toBe(COLOR_NAMED);
    expect(b.fg & 0xffffff).toBe(256); // NamedColor::Foreground
    term.dispose();
  });
});

describe('SGR flags', () => {
  it.each([
    ['1', STYLE_BOLD],
    ['2', STYLE_DIM],
    ['3', STYLE_ITALIC],
    ['4', STYLE_UNDERLINE],
    ['4:3', STYLE_UNDERCURL],
    ['7', STYLE_INVERSE],
    ['9', STYLE_STRIKEOUT],
  ])('SGR %s sets the expected flag', (code, flag) => {
    const term = makeTerminal();
    term.write(`\x1b[${code}mX`);
    expect(cell(term, 0, 0).flags & flag).toBe(flag);
    term.dispose();
  });

  it('cancel codes clear their flags', () => {
    const term = makeTerminal();
    term.write('\x1b[1;4mA\x1b[22;24mB');
    const a = cell(term, 0, 0);
    const b = cell(term, 0, 1);
    expect(a.flags & (STYLE_BOLD | STYLE_UNDERLINE)).toBe(STYLE_BOLD | STYLE_UNDERLINE);
    expect(b.flags & (STYLE_BOLD | STYLE_UNDERLINE)).toBe(0);
    term.dispose();
  });
});

describe('erase fills carry color inline', () => {
  it('EL with colored background paints trailing cells', () => {
    const term = makeTerminal();
    term.write('\x1b[44mA\x1b[K');
    const last = cell(term, 0, 39);
    expect(last.bg >>> 24).toBe(COLOR_INDEXED);
    expect(last.bg & 0xffffff).toBe(4);
    term.dispose();
  });
});

describe('theme resolution (pure)', () => {
  const colors = new ColorResolver(defaultTheme);

  it('resolves named ANSI, defaults, and dim variants', () => {
    expect(colors.resolve((COLOR_NAMED << 24) | 1, true)).toBe(defaultTheme.red);
    expect(colors.resolve((COLOR_NAMED << 24) | 256, true)).toBe(defaultTheme.foreground);
    expect(colors.resolve((COLOR_NAMED << 24) | 257, false)).toBe(defaultTheme.background);
    expect(colors.resolve((COLOR_NAMED << 24) | 258, true)).toBe(defaultTheme.cursor);
    // Dim red: two-thirds of #FF1261.
    expect(colors.resolve((COLOR_NAMED << 24) | 260, true)).toBe('#aa0c40');
  });

  it('resolves indexed cube and grayscale entries', () => {
    expect(colors.resolve((COLOR_INDEXED << 24) | 196, true)).toBe('#ff0000');
    expect(colors.resolve((COLOR_INDEXED << 24) | 232, true)).toBe('#080808');
    expect(colors.resolve((COLOR_INDEXED << 24) | 255, true)).toBe('#eeeeee');
  });

  it('resolves truecolor payloads directly', () => {
    expect(colors.resolve((COLOR_RGB << 24) | 0xa1b2c3, true)).toBe('#a1b2c3');
  });

  it('builds a full 256-entry palette with theme overrides first', () => {
    const palette = buildPalette(defaultTheme);
    expect(palette).toHaveLength(256);
    expect(palette[1]).toBe(defaultTheme.red);
    expect(palette[15]).toBe(defaultTheme.brightWhite);
    expect(palette[16]).toBe('#000000');
    expect(palette[231]).toBe('#ffffff');
  });
});

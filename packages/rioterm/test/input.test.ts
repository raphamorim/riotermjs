// Input encoding through the engine: keys under every terminal mode the
// program can set (application cursor, kitty keyboard), alt-as-meta,
// mouse reports, and the wheel dispatch tiers.

import { beforeAll, describe, expect, it } from 'vitest';

import {
  KEY_ACTION_PRESS,
  KEY_ACTION_RELEASE,
  KEY_BACKSPACE,
  KEY_CHAR,
  KEY_DOWN,
  KEY_ENTER,
  KEY_ESCAPE,
  KEY_F,
  KEY_TAB,
  KEY_UP,
  MOD_ALT,
  MOD_CTRL,
  MOD_SHIFT,
} from '../src/index.js';
import { collectData, ensureWasm, makeTerminal } from './helpers.js';

beforeAll(ensureWasm);

const press = (
  term: ReturnType<typeof makeTerminal>,
  tag: number,
  codepoint = 0,
  mods = 0,
  text?: string,
  fkey = 0,
) => term.key(KEY_ACTION_PRESS, tag, codepoint, fkey, mods, 0, false, text);

describe('plain keys', () => {
  it('printable text passes through', () => {
    const term = makeTerminal();
    const out = collectData(term);
    press(term, KEY_CHAR, 0x61, 0, 'a');
    expect(out.text()).toBe('a');
    term.dispose();
  });

  it('enter, tab, backspace, escape', () => {
    const term = makeTerminal();
    const out = collectData(term);
    press(term, KEY_ENTER);
    press(term, KEY_TAB);
    press(term, KEY_BACKSPACE);
    press(term, KEY_ESCAPE);
    expect(out.text()).toBe('\r\t\x7f\x1b');
    term.dispose();
  });

  it('F-keys use their legacy encodings', () => {
    const term = makeTerminal();
    const out = collectData(term);
    press(term, KEY_F, 0, 0, undefined, 1);
    press(term, KEY_F, 0, 0, undefined, 5);
    expect(out.text()).toBe('\x1bOP\x1b[15~');
    term.dispose();
  });

  it('releases produce nothing in legacy mode', () => {
    const term = makeTerminal();
    const out = collectData(term);
    term.key(KEY_ACTION_RELEASE, KEY_CHAR, 0x61, 0, 0, 0, false, 'a');
    expect(out.text()).toBe('');
    term.dispose();
  });
});

describe('modifiers', () => {
  it('ctrl+letter produces control bytes', () => {
    const term = makeTerminal();
    const out = collectData(term);
    press(term, KEY_CHAR, 0x61, MOD_CTRL); // ctrl+a
    press(term, KEY_CHAR, 0x63, MOD_CTRL); // ctrl+c
    expect(out.text()).toBe('\x01\x03');
    term.dispose();
  });

  it('alt acts as meta by default, and can be disabled', () => {
    const term = makeTerminal();
    const out = collectData(term);
    press(term, KEY_CHAR, 0x62, MOD_ALT);
    expect(out.text()).toBe('\x1bb');
    out.clear();
    term.setAltIsMeta(false);
    press(term, KEY_CHAR, 0x62, MOD_ALT, 'b');
    expect(out.text()).toBe('b');
    term.dispose();
  });

  it('shifted arrows carry the modifier parameter', () => {
    const term = makeTerminal();
    const out = collectData(term);
    press(term, KEY_UP, 0, MOD_SHIFT);
    expect(out.text()).toBe('\x1b[1;2A');
    term.dispose();
  });
});

describe('application cursor mode', () => {
  it('arrows switch from CSI to SS3 when the program asks', () => {
    const term = makeTerminal();
    const out = collectData(term);
    press(term, KEY_UP);
    expect(out.text()).toBe('\x1b[A');
    out.clear();
    term.write('\x1b[?1h');
    press(term, KEY_UP);
    press(term, KEY_DOWN);
    expect(out.text()).toBe('\x1bOA\x1bOB');
    expect(term.modes().applicationCursorKeys).toBe(true);
    term.dispose();
  });
});

describe('kitty keyboard protocol', () => {
  it('escape disambiguates to CSI u when flags are pushed', () => {
    const term = makeTerminal();
    const out = collectData(term);
    term.write('\x1b[>1u');
    press(term, KEY_ESCAPE);
    expect(out.text()).toBe('\x1b[27u');
    out.clear();
    term.write('\x1b[<u');
    press(term, KEY_ESCAPE);
    expect(out.text()).toBe('\x1b');
    term.dispose();
  });

  it('reports release events when the program opts in', () => {
    const term = makeTerminal();
    const out = collectData(term);
    term.write('\x1b[>3u'); // disambiguate + report event types
    term.key(KEY_ACTION_RELEASE, KEY_ESCAPE, 0, 0, 0, 0, false, undefined);
    expect(out.text()).toBe('\x1b[27;1:3u');
    term.dispose();
  });
});

describe('mouse and wheel', () => {
  it('wheel scrolls the view in a plain shell', () => {
    const term = makeTerminal({ rows: 5 });
    for (let i = 0; i < 20; i++) term.write(`l${i}\r\n`);
    const consumed = term.scrollWheel(3, 0, 0, 0);
    expect(consumed).toBe(false);
    expect(term.snapshot().displayOffset).toBe(3);
    term.dispose();
  });

  it('wheel becomes SGR mouse reports when tracking is on', () => {
    const term = makeTerminal();
    const out = collectData(term);
    term.write('\x1b[?1000h\x1b[?1006h');
    expect(term.modes().mouseTracking).toBe(true);
    expect(term.scrollWheel(1, 4, 2, 0)).toBe(true);
    expect(term.scrollWheel(-1, 4, 2, 0)).toBe(true);
    expect(out.text()).toBe('\x1b[<64;5;3M\x1b[<65;5;3M');
    term.dispose();
  });

  it('wheel becomes arrows on the alternate screen with alt-scroll', () => {
    const term = makeTerminal();
    const out = collectData(term);
    term.write('\x1b[?1049h\x1b[?1007h');
    expect(term.scrollWheel(2, 0, 0, 0)).toBe(true);
    expect(out.text()).toBe('\x1b[A\x1b[A');
    term.dispose();
  });

  it('shift always reclaims the wheel for scrollback', () => {
    const term = makeTerminal({ rows: 5 });
    for (let i = 0; i < 20; i++) term.write(`l${i}\r\n`);
    term.write('\x1b[?1000h\x1b[?1006h');
    expect(term.scrollWheel(2, 0, 0, MOD_SHIFT)).toBe(false);
    expect(term.snapshot().displayOffset).toBe(2);
    term.dispose();
  });
});

// KeyboardEvent -> librio key events. The tags mirror librio's C ABI so
// Swift, C, and JS embedders share one vocabulary; librio itself decides
// the encoding (app cursor mode, kitty keyboard flags, modifyOtherKeys).

import type { Terminal } from './core.js';

export const KEY_CHAR = 0;
export const KEY_ENTER = 1;
export const KEY_TAB = 2;
export const KEY_BACKSPACE = 3;
export const KEY_ESCAPE = 4;
export const KEY_UP = 5;
export const KEY_DOWN = 6;
export const KEY_LEFT = 7;
export const KEY_RIGHT = 8;
export const KEY_HOME = 9;
export const KEY_END = 10;
export const KEY_PAGE_UP = 11;
export const KEY_PAGE_DOWN = 12;
export const KEY_INSERT = 13;
export const KEY_DELETE = 14;
export const KEY_F = 15;
export const KEY_NONE = 16;
export const KEY_CAPS_LOCK = 17;
export const KEY_SHIFT_LEFT = 18;
export const KEY_SHIFT_RIGHT = 19;
export const KEY_CONTROL_LEFT = 20;
export const KEY_CONTROL_RIGHT = 21;
export const KEY_ALT_LEFT = 22;
export const KEY_ALT_RIGHT = 23;
export const KEY_SUPER_LEFT = 24;
export const KEY_SUPER_RIGHT = 25;

export const KEY_ACTION_PRESS = 0;
export const KEY_ACTION_REPEAT = 1;
export const KEY_ACTION_RELEASE = 2;

export const MOD_SHIFT = 1 << 0;
export const MOD_CTRL = 1 << 1;
export const MOD_ALT = 1 << 2;
export const MOD_SUPER = 1 << 3;

const NAMED_KEYS: Record<string, number> = {
  Enter: KEY_ENTER,
  Tab: KEY_TAB,
  Backspace: KEY_BACKSPACE,
  Escape: KEY_ESCAPE,
  ArrowUp: KEY_UP,
  ArrowDown: KEY_DOWN,
  ArrowLeft: KEY_LEFT,
  ArrowRight: KEY_RIGHT,
  Home: KEY_HOME,
  End: KEY_END,
  PageUp: KEY_PAGE_UP,
  PageDown: KEY_PAGE_DOWN,
  Insert: KEY_INSERT,
  Delete: KEY_DELETE,
  CapsLock: KEY_CAPS_LOCK,
};

const MODIFIER_CODES: Record<string, number> = {
  ShiftLeft: KEY_SHIFT_LEFT,
  ShiftRight: KEY_SHIFT_RIGHT,
  ControlLeft: KEY_CONTROL_LEFT,
  ControlRight: KEY_CONTROL_RIGHT,
  AltLeft: KEY_ALT_LEFT,
  AltRight: KEY_ALT_RIGHT,
  MetaLeft: KEY_SUPER_LEFT,
  MetaRight: KEY_SUPER_RIGHT,
};

export function modsOf(event: KeyboardEvent): number {
  return (
    (event.shiftKey ? MOD_SHIFT : 0) |
    (event.ctrlKey ? MOD_CTRL : 0) |
    (event.altKey ? MOD_ALT : 0) |
    (event.metaKey ? MOD_SUPER : 0)
  );
}

/**
 * Feed a keydown/keyup into the terminal. Returns true when the key was
 * consumed (the caller should preventDefault).
 */
export function handleKeyboardEvent(term: Terminal, event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' && event.type !== 'keyup') return false;
  // Leave browser shortcuts (copy/paste/etc.) to the embedder.
  if (event.metaKey) return false;

  const action =
    event.type === 'keyup'
      ? KEY_ACTION_RELEASE
      : event.repeat
        ? KEY_ACTION_REPEAT
        : KEY_ACTION_PRESS;
  const mods = modsOf(event);

  let tag: number;
  let codepoint = 0;
  let functionKey = 0;
  let text: string | undefined;
  let consumedMods = 0;

  const fMatch = /^F(\d{1,2})$/.exec(event.key);
  if (event.key in NAMED_KEYS) {
    tag = NAMED_KEYS[event.key];
  } else if (fMatch) {
    tag = KEY_F;
    functionKey = parseInt(fMatch[1], 10);
  } else if (event.code in MODIFIER_CODES) {
    tag = MODIFIER_CODES[event.code];
  } else if ([...event.key].length === 1) {
    // The tag names the key without shift applied: shift+a is CHAR 'a'
    // and the 'A' travels in text, with SHIFT marked as consumed.
    tag = KEY_CHAR;
    const lower = event.key.toLowerCase();
    codepoint = ([...lower][0] as string).codePointAt(0)!;
    if (!event.ctrlKey && !event.altKey) {
      text = event.key;
      if (event.key !== lower) consumedMods = MOD_SHIFT;
    }
  } else {
    return false;
  }

  return term.key(
    action,
    tag,
    codepoint,
    functionKey,
    mods,
    consumedMods,
    event.isComposing,
    text,
  );
}

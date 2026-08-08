// Pure-TS unit tests for the KeyboardEvent translation layer. No DOM:
// events are plain objects with the fields the translator reads, checked
// end to end against the engine's actual byte output.

import { beforeAll, describe, expect, it } from 'vitest';

import { handleKeyboardEvent, modsOf, MOD_ALT, MOD_CTRL, MOD_SHIFT } from '../src/index.js';
import { collectData, ensureWasm, makeTerminal } from './helpers.js';

beforeAll(ensureWasm);

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown',
    key: '',
    code: '',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    ...overrides,
  } as KeyboardEvent;
}

describe('modsOf', () => {
  it('maps modifier flags to librio bits', () => {
    expect(modsOf(keyEvent({ shiftKey: true }))).toBe(MOD_SHIFT);
    expect(modsOf(keyEvent({ ctrlKey: true, altKey: true }))).toBe(MOD_CTRL | MOD_ALT);
  });
});

describe('handleKeyboardEvent', () => {
  it('letters flow through with their text', () => {
    const term = makeTerminal();
    const out = collectData(term);
    expect(handleKeyboardEvent(term, keyEvent({ key: 'a' }))).toBe(true);
    expect(out.text()).toBe('a');
    term.dispose();
  });

  it('shift+letter sends the shifted text once', () => {
    const term = makeTerminal();
    const out = collectData(term);
    handleKeyboardEvent(term, keyEvent({ key: 'A', shiftKey: true }));
    expect(out.text()).toBe('A');
    term.dispose();
  });

  it('ctrl+c becomes ETX without text passthrough', () => {
    const term = makeTerminal();
    const out = collectData(term);
    handleKeyboardEvent(term, keyEvent({ key: 'c', ctrlKey: true }));
    expect(out.text()).toBe('\x03');
    term.dispose();
  });

  it('named keys and F-keys translate to their tags', () => {
    const term = makeTerminal();
    const out = collectData(term);
    handleKeyboardEvent(term, keyEvent({ key: 'Enter' }));
    handleKeyboardEvent(term, keyEvent({ key: 'ArrowLeft' }));
    handleKeyboardEvent(term, keyEvent({ key: 'F2' }));
    expect(out.text()).toBe('\r\x1b[D\x1bOQ');
    term.dispose();
  });

  it('meta shortcuts are left to the browser', () => {
    const term = makeTerminal();
    const out = collectData(term);
    expect(handleKeyboardEvent(term, keyEvent({ key: 'c', metaKey: true }))).toBe(false);
    expect(out.text()).toBe('');
    term.dispose();
  });

  it('bare modifier presses produce nothing in legacy mode', () => {
    const term = makeTerminal();
    const out = collectData(term);
    handleKeyboardEvent(term, keyEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }));
    expect(out.text()).toBe('');
    term.dispose();
  });

  it('unknown multi-char keys are ignored', () => {
    const term = makeTerminal();
    expect(handleKeyboardEvent(term, keyEvent({ key: 'MediaPlayPause' }))).toBe(false);
    term.dispose();
  });
});

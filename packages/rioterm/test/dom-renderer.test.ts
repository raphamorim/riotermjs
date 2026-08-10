// @vitest-environment happy-dom
//
// DOMRenderer integration: real DOM (happy-dom), real engine. Verifies
// the rows/spans structure, style runs, selection painting, hover
// underlines, and dirty-row rebuild behavior.

import { beforeAll, describe, expect, it } from 'vitest';

import { DOMRenderer, defaultTheme } from '../src/index.js';
import { ensureWasm, makeTerminal } from './helpers.js';

beforeAll(ensureWasm);

function renderNow(renderer: DOMRenderer): void {
  // Tests drive rendering synchronously instead of waiting for rAF.
  renderer.render();
}

function rows(renderer: DOMRenderer): HTMLElement[] {
  return Array.from(renderer.element.children[0].children) as HTMLElement[];
}

describe('DOMRenderer', () => {
  it('renders one div per row with text content', () => {
    const term = makeTerminal({ cols: 20, rows: 4 });
    const renderer = new DOMRenderer(term);
    term.write('hello\r\nworld');
    renderNow(renderer);
    const els = rows(renderer);
    expect(els).toHaveLength(4);
    expect(els[0].textContent).toContain('hello');
    expect(els[1].textContent).toContain('world');
    renderer.dispose();
    term.dispose();
  });

  it('groups same-style cells into single spans', () => {
    const term = makeTerminal({ cols: 20, rows: 2 });
    const renderer = new DOMRenderer(term);
    term.write('\x1b[31mred\x1b[0m plain');
    renderNow(renderer);
    const spans = rows(renderer)[0].querySelectorAll('span');
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe('red');
    expect(spans[0].style.color.toLowerCase()).toBe(defaultTheme.red.toLowerCase());
    renderer.dispose();
    term.dispose();
  });

  it('renders full grapheme clusters, not just their base codepoint', () => {
    // Mode 2027 is on by default: the farmer ZWJ sequence lands in one
    // wide cell whose codepoint word carries only the base. The DOM
    // must show the whole cluster, followed by the pipe two cells in.
    const term = makeTerminal({ cols: 20, rows: 2 });
    const renderer = new DOMRenderer(term);
    term.write('\u{1F9D1}\u{200D}\u{1F33E}|');
    renderNow(renderer);
    const cluster = '\u{1F9D1}\u{200D}\u{1F33E}';
    const text = rows(renderer)[0].textContent ?? '';
    expect(text).toContain(cluster);
    // The wide cell's spacer is skipped, so the pipe follows the
    // cluster directly (indexOf counts UTF-16 units).
    expect(text.indexOf('|')).toBe(text.indexOf(cluster) + cluster.length);
    renderer.dispose();
    term.dispose();
  });

  it('paints selection with the theme colors', () => {
    const term = makeTerminal({ cols: 20, rows: 2 });
    const renderer = new DOMRenderer(term);
    term.write('select this');
    term.selectionBegin(0, 0);
    term.selectionUpdate(0, 5, true);
    renderNow(renderer);
    const first = rows(renderer)[0].querySelector('span');
    expect(first?.style.backgroundColor.toLowerCase()).toBe(defaultTheme.selectionBackground.toLowerCase());
    renderer.dispose();
    term.dispose();
  });

  it('underlines the hovered link run and clears it', () => {
    const term = makeTerminal({ cols: 30, rows: 2 });
    const renderer = new DOMRenderer(term);
    term.write('\x1b]8;;https://x.dev\x1b\\click\x1b]8;;\x1b\\ after');
    renderNow(renderer);
    const link = term.linkAt(0, 2)!;
    renderer.setHoverLink({ line: 0, startCol: link.startCol, endCol: link.endCol });
    renderNow(renderer);
    const underlined = Array.from(rows(renderer)[0].querySelectorAll('span')).filter((s) =>
      s.style.textDecoration.includes('underline'),
    );
    expect(underlined.length).toBe(1);
    expect(underlined[0].textContent).toBe('click');
    renderer.setHoverLink(null);
    renderNow(renderer);
    const after = Array.from(rows(renderer)[0].querySelectorAll('span')).filter((s) =>
      s.style.textDecoration.includes('underline'),
    );
    expect(after.length).toBe(0);
    renderer.dispose();
    term.dispose();
  });

  it('rebuilds only dirty rows', () => {
    const term = makeTerminal({ cols: 20, rows: 4 });
    const renderer = new DOMRenderer(term);
    term.write('top\r\n\r\n\r\nbottom');
    renderNow(renderer);
    const before = rows(renderer)[0];
    const beforeMarker = document.createElement('i');
    before.appendChild(beforeMarker);
    // Writing on the last row must not rebuild row 0.
    term.write('!');
    renderNow(renderer);
    expect(rows(renderer)[0].contains(beforeMarker)).toBe(true);
    renderer.dispose();
    term.dispose();
  });

  it('fit() resizes the grid from pixel dimensions', () => {
    const term = makeTerminal({ cols: 10, rows: 4 });
    const renderer = new DOMRenderer(term, { fontSize: 10, lineHeight: 1 });
    renderer.fit(renderer.cellWidth * 33, renderer.cellHeight * 7);
    expect(term.options.cols).toBe(33);
    expect(term.options.rows).toBe(7);
    renderNow(renderer);
    expect(rows(renderer)).toHaveLength(7);
    renderer.dispose();
    term.dispose();
  });

  it('does not paint the cursor while DECTCEM hides it', () => {
    const term = makeTerminal({ cols: 20, rows: 2 });
    const renderer = new DOMRenderer(term);
    term.write('ready');
    renderNow(renderer);
    const cursor = renderer.element.children[1] as HTMLElement;
    expect(cursor.style.display).not.toBe('none');
    term.write('\x1b[?25l');
    renderNow(renderer);
    expect(cursor.style.display).toBe('none');
    term.write('\x1b[?25h');
    renderNow(renderer);
    expect(cursor.style.display).not.toBe('none');
    renderer.dispose();
    term.dispose();
  });

  it('fit() ignores a collapsed container instead of folding the grid', () => {
    const term = makeTerminal({ cols: 10, rows: 4 });
    const renderer = new DOMRenderer(term, { fontSize: 10, lineHeight: 1 });
    renderer.fit(0, 0);
    renderer.fit(renderer.cellWidth - 1, renderer.cellHeight * 7);
    expect(term.options.cols).toBe(10);
    expect(term.options.rows).toBe(4);
    renderer.dispose();
    term.dispose();
  });
});

// Vanilla entry point: mounts a Terminal + CanvasRenderer into an element
// and wires keyboard, mouse selection, wheel, paste, and clipboard.

import { Terminal, initWasm, type TerminalOptions } from './core.js';
import { CanvasRenderer, type CanvasRendererOptions } from './canvas.js';
import { DOMRenderer } from './dom-renderer.js';
import { handleKeyboardEvent, modsOf } from './keys.js';

export interface OpenOptions extends TerminalOptions, CanvasRendererOptions {
  /** How to paint the grid: GPU-friendly canvas (default) or DOM rows. */
  renderer?: 'canvas' | 'dom';
  /** Autofocus the terminal after mounting (default true). */
  autoFocus?: boolean;
  /** Track the container size and refit the grid (default true). */
  fit?: boolean;
}

export interface RioTermHandle {
  terminal: Terminal;
  renderer: CanvasRenderer | DOMRenderer;
  focus(): void;
  dispose(): void;
}

export async function open(
  parent: HTMLElement,
  options: OpenOptions = {},
): Promise<RioTermHandle> {
  await initWasm();
  const terminal = new Terminal(options);
  const renderer =
    options.renderer === 'dom'
      ? new DOMRenderer(terminal, options)
      : new CanvasRenderer(terminal, options);

  const container = document.createElement('div');
  container.style.position = 'relative';
  container.style.overflow = 'hidden';
  container.appendChild(renderer.element);

  // Hidden textarea holds focus so keyboard and paste events arrive and
  // IME composition has somewhere to live.
  const textarea = document.createElement('textarea');
  Object.assign(textarea.style, {
    position: 'absolute',
    left: '-9999px',
    top: '0',
    width: '0',
    height: '0',
    opacity: '0',
  } satisfies Partial<CSSStyleDeclaration>);
  textarea.setAttribute('autocorrect', 'off');
  textarea.setAttribute('autocapitalize', 'off');
  textarea.setAttribute('spellcheck', 'false');
  container.appendChild(textarea);
  parent.appendChild(container);

  const disposers: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement | Window,
    type: K,
    fn: (ev: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ) => {
    el.addEventListener(type, fn as EventListener, opts);
    disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
  };

  on(textarea, 'keydown', (e) => {
    // Copy/paste shortcuts act on librio's selection, since there is no
    // DOM selection over a canvas: cmd+c (mac) / ctrl+shift+c, and
    // ctrl+shift+v (cmd+v arrives via the paste event).
    const isCopy =
      (e.metaKey && !e.ctrlKey && e.key === 'c') ||
      (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c');
    if (isCopy) {
      const text = terminal.getSelection();
      if (text) {
        void navigator.clipboard?.writeText(text).catch(() => {});
        e.preventDefault();
        return;
      }
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v') {
      void navigator.clipboard
        ?.readText()
        .then((text) => text && terminal.paste(text))
        .catch(() => {});
      e.preventDefault();
      return;
    }
    if (handleKeyboardEvent(terminal, e)) e.preventDefault();
  });
  on(textarea, 'keyup', (e) => {
    handleKeyboardEvent(terminal, e);
  });
  on(textarea, 'paste', (e) => {
    const text = e.clipboardData?.getData('text');
    if (text) terminal.paste(text);
    e.preventDefault();
  });

  // OSC 52 writes from programs go to the system clipboard when allowed.
  terminal.onClipboardWrite((text) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  });

  // Mouse selection: click begins, drag extends, double/triple click
  // select word/line; a completed selection is copied when the platform
  // allows it (matching terminal muscle memory).
  let selecting = false;
  on(container, 'mousedown', (e) => {
    if (e.button !== 0) return;
    textarea.focus();
    const { col, row, sideRight } = renderer.cellAt(e.clientX, e.clientY);
    const kind = e.detail >= 3 ? 'line' : e.detail === 2 ? 'word' : e.altKey ? 'block' : 'simple';
    terminal.selectionBegin(row, col, kind, sideRight);
    selecting = true;
    e.preventDefault();
  });
  on(window as unknown as HTMLElement, 'mousemove', (e) => {
    if (!selecting) return;
    const me = e as MouseEvent;
    const { col, row, sideRight } = renderer.cellAt(me.clientX, me.clientY);
    terminal.selectionUpdate(row, col, sideRight);
  });
  on(window as unknown as HTMLElement, 'mouseup', () => {
    if (!selecting) return;
    selecting = false;
    const text = terminal.getSelection();
    if (text) void navigator.clipboard?.writeText(text).catch(() => {});
  });

  on(
    container,
    'wheel',
    (e) => {
      const lines =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? -e.deltaY
          : -e.deltaY / renderer.cellHeight;
      const whole = Math.trunc(lines);
      if (whole === 0) return;
      const { col, row } = renderer.cellAt(e.clientX, e.clientY);
      // Claim the event only when the terminal used it (mouse report,
      // alternate scroll, or the scrollback view moved); otherwise the
      // page keeps scrolling instead of trapping the wheel.
      const offsetBefore = terminal.displayOffset();
      const consumed = terminal.scrollWheel(
        whole,
        col,
        row,
        modsOf(e as unknown as KeyboardEvent),
      );
      if (consumed || terminal.displayOffset() !== offsetBefore) {
        e.preventDefault();
      }
    },
    { passive: false },
  );

  let observer: ResizeObserver | undefined;
  if (options.fit !== false) {
    observer = new ResizeObserver(() => {
      renderer.fit(parent.clientWidth, parent.clientHeight);
    });
    observer.observe(parent);
  }

  if (options.autoFocus !== false) textarea.focus();

  return {
    terminal,
    renderer,
    focus: () => textarea.focus(),
    dispose() {
      observer?.disconnect();
      for (const dispose of disposers) dispose();
      renderer.dispose();
      terminal.dispose();
      container.remove();
    },
  };
}

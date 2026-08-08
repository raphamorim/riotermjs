# Migrating from xterm.js

rioterm's `Terminal` is deliberately xterm-shaped: bytes in via `write()`,
input out via `onData()`, and a renderer attached to a DOM element. Most
migrations are a rename plus deleting addons, because the addon surface
(fit, serialize, search, web links, clipboard) is built in.

The one architectural difference to internalize: rioterm's parser runs in
Rust/WebAssembly and `write()` is synchronous. When `write()` returns, the
grid is updated and any auto-responses (DA, DSR, DECRQM) have already been
delivered to `onData`. There is no write callback and no need for one.

## Setup

xterm.js:

```js
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const term = new Terminal({ scrollback: 10000 });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(element);
fit.fit();
```

rioterm:

```js
import { open } from 'rioterm';

const { terminal, renderer, focus, dispose } = await open(element, {
  renderer: 'canvas', // or 'dom'
  scrollback: 10000,
  // fit: true is the default; a ResizeObserver keeps the grid fitted
});
```

`open()` is async because it instantiates the wasm module. No CSS import:
renderers style themselves. If you manage sizing yourself (remote-controlled
dimensions, custom layout), pass `fit: false` and call
`renderer.fit(widthPx, heightPx)` when you decide to.

## Core API mapping

| xterm.js | rioterm |
|---|---|
| `new Terminal(opts)` + `term.open(el)` | `await open(el, opts)` (returns `{ terminal, renderer, focus, dispose }`) |
| `term.write(data)` | `terminal.write(data)` (string or `Uint8Array`; synchronous) |
| `term.write(data, callback)` | `terminal.write(data)` then just continue; the write already applied |
| `term.writeln(data)` | `terminal.write(data + '\r\n')` |
| `term.onData(fn)` | `terminal.onData(fn)` receives `Uint8Array`; decode with `TextDecoder` if you need a string |
| `term.onBinary(fn)` | not needed; `onData` already carries bytes |
| `term.input(text)` | `terminal.input(text)` |
| `term.paste(text)` | `terminal.paste(text)` (bracketed paste + newline normalization) |
| `term.onTitleChange(fn)` | `terminal.onTitleChange(fn)` |
| `term.onBell(fn)` | `terminal.onBell(fn)` |
| `term.onSelectionChange(fn)` | `terminal.onUpdate(fn)` + `terminal.getSelection()` |
| `term.onRender(fn)` / `onWriteParsed(fn)` | `terminal.onUpdate(fn)` |
| `term.onResize(fn)` | you call `resize()`/`renderer.fit()`, so observe your own calls, or read `terminal.options.cols/rows` after an update |
| `term.resize(cols, rows)` | `terminal.resize(cols, rows)` |
| `term.rows`, `term.cols` | `terminal.options.rows`, `terminal.options.cols` |
| `term.reset()` | `terminal.write('\x1bc')` (RIS resets grid, modes, parser) |
| `term.clear()` | `terminal.write('\x1b[2J\x1b[3J\x1b[H')` |
| `term.focus()` | `focus()` from the `open()` handle |
| `term.getSelection()` | `terminal.getSelection()` |
| `term.clearSelection()` | `terminal.clearSelection()` |
| `term.select(col, row, len)` | `terminal.selectionBegin(line, col)` + `terminal.selectionUpdate(line, endCol, true)` |
| `term.scrollLines(n)` | `terminal.scrollLines(n)` (positive scrolls into history) |
| `term.scrollToBottom()` | `terminal.scrollLines(-terminal.historySize())` |
| `term.scrollToTop()` | `terminal.scrollLines(terminal.historySize())` |
| `term.buffer.active.getLine(y)` | `terminal.textRow(y)` for text, `terminal.snapshot()` for styled cells |
| `term.buffer.active.viewportY` | `terminal.displayOffset()` (distance from the live bottom) |
| `term.attachCustomKeyEventHandler(fn)` | intercept `keydown` on your container before it reaches the terminal, or gate `onData` |
| `term.options.theme = {...}` | `theme` in `open()` options (same color names) |
| `term.options.convertEol` | `convertEol` in options |
| `term.dispose()` | `dispose()` from the `open()` handle |

Options that carry over by name: `cols`, `rows`, `scrollback`, `fontSize`,
`fontFamily`, `lineHeight`, `cursorStyle`, `theme`, `convertEol`.

## Addon mapping

| xterm.js addon | rioterm |
|---|---|
| `@xterm/addon-fit` | built in: `fit: true` (default) or `renderer.fit(w, h)` |
| `@xterm/addon-webgl` / `addon-canvas` | `renderer: 'canvas'` (default) |
| DOM renderer fallback | `renderer: 'dom'` (a first-class choice here, not a fallback; see [ACCESSIBILITY.md](ACCESSIBILITY.md)) |
| `@xterm/addon-serialize` | `terminal.serialize()` returns a VT stream with styles, links, and scrollback; replay with `write()` into a same-width terminal |
| `@xterm/addon-search` | `terminal.search(pattern)`, `terminal.findNext(pattern)`, `terminal.findPrevious(pattern)` |
| `@xterm/addon-web-links` | OSC 8 hyperlinks are built in: hover underline plus click activation, routed through the `linkHandler` option. Plain-text URL autodetection is not built in yet; `textRow()` gives you the text to scan if you need it today |
| `@xterm/addon-clipboard` | OSC 52 is built in: `terminal.onClipboardWrite(fn)` |
| `@xterm/addon-attach` | two lines: `terminal.onData((b) => ws.send(b))` and `ws.onmessage = (e) => terminal.write(new Uint8Array(e.data))` |
| `@xterm/addon-unicode11` | built in (wide chars, zero-width joiners handled by the Rust grid) |
| `@xterm/addon-image` | kitty graphics protocol is built in; the canvas renderer paints placements |
| `@xterm/addon-ligatures` | not supported |

## Serialize and reconnect

The pattern every cloud IDE needs: persist the buffer on disconnect, replay
it on reconnect so the user keeps their scrollback.

```js
// on disconnect (or on an interval)
const state = terminal.serialize();
sessionStorage.setItem('term-state', state);

// on reconnect, before attaching the live stream
const saved = sessionStorage.getItem('term-state');
if (saved) terminal.write(saved);
```

`serialize()` covers scrollback plus screen, preserves SGR styling and
OSC 8 links, and emits wrapped rows without line breaks so they re-wrap
correctly in a same-width terminal. Replaying it through `write()` means
the bytes go through the parser like any other output; nothing is pasted
to the shell. For plain text without styles, `dump()` still exists.

## Search

`search()` returns matches over scrollback plus screen in buffer
coordinates, where line 0 is the top of the scrollback and
`historySize()` is the first row of the live screen. `findNext()` and
`findPrevious()` cycle through matches, select the current one so the
renderer highlights it, and scroll it into view:

```js
searchInput.onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  const hit = e.shiftKey
    ? terminal.findPrevious(searchInput.value)
    : terminal.findNext(searchInput.value);
  if (!hit) flashNoResults();
};
```

Patterns are regular expressions; an invalid pattern simply matches
nothing.

## Worked example: the Lovable adapter

Lovable's admin terminal migrated from xterm.js to rioterm with no
fallback path. The full component is a standard React wrapper around
`open()`; these are the parts that differ from the xterm version.

**Replay suppression got simpler.** Replayed scrollback contains recorded
terminal queries (DA, DSR), and the parser auto-answers them; those
answers must not reach the live PTY. With xterm's async write this needed
callback counting. rioterm writes synchronously, so a boolean is enough:

```js
const suppressInput = { current: false };

terminal.onData((bytes) => {
  if (suppressInput.current || readOnly.current) return;
  onInput(decoder.decode(bytes));
});

function writeReplay(bytes) {
  suppressInput.current = true;
  terminal.write(bytes);   // responses fire inside this call
  suppressInput.current = false;
}
```

**Sizing stays host-owned.** The adapter supports observer mode, where a
remote peer dictates dimensions. It opens with `fit: false` and drives
`renderer.fit(container.clientWidth, container.clientHeight)` from its own
ResizeObserver, or applies server-sent `terminal.resize(cols, rows)` when
following a remote.

**Links route through platform bridges.** OSC 8 activation goes through
`linkHandler` instead of `window.open`, so mobile WebViews and the desktop
app can open links natively:

```js
await open(container, {
  renderer: 'canvas',
  fit: false,
  autoFocus: false,
  theme: RIO_THEME,
  linkHandler: { activate: (uri) => openThroughBridge(uri) },
});
```

**Imperative surface mapped one to one.** The ref contract the rest of
the app depends on kept its shape: `write`, `writeln`, `clear`, `reset`,
`resize`, `focus`, `paste`, `getDimensions`, plus mode checks via
`terminal.modes()` (application cursor keys for touch scrolling, mouse
tracking, alternate screen).

The whole migration removed the `@xterm/*` dependencies and the xterm CSS
import, and the component logic got shorter, mostly because fit,
serialize-style replay handling, and link handling stopped being addons
to wire up.

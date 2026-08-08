# Accessibility

rioterm ships two renderers, and the choice matters for accessibility.
This document explains why the DOM renderer is a stronger foundation for
assistive technology than the shadow-buffer approach used by canvas-based
terminals, what works today, what does not yet, and how to build
accessible terminal UIs on the current API.

## The shadow buffer problem

A canvas terminal (xterm.js with the webgl or canvas addon, and rioterm
with `renderer: 'canvas'`) paints pixels. Pixels are invisible to screen
readers, so canvas terminals bolt on a second, hidden representation:
xterm.js keeps an off-screen "accessibility tree" of DOM nodes that
mirrors the visible buffer, activated behind a `screenReaderMode` flag.

That design has structural costs:

- **It is opt-in**, so most deployments never turn it on, and users who
  need it depend on every embedding application having wired up a flag
  the developers likely never tested.
- **It is a duplicate**: the mirror must be kept in sync with the real
  buffer by hand. Every sync gap is a bug only screen reader users hit.
- **Only screen readers benefit.** Browser find-in-page, translation,
  user stylesheets, forced-colors mode, and text extraction all still
  see an opaque bitmap.

## What the DOM renderer does instead

`renderer: 'dom'` makes the visible output itself real text: one `div`
per row, one `span` per same-style run, laid out on a `ch` grid. There
is no mirror to keep in sync because there is nothing to mirror; the
thing on screen is the thing assistive technology reads. That means:

- Screen readers read the same content sighted users see, always on,
  with no mode to enable.
- Zoom reflows real text; forced-colors and high-contrast modes apply
  to real styled elements rather than being repainted approximations.
- Selection is real browser text behavior under the hood, and the text
  is available to any extension or tool that walks the DOM.

The engine underneath is identical: the same wasm grid, the same dirty
row tracking, the same style runs. The renderer choice is one option, so
an application can offer it as a user preference:

```js
const { terminal } = await open(element, {
  renderer: prefersAccessibleRenderer ? 'dom' : 'canvas',
});
```

## What works today

- **Real text rows** in the DOM renderer, rebuilt only when dirty, so
  assistive tech sees stable nodes rather than a full-screen churn on
  every frame.
- **Keyboard and IME**: focus lives in a real `textarea` (with
  autocorrect, autocapitalize, and spellcheck disabled), so composition,
  dictation, and on-screen keyboards work through standard input events
  in both renderers.
- **Programmatic text access** in both renderers: `textRow(line)` for
  any viewport row, `dump()` for the whole buffer, `snapshot()` for
  styled cells. A host can build announcements, transcripts, or a
  braille-friendly view from these without reverse-engineering pixels.
- **OSC 8 hyperlinks** are exposed for hit-testing (`linkAt`) and are
  activated through a pluggable `linkHandler`, so hosts can present
  confirmation UI that meets their own accessibility bar.
- **Theme control**: every color comes from the `theme` option, so
  high-contrast palettes are a host decision, not a fork.

## What is not there yet

Being honest about the gaps:

- No ARIA roles or live regions out of the box: rows are plain `div`s,
  and new output is not announced automatically. A host that needs
  announcements today should watch `onUpdate()` and feed a
  `aria-live="polite"` region from `textRow()` diffs.
- No built-in screen reader navigation commands (jump to prompt, read
  previous command output).
- The canvas renderer has no fallback text layer at all; if assistive
  technology matters in your deployment, use the DOM renderer.

The roadmap is to grow the DOM renderer into the accessible-by-default
path: row-level ARIA semantics, an opt-out live region for new output,
and reduced-motion handling for the cursor. Because the DOM renderer's
output is already the accessibility tree, each of these is an attribute
on existing nodes rather than a parallel subsystem.

## Recommendations for embedders

1. Offer `renderer: 'dom'` wherever a user can express a preference, or
   default to it when `navigator` signals assistive tech friendly
   settings you already track (your app's own accessibility toggle,
   `prefers-reduced-motion`, forced colors).
2. Pipe new-output announcements through a live region if your users
   rely on them, using `onUpdate()` plus `textRow()`.
3. Keep focus management native: call `focus()` from the `open()`
   handle instead of managing a fake caret.
4. Respect the platform: route `linkHandler` through your app's link
   confirmation flow rather than bare `window.open`.

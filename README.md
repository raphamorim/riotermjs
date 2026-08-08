# rioterm (web)

[Rio](https://github.com/raphamorim/rio)'s Rust terminal core (librio),
compiled to WebAssembly and packaged for the web.
Live demo: https://raphamorim.github.io/riotermjs/ (it boots Linux).

- **[`rioterm`](packages/rioterm)**: the core npm package, a headless
  `Terminal` (feed bytes in, get backend bytes out, pull grid snapshots)
  plus two renderers, canvas and DOM, selectable per instance.
- **[`react-rioterm`](packages/react-rioterm)**: `<RioTerminal />`, a thin
  React wrapper with the same renderer choice.
- **[`docs/`](docs)**: the landing page and live demo
  (GitHub Pages), which doubles as the dev testbed.

## Install

```sh
npm i rioterm --save
```

## Integration

The whole integration surface is two directions of bytes:

```js
import { open } from 'rioterm';

const { terminal } = await open(document.getElementById('term'), {
  renderer: 'canvas', // or 'dom'
});

// bytes the terminal wants delivered to the child
terminal.onData((bytes) => socket.send(bytes));
// child output to display
socket.onmessage = (e) => terminal.write(new Uint8Array(e.data));
```

There is no PTY in a browser: the host owns the transport. A real shell
over WebSocket looks like this; the demo site plugs
[v86](https://github.com/copy/v86)'s serial port into the same two lines
instead of a socket:

```js
// server: any PTY owner, node-pty + ws shown
pty.onData((data) => ws.send(data));
ws.on('message', (bytes) => pty.write(bytes));

// browser: same two lines as always
terminal.onData((bytes) => ws.send(bytes));
ws.onmessage = (e) => terminal.write(new Uint8Array(e.data));
```

React:

```jsx
import { RioTerminal } from 'react-rioterm';

<RioTerminal
  renderer="dom" // or "canvas"
  onData={(bytes) => socket.send(bytes)}
  onReady={(term) => term.write('welcome\r\n')}
/>;
```

## What the engine speaks

| sequence | feature |
| --- | --- |
| `CSI u` | kitty keyboard protocol |
| `ESC[38;2` | truecolor |
| `ESC[<m` | sgr mouse reporting (x10 fallback) |
| `ESC]52` | system clipboard |
| `ESC[?1049` | alternate screen (and alternate scroll) |
| `ESC[?2026` | synchronized output |
| `ESC[200~` | bracketed paste |
| `ESC]0;` | window titles |
| `ESC]9;4` | progress reports |

Selection is the engine's own model (simple, word, line, block),
painted by the renderer and copied on mouseup or cmd/ctrl+shift+c: no
fake DOM selection over a bitmap. Scrollback, dirty-row tracking, and
plain-text dumps come from librio's pulled render state.

Rendering is canvas or DOM per instance, same input and selection
behavior either way. The headless `Terminal` class runs without any DOM
at all: packed grid snapshots for your own renderer, or Node for tests.

## Building

The wasm binary is built from the Rio source tree by
`scripts/build-wasm.mjs`, pinned to the revision in `rio.rev`
(bump it deliberately). Requirements: Rust with the
`wasm32-unknown-unknown` target, and `wasm-pack`.

```sh
node scripts/build-wasm.mjs       # clones rio at the pinned rev
RIO=../rio node scripts/build-wasm.mjs  # or use a local checkout

npm install
npm run build                     # both packages
npm test                          # rioterm's vitest suite (runs the wasm in Node)
npm run dev                       # docs site + live demo
```

## Repository layout

```
packages/rioterm/        core package (TypeScript + wasm artifact)
packages/react-rioterm/  React wrapper
docs/                    landing page + demo (Vite, GitHub Pages)
scripts/build-wasm.mjs   rio checkout -> wasm-pack -> packages/rioterm/wasm
rio.rev                  pinned rio revision
```

## License

MIT.

The live demo additionally serves third-party binaries fetched at build
time: a Linux image built with [Buildroot](https://buildroot.org/)
(GPL; sources available there and via
[v86's image tooling](https://github.com/copy/v86/tree/master/tools/docker)),
[SeaBIOS](https://www.seabios.org/) (LGPL), and the
[sharrattj/bash](https://wasmer.io/sharrattj/bash) WASIX package.

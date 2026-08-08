# rioterm

[Rio](https://github.com/raphamorim/rio)'s Rust terminal core (librio),
compiled to WebAssembly, behind an xterm.js-shaped API. Real VT
semantics: the same engine Rio ships on desktop, not a reimplementation.

```sh
npm i rioterm --save
```

```js
import { open } from 'rioterm';

const { terminal } = await open(document.getElementById('term'), {
  renderer: 'canvas', // or 'dom'
});

// bytes the terminal wants delivered to your backend
terminal.onData((bytes) => socket.send(bytes));
// backend output to display
socket.onmessage = (e) => terminal.write(new Uint8Array(e.data));
```

There is no PTY in a browser, so the host owns the transport: a
WebSocket bridging a real shell, an ssh gateway, or an in-page program.

Beyond `open()`, the headless `Terminal` class exposes packed grid
snapshots (`snapshot()`), selection, scrollback, key encoding, and
plain-text dumps, so you can bring your own renderer.

Live demo and docs: https://raphamorim.github.io/riotermjs/

React component: [`react-rioterm`](https://www.npmjs.com/package/react-rioterm).

# react-rioterm

React component for [`rioterm`](https://www.npmjs.com/package/rioterm):
Rio's Rust terminal core in WebAssembly.

```sh
npm i react-rioterm rioterm --save
```

```jsx
import { RioTerminal } from 'react-rioterm';

<RioTerminal
  renderer="dom" // or "canvas" (default)
  onData={(bytes) => socket.send(bytes)}
  onReady={(term) => term.write('welcome\r\n')}
/>;
```

The `ref` handle exposes `write`, `input`, `paste`, `focus`, `resize`,
`getSelection`, and the underlying `Terminal`.

Live demo and docs: https://raphamorim.github.io/riotermjs/

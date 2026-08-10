// Standalone rioterm playground: a terminal wired to a *simulated* PTY that
// echoes keystrokes back after an adjustable latency. Lets us verify input
// delivery and predictive echo in isolation, with no backend/auth involved.
//
// Instrumented: on-screen counters for keydown / onData / write plus any
// thrown error, so we can locate where the input chain breaks without the
// console. Key signal: if keydowns climb but onData stays 0, something
// between the keypress and the send is throwing (the prediction listener
// runs before the input listener, so a throw there swallows the keystroke).

import { open, type RioTermHandle } from 'rioterm';

const TERM_FONT = "'Cascadia Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";

let handle: RioTermHandle | null = null;
let latency = 250;

let keydowns = 0;
let onDataEvents = 0;
let writes = 0;
let lastError = '';

const latencyEl = document.getElementById('latency') as HTMLInputElement;
const latencyVal = document.getElementById('latency-val')!;
const predictEl = document.getElementById('predict') as HTMLInputElement;
const statusEl = document.getElementById('status')!;

latencyEl.addEventListener('input', () => {
  latency = Number(latencyEl.value);
  latencyVal.textContent = `${latency} ms`;
});

predictEl.addEventListener('change', () => {
  try {
    handle?.setPredictiveEcho(predictEl.checked);
  } catch (e) {
    lastError = `setPredictiveEcho: ${String(e)}`;
  }
  render();
});

// Surface any uncaught error (e.g. a throw inside rioterm's onData listeners)
// on screen — a throw in the prediction feed would otherwise be invisible.
window.addEventListener('error', (e) => {
  lastError = `window.onerror: ${e.message}`;
  render();
});
window.addEventListener('unhandledrejection', (e) => {
  lastError = `unhandledrejection: ${String(e.reason)}`;
  render();
});

// Count real key presses reaching the page.
document.addEventListener('keydown', () => {
  keydowns++;
  render();
});

function render(): void {
  statusEl.textContent =
    `predict ${predictEl.checked ? 'on' : 'off'} · keydown ${keydowns} · onData ${onDataEvents} · write ${writes}` +
    (lastError ? ` · ERROR ${lastError}` : '');
}

function shellEcho(input: string): string {
  let out = '';
  for (const ch of input) {
    if (ch === '\r' || ch === '\n') out += '\r\n$ ';
    else if (ch === '\x7f' || ch === '\x08') out += '\b \b';
    else out += ch;
  }
  return out;
}

async function boot(): Promise<void> {
  handle = await open(document.getElementById('term')!, {
    renderer: 'canvas',
    fontFamily: TERM_FONT,
    fontSize: 14,
    scrollback: 1000,
    predictiveEcho: { latencyThreshold: 30, style: 'underline' },
  });

  const term = handle.terminal;
  const decoder = new TextDecoder();

  // The simulated PTY: echo keystrokes back after `latency` ms.
  term.onData((bytes) => {
    onDataEvents++;
    render();
    const text = shellEcho(decoder.decode(bytes));
    const delay = latency;
    window.setTimeout(() => {
      writes++;
      term.write(text);
      render();
    }, delay);
  });

  term.write('rio predictive-echo playground (simulated PTY)\r\n$ ');
  handle.focus();
  render();
}

void boot();

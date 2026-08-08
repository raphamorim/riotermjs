import { open, type RioTermHandle } from 'rioterm';
import { unscramble } from './unscramble.js';
import type { LinuxSession } from './linux-vm.js';
import { BashSession } from './wasmer-shell.js';

type Renderer = 'canvas' | 'dom';
type Program = 'bash' | 'linux';

export const TERM_FONT = '"Cascadia Mono", ui-monospace, Menlo, Consolas, monospace';

// bash (wasix) needs SharedArrayBuffer; without cross-origin isolation
// (plain GitHub Pages) only the linux snapshot runs.
const bashAvailable = BashSession.supported();

const state: { renderer: Renderer; program: Program } = {
  renderer: 'canvas',
  program: bashAvailable ? 'bash' : 'linux',
};

let hero: RioTermHandle | undefined;
let linux: LinuxSession | undefined;
let bash: BashSession | undefined;

// The terminal pane only exists on desktop; on narrow screens it is
// display:none and no session ever starts.
const desktop = window.matchMedia('(min-width: 981px)');

// Mounting is async (font load, wasm init); a toggle clicked mid-mount
// must not race the mount already in flight, so calls are serialized.
let mountQueue: Promise<void> = Promise.resolve();

function mountHero(): Promise<void> {
  mountQueue = mountQueue.then(doMountHero, doMountHero);
  return mountQueue;
}

async function doMountHero(): Promise<void> {
  // The canvas renderer measures cell metrics at mount; the font must be
  // resident first or every cell inherits fallback-font widths.
  await document.fonts.load('14px "Cascadia Mono"').catch(() => {});
  hero?.dispose();
  linux?.detach();
  bash?.detach();
  hero = await open(document.getElementById('hero-term')!, {
    renderer: state.renderer,
    scrollback: 2000,
    fontFamily: TERM_FONT,
    fontSize: 14,
    autoFocus: false,
    // WASIX bash writes bare LF (no PTY line discipline doing ONLCR);
    // the v86 serial console is a real tty and sends CRLF itself.
    convertEol: state.program === 'bash',
  });
  hero.terminal.onTitleChange((title) => {
    const el = document.getElementById('fig-title');
    if (el) el.textContent = title || 'rio terminal emulator';
  });

  if (state.program === 'bash') {
    if (!bash) {
      hero.terminal.write('\x1b[2mstarting bash (wasix)...\x1b[0m\r\n');
      bash = new BashSession();
      void bash.start(import.meta.env.BASE_URL);
    }
    bash.attach(hero.terminal);
  } else {
    if (!linux) {
      hero.terminal.write('\x1b[2mrestoring linux snapshot...\x1b[0m\r\n');
      // v86 and its wasm load after first paint.
      const { LinuxSession } = await import('./linux-vm.js');
      linux = new LinuxSession(import.meta.env.BASE_URL);
    }
    linux.attach(hero.terminal);
  }
  updateStatus();
}

function updateStatus(): void {
  const el = document.getElementById('fig-status');
  if (!el || !hero) return;
  const { cols, rows } = hero.terminal.options;
  const engine = state.program === 'bash' ? 'librio wasm + wasix' : 'librio wasm + v86';
  el.textContent = `${engine} · ${state.renderer} · ${cols}x${rows}`;
}

setInterval(updateStatus, 2000);

function wireToggle(id: string, apply: (value: string) => void): void {
  document.getElementById(id)!.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('button');
    if (!button || button.disabled || button.classList.contains('active')) return;
    for (const b of button.parentElement!.querySelectorAll('button')) {
      b.classList.toggle('active', b === button);
    }
    apply(button.dataset.value!);
  });
}

wireToggle('program-toggle', (value) => {
  state.program = value as Program;
  void mountHero().then(() => hero?.focus());
});

wireToggle('renderer-toggle', (value) => {
  state.renderer = value as Renderer;
  void mountHero().then(() => hero?.focus());
});

if (!bashAvailable) {
  const toggle = document.getElementById('program-toggle')!;
  const bashButton = toggle.querySelector<HTMLButtonElement>('[data-value="bash"]')!;
  const linuxButton = toggle.querySelector<HTMLButtonElement>('[data-value="linux"]')!;
  bashButton.disabled = true;
  bashButton.classList.remove('active');
  bashButton.title = 'needs cross-origin isolation (COOP/COEP headers)';
  linuxButton.classList.add('active');
}

for (const button of document.querySelectorAll<HTMLElement>('[data-copy]')) {
  button.addEventListener('click', () => {
    void navigator.clipboard.writeText(button.dataset.copy!).then(() => {
      const label = button.textContent;
      button.textContent = 'copied';
      setTimeout(() => (button.textContent = label), 1200);
    });
  });
}

// Section headings unscramble into place on load.
unscramble(document.body);

if (desktop.matches) void mountHero();
desktop.addEventListener('change', (e) => {
  if (e.matches && !hero) void mountHero();
});

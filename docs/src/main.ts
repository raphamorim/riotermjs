import { open, type RioTermHandle } from 'rioterm';
import { unscramble } from './unscramble.js';
import type { LinuxSession } from './linux-vm.js';

type Renderer = 'canvas' | 'dom';

export const TERM_FONT = '"Cascadia Mono", ui-monospace, Menlo, Consolas, monospace';

const state: { renderer: Renderer } = { renderer: 'canvas' };

let hero: RioTermHandle | undefined;
let linux: LinuxSession | undefined;

// The terminal pane only exists on desktop; on narrow screens it is
// display:none and the VM never boots (no point downloading a kernel a
// hidden pane would run).
const desktop = window.matchMedia('(min-width: 981px)');

async function mountHero(): Promise<void> {
  // The canvas renderer measures cell metrics at mount; the font must be
  // resident first or every cell inherits fallback-font widths.
  await document.fonts.load('14px "Cascadia Mono"').catch(() => {});
  hero?.dispose();
  linux?.detach();
  hero = await open(document.getElementById('hero-term')!, {
    renderer: state.renderer,
    scrollback: 2000,
    fontFamily: TERM_FONT,
    fontSize: 14,
    autoFocus: false,
  });
  hero.terminal.onTitleChange((title) => {
    const el = document.getElementById('fig-title');
    if (el) el.textContent = title || 'rio terminal emulator';
  });

  if (!linux) {
    hero.terminal.write(
      '\x1b[2mfetching kernel image (~10MB) and booting linux via v86...\x1b[0m\r\n\r\n',
    );
    // v86 and its wasm load after first paint.
    const { LinuxSession } = await import('./linux-vm.js');
    linux = new LinuxSession(import.meta.env.BASE_URL);
  }
  linux.attach(hero.terminal);
  updateStatus();
}

function updateStatus(): void {
  const el = document.getElementById('fig-status');
  if (!el || !hero) return;
  const { cols, rows } = hero.terminal.options;
  el.textContent = `librio wasm + v86 · ${state.renderer} · ${cols}x${rows}`;
}

setInterval(updateStatus, 2000);

document.getElementById('renderer-toggle')!.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest('button');
  if (!button || button.classList.contains('active')) return;
  for (const b of button.parentElement!.querySelectorAll('button')) {
    b.classList.toggle('active', b === button);
  }
  state.renderer = button.dataset.value as Renderer;
  void mountHero().then(() => hero?.focus());
});

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

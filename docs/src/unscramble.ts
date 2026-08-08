// Text unscramble: every [data-flap] element spins its characters and
// settles onto the target text, staggered left to right. Pure DOM.

const CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789·-/:.';

function spin(span: HTMLElement, target: string, delay: number): void {
  const settleAt = delay + 4 + Math.floor(Math.random() * 6);
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    if (tick < delay) return;
    if (tick >= settleAt) {
      span.textContent = target;
      clearInterval(timer);
      return;
    }
    span.textContent = CHARS[Math.floor(Math.random() * CHARS.length)];
  }, 45);
}

export function unscramble(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-flap]')) {
    const text = el.dataset.flap ?? '';
    el.textContent = '';
    el.setAttribute('aria-label', text.trim());
    [...text].forEach((ch, i) => {
      const span = document.createElement('span');
      span.setAttribute('aria-hidden', 'true');
      if (ch === ' ') {
        span.textContent = ' ';
        el.appendChild(span);
        return;
      }
      span.textContent = CHARS[Math.floor(Math.random() * CHARS.length)];
      el.appendChild(span);
      spin(span, ch, i);
    });
  }
}

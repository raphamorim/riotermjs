// Shared workload generators. Deterministic on purpose: both engines see
// byte-identical input, and reruns are comparable.

const encoder = new TextEncoder();

/** Plain scrolling text, ~64KB chunks. */
export function plainChunks(totalBytes) {
  const line =
    'the quick brown fox jumps over the lazy dog 0123456789 lorem ipsum dolor sit amet consetetur\r\n';
  const chunk = encoder.encode(line.repeat(Math.ceil(65536 / line.length)));
  const chunks = [];
  let bytes = 0;
  while (bytes < totalBytes) {
    chunks.push(chunk);
    bytes += chunk.length;
  }
  return { chunks, bytes };
}

/** SGR-heavy scrolling text: 256-color + truecolor + styles per word. */
export function ansiChunks(totalBytes) {
  let line = '';
  for (let i = 0; i < 10; i++) {
    line += `\x1b[38;5;${(i * 37) % 256}m\x1b[48;5;${(i * 53 + 8) % 256}mword${i}\x1b[0m `;
    line += `\x1b[1;38;2;${(i * 31) % 256};${(i * 67) % 256};${(i * 13) % 256}mbold\x1b[0m `;
    line += i % 2 ? '\x1b[3mital\x1b[0m ' : '\x1b[4munder\x1b[0m ';
  }
  line += '\r\n';
  const chunk = encoder.encode(line.repeat(Math.ceil(65536 / line.length)));
  const chunks = [];
  let bytes = 0;
  while (bytes < totalBytes) {
    chunks.push(chunk);
    bytes += chunk.length;
  }
  return { chunks, bytes };
}

/** One full-screen redraw frame, top/htop style, colors shift per frame. */
export function altScreenFrame(cols, rows, frame) {
  let out = '\x1b[H';
  for (let r = 0; r < rows; r++) {
    const color = 16 + ((r * 7 + frame) % 216);
    out += `\x1b[K\x1b[38;5;${color}mrow${String(r).padStart(3, '0')} `;
    const width = cols - 8;
    for (let c = 0; c < width; c++) {
      out += String.fromCharCode(33 + ((c + frame + r) % 93));
    }
    out += '\x1b[0m\r\n';
  }
  return encoder.encode(out);
}

export const ALT_ENTER = encoder.encode('\x1b[?1049h\x1b[?25l');
export const ALT_LEAVE = encoder.encode('\x1b[?1049l\x1b[?25h');

// Boots the Buildroot image once under Node and saves a v86 state
// snapshot, so the site restores a live shell instantly instead of
// booting the kernel in the visitor's tab. Output is zstd-compressed
// (v86 detects and decompresses zstd states natively, the same format
// copy.sh serves).

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync, constants as zconst } from 'node:zlib';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'docs', 'public', 'v86');
const out = join(assets, 'v86state.bin.zst');

if (existsSync(out) && statSync(out).size > 0) {
  console.log('have v86state.bin.zst');
  process.exit(0);
}

const kernel = join(root, '.v86-cache', 'buildroot-bzimage68.bin');
for (const need of [join(assets, 'seabios.bin'), join(assets, 'vgabios.bin'), kernel]) {
  if (!existsSync(need)) {
    console.error(`missing ${need}; run scripts/fetch-linux-image.mjs first`);
    process.exit(1);
  }
}

const require = createRequire(import.meta.url);
const { V86 } = require('v86');

const emulator = new V86({
  wasm_path: require.resolve('v86/build/v86.wasm'),
  memory_size: 128 * 1024 * 1024,
  vga_memory_size: 2 * 1024 * 1024,
  bios: { url: join(assets, 'seabios.bin') },
  vga_bios: { url: join(assets, 'vgabios.bin') },
  bzimage: { url: kernel },
  cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0',
  autostart: true,
  disable_speaker: true,
});

let serial = '';
emulator.add_listener('serial0-output-byte', (byte) => {
  serial += String.fromCharCode(byte);
  if (serial.length > 65536) serial = serial.slice(-32768);
});

console.log('booting buildroot under node (this takes a bit) ...');
const deadline = Date.now() + 300_000;
const prompt = /(~%|#|\$) $/;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let booted = false;
while (Date.now() < deadline) {
  await wait(500);
  // Strip ANSI so cursor/color codes near the prompt don't hide it.
  const tail = serial.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
  if (prompt.test(tail + ' ') || prompt.test(serial.slice(-6))) {
    booted = true;
    break;
  }
}
if (!booted) {
  console.error('no shell prompt after 5 minutes; last serial output:');
  console.error(serial.slice(-600));
  process.exit(1);
}

// Let the system go quiet, then snapshot.
await wait(2000);
const state = await emulator.save_state();
emulator.destroy();

const raw = Buffer.from(state);
const compressed = zstdCompressSync(raw, {
  params: { [zconst.ZSTD_c_compressionLevel]: 19 },
});
writeFileSync(out, compressed);
console.log(
  `state: ${(raw.length / 1024 / 1024).toFixed(1)}MB raw -> ${(compressed.length / 1024 / 1024).toFixed(1)}MB zstd`,
);
process.exit(0);

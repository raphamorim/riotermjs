// Fetches the assets the docs' "linux" demo tab boots with: a Buildroot
// kernel image from copy.sh (the v86 project's own image host) and the
// SeaBIOS/VGABIOS blobs from the v86 repository. Cached in docs/public/v86
// (gitignored) so dev, build, and CI all serve them same-origin instead of
// hotlinking copy.sh from the published site.

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'public', 'v86');
mkdirSync(out, { recursive: true });

const ASSETS = [
  ['buildroot-bzimage68.bin', 'https://i.copy.sh/buildroot-bzimage68.bin'],
  ['seabios.bin', 'https://cdn.jsdelivr.net/gh/copy/v86@master/bios/seabios.bin'],
  ['vgabios.bin', 'https://cdn.jsdelivr.net/gh/copy/v86@master/bios/vgabios.bin'],
];

for (const [name, url] of ASSETS) {
  const path = join(out, name);
  if (existsSync(path) && statSync(path).size > 0) {
    console.log(`have ${name}`);
    continue;
  }
  console.log(`fetching ${name} ...`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    console.error(`failed to fetch ${url}: ${res.status}`);
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
  console.log(`  ${name}: ${(statSync(path).size / 1024 / 1024).toFixed(1)}MB`);
}
console.log('linux demo assets ready');

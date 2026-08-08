// Downloads the sharrattj/bash webc package from the wasmer registry into
// docs/public/wasmer, so the site loads it same-origin instead of hitting
// the registry from every visitor's cold cache.

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'public',
  'wasmer',
);
mkdirSync(out, { recursive: true });
const path = join(out, 'bash.webc');

if (existsSync(path) && statSync(path).size > 0) {
  console.log('have bash.webc');
  process.exit(0);
}

const query =
  'query { getPackage(name: "sharrattj/bash") { lastVersion { version distribution { downloadUrl } } } }';
const gql = await fetch('https://registry.wasmer.io/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
});
const meta = await gql.json();
const { version, distribution } = meta.data.getPackage.lastVersion;
console.log(`fetching sharrattj/bash ${version} ...`);

const res = await fetch(distribution.downloadUrl);
if (!res.ok || !res.body) {
  console.error(`failed: ${res.status}`);
  process.exit(1);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
console.log(`  bash.webc: ${(statSync(path).size / 1024 / 1024).toFixed(1)}MB`);

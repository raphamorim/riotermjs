// Builds librio-wasm from the Rio source tree and drops the wasm-bindgen
// output into packages/rioterm/wasm (web target, what the package ships)
// and packages/rioterm/wasm-node (nodejs target, used only by vitest).
//
// Rio comes from, in order:
//   1. $RIO - path to a local checkout (day-to-day development)
//   2. .rio-cache/ - a shallow clone of raphamorim/rio pinned to ./rio.rev
//
// The pin in rio.rev is bumped deliberately, canario-style: a change
// upstream cannot land in a rioterm release without being chosen.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rev = readFileSync(join(root, 'rio.rev'), 'utf8').trim();

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });

let rio = process.env.RIO;
if (rio) {
  rio = resolve(rio);
  console.log(`using local rio checkout: ${rio}`);
} else {
  rio = join(root, '.rio-cache');
  if (!existsSync(join(rio, 'Cargo.toml'))) {
    console.log(`cloning rio @ ${rev} into .rio-cache ...`);
    rmSync(rio, { recursive: true, force: true });
    run('git', ['init', '-q', rio]);
    run('git', ['-C', rio, 'remote', 'add', 'origin', 'https://github.com/raphamorim/rio.git']);
    run('git', ['-C', rio, 'fetch', '-q', '--depth', '1', 'origin', rev]);
    run('git', ['-C', rio, 'checkout', '-q', 'FETCH_HEAD']);
  } else {
    const head = execFileSync('git', ['-C', rio, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== rev) {
      console.log(`updating .rio-cache to ${rev} ...`);
      run('git', ['-C', rio, 'fetch', '-q', '--depth', '1', 'origin', rev]);
      run('git', ['-C', rio, 'checkout', '-q', 'FETCH_HEAD']);
    }
  }
}

const crate = join(rio, 'librio-wasm');
if (!existsSync(join(crate, 'Cargo.toml'))) {
  console.error(`no librio-wasm crate at ${crate}; is the rio checkout/pin recent enough?`);
  process.exit(1);
}

const pkg = join(root, 'packages', 'rioterm');

for (const [target, outName] of [
  ['web', 'wasm'],
  ['nodejs', 'wasm-node'],
]) {
  const out = join(pkg, outName);
  console.log(`wasm-pack build (--target ${target}) -> ${out}`);
  rmSync(out, { recursive: true, force: true });
  run('wasm-pack', ['build', crate, '--release', '--target', target, '--out-dir', out, '--out-name', 'librio_wasm'], {
    env: { ...process.env },
  });
  // wasm-pack emits an npm package; the glue is consumed as plain files
  // inside the rioterm package, so drop the packaging extras.
  for (const junk of ['package.json', '.gitignore', 'README.md', 'LICENSE']) {
    rmSync(join(out, junk), { force: true });
  }
}

console.log('wasm build done');

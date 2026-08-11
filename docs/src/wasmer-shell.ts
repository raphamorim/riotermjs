// A real bash, instantly: sharrattj/bash from the Wasmer registry running
// under WASIX in the browser. Needs cross-origin isolation (COOP/COEP
// headers) for SharedArrayBuffer; docs/public/_headers provides them on
// Cloudflare Pages and oj sets them in dev/preview. Where isolation is
// missing (plain GitHub Pages) the program toggle falls back to Linux.

import type { Terminal } from 'rioterm';

const MAX_REPLAY = 256 * 1024;

export class BashSession {
  private terminal: Terminal | null = null;
  private subscription: { dispose(): void } | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private replay: Uint8Array[] = [];
  private replayLen = 0;
  private started = false;

  static supported(): boolean {
    return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  }

  async start(base: string): Promise<void> {
    if (this.started) return;
    this.started = true;

    const { init, Wasmer } = await import('@wasmer/sdk');
    // The package is self-hosted (scripts/fetch-bash-webc.mjs); loading it
    // in parallel with the runtime init keeps cold starts short.
    const [webc] = await Promise.all([
      fetch(`${base}wasmer/bash.webc`).then((r) => r.arrayBuffer()),
      init(),
    ]);
    const pkg = await Wasmer.fromFile(new Uint8Array(webc));
    const instance = await pkg.entrypoint!.run({
      env: { TERM: 'xterm-256color', HOME: '/home', PS1: '\\w $ ' },
    });

    this.writer = instance.stdin!.getWriter();
    const pump = (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const loop = (): void => {
        reader
          .read()
          .then(({ value, done }) => {
            if (done || !value) return;
            this.remember(value);
            this.terminal?.write(value);
            loop();
          })
          .catch(() => {});
      };
      loop();
    };
    pump(instance.stdout);
    pump(instance.stderr);
  }

  private remember(bytes: Uint8Array): void {
    this.replay.push(bytes);
    this.replayLen += bytes.length;
    while (this.replayLen > MAX_REPLAY && this.replay.length > 1) {
      this.replayLen -= this.replay.shift()!.length;
    }
  }

  attach(terminal: Terminal): void {
    this.detach();
    this.terminal = terminal;
    for (const chunk of this.replay) terminal.write(chunk);
    this.subscription = terminal.onData((bytes) => {
      void this.writer?.write(bytes.slice());
    });
  }

  detach(): void {
    this.subscription?.dispose();
    this.subscription = null;
    this.terminal = null;
  }
}

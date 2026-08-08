// Real Linux behind the terminal: v86 (x86-to-wasm JIT) boots a Buildroot
// image with its console on the emulated serial port, and the serial port
// is wired to rioterm exactly like any other backend: onData in,
// terminal.write out. No server, no SharedArrayBuffer requirements.

import type { Terminal } from 'rioterm';
// @ts-expect-error the v86 package ships no type for the ?url asset import
import v86WasmUrl from 'v86/build/v86.wasm?url';
import { V86 } from 'v86';

const MAX_REPLAY = 256 * 1024;

/**
 * Owns the emulator, which outlives terminal instances: the renderer
 * toggle swaps terminals while Linux keeps running, so recent serial
 * output is buffered and replayed onto the next terminal.
 */
export class LinuxSession {
  private emulator: V86;
  private terminal: Terminal | null = null;
  private replay: number[] = [];
  private subscription: { dispose(): void } | null = null;
  private pending: number[] = [];
  private flushTimer = 0;

  constructor(base: string) {
    this.emulator = new V86({
      wasm_path: v86WasmUrl,
      memory_size: 128 * 1024 * 1024,
      vga_memory_size: 2 * 1024 * 1024,
      bios: { url: `${base}v86/seabios.bin` },
      vga_bios: { url: `${base}v86/vgabios.bin` },
      bzimage: { url: `${base}v86/buildroot-bzimage68.bin` },
      // The same cmdline v86's own tests boot buildroot with; console on
      // the serial port is what makes the shell appear here.
      cmdline:
        'tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0',
      autostart: true,
      disable_speaker: true,
    });

    this.emulator.add_listener('serial0-output-byte', (byte: number) => {
      this.replay.push(byte);
      if (this.replay.length > MAX_REPLAY) {
        this.replay.splice(0, this.replay.length - MAX_REPLAY);
      }
      // Batch per tick: byte-at-a-time writes would re-parse constantly.
      this.pending.push(byte);
      if (!this.flushTimer) {
        this.flushTimer = window.setTimeout(() => {
          this.flushTimer = 0;
          const bytes = new Uint8Array(this.pending);
          this.pending = [];
          this.terminal?.write(bytes);
        }, 0);
      }
    });
  }

  attach(terminal: Terminal): void {
    this.detach();
    this.terminal = terminal;
    if (this.replay.length) {
      terminal.write(new Uint8Array(this.replay));
    }
    this.subscription = terminal.onData((bytes) => {
      let chars = '';
      for (const byte of bytes) chars += String.fromCharCode(byte);
      this.emulator.serial0_send(chars);
    });
  }

  detach(): void {
    this.subscription?.dispose();
    this.subscription = null;
    this.terminal = null;
  }

  destroy(): void {
    this.detach();
    this.emulator.destroy();
  }
}

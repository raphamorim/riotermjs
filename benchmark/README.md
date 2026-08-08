# benchmark

rioterm vs xterm.js on byte-identical workloads. Standalone package: it
does not touch `packages/`; rioterm comes from `file:../packages/rioterm`
(build it first), xterm.js from npm with its WebGL addon (its fastest
renderer).

```sh
npm install
npm run bench        # browser matrix via your installed Chrome
npm run bench:parse  # parser-only, no DOM: @xterm/headless vs rioterm in Node
```

Both engines get a fixed 120x40 grid, the same font, the same chunked
input. Every scenario warms up first, then reports the median of three
runs. `results.json` gets the full numbers.

## Scenarios

- **plainThroughput / ansiThroughput**: MB/s from first byte submitted to
  everything parsed and a frame painted (8MB per run).
- **altScreenFps**: a TUI redrawing the whole screen every frame
  (top-style), frame submitted, parsed, painted; reports achieved fps and
  frame-time percentiles.
- **scrollbackScroll**: scrollback navigation with a full buffer.
- **init**: component creation to first rendered frame, fresh page.
- **node-parse**: pure VT engine cost, 32MB through each parser headless.

## Sample results

Apple Silicon, Chrome 143 headless, 2026-08. Medians; run your own.

| metric | xterm.js (webgl) | rioterm 0.1.0 (canvas) |
| --- | --- | --- |
| init | 41.1 ms | 21.6 ms |
| plain throughput | 179 MB/s | 657 MB/s |
| ansi throughput | 109 MB/s | 237 MB/s |
| altscreen fps | 119.9 (display-capped) | 119.9 (display-capped) |
| altscreen frame p95 | 9.4 ms | 8.9 ms |
| scrollback frame p95 | 9.1 ms | 8.9 ms |
| JS heap after plain 8MB | 31.2 MB | 4.4 MB |

Parser-only (Node, 32MB): plain 168 vs 1142 MB/s, ansi 100 vs 233 MB/s.

## Honest caveats

- rioterm's grid and scrollback live in wasm linear memory, which
  `performance.memory.usedJSHeapSize` does not count; the JS-heap row
  overstates rioterm's memory advantage. Wasm memory for this
  configuration is on the order of tens of MB.
- xterm's write path is asynchronous (internal parse queue); rioterm's is
  synchronous. Throughput runs measure submit-to-parsed-and-painted for
  both, which is the fair comparison, but per-call latency profiles
  differ by design.
- Both engines saturate the display refresh in the fps scenarios on this
  hardware; the differentiators there are the percentiles, not the fps.

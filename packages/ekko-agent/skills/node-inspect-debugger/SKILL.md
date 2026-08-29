---
name: node-inspect-debugger
description: Debug Node.js with node inspect, inspector attach, breakpoints, Chrome DevTools Protocol, heap snapshots, and CPU profiles.
metadata:
  keywords:
    - node inspect
    - node debugger
    - chrome devtools protocol
    - heap snapshot
---

# Node Inspect Debugger

Use when Node.js debugging requires hidden locals, async hangs, flaky tests, child processes, startup races, memory analysis, or CPU profiling.

Default to `node inspect` first. Use Chrome DevTools Protocol only for scripted breakpoints, automated state capture, heap snapshots, or CPU profiles.

## Quick start

```bash
node inspect path/to/script.js
node --inspect-brk --import tsx path/to/script.ts
kill -SIGUSR1 <pid>
node inspect -p <pid>
curl -s http://127.0.0.1:9229/json/list | jq
```

For a test runner such as Vitest, debug one file with one worker and avoid worker pools while stepping.

## Debugger REPL

- Continue and step: `cont`, `next`, `step`, `out`, `pause`.
- Breakpoints: `sb('file.js', 42)`, `sb(42)`, `sb('functionName')`, `breakpoints`, `cb('file.js', 42)`.
- Inspect: `bt`, `list(8)`, `watch('expr')`, `exec expr`.
- Current scope: enter `repl`, evaluate locals, then press `Ctrl+C` to exit REPL mode.
- Exit safely: use `cont` before quitting if the process should keep running; otherwise use `kill`.

## Safe setup

- Prefer `127.0.0.1` inspector binds. Do not expose `--inspect=0.0.0.0` unless the network is isolated.
- Use `--enable-source-maps` when TypeScript source breakpoints need it.
- `NODE_OPTIONS=--inspect-brk` can propagate the inspector to child processes, but each process needs a unique port.
- For a long-lived service, confirm the PID and `/json/list` target before attaching.

## Programmatic CDP

Install temporary tooling outside the project unless it is already a dependency:

```bash
mkdir -p /tmp/cdp-tools
npm --prefix /tmp/cdp-tools install chrome-remote-interface
NODE_PATH=/tmp/cdp-tools/node_modules node /tmp/cdp-debug.cjs
```

Minimal driver:

```js
const CDP = require("chrome-remote-interface");

(async () => {
  const client = await CDP({ port: 9229 });
  const { Debugger, Runtime } = client;

  Debugger.paused(async ({ callFrames, reason }) => {
    const top = callFrames[0];
    console.log("paused", reason, top.url, top.location.lineNumber + 1);
    const { result } = await Debugger.evaluateOnCallFrame({
      callFrameId: top.callFrameId,
      expression: "JSON.stringify({ pid: process.pid })",
    });
    console.log(result.value ?? result.description);
    await Debugger.resume();
  });

  await Runtime.enable();
  await Debugger.enable();
  await Debugger.setBreakpointByUrl({ urlRegex: ".*target\\.js$", lineNumber: 41 });
  await Runtime.runIfWaitingForDebugger();
})();
```

## Profiles

- CPU: enable `Profiler`, start, wait, stop, write a `.cpuprofile`, then open it in Chrome DevTools.
- Heap: enable `HeapProfiler`, collect `addHeapSnapshotChunk`, call `takeHeapSnapshot`, then write a `.heapsnapshot`.

## Pitfalls

- `--inspect` does not pause; use `--inspect-brk` when startup code matters.
- Port `9229` is the default; use `--inspect=0` or a unique port for parallel targets.
- If a breakpoint misses, confirm the path, source maps, and whether execution already passed the line.
- A process that appears frozen after detach may still be paused in the debugger.

# DSH M0 compatibility fixture

This opt-in experiment exercises the published DSH `0.1.5-rc.1` packages
against a loopback Responses server. It does not change the production runner,
load a user's DSH Home, use model credentials, or start the official Web UI.

From the repository root, install the separate fixture dependency graph:

```sh
cd tests/fixtures/dsh-m0/runtime
npm ci --ignore-scripts --no-audit --no-fund
cd ../../../..
npx cross-env DSH_M0_REAL=1 vitest run tests/server/dsh-m0-real.test.ts
```

`DSH_M0_RUNTIME` can instead point to a separately installed directory with the
exact same package-lock. `DSH_M0_EVIDENCE` optionally selects an existing parent
directory and output JSON file for source hashes, actual package versions,
composition omissions, assertions and timings. Neither environment variable
is consumed by production.

Normal unit tests skip the real experiment. Node must meet the repository's
engine requirement, and `git` must be on PATH to apply the build-time patch.
The fixture uses temporary Homes, loopback ports and only its own subprocesses;
cleanup awaits process exit before removing their state.

## Maintained adapter boundary

The official ACP package exports `apply`, `Config`, `inject`, and `name`.
Although its published type declarations describe `AcpSession`, that class
is not exported. Its factory setup also has no preset-selection hook.

`acp-rc1.patch` is an experimental, build-time fork of the published
`@deepseek-ai/dsh-acp/lib/index.js`. The test checks the original SHA-256 from
`upstream.json`, copies the module into a temporary directory, and applies the
patch there. It never rewrites the installed module, imports an unpublished
source subpath, or patches a live factory. Keep the upstream MIT notice in
`UPSTREAM-LICENSE` with any redistributed derivative.

The patch changes eight regions: creation metadata/setup, resume setup,
quiescent prompt flush, preset config, create arguments, resume mismatch
validation, resume arguments, and two private M0 observation methods. The
creation metadata and setup occupy one diff hunk. `_ekko/m0/*` is explicitly
experimental and is not a production or standard ACP API.

The prototype retains the upstream ACP prompt, cancellation, MCP, model and
output projection implementation. It does not implement the production
capability handshake, event generations, owner admission, resource limits,
browser authorization, or a general Web composition resolver.

The fixture retains Web's top-level agent-plane overrides and only the
`agent-presets` and `cordis-host-runner` inserted host entries. The evidence
lists every omitted Web entry. This deliberate minimum proves the two M0
seams; it does not claim that arbitrary Web configurations can be converted.

Before advancing a version, regenerate the separate lockfile, audit the
published exports, deliberately rebase the patch and rerun the experiment.
Changing only the `dsh` CLI version cannot establish compatibility: its
dependency ranges can resolve newer DSH service packages.

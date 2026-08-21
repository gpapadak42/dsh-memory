# Changelog

All notable changes to this project are documented in this file.

## [0.1.1] - 2026-08-21

### Fixed

- **Tool dispatch crash (`Cannot read properties of undefined (reading 'prepare')`).**

  **What was wrong:** the plugin declared `@deepseek-ai/dsh-tools@0.1.0-rc.6` and
  `@deepseek-ai/dsh-home-paths@0.1.0-rc.6` as regular `dependencies`, while the
  DeepSeek Harness runtime profile runs `0.1.1-rc.1` for every `@deepseek-ai`
  package. Installing the plugin with `dsh plugin add` made pnpm hoist a second,
  stale copy of `dsh-tools` into the profile's `node_modules`. The harness
  loader resolves the `tools` service from the profile directory, so
  `ctx.tools` became a `ToolRuntime` instance from the stale copy — whose
  module-local `TOOL_RUNTIME_SCHEDULER` symbol differs from the one
  `dsh-agent-loop` imports from the runtime copy. Every tool call (not just
  `memory_*`) then failed in the scheduler with `Cannot read properties of
  undefined (reading 'prepare')`, and the turn died without a tool result.

  **How it was fixed:** the `@deepseek-ai` runtime packages were moved from
  `dependencies` to `peerDependencies`, pinned to the runtime versions
  (`dsh-tools` / `dsh-home-paths` `0.1.1-rc.1`, `cordis` `4.0.1`,
  `schemastery` `3.18.1`). Profiles set `autoInstallPeers: false`, so the
  plugin no longer installs its own copies of runtime packages; it resolves
  them from the harness's shared flat fallback — the same single module
  instance the runtime itself uses. The scheduler symbol lookup matches again
  and tool dispatch works.

  **Upgrade path:** reinstall the bundle into the profile
  (`dsh plugin --profile <name> add github:gpapadak42/dsh-memory`) and restart
  the harness app. Version 0.1.0 installs are unaffected in storage — memory
  entries live in `~/.dsh/memory/` and carry over unchanged.

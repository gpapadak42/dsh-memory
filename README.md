# dsh-memory

Persistent cross-session memory for the DeepSeek Harness. A Cordis plugin
bundle that stores durable memory entries **outside the session log** — in a
plain JSONL file under your harness home — and makes them available to every
new session:

- **Injected into the system prompt**: a dynamic runtime-context contribution
  renders the most relevant recent entries into every model request, so a
  fresh session already knows what earlier sessions decided to remember.
- **Four tools** for the agent to manage the store:
  `memory_save`, `memory_recall`, `memory_update`, `memory_forget`.

## How it works

| Piece | Mechanism |
|---|---|
| Storage | `~/.dsh/memory/memory.jsonl` (`scope: global`, default) or `~/.dsh/memory/workspace-<hash>.jsonl` (`scope: workspace`, one store per workspace root). One JSON object per line; mutations rewrite the file atomically. |
| Injection | `ctx.systemPrompt.context({ name: "memory", ... })` — rendered into the "Current runtime context" snapshot on every request, with an empty render automatically dropped. |
| Tools | `ctx.tools.register(defineTool({...}))` on the shared tool registry, so the tools appear in every agent (including subagents). |
| Scope | `global` shares one memory across all sessions and workspaces on the machine; `workspace` keys the store by `process.cwd()` at boot. |

## Install

Any profile installs the plugin by package reference — no checkout needed:

**From GitHub (public repo, works today):**

```sh
dsh plugin --profile <name> add github:gpapadak42/dsh-memory
```

**From npm (once `@gpapadak42/dsh-memory` is published):**

```sh
dsh plugin --profile <name> add @gpapadak42/dsh-memory
```

`dsh plugin` runs pnpm in the profile directory and reconciles the profile's
`dsh.profile.bundles` layer list: because the package declares
`dsh.bundle.patch`, it joins the layer stack automatically. Then **restart the
harness app for that profile**; the memory context and the four `memory_*`
tools go live.

## Install from this checkout (development)

The plugin is installed as a **linked** dependency, so edits under the plugin
checkout are live (no reinstall needed to iterate):

```sh
# 1. Install the plugin's own dependencies (once):
cd E:\Deepseek\dsh-memory && pnpm install

# 2. Link it into the web profile from anywhere:
dsh plugin --profile web add link:E:/Deepseek/dsh-memory
```

- `dsh plugin` forwards to pnpm in the profile directory, then reconciles the
  profile's `dsh.profile.bundles` layer list — the package declares
  `dsh.bundle.patch`, so it joins the layer stack automatically.
- A `link:` dependency keeps one live copy: edit
  `E:\Deepseek\dsh-memory\lib\index.js`, and the next harness restart picks it
  up. (A `file:` dependency would copy the package instead.)

Then **restart the harness web app** (`dsh web`) so the new bundle is loaded.
After restart, the memory context and the four `memory_*` tools are live.

## Override configuration

Defaults are set in the bundle's `cordis.patch.yml` (row id `memory`) and in
the plugin's own `Config`. To override, add a config-replacing row to the
profile's `cordis.patch.yml`:

```yaml
- memory:
    scope: workspace
    maxInjectedMemories: 10
```

Since a patch replaces the row's whole config, restate any field you keep.

| Config | Default | Meaning |
|---|---|---|
| `scope` | `global` | `global` (one store for the machine) or `workspace` (per workspace root). |
| `storageRoot` | `~/.dsh/memory` | Directory holding the JSONL store. |
| `workspaceRoot` | `process.cwd()` | Root used to key a workspace-scoped store. |
| `maxInjectedMemories` | `20` | Max entries shown in the system-prompt context. |
| `maxRecallResults` | `10` | Max results returned by `memory_recall`. |
| `maxMemoryBytes` | `4000` | Per-entry byte cap enforced by save/update. |
| `injectContext` | `true` | Set `false` to disable prompt injection (tools only). |
| `contextOrder` | `1000` | Sort order of the memory context among runtime contexts. |

## Behavior notes

- The injected context is relevance-ranked against the newest user message of
  the current turn (simple term overlap), with recency as tiebreak; with no
  user message yet it shows the most recent entries.
- The store tolerates corrupt lines (they are skipped, not fatal) and a
  missing file (treated as empty).
- Memory is plain text — treat it as you would any durable file. The file
  lives at `~/.dsh/memory/` and can be edited by hand; ids are stable.

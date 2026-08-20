import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Persistent cross-session memory for the DeepSeek Harness.
 *
 * A Cordis plugin bundle (`dsh-memory`) that keeps a small durable store of
 * free-text memory entries OUTSIDE the append-only session log, so facts
 * survive session restarts:
 *
 * - storage: one JSONL file per store under `~/.dsh/memory/` (global scope,
 *   the default) or per workspace root (`scope: workspace`). Reads are cached
 *   in memory; mutations rewrite the file atomically.
 * - system prompt: a dynamic runtime-context contribution (`memory`) renders
 *   the most relevant recent entries into every model request, so each new
 *   session starts with what earlier sessions decided to remember.
 * - tools: `memory_save`, `memory_recall`, `memory_update`, `memory_forget`
 *   let the agent manage the store.
 *
 * @module dsh-memory
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = "memory";

/** Services this row must wait for before mounting. */
export const inject = ["tools", "systemPrompt"];

/** Deployment configuration for the memory row. */
export const Config = z.object({
  scope: z.union([z.const("global"), z.const("workspace")]).default("global"),
  storageRoot: z.string().default(void 0),
  workspaceRoot: z.string().default(void 0),
  maxInjectedMemories: z.number().min(1).max(500).default(20),
  maxRecallResults: z.number().min(1).max(200).default(10),
  maxMemoryBytes: z.number().min(1).max(100000).default(4000),
  injectContext: z.boolean().default(true),
  contextOrder: z.number().default(1000)
});

/** Words too common to make a query discriminating. */
const STOPWORDS = new Set([
  "about", "after", "again", "also", "are", "been", "before", "being",
  "between", "both", "but", "can", "could", "did", "does", "doing", "down",
  "during", "each", "for", "from", "further", "had", "has", "have", "having",
  "here", "how", "into", "just", "more", "most", "much", "not", "now", "only",
  "other", "our", "ours", "out", "over", "same", "should", "some", "such",
  "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "those", "through", "under", "very", "was", "were", "what", "when",
  "where", "which", "while", "who", "why", "will", "with", "would", "your",
  "yours", "youre", "dont", "cant", "wont", "about", "have", "what", "with"
]);

/**
 * Tokenize free text into distinct, meaningful lowercase terms. Terms shorter
 * than four characters and stop words are dropped; results are deduplicated.
 * @param text - the text to tokenize.
 * @returns the distinct query terms.
 */
function tokenize(text) {
  if (typeof text !== "string") return [];
  const terms = new Set();
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 4 && !STOPWORDS.has(token)) terms.add(token);
  }
  return [...terms];
}

/**
 * Score one entry against query terms: one point per term contained in the
 * entry text or tags.
 * @param entry - the stored entry.
 * @param terms - tokenized query terms.
 * @returns the overlap count.
 */
function scoreEntry(entry, terms) {
  const haystack = `${entry.text} ${(entry.tags ?? []).join(" ")}`.toLowerCase();
  return terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
}

/** Extract the newest non-empty user message text from an agent session. */
function lastUserText(agent) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return "";
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== "user/message") continue;
    const content = event.data?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join(" ")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

/**
 * One persisted memory entry. Stored as a JSON object per line.
 * @typedef {{ id: string, text: string, tags: string[], createdAt: string, updatedAt: string }} MemoryEntry
 */

/**
 * Durable JSONL-backed memory store with an in-memory cache.
 *
 * Reads are idempotent and cached (`ensureLoaded`); mutations run through a
 * serialized write chain so concurrent tool calls cannot interleave file
 * rewrites. Every mutation rewrites the whole file atomically (tmp + rename),
 * which keeps update/forget consistent at the tiny scale these stores reach.
 */
class MemoryStore {
  /**
   * @param storageRoot - absolute directory holding store files.
   * @param scope - `global` (one file) or `workspace` (per workspace root).
   * @param workspaceRoot - absolute workspace root used to key workspace stores.
   */
  constructor({ storageRoot, scope, workspaceRoot }) {
    const file =
      scope === "workspace"
        ? join(storageRoot, `workspace-${createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 12)}.jsonl`)
        : join(storageRoot, "memory.jsonl");
    this.file = file;
    this.map = new Map();
    this.loadPromise = null;
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  /** Load the store file once; concurrent and repeated calls share one read. */
  ensureLoaded() {
    if (this.loadPromise === null) this.loadPromise = this.#load();
    return this.loadPromise;
  }

  async #load() {
    let raw;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.loaded = true;
      return;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.id === "string" && typeof entry?.text === "string") {
          this.map.set(entry.id, {
            id: entry.id,
            text: entry.text,
            tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === "string") : [],
            createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
            updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null
          });
        }
      } catch {
        // Tolerate a corrupt line rather than failing the whole session.
      }
    }
    this.loaded = true;
  }

  /** Rewrite the store file atomically from the in-memory cache. */
  async #persist() {
    const lines = [...this.map.values()]
      .sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""))
      .map((entry) => JSON.stringify(entry));
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
    await rename(tmp, this.file);
  }

  /**
   * Run a mutation through the serialized write chain: wait for prior writes,
   * ensure the store is loaded, apply `mutate` (which returns `null` when the
   * entry was not found and nothing changed), then persist.
   * @param mutate - mutating closure over the in-memory cache.
   * @returns the mutation result (entry, removal result, or null).
   */
  #serialize(mutate) {
    const run = this.writeChain.then(async () => {
      await this.ensureLoaded();
      const result = mutate();
      if (result !== null) await this.#persist();
      return result;
    });
    // Keep the chain alive even when a mutation rejects.
    this.writeChain = run.catch(() => {});
    return run;
  }

  /**
   * Create a new entry.
   * @param input - `text` (required) and optional `tags`.
   * @returns the stored entry.
   */
  async save({ text, tags }) {
    const trimmed = text.trim();
    const now = new Date().toISOString();
    return this.#serialize(() => {
      const entry = {
        id: randomUUID(),
        text: trimmed,
        tags: [...new Set((tags ?? []).map((tag) => String(tag).trim()).filter(Boolean))],
        createdAt: now,
        updatedAt: now
      };
      this.map.set(entry.id, entry);
      return entry;
    });
  }

  /**
   * Replace the fields supplied on an existing entry and bump `updatedAt`.
   * @param id - the entry id.
   * @param patch - optional new `text` and/or `tags`.
   * @returns the updated entry, or null when the id is unknown.
   */
  async update(id, patch) {
    return this.#serialize(() => {
      const entry = this.map.get(id);
      if (entry === undefined) return null;
      const { text, tags } = patch ?? {};
      if (typeof text === "string" && text.trim() !== "") entry.text = text.trim();
      if (tags !== undefined) {
        entry.tags = [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))];
      }
      entry.updatedAt = new Date().toISOString();
      return entry;
    });
  }

  /**
   * Delete an entry by id.
   * @param id - the entry id.
   * @returns `{ id, removed: true }`, or null when the id is unknown.
   */
  async forget(id) {
    return this.#serialize(() => {
      if (!this.map.delete(id)) return null;
      return { id, removed: true };
    });
  }

  /**
   * Search entries by query terms, most relevant first, recency as tiebreak.
   * An empty query returns the most recently updated entries.
   * @param query - free-text search; terms are tokenized and matched.
   * @param limit - maximum number of results.
   * @returns the matched entries.
   */
  async recall(query, limit) {
    await this.ensureLoaded();
    const terms = tokenize(query);
    return [...this.map.values()]
      .map((entry) => ({ entry, score: terms.length === 0 ? 0 : scoreEntry(entry, terms) }))
      .sort((a, b) => b.score - a.score || (b.entry.updatedAt ?? "").localeCompare(a.entry.updatedAt ?? ""))
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  /** All entries, most recently updated first. */
  async entries() {
    await this.ensureLoaded();
    return [...this.map.values()].sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  /**
   * Synchronous snapshot of the cached entries, newest first. Empty until the
   * store has loaded; used by the synchronous system-prompt render path.
   * @returns the cached entries.
   */
  snapshot() {
    return [...this.map.values()].sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }
}

/**
 * Render the injected memory context for one prompt assembly. Synchronous by
 * contract (context text functions are evaluated synchronously during
 * assembly), so it renders from the cached store and returns `''` until the
 * store has loaded or when there is nothing to show; an empty string drops
 * the context from the snapshot.
 * @param store - the memory store.
 * @param assembleContext - the assembly context (`{ agent, scope, signal }`).
 * @param maxEntries - how many entries to show.
 * @returns the rendered context text, or `''` to drop it.
 */
function renderMemoryContext(store, assembleContext, maxEntries) {
  if (!store.loaded) return "";
  let ranked;
  try {
    const terms = tokenize(lastUserText(assembleContext?.agent));
    ranked = store.snapshot()
      .map((entry) => ({ entry, score: terms.length === 0 ? 0 : scoreEntry(entry, terms) }))
      .sort((a, b) => b.score - a.score || (b.entry.updatedAt ?? "").localeCompare(a.entry.updatedAt ?? ""));
  } catch {
    return "";
  }
  const shown = ranked.slice(0, maxEntries).map(({ entry }) => entry);
  if (shown.length === 0) return "";
  const lines = shown.map((entry) => {
    const tags = entry.tags.length > 0 ? ` (tags: ${entry.tags.join(", ")})` : "";
    const when = entry.updatedAt ? ` [updated ${entry.updatedAt.slice(0, 10)}]` : "";
    return `- ${entry.text}${tags}${when}`;
  });
  return [
    "Persistent memory, shared across sessions. Entries below were saved in earlier or current sessions and survive session restarts:",
    ...lines,
    "Manage this memory with memory_save (add), memory_update (edit), memory_recall (search), memory_forget (remove). Anything you save becomes visible to every future session."
  ].join("\n");
}

/** Assert `text` fits the configured per-entry byte budget. */
function assertWithinBudget(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`memory text exceeds the ${maxBytes}-byte limit`);
  }
}

/**
 * Mount the memory store, its system-prompt context, and its tools on `ctx`.
 * @param ctx - registrant context carrying the tools and systemPrompt services.
 * @param config - deployment configuration (see {@link Config}).
 */
export function apply(ctx, config) {
  const store = new MemoryStore({
    storageRoot: config.storageRoot ?? dshHomePath("memory"),
    scope: config.scope,
    workspaceRoot: config.workspaceRoot ?? process.cwd()
  });
  // Eager load so the injected context is populated from the first request;
  // every store method still awaits the same idempotent load.
  void store.ensureLoaded();

  if (config.injectContext) {
    ctx.systemPrompt.context({
      name: "memory",
      order: config.contextOrder,
      text: (assembleContext) => renderMemoryContext(store, assembleContext, config.maxInjectedMemories)
    });
  }

  ctx.tools.register(defineTool({
    name: "memory_save",
    description:
      "Persist a durable fact, preference, decision, or project detail so it survives across sessions and appears in the system prompt of every future session. Use it for information worth remembering long-term: user preferences, standing decisions and their rationale, project conventions, environment facts, long-term goals. Do not use it for ephemeral working state — that belongs in todo_write.",
    parameters: {
      text: {
        type: "string",
        required: true,
        description: "What to remember, as one concise self-contained statement."
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional short tags (e.g. project, user, decision) to make recall easier."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          text: { type: "string", required: true },
          tags: { type: "array", required: true, items: { type: "string" } },
          createdAt: { type: "string", required: true },
          updatedAt: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: `Memory saved (id ${value.id}).` }]
    },
    async execute(args) {
      const text = String(args.text ?? "").trim();
      if (text.length === 0) throw new Error("memory_save: `text` must be a non-empty string");
      assertWithinBudget(text, config.maxMemoryBytes);
      return store.save({ text, tags: args.tags });
    }
  }));

  ctx.tools.register(defineTool({
    name: "memory_recall",
    description:
      "Search persistent cross-session memory. Returns the entries whose text or tags best match the query, most relevant first; an empty query returns the most recent entries. Use it when you suspect an earlier session recorded something relevant.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "Free-text search; keywords are matched against entry text and tags. Pass an empty string to list the most recent entries."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                text: { type: "string", required: true },
                tags: { type: "array", required: true, items: { type: "string" } },
                createdAt: { type: "string", required: true },
                updatedAt: { type: "string", required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        if (value.results.length === 0) {
          return [{ type: "text", text: "No memories found." }];
        }
        const body = value.results
          .map((entry) => `- [${entry.id}] ${entry.text}${entry.tags.length > 0 ? ` (tags: ${entry.tags.join(", ")})` : ""}`)
          .join("\n");
        return [{ type: "text", text: `Memory recall (${value.results.length}):\n${body}` }];
      }
    },
    async execute(args) {
      const results = await store.recall(args.query ?? "", config.maxRecallResults);
      return { results };
    }
  }));

  ctx.tools.register(defineTool({
    name: "memory_update",
    description:
      "Edit a persistent memory entry by id. Supply `text` to replace the entry's statement and/or `tags` to replace its tags. Fails when the id is unknown — run memory_recall first to find ids.",
    parameters: {
      id: {
        type: "string",
        required: true,
        description: "The entry id returned by memory_save or memory_recall."
      },
      text: {
        type: "string",
        description: "Replacement statement for the entry."
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Replacement tags."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          text: { type: "string", required: true },
          tags: { type: "array", required: true, items: { type: "string" } },
          createdAt: { type: "string", required: true },
          updatedAt: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: `Memory ${value.id} updated.` }]
    },
    async execute(args) {
      if (typeof args.text === "string" && args.text.trim() !== "") {
        assertWithinBudget(args.text.trim(), config.maxMemoryBytes);
      }
      const entry = await store.update(args.id, { text: args.text, tags: args.tags });
      if (entry === null) throw new Error(`memory_update: no memory with id ${JSON.stringify(args.id)}`);
      return entry;
    }
  }));

  ctx.tools.register(defineTool({
    name: "memory_forget",
    description:
      "Delete a persistent memory entry by id. Fails when the id is unknown — run memory_recall first to find ids.",
    parameters: {
      id: {
        type: "string",
        required: true,
        description: "The entry id returned by memory_save or memory_recall."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          removed: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: `Memory ${value.id} forgotten.` }]
    },
    async execute(args) {
      const result = await store.forget(args.id);
      if (result === null) throw new Error(`memory_forget: no memory with id ${JSON.stringify(args.id)}`);
      return result;
    }
  }));
}

export { MemoryStore, renderMemoryContext, scoreEntry, tokenize };
export default { name, inject, Config, apply };

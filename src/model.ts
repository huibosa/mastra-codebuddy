// A codebuddy CLI call, run through @tencent-ai/agent-sdk, as an AI SDK language model, so
// Mastra agents (or any AI SDK caller) can use CodeBuddy models with the CLI's OAuth login.
// Each call is one completion and nothing more: no tools, no MCP, no session, one model
// request. Search mode is the one exception: the CLI's WebSearch tool, up to a cap, and the
// turns it takes. See watcher.ts for why the stream is watched on top of the flags.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  SharedV3Warning
} from "@ai-sdk/provider";
import { type Effort, type HookCallback, type Message, type Options, query, type Query, type UserMessage } from "@tencent-ai/agent-sdk";
import { RATE_LIMIT, RateLimitError } from "./errors";
import { toUserMessage } from "./prompt";
import { StreamWatcher } from "./watcher";

// Turns off injected context (auto memory, CODEBUDDY.md, git info; ~3k prompt tokens per
// call), local logs/traces, side calls (title, prompt suggestion, memory extraction) and the
// CLI's own HTTP retries, which the caller's retry loop replaces. Auth stays the OAuth login.
export const CODEBUDDY_ENV: Record<string, string> = {
  CODEBUDDY_MAX_RETRIES: "0",
  CODEBUDDY_CODE_DISABLE_TERMINAL_TITLE: "1",
  CODEBUDDY_PROMPT_SUGGESTION_DISABLED: "1",
  CODEBUDDY_MEMORY_EXTRACTION_DISABLED: "1",
  CODEBUDDY_DISABLE_AUTO_MEMORY: "1",
  CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: "1",
  CODEBUDDY_DISABLE_PARENT_MEMORY: "1",
  CODEBUDDY_DISABLE_GIT_PROMPT_CONTEXT: "1",
  CODEBUDDY_DISABLE_SYSTEM_INFO_GIT: "1",
  CODEBUDDY_DISABLE_FILE_LOGS: "1",
  CODEBUDDY_DISABLE_TRACE_COLLECTOR: "1",
  DISABLE_TELEMETRY: "1"
};

export const DEFAULT_MAX_SEARCHES = 5;

export type CodebuddySettings = {
  // The CLI to run. Default: the `codebuddy` on PATH, so the app shares the CLI's version and
  // login; the SDK's bundled copy is never used. A .ts/.js path (a fake) is run with bun.
  cliPath?: string;
  timeoutMs: number;
  // Extra environment for the CLI, on top of CODEBUDDY_ENV.
  env?: Record<string, string>;
};

// Search mode: the model may search the web, up to maxSearches times; each query is reported
// as it is made. Searches past the cap are denied and the model answers with what it has.
export type SearchMode = { maxSearches?: number; onSearch?: (query: string) => void };

export type ModelSettings = { effort: Effort | (string & {}); search?: SearchMode };

export class CodebuddyModel implements LanguageModelV3 {
  readonly specificationVersion = "v3";
  readonly provider = "codebuddy";
  readonly supportedUrls = {};

  constructor(
    readonly modelId: string,
    private settings: ModelSettings,
    private config: CodebuddySettings
  ) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    return this.call(prepare(options), options.abortSignal);
  }

  // Text and reasoning stream as the model writes them. In search mode that includes what the
  // model writes before each search, which doGenerate drops from its reply. Tool calls are the
  // CLI's own (WebSearch) and are not streamed.
  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const prepared = prepare(options);
    // Cancelling the stream stops the CLI.
    const cancel = new AbortController();
    const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, cancel.signal]) : cancel.signal;
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings: prepared.warnings });
        const parts = new StreamParts((p) => controller.enqueue(p));
        this.call(prepared, signal, (m) => parts.push(m)).then(
          (r) => {
            parts.closeAll();
            controller.enqueue({ type: "finish", finishReason: r.finishReason, usage: r.usage, providerMetadata: r.providerMetadata });
            controller.close();
          },
          (err) => controller.error(err)
        );
      },
      cancel: () => cancel.abort()
    });
    return { stream };
  }

  private async call(
    prepared: Prepared,
    abortSignal: AbortSignal | undefined,
    onMessage?: (m: Message) => void
  ): Promise<LanguageModelV3GenerateResult> {
    // Its own empty working directory, so codebuddy finds no project files or memory.
    const dir = join(tmpdir(), "mastra-codebuddy", crypto.randomUUID());
    await mkdir(dir, { recursive: true });
    const systemFile = join(dir, "system.md");
    await writeFile(systemFile, prepared.system || "You are a helpful assistant.");
    try {
      return await this.run(dir, systemFile, prepared, abortSignal, onMessage);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async run(
    cwd: string,
    systemFile: string,
    prepared: Prepared,
    abortSignal: AbortSignal | undefined,
    onMessage: ((m: Message) => void) | undefined
  ): Promise<LanguageModelV3GenerateResult> {
    if (abortSignal?.aborted) throw new Error("aborted");
    const search = this.settings.search;
    const watcher = new StreamWatcher(!!search);
    let stderr = "";
    const opts: Options = {
      pathToCodebuddyCode: resolveCli(this.config),
      cwd,
      env: { ...CODEBUDDY_ENV, ...this.config.env },
      model: this.modelId,
      effort: this.settings.effort as Effort,
      tools: search ? ["WebSearch"] : [],
      maxTurns: search ? undefined : 1,
      persistSession: false,
      strictMcpConfig: true,
      settingSources: [],
      includePartialMessages: !!onMessage,
      extraArgs: { "system-prompt-file": systemFile, settings: '{"autoCompactEnabled":false}' },
      hooks: search ? { PreToolUse: [{ matcher: "WebSearch", hooks: [searchCap(search, watcher)] }] } : undefined,
      stderr: (d) => (stderr = (stderr + d).slice(-2000))
    };
    const q = query({ prompt: once(prepared.message), options: opts });

    let stopped: string | null = null;
    const stop = (why: string) => {
      stopped ??= why;
      forceClose(q);
    };
    const timer = setTimeout(() => stop(`codebuddy timed out after ${this.config.timeoutMs / 1000}s`), this.config.timeoutMs);
    const onAbort = () => stop("aborted");
    abortSignal?.addEventListener("abort", onAbort);

    let thrown: unknown = null;
    try {
      for await (const m of q) {
        watcher.push(m);
        // Leaving the loop ends the SDK's iterator, which terminates the CLI.
        if (watcher.violation) {
          stopped = watcher.violation;
          break;
        }
        onMessage?.(m);
      }
    } catch (err) {
      thrown = err;
    } finally {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    }

    if (stopped) throw new Error(stopped);
    if (!watcher.result?.ok) {
      const detail =
        watcher.result?.message || (thrown instanceof Error ? thrown.message : "") || stderr || "the CLI ended without a result";
      if (RATE_LIMIT.test(detail)) throw new RateLimitError(detail.slice(0, 500));
      throw new Error(`codebuddy ${this.modelId} failed: ${detail.slice(0, 500)}`);
    }
    const u = watcher.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    return {
      content: [{ type: "text", text: watcher.text.trim() }],
      finishReason: { unified: "stop", raw: "success" },
      usage: {
        inputTokens: {
          total: u.input,
          noCache: Math.max(0, u.input - u.cacheRead - u.cacheWrite),
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite
        },
        outputTokens: { total: u.output, text: undefined, reasoning: undefined }
      },
      // Credits are what CodeBuddy bills; null when the CLI did not report them.
      ...(watcher.credits === null ? {} : { providerMetadata: { codebuddy: { credits: watcher.credits } } }),
      warnings: prepared.warnings
    };
  }
}

type Prepared = ReturnType<typeof toUserMessage> & { warnings: SharedV3Warning[] };

// Checks and converts the request before any process starts, so a bad one fails at once.
function prepare(options: LanguageModelV3CallOptions): Prepared {
  const warnings: SharedV3Warning[] = [];
  if (options.maxOutputTokens) warnings.push({ type: "unsupported", feature: "maxOutputTokens" });
  return { ...toUserMessage(options), warnings };
}

// Turns the CLI's raw stream events (with --include-partial-messages) into AI SDK stream
// parts. Each content block of each model request gets its own id.
class StreamParts {
  private request = "";
  private requests = 0;
  private open = new Map<number, { id: string; kind: "text" | "reasoning" }>();

  constructor(private enqueue: (part: LanguageModelV3StreamPart) => void) {}

  push(m: Message) {
    if (m.type !== "stream_event") return;
    const ev = m.event as Record<string, any>;
    if (ev.type === "message_start") {
      this.request = String(ev.message?.id ?? `r${this.requests}`);
      this.requests++;
    } else if (ev.type === "content_block_start") {
      const type = ev.content_block?.type;
      const kind = type === "text" ? "text" : type === "thinking" ? "reasoning" : null;
      if (!kind) return;
      const id = `${this.request}:${ev.index}`;
      this.open.set(ev.index, { id, kind });
      this.enqueue({ type: `${kind}-start`, id });
    } else if (ev.type === "content_block_delta") {
      const block = this.open.get(ev.index);
      const delta = ev.delta?.type === "text_delta" ? ev.delta.text : ev.delta?.type === "thinking_delta" ? ev.delta.thinking : "";
      if (block && delta) this.enqueue({ type: `${block.kind}-delta`, id: block.id, delta });
    } else if (ev.type === "content_block_stop") {
      this.end(ev.index);
    }
  }

  closeAll() {
    for (const index of [...this.open.keys()]) this.end(index);
  }

  private end(index: number) {
    const block = this.open.get(index);
    if (!block) return;
    this.open.delete(index);
    this.enqueue({ type: `${block.kind}-end`, id: block.id });
  }
}

// Counts searches in the CLI's PreToolUse hook: reports each allowed query, denies the rest.
// (canUseTool is never asked about WebSearch: the CLI allows it without a permission check.)
function searchCap(search: SearchMode, watcher: StreamWatcher): HookCallback {
  const max = search.maxSearches ?? DEFAULT_MAX_SEARCHES;
  let count = 0;
  return async (input, toolUseId) => {
    const query = String((input as { tool_input?: { query?: unknown } }).tool_input?.query ?? "");
    if (++count <= max) {
      search.onSearch?.(query);
      return { continue: true };
    }
    if (toolUseId) watcher.denySearch(toolUseId);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Search limit of ${max} reached. Answer with what you have found.`
      }
    };
  };
}

async function* once(message: UserMessage) {
  yield message;
}

// The SDK has no public way to stop a CLI that has gone quiet: interrupt() waits for the CLI to
// answer, and the abort signal never reaches the process. Closing the transport terminates
// the CLI and ends the message stream. Private in @tencent-ai/agent-sdk 0.3.301 (pinned); the
// timeout and abort tests fail if it moves.
function forceClose(q: Query) {
  const transport = (q as unknown as { transport?: { close?: () => void } }).transport;
  if (typeof transport?.close !== "function") throw new Error("agent-sdk changed: Query.transport.close() is gone");
  transport.close();
}

export function resolveCli(config: CodebuddySettings) {
  return config.cliPath ?? globalCli();
}

let cachedCli: string | null = null;
function globalCli() {
  if (cachedCli) return cachedCli;
  const bin = Bun.which("codebuddy");
  if (!bin) throw new Error("codebuddy CLI not found on PATH; install it or pass cliPath");
  // The SDK runs <pkg>/dist/codebuddy-headless.js when the path ends in bin/codebuddy.
  cachedCli = realpathSync(bin);
  return cachedCli;
}

// Building blocks for a fake codebuddy CLI, so tests never reach the network. A fake is a
// script that calls fakeCli(); point the provider's cliPath at it and the SDK runs it with bun.
// It speaks the SDK's stream-json control protocol as recorded from the real CLI (2.181.0):
// the SDK sends an `initialize` control request, then the user message; the CLI answers the
// request and streams events. Hook callbacks go the other way as control requests.
import { appendFileSync, readFileSync } from "node:fs";

export type FakeCall = {
  argv: string[];
  // The system prompt file's contents, "" when none was passed.
  system: string;
  // The user message's content blocks.
  content: Array<Record<string, any>>;
  // The CODEBUDDY_* and DISABLE_* variables the CLI was started with.
  env: Record<string, string | undefined>;
};

export type FakeIo = {
  emit(event: object): void;
  init(): void;
  assistant(content: object[]): void;
  result(ok: boolean, text: string): void;
  // One web search as the real CLI streams it: the call, the PreToolUse hook if the SDK
  // registered one, then the tool result. Returns false if the hook denied it.
  search(query: string, preamble?: string): Promise<boolean>;
};

export const FAKE_USAGE = { input_tokens: 1200, output_tokens: 34, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
export const FAKE_CREDITS = 0.37;
// What get_available_models answers, in the CLI's raw model shape.
export const FAKE_MODELS = [
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    supportsImages: true,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    credits: "x0.11 credits",
    reasoning: { supportedEfforts: ["low", "high", "max"], defaultEffort: "high" }
  },
  { id: "glm-5.2", name: "GLM 5.2", supportsImages: false, maxInputTokens: 1_000_000, maxOutputTokens: 64_000, credits: "x0.79 credits" }
];

// FAKE_CB_LOG, when set, gets one JSON line per call: a FakeCall.
export async function fakeCli(handler: (call: FakeCall, io: FakeIo) => Promise<void>) {
  // The real CLI (2.181.0) exits at once when given this flag, which the SDK adds for its
  // requestTimeoutMs option.
  if (process.argv.includes("--request-timeout-ms")) process.exit(1);
  const lines = stdinLines();
  const pending = new Map<string, (response: any) => void>();
  let hooks: Record<string, Array<{ matcher?: string; hookCallbackIds: string[] }>> = {};
  const { promise: promptP, resolve: prompt } = Promise.withResolvers<any[]>();

  const emit = (ev: object) => process.stdout.write(JSON.stringify(ev) + "\n");
  // Reads stdin for the whole run: control responses can arrive at any point.
  (async () => {
    for await (const line of lines) {
      const msg = JSON.parse(line);
      const reply = (response: object) =>
        emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } });
      if (msg.type === "control_request" && msg.request.subtype === "initialize") {
        hooks = msg.request.hooks ?? {};
        reply({});
      } else if (msg.type === "control_request" && msg.request.subtype === "get_available_models") {
        reply({ availableModels: FAKE_MODELS.map((m) => ({ modelId: m.id, name: m.name })), rawModels: FAKE_MODELS });
      } else if (msg.type === "control_response") {
        pending.get(msg.response.request_id)?.(msg.response.response);
      } else if (msg.type === "user") {
        prompt(msg.message.content);
      }
    }
  })();

  let seq = 0;
  const request = (payload: object) =>
    new Promise<any>((resolve) => {
      const id = `fake_${++seq}`;
      pending.set(id, resolve);
      emit({ type: "control_request", request_id: id, request: payload });
    });
  const usage = FAKE_USAGE;
  const argv = process.argv.slice(2);
  // With --include-partial-messages the real CLI streams each model request as raw events
  // (message_start, content blocks with deltas, message_stop) before the whole message.
  const partial = argv.includes("--include-partial-messages");
  const streamEvent = (event: object) => emit({ type: "stream_event", session_id: "fake", parent_tool_use_id: null, event });
  const streamBlocks = (id: string, content: Array<Record<string, any>>) => {
    streamEvent({ type: "message_start", message: { id, role: "assistant", content: [], usage } });
    content.forEach((block, index) => {
      if (block.type === "tool_use") {
        streamEvent({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      } else {
        const [key, deltaType] = block.type === "thinking" ? ["thinking", "thinking_delta"] : ["text", "text_delta"];
        const full = String(block[key!] ?? "");
        streamEvent({ type: "content_block_start", index, content_block: { type: block.type, [key!]: "" } });
        // Two deltas, so a consumer has to join them.
        const half = Math.ceil(full.length / 2);
        for (const piece of [full.slice(0, half), full.slice(half)]) {
          if (piece) streamEvent({ type: "content_block_delta", index, delta: { type: deltaType, [key!]: piece } });
        }
      }
      streamEvent({ type: "content_block_stop", index });
    });
    streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage });
    streamEvent({ type: "message_stop" });
  };
  const io: FakeIo = {
    emit,
    init: () => emit({ type: "system", subtype: "init", session_id: "fake", tools: [], mcp_servers: [] }),
    assistant(content) {
      const id = `m${++seq}`;
      if (partial) streamBlocks(id, content as Array<Record<string, any>>);
      emit({ type: "assistant", session_id: "fake", message: { id, role: "assistant", content, usage, stop_reason: null } });
    },
    result(ok, text) {
      // The CLI's closing usage snapshot, with the credits the whole run cost.
      const turnUsage = { version: 1, scope: "turn", kind: "snapshot", total: { usage, credits: FAKE_CREDITS, creditStatus: "known" } };
      emit({ type: "system", subtype: "usage_update", session_id: "fake", _meta: { "codebuddy.ai/turnUsage": turnUsage } });
      emit({ type: "result", session_id: "fake", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: text, usage, num_turns: 1 });
    },
    async search(query, preamble) {
      const id = `ws${++seq}`;
      io.assistant([...(preamble ? [{ type: "text", text: preamble }] : []), { type: "tool_use", id, name: "WebSearch", input: { query } }]);
      let allowed = true;
      for (const m of hooks.PreToolUse ?? []) {
        if (m.matcher && m.matcher !== "WebSearch") continue;
        for (const callback_id of m.hookCallbackIds) {
          const input = { hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input: { query }, tool_use_id: id };
          const r = await request({ subtype: "hook_callback", callback_id, input, tool_use_id: id });
          if (r?.hookSpecificOutput?.permissionDecision === "deny") allowed = false;
        }
      }
      const content = allowed ? "results" : "Error: PreToolUse:WebSearch hook blocked this tool call";
      emit({ type: "user", session_id: "fake", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: !allowed }] } });
      return allowed;
    }
  };

  const content = await promptP;
  const i = argv.indexOf("--system-prompt-file");
  const call = {
    argv,
    system: i >= 0 ? readFileSync(argv[i + 1]!, "utf8") : "",
    content,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CODEBUDDY_|DISABLE_)/.test(k)))
  };
  if (process.env.FAKE_CB_LOG) appendFileSync(process.env.FAKE_CB_LOG, JSON.stringify(call) + "\n");
  io.init();
  emit({ type: "system", subtype: "status", status: null, session_id: "fake" });
  await handler(call, io);
  process.exit(0);
}

async function* stdinLines() {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
}

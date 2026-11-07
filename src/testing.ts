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

// FAKE_CB_LOG, when set, gets one JSON line per call: a FakeCall.
export async function fakeCli(handler: (call: FakeCall, io: FakeIo) => Promise<void>) {
  const lines = stdinLines();
  const pending = new Map<string, (response: any) => void>();
  let hooks: Record<string, Array<{ matcher?: string; hookCallbackIds: string[] }>> = {};
  const { promise: promptP, resolve: prompt } = Promise.withResolvers<any[]>();

  const emit = (ev: object) => process.stdout.write(JSON.stringify(ev) + "\n");
  // Reads stdin for the whole run: control responses can arrive at any point.
  (async () => {
    for await (const line of lines) {
      const msg = JSON.parse(line);
      if (msg.type === "control_request" && msg.request.subtype === "initialize") {
        hooks = msg.request.hooks ?? {};
        emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
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
  const io: FakeIo = {
    emit,
    init: () => emit({ type: "system", subtype: "init", session_id: "fake", tools: [], mcp_servers: [] }),
    assistant: (content) =>
      emit({ type: "assistant", session_id: "fake", message: { id: `m${++seq}`, role: "assistant", content, usage, stop_reason: null } }),
    result: (ok, text) =>
      emit({ type: "result", session_id: "fake", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: text, usage, num_turns: 1 }),
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

  const argv = process.argv.slice(2);
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

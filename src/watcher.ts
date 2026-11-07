// Reads the SDK's messages for one call. `violation` is set the moment the run does more than
// its mode allows; the caller stops the CLI then.
//
// The CLI cannot be bounded to one model request by flags alone (checked against 2.178.1):
// --max-turns counts turns within one run, and its recovery paths (truncated reply, error
// finish, network error, empty stream) start a new run with a fresh budget, with no off
// switch, and no SDK hook fires before a model request. Each new run emits a fresh `init`.
import type { Message } from "@tencent-ai/agent-sdk";

export type CodebuddyUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export class StreamWatcher {
  inits = 0;
  text = "";
  usage: CodebuddyUsage | null = null;
  result: { ok: boolean; message: string } | null = null;
  violation: string | null = null;
  // Search mode: the model request (by order) each search was made in, and the searches the
  // cap denied. The denial comes from the hook, which can run before the watcher has read the
  // search's own message, so the check holds whichever arrives first.
  private requests: string[] = [];
  private searchRequest = new Map<string, number>();
  private deniedSearches = new Set<string>();

  constructor(private search: boolean) {}

  push(m: Message) {
    const ev = m as Record<string, any>;
    if (ev.type === "system" && ev.subtype === "init" && ++this.inits > 1) {
      this.violation = "codebuddy started a second model request";
    } else if (ev.type === "assistant") {
      const request = String(ev.message?.id ?? ev.uuid ?? this.requests.length);
      if (!this.requests.includes(request)) this.requests.push(request);
      for (const block of ev.message?.content ?? []) {
        if (block.type === "text") this.text += block.text ?? "";
        else if (block.type === "tool_use") this.toolUse(block, this.requests.indexOf(request));
      }
    } else if (ev.type === "result") {
      const u = ev.usage ?? {};
      this.usage = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0
      };
      const message = ev.result ?? (ev.errors ?? []).join("; ");
      this.result = { ok: ev.subtype === "success" && !ev.is_error, message: String(message) };
    }
  }

  // The search cap denied this search (by tool_use id).
  denySearch(toolUseId: string) {
    this.deniedSearches.add(toolUseId);
    this.checkSearches();
  }

  private toolUse(block: Record<string, any>, request: number) {
    if (!this.search || block.name !== "WebSearch") {
      this.violation = `codebuddy tried to call a tool (${block.name})`;
      return;
    }
    // Text written before a search is the model thinking aloud; the reply is what follows.
    this.text = "";
    this.searchRequest.set(String(block.id), request);
    this.checkSearches();
  }

  // After a denial the model must answer: a search in any later model request is one too many.
  // Searches made in parallel with the denied one share its request and are fine.
  private checkSearches() {
    const denied = [...this.deniedSearches].map((id) => this.searchRequest.get(id)).filter((r) => r !== undefined);
    if (!denied.length) return;
    const first = Math.min(...denied);
    if ([...this.searchRequest.values()].some((r) => r > first)) {
      this.violation ??= "codebuddy kept searching after the search cap";
    }
  }
}

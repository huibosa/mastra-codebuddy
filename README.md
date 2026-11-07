# mastra-codebuddy

CodeBuddy models for [Mastra](https://mastra.ai) agents, or any AI SDK caller. Each call runs the
`codebuddy` CLI through [`@tencent-ai/agent-sdk`](https://www.npmjs.com/package/@tencent-ai/agent-sdk)
and uses the CLI's OAuth login, so there is no API key. Every call is **one model completion and
nothing more**: no tools, no MCP, no session. The one exception is search mode, which lets the
model run web searches up to a cap.

## Setup

Install the `codebuddy` CLI and log in once (`codebuddy`, OAuth) as the user the app runs as.
The library runs the `codebuddy` on `PATH`, so the app and your shell share one CLI version and
one login. The CLI that comes bundled with the SDK is never used.

```jsonc
// package.json of the app
"dependencies": { "mastra-codebuddy": "file:../../mastra-codebuddy" }
```

## Use

```ts
import { Agent } from "@mastra/core/agent";
import { createCodebuddy } from "mastra-codebuddy";

const codebuddy = createCodebuddy({ timeoutMs: 600_000 }); // cliPath?, env?

const reader = new Agent({
  id: "reader",
  name: "Reader",
  instructions: "…",
  model: codebuddy("deepseek-v4.1-flash", { effort: "low" })
});

// Search mode: WebSearch is the only tool. Every query is reported; once the cap is reached
// further searches are denied and the model answers with what it found.
const scout = codebuddy("kimi-k3.1-pro", {
  effort: "high",
  search: { maxSearches: 5, onSearch: (q) => console.log("searching", q) }
});

// The models this account can use: efforts, vision, token limits, credit rate.
const models = await codebuddy.listModels();
```

- **Prompts:** one user turn, made of text and images (bytes or base64; URLs are refused). The
  system prompt is handed to the CLI as a file and the user turn goes over stdin, so a prompt of
  any size fits.
- **Structured output:** the schema is written into the prompt, so use Mastra's
  `jsonPromptInjection: true`. The CLI's `--json-schema` is never used, because it adds a hook
  that re-prompts up to 4 times.
- **Streaming:** `doStream` sends text and reasoning deltas as the model writes them. Mastra's
  `agent.generate()` calls `doGenerate`, and `agent.stream()` calls `doStream`. In search mode the
  stream also includes what the model writes before each search; `doGenerate` returns only the
  final answer.
- **Usage:** tokens are returned as usual. The credits the call cost (CodeBuddy bills in credits,
  not USD) come back in `providerMetadata.codebuddy.credits`. In Mastra that is
  `result.providerMetadata`.
- **Errors:** `RateLimitError` is thrown for rate limits; back off and retry. Any other failure
  throws an `Error` that includes the CLI's message or stderr. The CLI's own retries are
  switched off, so retrying is the caller's job.
- **`maxOutputTokens`:** not supported; the call returns a warning instead.

## Why the output stream is watched

The CLI cannot be held to one model request by flags alone (checked on 2.178–2.181):

- `--max-turns` counts turns within one run.
- Its recovery paths (truncated reply, error finish, network error, empty stream) start a new run
  with a fresh turn budget, and there is no setting to turn them off.
- No SDK hook fires before a model request.

So the library switches off everything that can be switched off: tools, MCP, settings files,
session persistence, auto memory, git context, telemetry, side calls and retries (see
`CODEBUDDY_ENV`). It then watches the SDK's message stream. The CLI is stopped as soon as one of
these happens:

- A second run starts (a new `init` event).
- The model calls a tool other than WebSearch in search mode.
- The model searches again in a later model request after the search cap denied a search.

Timeouts and aborts stop the CLI too. The SDK has no public way to stop a CLI that has stopped
responding, so the library calls the SDK's private `Query.transport.close()`. That is why
`@tencent-ai/agent-sdk` is pinned to an exact version. The timeout and abort tests fail if an
upgrade moves that method.

## Tests

```sh
bun test                 # offline, against a fake CLI
LIVE=1 bun test test/live.test.ts   # real CLI and account; about one credit
```

`mastra-codebuddy/testing` exports `fakeCli()`, the stream-json control protocol of the real
CLI as recorded from 2.181.0. Apps can use it to write their own fake: a script that calls
`fakeCli(handler)`, passed as `cliPath`. The SDK runs it with `bun`. Set `FAKE_CB_LOG` to have
it record each call (argv, system prompt, content, CodeBuddy environment).

Known CLI quirks the fake mirrors:

- The CLI exits at once when given `--request-timeout-ms`, which the SDK adds for its
  `requestTimeoutMs` option. Never set `requestTimeoutMs`.
- `canUseTool` is never asked about WebSearch, because the CLI allows it without a permission
  check. That is why the search cap is enforced in a `PreToolUse` hook instead.

// The provider against the fake CLI, through the real agent-sdk.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createCodebuddy, RateLimitError } from "../src";
import { FAKE_CREDITS, type FakeCall } from "../src/testing";

const FAKE = join(import.meta.dir, "fixtures/fake-codebuddy.ts");
const LOG = `/tmp/mastra-codebuddy-fake-${process.pid}.jsonl`;
const codebuddy = createCodebuddy({ cliPath: FAKE, timeoutMs: 3_000 });

const mode = (m: string, text?: string) => {
  process.env.FAKE_CB_MODE = m;
  if (text === undefined) delete process.env.FAKE_CB_TEXT;
  else process.env.FAKE_CB_TEXT = text;
};
const calls = (): FakeCall[] =>
  readFileSync(LOG, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const userPrompt = (text: string) => [{ role: "user" as const, content: [{ type: "text" as const, text }] }];
const env = ["FAKE_CB_SEARCHES", "FAKE_CB_SEARCH_DELAY_MS"];

beforeEach(() => {
  rmSync(LOG, { force: true });
  process.env.FAKE_CB_LOG = LOG;
  for (const k of env) delete process.env[k];
});
afterAll(() => rmSync(LOG, { force: true }));

describe("single completion", () => {
  const model = codebuddy("deepseek-v4.1-flash", { effort: "low" });

  test("one call: isolated flags, system prompt in a file, prompt on stdin, text and usage back", async () => {
    mode("ok", "pong");
    const r = await model.doGenerate({ prompt: [{ role: "system", content: "sys" }, ...userPrompt("ping")] });
    expect(r.content).toEqual([{ type: "text", text: "pong" }]);
    expect(r.usage.inputTokens.total).toBe(1200);
    expect(r.usage.inputTokens.cacheRead).toBe(1000);
    const [call] = calls();
    expect(call!.argv).toEqual(
      expect.arrayContaining(["--model", "deepseek-v4.1-flash", "--effort", "low", "--tools", "", "--max-turns", "1"])
    );
    expect(call!.argv).toEqual(expect.arrayContaining(["--strict-mcp-config", "--no-session-persistence", "--setting-sources", "none"]));
    expect(call!.argv).not.toContain("--json-schema");
    expect(call!.argv).not.toContain("--system-prompt");
    expect(call!.system).toBe("sys");
    expect(call!.content).toEqual([{ type: "text", text: "ping" }]);
    expect(call!.env).toMatchObject({ CODEBUDDY_MAX_RETRIES: "0", CODEBUDDY_DISABLE_AUTO_MEMORY: "1", DISABLE_TELEMETRY: "1" });
  });

  test("a run that starts a second request is stopped at once", async () => {
    mode("loop");
    const t0 = performance.now();
    await expect(model.doGenerate({ prompt: userPrompt("x") })).rejects.toThrow("second model request");
    expect(performance.now() - t0).toBeLessThan(800);
  });

  test("a tool call is stopped at once", async () => {
    mode("tool");
    const t0 = performance.now();
    await expect(model.doGenerate({ prompt: userPrompt("x") })).rejects.toThrow("Bash");
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  test("a web search is refused too", async () => {
    mode("search", "answer");
    await expect(model.doGenerate({ prompt: userPrompt("x") })).rejects.toThrow("WebSearch");
  });

  test("rate limits surface as RateLimitError; other failures carry stderr", async () => {
    mode("ratelimit");
    await expect(model.doGenerate({ prompt: userPrompt("x") })).rejects.toBeInstanceOf(RateLimitError);
    mode("fail");
    await expect(model.doGenerate({ prompt: userPrompt("x") })).rejects.toThrow("model not available");
  });

  test("a hung process is killed at the timeout", async () => {
    mode("hang");
    const quick = createCodebuddy({ cliPath: FAKE, timeoutMs: 500 })("deepseek-v4.1-flash", { effort: "low" });
    const t0 = performance.now();
    await expect(quick.doGenerate({ prompt: userPrompt("x") })).rejects.toThrow("timed out");
    expect(performance.now() - t0).toBeLessThan(1_500);
  });

  test("an abort stops a hung call", async () => {
    mode("hang");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    const t0 = performance.now();
    await expect(model.doGenerate({ prompt: userPrompt("x"), abortSignal: ctl.signal })).rejects.toThrow("aborted");
    expect(performance.now() - t0).toBeLessThan(1_500);
  });

  test("credits come back in provider metadata", async () => {
    mode("ok", "pong");
    const r = await model.doGenerate({ prompt: userPrompt("x") });
    expect(r.providerMetadata).toEqual({ codebuddy: { credits: FAKE_CREDITS } });
    expect(calls()[0]!.argv).not.toContain("--include-partial-messages");
  });
});

const read = async (stream: ReadableStream<any>) => {
  const parts: any[] = [];
  for await (const p of stream) parts.push(p);
  return parts;
};

describe("streaming", () => {
  const model = codebuddy("deepseek-v4.1-flash", { effort: "low" });

  test("text and reasoning arrive as deltas, then finish with usage and credits", async () => {
    mode("ok", "streamed reply");
    const parts = await read((await model.doStream({ prompt: userPrompt("x") })).stream);
    expect(calls()[0]!.argv).toContain("--include-partial-messages");
    const types = parts.map((p) => p.type);
    expect(types[0]).toBe("stream-start");
    expect(types).toEqual(expect.arrayContaining(["reasoning-start", "reasoning-delta", "reasoning-end", "text-start", "text-end"]));
    const deltas = parts.filter((p) => p.type === "text-delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((p) => p.delta).join("")).toBe("streamed reply");
    expect(parts.filter((p) => p.type === "reasoning-delta").map((p) => p.delta).join("")).toBe("considering");
    const finish = parts.at(-1);
    expect(finish).toMatchObject({ type: "finish", finishReason: { unified: "stop" }, providerMetadata: { codebuddy: { credits: FAKE_CREDITS } } });
    expect(finish.usage.inputTokens.total).toBe(1200);
  });

  test("each block is opened before its deltas and closed once", async () => {
    mode("ok", "pong");
    const parts = await read((await model.doStream({ prompt: userPrompt("x") })).stream);
    const open = new Set<string>();
    for (const p of parts) {
      if (p.type.endsWith("-start") && p.id) open.add(p.id);
      if (p.type.endsWith("-delta")) expect(open.has(p.id)).toBe(true);
      if (p.type.endsWith("-end")) expect(open.delete(p.id)).toBe(true);
    }
    expect(open.size).toBe(0);
  });

  test("failures error the stream with the same errors as doGenerate", async () => {
    mode("ratelimit");
    await expect(read((await model.doStream({ prompt: userPrompt("x") })).stream)).rejects.toBeInstanceOf(RateLimitError);
    mode("tool");
    await expect(read((await model.doStream({ prompt: userPrompt("x") })).stream)).rejects.toThrow("Bash");
  });

  test("a bad prompt is refused before anything starts", async () => {
    await expect(model.doStream({ prompt: [] })).rejects.toThrow("empty prompt");
  });

  test("search mode streams the searches' preambles too, and the answer", async () => {
    mode("search", "the answer");
    process.env.FAKE_CB_SEARCHES = "2";
    const searching = codebuddy("deepseek-v4.1-flash", { effort: "low", search: {} });
    const parts = await read((await searching.doStream({ prompt: userPrompt("x") })).stream);
    const text = parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");
    expect(text).toBe("Let me check the terms. Let me check the terms. the answer");
    expect(parts.some((p) => p.type === "tool-call")).toBe(false);
  });
});

describe("model discovery", () => {
  test("lists the account's models with efforts, vision, limits and credit rate", async () => {
    const models = await codebuddy.listModels();
    expect(models).toEqual([
      {
        id: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        efforts: ["low", "high", "max"],
        defaultEffort: "high",
        vision: true,
        maxInput: 1_000_000,
        maxOutput: 128_000,
        credits: "x0.11 credits"
      },
      { id: "glm-5.2", name: "GLM 5.2", efforts: [], vision: false, maxInput: 1_000_000, maxOutput: 64_000, credits: "x0.79 credits" }
    ]);
  });
});

describe("search mode", () => {
  let queries: string[] = [];
  const model = codebuddy("deepseek-v4.1-flash", { effort: "low", search: { onSearch: (q) => queries.push(q) } });
  const searches = (n: number) => (process.env.FAKE_CB_SEARCHES = String(n));
  beforeEach(() => {
    queries = [];
  });

  test("web search is the only tool, with no turn limit", async () => {
    mode("search", "answer");
    searches(1);
    await model.doGenerate({ prompt: userPrompt("x") });
    const [call] = calls();
    expect(call!.argv[call!.argv.indexOf("--tools") + 1]).toBe("WebSearch");
    expect(call!.argv).not.toContain("--max-turns");
    expect(call!.argv).not.toContain("--dangerously-skip-permissions");
  });

  test("up to 5 searches: the final text and usage come back, each query is reported", async () => {
    mode("search", "the answer");
    searches(5);
    const r = await model.doGenerate({ prompt: userPrompt("x") });
    expect(r.content).toEqual([{ type: "text", text: "the answer" }]);
    expect(r.usage.inputTokens.total).toBe(1200);
    expect(queries).toEqual(["query 1", "query 2", "query 3", "query 4", "query 5"]);
  });

  test("a sixth search is denied and the model answers with what it has", async () => {
    mode("search", "answer from five");
    searches(6);
    const r = await model.doGenerate({ prompt: userPrompt("x") });
    expect(r.content).toEqual([{ type: "text", text: "answer from five" }]);
    expect(queries).toHaveLength(5);
  });

  test("the cap is configurable", async () => {
    mode("search", "answer");
    searches(3);
    const capped = codebuddy("deepseek-v4.1-flash", { effort: "low", search: { maxSearches: 2, onSearch: (q) => queries.push(q) } });
    await capped.doGenerate({ prompt: userPrompt("x") });
    expect(queries).toEqual(["query 1", "query 2"]);
  });

  test("searching again after a denial is stopped at once", async () => {
    mode("search-stubborn");
    await expect(model.doGenerate({ prompt: userPrompt("x") })).rejects.toThrow("after the search cap");
    expect(queries).toHaveLength(5);
  });

  test("any other tool is stopped at once, even after a search", async () => {
    mode("search-tool");
    const t0 = performance.now();
    await expect(model.doGenerate({ prompt: userPrompt("x") })).rejects.toThrow("Bash");
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  test("a second model request is still stopped", async () => {
    mode("loop");
    await expect(model.doGenerate({ prompt: userPrompt("x") })).rejects.toThrow("second model request");
  });
});

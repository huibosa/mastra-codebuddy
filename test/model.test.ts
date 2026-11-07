// The provider against the fake CLI, through the real agent-sdk.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createCodebuddy, RateLimitError } from "../src";
import type { FakeCall } from "../src/testing";

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

  test("doStream yields the reply", async () => {
    mode("ok", "streamed");
    const { stream } = await model.doStream({ prompt: userPrompt("x") });
    const parts: any[] = [];
    for await (const p of stream) parts.push(p);
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe("streamed");
    expect(parts.at(-1).type).toBe("finish");
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

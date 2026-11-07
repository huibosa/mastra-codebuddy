// The provider inside Mastra agents, against the fake CLI.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { createCodebuddy } from "../src";
import { FAKE_CREDITS } from "../src/testing";

const codebuddy = createCodebuddy({ cliPath: join(import.meta.dir, "fixtures/fake-codebuddy.ts"), timeoutMs: 3_000 });
const agent = new Agent({ id: "a", name: "a", instructions: "be terse", model: codebuddy("deepseek-v4.1-flash", { effort: "low" }) });
const ask = [{ role: "user" as const, content: "x" }];

describe("Mastra agents", () => {
  test("generate returns the reply, usage and credits", async () => {
    process.env.FAKE_CB_MODE = "ok";
    process.env.FAKE_CB_TEXT = "hello";
    const r = await agent.generate(ask, { maxSteps: 1 });
    expect(r.text).toBe("hello");
    expect(r.usage.inputTokens).toBe(1200);
    expect(r.providerMetadata).toEqual({ codebuddy: { credits: FAKE_CREDITS } });
  });

  test("structured output with the schema in the prompt", async () => {
    process.env.FAKE_CB_MODE = "ok";
    process.env.FAKE_CB_TEXT = JSON.stringify({ colour: "red" });
    const r = await agent.generate(ask, {
      maxSteps: 1,
      structuredOutput: { schema: z.object({ colour: z.string() }), jsonPromptInjection: true, errorStrategy: "strict" }
    });
    expect(r.object).toEqual({ colour: "red" });
  });

  test("stream delivers the text in pieces", async () => {
    process.env.FAKE_CB_MODE = "ok";
    process.env.FAKE_CB_TEXT = "streamed through mastra";
    const r = await agent.stream(ask, { maxSteps: 1 });
    const pieces: string[] = [];
    for await (const t of r.textStream) pieces.push(t);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe("streamed through mastra");
  });

  test("a failure reaches the caller", async () => {
    process.env.FAKE_CB_MODE = "fail";
    const r = await agent.generate(ask, { maxSteps: 1 }).catch((e) => ({ error: e }));
    expect(String((r as { error?: unknown }).error)).toContain("model not available");
  });
});

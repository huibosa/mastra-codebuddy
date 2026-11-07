import { describe, expect, test } from "bun:test";
import { StreamWatcher, toUserMessage } from "../src";

const userPrompt = (text: string) => [{ role: "user" as const, content: [{ type: "text" as const, text }] }];
const ev = (m: object) => m as any;
const init = ev({ type: "system", subtype: "init" });
const toolUse = (name: string, id = "t1", request = "r1") =>
  ev({ type: "assistant", message: { id: request, content: [{ type: "tool_use", id, name, input: { query: "q" } }] } });

describe("request shape", () => {
  test("system and user text are split; the user turn is one SDK user message", () => {
    const big = "x".repeat(300_000);
    const { system, message } = toUserMessage({ prompt: [{ role: "system", content: "be terse" }, ...userPrompt(big)] });
    expect(system).toBe("be terse");
    expect(message.type).toBe("user");
    expect((message.message.content as any)[0].text).toHaveLength(300_000);
  });

  test("images become base64 blocks", () => {
    const { message } = toUserMessage({
      prompt: [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }] }]
    });
    expect(message.message.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }]);
  });

  test("tools, extra turns, non-images and image URLs are refused", () => {
    const tool = { type: "function" as const, name: "x", inputSchema: { type: "object" as const } };
    expect(() => toUserMessage({ prompt: userPrompt("hi"), tools: [tool] })).toThrow("without tools");
    expect(() =>
      toUserMessage({ prompt: [...userPrompt("a"), { role: "assistant", content: [{ type: "text", text: "b" }] }] })
    ).toThrow("one user turn");
    expect(() =>
      toUserMessage({ prompt: [{ role: "user", content: [{ type: "file", mediaType: "application/pdf", data: "AA" }] }] })
    ).toThrow("images only");
    expect(() =>
      toUserMessage({
        prompt: [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: new URL("https://x/y.png") }] }]
      })
    ).toThrow("not URLs");
  });

  test("a JSON response format becomes a prompt instruction", () => {
    const schema = { type: "object" as const, properties: { a: { type: "string" as const } } };
    const { system } = toUserMessage({ prompt: userPrompt("hi"), responseFormat: { type: "json", schema } });
    expect(system).toContain(JSON.stringify(schema));
  });
});

describe("stream watcher", () => {
  test("flags a second model request", () => {
    const w = new StreamWatcher(false);
    w.push(init);
    expect(w.violation).toBeNull();
    w.push(init);
    expect(w.violation).toContain("second model request");
  });

  test("flags any tool call in single-completion mode, WebSearch included", () => {
    const w = new StreamWatcher(false);
    w.push(toolUse("WebSearch"));
    expect(w.violation).toContain("WebSearch");
  });

  test("in search mode allows WebSearch, flags other tools", () => {
    const w = new StreamWatcher(true);
    w.push(ev({ type: "assistant", message: { id: "r0", content: [{ type: "text", text: "thinking aloud" }] } }));
    w.push(toolUse("WebSearch"));
    expect(w.violation).toBeNull();
    expect(w.text).toBe("");
    const t = new StreamWatcher(true);
    t.push(toolUse("Bash"));
    expect(t.violation).toContain("Bash");
  });

  test("after a denial, searches in the same request are fine; one in a later request is flagged", () => {
    // The hook's denial can come before or after the watcher reads the search itself.
    for (const denyFirst of [true, false]) {
      const w = new StreamWatcher(true);
      if (denyFirst) w.denySearch("a2");
      w.push(toolUse("WebSearch", "a1", "r1"));
      w.push(toolUse("WebSearch", "a2", "r1"));
      if (!denyFirst) w.denySearch("a2");
      expect(w.violation).toBeNull();
      w.push(toolUse("WebSearch", "b1", "r2"));
      expect(w.violation).toContain("after the search cap");
    }
  });
});

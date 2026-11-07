// Live calls through the real codebuddy CLI and the logged-in account. Skipped unless LIVE=1;
// costs about one credit.
import { describe, expect, test } from "bun:test";
import { createCodebuddy } from "../src";

const live = process.env.LIVE === "1";
const MODEL = process.env.LIVE_MODEL ?? "deepseek-v4.1-flash";
const codebuddy = createCodebuddy({ timeoutMs: 180_000 });
const prompt = (text: string) => [
  { role: "system" as const, content: "You are terse." },
  { role: "user" as const, content: [{ type: "text" as const, text }] }
];

describe.skipIf(!live)("live codebuddy", () => {
  test("one completion, with usage and credits", async () => {
    const r = await codebuddy(MODEL, { effort: "low" }).doGenerate({ prompt: prompt("Reply with exactly: ok") });
    expect(r.content).toEqual([{ type: "text", text: "ok" }]);
    expect(r.usage.inputTokens.total).toBeGreaterThan(0);
    expect((r.providerMetadata?.codebuddy as { credits: number }).credits).toBeGreaterThan(0);
  }, 180_000);

  test("streaming arrives in pieces", async () => {
    const { stream } = await codebuddy(MODEL, { effort: "low" }).doStream({ prompt: prompt("Count from 1 to 30, comma separated.") });
    const deltas: string[] = [];
    for await (const p of stream) if (p.type === "text-delta") deltas.push(p.delta);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toContain("30");
  }, 180_000);

  test("search mode: searches up to the cap are reported, the rest denied, and the model answers", async () => {
    const queries: string[] = [];
    const model = codebuddy(MODEL, { effort: "low", search: { maxSearches: 1, onSearch: (q) => queries.push(q) } });
    const r = await model.doGenerate({
      prompt: prompt("Do two separate web searches: 'Bun runtime latest version' and 'Deno latest version'. Then answer in one line.")
    });
    expect(queries).toHaveLength(1);
    expect(r.content[0]?.type === "text" && r.content[0].text.length).toBeGreaterThan(0);
  }, 180_000);

  test("the account's models are listed", async () => {
    const models = await codebuddy.listModels();
    const m = models.find((x) => x.id === MODEL);
    expect(m).toBeDefined();
    expect(m!.efforts.length).toBeGreaterThan(0);
  }, 60_000);
});

// Stands in for the codebuddy CLI in the library's tests. FAKE_CB_MODE picks the behaviour.
import { fakeCli } from "../../src/testing";

const mode = process.env.FAKE_CB_MODE ?? "ok";
const text = process.env.FAKE_CB_TEXT ?? "pong";

await fakeCli(async (_call, io) => {
  switch (mode) {
    case "ok":
      io.assistant([{ type: "thinking", thinking: "considering" }]);
      io.assistant([{ type: "text", text }]);
      io.result(true, text);
      break;
    case "search": {
      // FAKE_CB_SEARCHES searches, FAKE_CB_SEARCH_DELAY_MS apart; the model stops at a denial.
      const n = Number(process.env.FAKE_CB_SEARCHES ?? 1);
      for (let i = 1; i <= n; i++) {
        if (!(await io.search(`query ${i}`, "Let me check the terms. "))) break;
        await Bun.sleep(Number(process.env.FAKE_CB_SEARCH_DELAY_MS ?? 0));
      }
      io.assistant([{ type: "text", text }]);
      io.result(true, text);
      break;
    }
    case "search-stubborn":
      // Ignores a denial and keeps searching in the next model request.
      for (let i = 1; i <= 10; i++) await io.search(`query ${i}`);
      io.result(true, "too late");
      break;
    case "search-tool":
      await io.search("query 1");
      io.assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]);
      await Bun.sleep(5_000);
      io.result(true, "too late");
      break;
    case "loop":
      // What --json-schema produced: one init per extra model request, many turns.
      for (let i = 0; i < 6; i++) {
        io.assistant([{ type: "text", text: `turn ${i}` }]);
        io.init();
        await Bun.sleep(200);
      }
      io.result(true, "too late");
      break;
    case "tool":
      io.assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]);
      await Bun.sleep(5_000);
      io.result(true, "too late");
      break;
    case "ratelimit":
      io.result(false, "429 Too Many Requests: rate limit exceeded");
      break;
    case "fail":
      console.error("model not available");
      process.exit(2);
    case "hang":
      await Bun.sleep(60_000);
  }
});

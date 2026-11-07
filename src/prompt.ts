// The user turn as the SDK's user message, and the system prompt separately (it goes to the CLI
// as a file: the SDK would put a string on the command line, and Linux caps one argument at
// 128 KiB). The message itself travels on stdin, so a paper of any size fits.
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { ContentBlock, UserMessage } from "@tencent-ai/agent-sdk";

export function toUserMessage(options: Pick<LanguageModelV3CallOptions, "prompt" | "tools" | "responseFormat">) {
  if (options.tools?.length) throw new Error("codebuddy models are called without tools");
  const system: string[] = [];
  const content: ContentBlock[] = [];
  for (const m of options.prompt) {
    if (m.role === "system") system.push(m.content);
    else if (m.role === "user") {
      for (const part of m.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else content.push(imageBlock(part.mediaType, part.data));
      }
    } else {
      throw new Error(`codebuddy models take one user turn; got a ${m.role} message`);
    }
  }
  if (!content.length) throw new Error("empty prompt");
  // Structured output: the schema goes into the prompt; the caller validates the reply. The
  // CLI's --json-schema is never used: it adds a hook that re-prompts up to 4 times.
  if (options.responseFormat?.type === "json") {
    const schema = options.responseFormat.schema;
    system.push(
      schema
        ? `Reply with only one JSON value that conforms to this JSON Schema, no prose, no code fence:\n${JSON.stringify(schema)}`
        : "Reply with only one JSON value, no prose, no code fence."
    );
  }
  const message: UserMessage = { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content } };
  return { system: system.join("\n\n"), message };
}

function imageBlock(mediaType: string, data: unknown): ContentBlock {
  if (!mediaType.startsWith("image/")) throw new Error(`codebuddy models take images only, got ${mediaType}`);
  const base64 =
    data instanceof Uint8Array ? Buffer.from(data).toString("base64") : typeof data === "string" ? data : null;
  if (base64 === null) throw new Error("images must be passed as bytes or base64, not URLs");
  return { type: "image", source: { type: "base64", media_type: mediaType as any, data: base64 } };
}

// The models the logged-in account can use, as the CLI's model picker sees them.
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_v2_createSession } from "@tencent-ai/agent-sdk";
import { type CodebuddySettings, CODEBUDDY_ENV, resolveCli } from "./model";

export type CodebuddyModelInfo = {
  id: string;
  name: string;
  // Effort levels the model accepts; empty when it takes none. The CLI silently clamps an
  // unsupported level to the next lower one, so callers should check against this list.
  efforts: string[];
  defaultEffort?: string;
  vision: boolean;
  maxInput?: number;
  maxOutput?: number;
  // The account's credit rate for the model as CodeBuddy words it, e.g. "x0.11 credits".
  credits?: string;
};

// Uses the SDK's experimental session API (the one-shot query() has no raw model list). The
// timeout is enforced here: the SDK's requestTimeoutMs becomes --request-timeout-ms, with
// which the CLI (2.181.0) exits before answering.
export async function listModels(config: CodebuddySettings): Promise<CodebuddyModelInfo[]> {
  const dir = join(tmpdir(), "mastra-codebuddy", crypto.randomUUID());
  await mkdir(dir, { recursive: true });
  const session = unstable_v2_createSession({
    pathToCodebuddyCode: resolveCli(config),
    cwd: dir,
    env: { ...CODEBUDDY_ENV, ...config.env },
    persistSession: false
  });
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`codebuddy model list timed out after ${config.timeoutMs / 1000}s`)), config.timeoutMs);
  });
  try {
    const raw = await Promise.race([session.getAvailableModelsRaw(), timeout]);
    return raw
      .filter((m) => !m.disabled)
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        efforts: [...(m.reasoning?.supportedEfforts ?? [])],
        ...(m.reasoning?.defaultEffort ? { defaultEffort: m.reasoning.defaultEffort } : {}),
        vision: !!m.supportsImages && !m.disabledMultimodal,
        ...(m.maxInputTokens ? { maxInput: m.maxInputTokens } : {}),
        ...(m.maxOutputTokens ? { maxOutput: m.maxOutputTokens } : {}),
        ...(m.credits ? { credits: m.credits } : {})
      }));
  } finally {
    clearTimeout(timer);
    session.close();
    await rm(dir, { recursive: true, force: true });
  }
}

import { CodebuddyModel, type CodebuddySettings, type ModelSettings } from "./model";

export { CODEBUDDY_ENV, CodebuddyModel, DEFAULT_MAX_SEARCHES } from "./model";
export type { CodebuddySettings, ModelSettings, SearchMode } from "./model";
export { RateLimitError } from "./errors";
export { toUserMessage } from "./prompt";
export { StreamWatcher } from "./watcher";

// const codebuddy = createCodebuddy({ timeoutMs: 600_000 });
// new Agent({ model: codebuddy("deepseek-v4.1-flash", { effort: "low" }), ... });
export function createCodebuddy(settings: CodebuddySettings) {
  return (modelId: string, model: ModelSettings) => new CodebuddyModel(modelId, model, settings);
}

export type CodebuddyProvider = ReturnType<typeof createCodebuddy>;

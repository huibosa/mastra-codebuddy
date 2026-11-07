import { CodebuddyModel, type CodebuddySettings, type ModelSettings } from "./model";
import { listModels } from "./models";

export { CODEBUDDY_ENV, CodebuddyModel, DEFAULT_MAX_SEARCHES } from "./model";
export type { CodebuddySettings, ModelSettings, SearchMode } from "./model";
export type { CodebuddyModelInfo } from "./models";
export { RateLimitError } from "./errors";
export { toUserMessage } from "./prompt";
export { StreamWatcher } from "./watcher";

// const codebuddy = createCodebuddy({ timeoutMs: 600_000 });
// new Agent({ model: codebuddy("deepseek-v4.1-flash", { effort: "low" }), ... });
// await codebuddy.listModels();
export function createCodebuddy(settings: CodebuddySettings) {
  return Object.assign((modelId: string, model: ModelSettings) => new CodebuddyModel(modelId, model, settings), {
    listModels: () => listModels(settings)
  });
}

export type CodebuddyProvider = ReturnType<typeof createCodebuddy>;

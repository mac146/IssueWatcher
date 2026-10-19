import type { Config, ProviderConfig } from "../config.js";
import { FallbackSummarizer, LlmSummarizer, noSummarizer, type LlmProvider } from "./provider.js";
import { AnthropicProvider, GeminiProvider, OpenAICompatibleProvider } from "./providers.js";
import { RateLimiter, type Summarizer } from "./summarizer.js";

export function createProvider(cfg: ProviderConfig): LlmProvider {
  switch (cfg.kind) {
    case "gemini":
      return new GeminiProvider(cfg.apiKey, cfg.model);
    case "anthropic":
      return new AnthropicProvider({ model: cfg.model, apiKey: cfg.apiKey });
    case "openai-compatible":
      return new OpenAICompatibleProvider({
        name: cfg.name,
        baseUrl: cfg.baseUrl!,
        model: cfg.model,
        apiKey: cfg.apiKey || undefined,
      });
  }
}

/**
 * Builds the summariser from config: one rate limiter per provider (quotas are
 * per key), tried in order. With no provider it returns a summariser that
 * produces nothing, and the digest falls back to excerpts.
 */
export function buildSummarizer(
  config: Pick<Config, "llmProviders" | "maxBodyChars" | "llmRequestsPerMinute">,
): { summarizer: Summarizer; providerNames: string[] } {
  if (!config.llmProviders.length) return { summarizer: noSummarizer, providerNames: [] };

  const chain = config.llmProviders.map((cfg) => {
    const summarizer = new LlmSummarizer(
      createProvider(cfg),
      config.maxBodyChars,
      new RateLimiter(config.llmRequestsPerMinute),
    );
    return { name: summarizer.name, summarizer };
  });
  const providerNames = chain.map((c) => c.name);
  if (chain.length === 1) return { summarizer: chain[0]!.summarizer, providerNames };
  return { summarizer: new FallbackSummarizer(chain), providerNames };
}

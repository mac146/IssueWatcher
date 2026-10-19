import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import axios, { AxiosInstance } from "axios";
import { AuthError, RateLimitError, type LlmProvider } from "./provider.js";
import { parseDurationMs, parseRetryDelayMs } from "./summarizer.js";

const DAY_MS = 86_400_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 30_000;

/** Maps a failed HTTP call onto the error types the retry logic understands. */
export function classifyHttpError(err: unknown): unknown {
  if (!axios.isAxiosError(err) || !err.response) return err;

  const { status, data, headers } = err.response;
  const body = data as { error?: { message?: string; code?: string; type?: string } | string } | undefined;
  const detail = typeof body?.error === "string" ? body.error : body?.error?.message;
  const message = `${status} ${detail ?? err.message}`;

  if (status === 401 || status === 403) return new AuthError(message);

  if (status === 429) {
    const code = typeof body?.error === "object" ? `${body.error.code ?? ""} ${body.error.type ?? ""}` : "";
    // Out of credit is not a burst limit; waiting a minute will not fix it.
    if (/insufficient_quota|billing|credit/i.test(`${code} ${detail ?? ""}`)) {
      return new RateLimitError(message, DAY_MS);
    }
    const header = Number(headers["retry-after"]);
    const waitMs =
      Number.isFinite(header) && header > 0
        ? header * 1000
        : (parseDurationMs(detail ?? "") ?? DEFAULT_RATE_LIMIT_WAIT_MS);
    return new RateLimitError(message, waitMs);
  }
  return new Error(message, { cause: err });
}

export class GeminiProvider implements LlmProvider {
  readonly name: string;
  private readonly model;

  constructor(apiKey: string, modelName: string) {
    this.name = `gemini:${modelName}`;
    this.model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              id: { type: SchemaType.INTEGER },
              summary: { type: SchemaType.STRING },
              fix: { type: SchemaType.STRING },
            },
            required: ["id", "summary", "fix"],
          },
        },
      },
    });
  }

  async complete(prompt: string): Promise<string> {
    try {
      return (await this.model.generateContent(prompt)).response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status;
      const retry = parseRetryDelayMs(err);
      if (retry !== null) throw new RateLimitError(message, retry);
      if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID/i.test(message)) {
        throw new AuthError(message);
      }
      throw err;
    }
  }
}

export type OpenAICompatibleOptions = {
  name: string;
  baseUrl: string;
  model: string;
  /** Optional: local servers such as Ollama need none. */
  apiKey?: string;
  client?: AxiosInstance;
};

/** Speaks the OpenAI chat-completions protocol: OpenAI, Groq, OpenRouter, Ollama, LM Studio, vLLM... */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  private readonly url: string;
  private readonly client: AxiosInstance;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.name = `${opts.name}:${opts.model}`;
    this.url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.client = opts.client ?? axios.create({ timeout: 60_000 });
  }

  async complete(prompt: string): Promise<string> {
    try {
      const res = await this.client.post<{ choices?: Array<{ message?: { content?: string | null } }> }>(
        this.url,
        {
          model: this.opts.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
        },
        { headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {} },
      );
      const text = res.data.choices?.[0]?.message?.content;
      if (!text) throw new Error("Empty response from model");
      return text;
    } catch (err) {
      throw classifyHttpError(err);
    }
  }
}

export type AnthropicOptions = { model: string; apiKey: string; client?: AxiosInstance };

export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  private readonly client: AxiosInstance;

  constructor(private readonly opts: AnthropicOptions) {
    this.name = `anthropic:${opts.model}`;
    this.client = opts.client ?? axios.create({ timeout: 60_000 });
  }

  async complete(prompt: string): Promise<string> {
    try {
      const res = await this.client.post<{ content?: Array<{ type: string; text?: string }> }>(
        "https://api.anthropic.com/v1/messages",
        { model: this.opts.model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] },
        {
          headers: {
            "x-api-key": this.opts.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
        },
      );
      const text = res.data.content?.find((c) => c.type === "text")?.text;
      if (!text) throw new Error("Empty response from model");
      return text;
    } catch (err) {
      throw classifyHttpError(err);
    }
  }
}

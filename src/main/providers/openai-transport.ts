import OpenAI from 'openai';
import type { ProviderHealth } from '../../shared/contracts';
import type { TextCompletion, TextProviderTransport } from './structured-text-provider';

export class OpenAiTransport implements TextProviderTransport {
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new OpenAI({ apiKey });
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await this.client.models.retrieve(this.model);
      return { ok: true, message: 'OpenAI API connection is ready' };
    } catch (error) {
      return { ok: false, message: readableError(error) };
    }
  }

  async complete(prompt: string, signal: AbortSignal): Promise<TextCompletion> {
    const response = await this.client.responses.create(
      {
        model: this.model,
        input: prompt,
        text: { format: { type: 'json_object' } }
      },
      { signal }
    );
    return {
      text: response.output_text,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    };
  }
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : 'OpenAI connection failed';
}

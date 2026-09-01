import Anthropic from '@anthropic-ai/sdk';
import type { ProviderHealth } from '../../shared/contracts';
import type { TextCompletion, TextProviderTransport } from './structured-text-provider';

export class AnthropicTransport implements TextProviderTransport {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with OK.' }]
      });
      return { ok: true, message: 'Anthropic API connection is ready' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Anthropic connection failed' };
    }
  }

  async complete(prompt: string, signal: AbortSignal): Promise<TextCompletion> {
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 8_192,
        messages: [{ role: 'user', content: prompt }]
      },
      { signal }
    );
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens
    };
  }
}

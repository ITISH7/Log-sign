import type { ProviderAdapter } from '../../shared/contracts';
import type { ProviderProfileRecord, ProviderRepository } from '../repositories/provider-repository';
import { AnthropicTransport } from './anthropic-transport';
import { createClaudeSubscriptionTransport } from './cli-transport';
import { CodexAppServerTransport } from './codex-app-server-transport';
import { OpenAiTransport } from './openai-transport';
import { StructuredTextProvider, type TextCompletion, type TextProviderTransport } from './structured-text-provider';

export class ProviderFactory {
  constructor(private readonly profiles: ProviderRepository) {}

  resolve(profileId?: string): ProviderAdapter {
    return new StructuredTextProvider(this.resolveTransport(profileId));
  }

  resolveTransport(profileId?: string): TextProviderTransport {
    const profile = this.resolveProfile(profileId);
    let transport: TextProviderTransport;
    switch (profile.kind) {
      case 'openai-api': {
        const key = this.requireCredential(profile);
        transport = new OpenAiTransport(key, profile.model);
        break;
      }
      case 'anthropic-api': {
        const key = this.requireCredential(profile);
        transport = new AnthropicTransport(key, profile.model);
        break;
      }
      case 'codex-subscription':
        transport = new CodexAppServerTransport(profile.model);
        break;
      case 'claude-subscription':
        transport = createClaudeSubscriptionTransport();
        break;
    }
    return new TimeoutTransport(transport, readTimeout(profile));
  }

  resolveProfile(profileId?: string): ProviderProfileRecord {
    const profile = profileId
      ? this.profiles.get(profileId)
      : this.profiles.list().find((candidate) => candidate.isDefault && candidate.enabled);
    if (!profile) throw new Error('Choose and configure an AI profile first');
    if (!profile.enabled) throw new Error(`AI profile “${profile.name}” is disabled`);
    return profile;
  }

  private requireCredential(profile: ProviderProfileRecord): string {
    const credential = this.profiles.getCredential(profile.id);
    if (!credential) throw new Error(`AI profile “${profile.name}” has no credential`);
    return credential;
  }
}

class TimeoutTransport implements TextProviderTransport {
  constructor(
    private readonly transport: TextProviderTransport,
    private readonly timeoutMs: number
  ) {}

  async healthCheck() {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.transport.healthCheck(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`Provider health check timed out after ${this.timeoutMs}ms`));
          }, this.timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  complete(prompt: string, signal: AbortSignal): Promise<TextCompletion> {
    return this.transport.complete(prompt, AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]));
  }
}

function readTimeout(profile: ProviderProfileRecord): number {
  const configured = profile.settings.timeoutMs;
  return typeof configured === 'number' && configured >= 1_000 ? configured : 120_000;
}

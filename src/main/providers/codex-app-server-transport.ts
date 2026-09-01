import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ProviderHealth } from '../../shared/contracts';
import type { TextCompletion, TextProviderTransport } from './structured-text-provider';

export interface AppServerProcess {
  stdout: Readable;
  stdin: Writable;
  stderr: Readable;
  kill(): boolean;
}

export type SpawnAppServer = (cwd: string) => Promise<AppServerProcess>;

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class CodexAppServerTransport implements TextProviderTransport {
  constructor(
    private readonly model: string,
    private readonly spawnServer: SpawnAppServer = defaultSpawn
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    try {
      return await this.withServer(async (client) => {
        const result = await client.request<{ account?: { type?: string; email?: string; planType?: string } }>(
          'account/read', { refreshToken: false }
        );
        if (!result.account) return { ok: false, message: 'Codex is installed but not signed in. Use Connect in Settings.' };
        const detail = result.account.email ?? result.account.planType ?? result.account.type ?? 'account';
        return { ok: true, message: `Codex App Server is ready (${detail})` };
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Codex App Server is unavailable' };
    }
  }

  async complete(prompt: string, signal: AbortSignal): Promise<TextCompletion> {
    if (signal.aborted) throw new DOMException('Generation cancelled', 'AbortError');
    return this.withServer(async (client, workspace) => {
      const thread = await client.request<{ thread: { id: string } }>('thread/start', {
        model: this.model,
        cwd: workspace,
        ephemeral: true
      });
      let finalText = '';
      let turnId = '';
      let resolveTurn!: () => void;
      let rejectTurn!: (reason: Error) => void;
      const completed = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      const stopListening = client.onNotification((message) => {
        if (message.method === 'item/completed') {
          const item = message.params?.item as { type?: string; text?: string } | undefined;
          if (item?.type === 'agentMessage' && item.text) finalText = item.text;
        }
        if (message.method === 'turn/completed') {
          const turn = message.params?.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
          if (turn?.status && !['completed', 'success'].includes(turn.status)) {
            rejectTurn(new Error(turn.error?.message ?? `Codex turn ended with status ${turn.status}`));
          } else resolveTurn();
        }
      });
      const onAbort = () => {
        if (turnId) void client.request('turn/interrupt', { threadId: thread.thread.id, turnId }).catch(() => undefined);
        rejectTurn(new DOMException('Generation cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await client.request<{ turn: { id: string } }>('turn/start', {
          threadId: thread.thread.id,
          input: [{ type: 'text', text: `Do not call tools or access files. Transform only the supplied data.\n\n${prompt}` }],
          cwd: workspace,
          model: this.model,
          approvalPolicy: 'never',
          sandboxPolicy: {
            type: 'readOnly',
            access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [workspace] }
          }
        });
        turnId = response.turn.id;
        await completed;
        if (!finalText) throw new Error('Codex App Server returned no final report message');
        return { text: finalText };
      } finally {
        signal.removeEventListener('abort', onAbort);
        stopListening();
      }
    });
  }

  async login(openUrl: (url: string) => Promise<unknown>, signal = new AbortController().signal): Promise<void> {
    await this.withServer(async (client) => {
      let resolveLogin!: () => void;
      let rejectLogin!: (reason: Error) => void;
      const completed = new Promise<void>((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });
      const stopListening = client.onNotification((message) => {
        if (message.method !== 'account/login/completed') return;
        const success = message.params?.success;
        if (success) resolveLogin();
        else rejectLogin(new Error(String(message.params?.error ?? 'Codex sign-in failed')));
      });
      const onAbort = () => rejectLogin(new DOMException('Codex sign-in cancelled', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await client.request<{ authUrl: string }>('account/login/start', {
          type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt'
        });
        await openUrl(result.authUrl);
        await completed;
      } finally {
        signal.removeEventListener('abort', onAbort);
        stopListening();
      }
    });
  }

  private async withServer<T>(operation: (client: RpcClient, workspace: string) => Promise<T>): Promise<T> {
    const workspace = await mkdtemp(join(tmpdir(), 'dsr-codex-app-server-'));
    let process: AppServerProcess | undefined;
    try {
      process = await this.spawnServer(workspace);
      const client = new RpcClient(process);
      await client.request('initialize', {
        clientInfo: { name: 'dsr_creator', title: 'DSR Creator', version: '0.1.0' }
      });
      client.notify('initialized', {});
      return await operation(client, workspace);
    } finally {
      process?.kill();
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private stderr = '';

  constructor(private readonly process: AppServerProcess) {
    process.stderr.setEncoding('utf8').on('data', (chunk) => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-2_000); });
    const lines = createInterface({ input: process.stdout });
    lines.on('line', (line) => this.receive(line));
    process.stdout.once('error', (error) => this.rejectAll(error));
  }

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  onNotification(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex App Server request failed'));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.process.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'DSR Creator disables agent tools and approvals' } })}\n`);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  private rejectAll(error: Error): void {
    const detail = this.stderr.trim();
    for (const pending of this.pending.values()) pending.reject(new Error(detail || error.message));
    this.pending.clear();
  }
}

async function defaultSpawn(cwd: string): Promise<AppServerProcess> {
  return await new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' }
    });
    child.once('spawn', () => resolve(child as AppServerProcess));
    child.once('error', reject);
  });
}

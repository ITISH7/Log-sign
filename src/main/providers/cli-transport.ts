import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderHealth } from '../../shared/contracts';
import type { TextCompletion, TextProviderTransport } from './structured-text-provider';

type OutputParser = (stdout: string) => string;

export class CliTransport implements TextProviderTransport {
  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly parseOutput: OutputParser
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const result = await runProcess(this.command, ['--version'], '', undefined, process.cwd());
      return { ok: true, message: `${this.command} is ready`, runtimeVersion: result.stdout.trim() };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : `${this.command} was not found`
      };
    }
  }

  async complete(prompt: string, signal: AbortSignal): Promise<TextCompletion> {
    const directory = await mkdtemp(join(tmpdir(), 'dsr-agent-'));
    try {
      const result = await runProcess(this.command, this.args, prompt, signal, directory);
      return { text: this.parseOutput(result.stdout) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export function createClaudeSubscriptionTransport(): CliTransport {
  return new CliTransport(
    'claude',
    ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', ''],
    (stdout) => {
      const parsed = JSON.parse(stdout) as { result?: string };
      if (!parsed.result) throw new Error('Claude Code did not return a report result');
      return parsed.result;
    }
  );
}

export function createCodexSubscriptionTransport(): CliTransport {
  return new CliTransport(
    'codex',
    ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-'],
    (stdout) => {
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      for (const line of lines.reverse()) {
        const event = JSON.parse(line) as {
          type?: string;
          item?: { type?: string; text?: string };
          message?: string;
        };
        if (event.item?.type === 'agent_message' && event.item.text) return event.item.text;
        if (event.type === 'message' && event.message) return event.message;
      }
      throw new Error('Codex did not return a final report message');
    }
  );
}

function runProcess(
  command: string,
  args: string[],
  stdin: string,
  signal: AbortSignal | undefined,
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' }
    });
    let stdout = '';
    let stderr = '';
    const maximumOutput = 8 * 1024 * 1024;
    let settled = false;
    const append = (current: string, chunk: unknown) => {
      const next = current + String(chunk);
      if (Buffer.byteLength(next) > maximumOutput) {
        child.kill();
        if (!settled) {
          settled = true;
          reject(new Error(`${command} exceeded the ${maximumOutput / 1024 / 1024} MB output limit`));
        }
      }
      return next.slice(-maximumOutput);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout = append(stdout, chunk)));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr = append(stderr, chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(stdin);
  });
}

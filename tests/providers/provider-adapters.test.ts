import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { CodexAppServerTransport, type AppServerProcess } from '../../src/main/providers/codex-app-server-transport';
import {
  StructuredTextProvider,
  type TextCompletion,
  type TextProviderTransport
} from '../../src/main/providers/structured-text-provider';
import type { GenerationRequest, ProviderHealth } from '../../src/shared/contracts';

function request(contextLimit = 32_768): GenerationRequest {
  return {
    entries: [
      {
        id: 'entry-1',
        workDate: '2026-08-31',
        note: 'Finished encrypted database and template tests',
        standardValues: { project: 'DSR Creator', status: 'done' },
        customValues: {},
        tags: ['testing'],
        createdAt: '2026-08-31T09:00:00.000Z',
        updatedAt: '2026-08-31T09:00:00.000Z'
      }
    ],
    blueprint: {
      schemaVersion: 1,
      templateVersionId: 'version-1',
      sections: [{ id: 'done', title: 'Completed', kind: 'bullets', sourceFields: ['note'], required: true }],
      fieldMappings: [],
      narrativeRules: [{ sectionId: 'done', instruction: 'Summarize completed work' }],
      outputLayouts: {}
    },
    dateFrom: '2026-08-31',
    dateTo: '2026-08-31',
    model: 'configured-model',
    contextLimit
  };
}

class SequenceTransport implements TextProviderTransport {
  readonly prompts: string[] = [];
  constructor(private readonly completions: TextCompletion[]) {}
  async healthCheck(): Promise<ProviderHealth> {
    return { ok: true, message: 'Connected' };
  }
  async complete(prompt: string): Promise<TextCompletion> {
    this.prompts.push(prompt);
    return this.completions.shift() ?? { text: '{}' };
  }
}

const validDraft = JSON.stringify({
  schemaVersion: 1,
  metadata: {
    title: 'Daily Status Report',
    dateFrom: '2026-08-31',
    dateTo: '2026-08-31',
    generatedAt: '2026-08-31T18:00:00.000Z'
  },
  sections: [{ id: 'done', title: 'Completed', kind: 'bullets', items: ['Finished encrypted storage'] }],
  warnings: []
});

describe('StructuredTextProvider', () => {
  it('repairs malformed structured output exactly once', async () => {
    const transport = new SequenceTransport([{ text: 'not-json' }, { text: validDraft }]);
    const provider = new StructuredTextProvider(transport);

    const draft = await provider.generateStructured(request(), new AbortController().signal);

    expect(draft.sections[0]?.items).toEqual(['Finished encrypted storage']);
    expect(transport.prompts).toHaveLength(2);
    expect(transport.prompts[1]).toContain('Repair the invalid response');
  });

  it('fails after one repair attempt instead of returning corrupt data', async () => {
    const provider = new StructuredTextProvider(
      new SequenceTransport([{ text: '{}' }, { text: '{"schemaVersion":1}' }])
    );

    await expect(
      provider.generateStructured(request(), new AbortController().signal)
    ).rejects.toThrow('Provider returned invalid structured report data');
  });

  it('repairs schema-valid output that does not match the selected template and dates', async () => {
    const wrong = JSON.stringify({
      schemaVersion: 1,
      metadata: {
        title: 'Unrelated', dateFrom: '2026-08-30', dateTo: '2026-08-30', generatedAt: '2026-08-31T18:00:00.000Z'
      },
      sections: [{ id: 'other', title: 'Other', kind: 'paragraph', text: 'Wrong report' }],
      warnings: []
    });
    const transport = new SequenceTransport([{ text: wrong }, { text: validDraft }]);

    const draft = await new StructuredTextProvider(transport).generateStructured(
      request(), new AbortController().signal
    );

    expect(draft.sections[0]?.id).toBe('done');
    expect(transport.prompts).toHaveLength(2);
    expect(transport.prompts[1]).toContain('Required template blueprint');
  });

  it('marks input for chunking at 75 percent of the model context', async () => {
    const provider = new StructuredTextProvider(new SequenceTransport([]));
    const smallLimit = request(80);

    const estimate = await provider.estimateTokens(smallLimit);

    expect(estimate.inputTokens).toBeGreaterThan(60);
    expect(estimate.requiresChunking).toBe(true);
  });

  it('does not call a provider after cancellation', async () => {
    const transport = new SequenceTransport([{ text: validDraft }]);
    const provider = new StructuredTextProvider(transport);
    const controller = new AbortController();
    controller.abort();

    await expect(provider.generateStructured(request(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(transport.prompts).toEqual([]);
  });
});

describe('CodexAppServerTransport', () => {
  it('uses the documented initialize/thread/turn sequence in an isolated read-only workspace', async () => {
    const serverOutput = new PassThrough();
    const requests: Array<Record<string, unknown>> = [];
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString()) as { id?: number; method: string; params?: Record<string, unknown> };
        requests.push(request);
        if (request.id !== undefined) {
          if (request.method === 'initialize') serverOutput.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
          if (request.method === 'thread/start') serverOutput.write(`${JSON.stringify({ id: request.id, result: { thread: { id: 'thread-1' } } })}\n`);
          if (request.method === 'turn/start') {
            serverOutput.write(`${JSON.stringify({ id: request.id, result: { turn: { id: 'turn-1' } } })}\n`);
            serverOutput.write(`${JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', text: validDraft } } })}\n`);
            serverOutput.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })}\n`);
          }
        }
        callback();
      }
    });
    const process: AppServerProcess = { stdout: serverOutput, stdin, stderr: new PassThrough(), kill: () => true };
    const transport = new CodexAppServerTransport('configured-model', async () => process);

    const completion = await transport.complete('Create JSON only', new AbortController().signal);

    expect(completion.text).toBe(validDraft);
    expect(requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    const turn = requests.find((request) => request.method === 'turn/start');
    expect(turn?.params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', access: { type: 'restricted' } }
    });
  });

  it('rejects pending RPC calls and terminates the process when the app server exits', async () => {
    const events = new EventEmitter();
    const serverOutput = new PassThrough();
    let killed = false;
    let markRequestWritten!: () => void;
    const requestWritten = new Promise<void>((resolve) => { markRequestWritten = resolve; });
    const process: AppServerProcess = {
      stdout: serverOutput,
      stderr: new PassThrough(),
      stdin: new Writable({ write(_chunk, _encoding, callback) { markRequestWritten(); callback(); } }),
      kill: () => { killed = true; return true; },
      once: (event, listener) => events.once(event, listener)
    };
    const transport = new CodexAppServerTransport('configured-model', async () => process);
    const completion = transport.complete('Create JSON only', new AbortController().signal);
    await requestWritten;
    events.emit('exit', 2);

    await expect(completion).rejects.toThrow('exited with code 2');
    expect(killed).toBe(true);
  });
});

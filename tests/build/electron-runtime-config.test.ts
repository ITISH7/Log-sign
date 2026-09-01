import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import electronViteConfig from '../../electron.vite.config';

const projectRoot = resolve(import.meta.dirname, '../..');

function flattenPlugins(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(flattenPlugins);
  return value && typeof value === 'object' ? [value as Record<string, unknown>] : [];
}

describe('Electron runtime configuration', () => {
  it('builds a CommonJS preload that a sandboxed renderer can execute', () => {
    const build = spawnSync(
      process.execPath,
      [resolve(projectRoot, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'],
      { cwd: projectRoot, encoding: 'utf8' }
    );

    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const preloadPath = resolve(projectRoot, 'out/preload/index.cjs');
    expect(existsSync(preloadPath)).toBe(true);
    expect(readFileSync(preloadPath, 'utf8')).not.toMatch(/^\s*import\s/m);
  });

  it('allows the Vite websocket only in development HTML', async () => {
    const renderer = (electronViteConfig as {
      renderer?: { plugins?: unknown };
    }).renderer;
    const plugin = flattenPlugins(renderer?.plugins).find(
      (candidate) => candidate.name === 'dsr-development-csp'
    );

    expect(plugin).toBeDefined();
    if (!plugin) return;
    const hook = plugin.transformIndexHtml as
      | ((html: string) => string | Promise<string>)
      | { handler: (html: string) => string | Promise<string> };
    const transform = typeof hook === 'function' ? hook : hook.handler;
    const productionHtml = "<meta http-equiv=\"Content-Security-Policy\" content=\"connect-src 'none'\">";

    await expect(Promise.resolve(transform(productionHtml))).resolves.toContain(
      "connect-src 'self' ws://localhost:* ws://127.0.0.1:*"
    );
    expect(productionHtml).toContain("connect-src 'none'");
  });
});

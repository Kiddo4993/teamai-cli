import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ repoPath: '', output: false, events: [] as string[] }));

vi.mock('../utils/teamwiki-root.js', () => ({
  resolveTeamwiki: vi.fn(async (opts: { output?: string }) => (
    opts.output
      ? { wikiRoot: path.resolve(opts.output, 'teamwiki') }
      : { wikiRoot: path.join(state.repoPath, 'teamwiki'), team: { localConfig: { repo: { localPath: state.repoPath } } } }
  )),
  assertTeamwikiWritable: vi.fn(async () => undefined),
  lockTeamwiki: vi.fn(async () => {
    state.events.push('lock');
    return async () => { state.events.push('release'); };
  }),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  pushRepoDirectly: vi.fn(async () => { state.events.push('push'); }),
}));

vi.mock('../deep-enrich.js', () => ({
  deepEnrich: vi.fn(async () => {
    state.events.push('enrich');
    return { complete: true, missingComponents: [], missingArchitecture: false };
  }),
}));

import { codebaseCmd } from '../codebase-cmd.js';
import { pushRepoDirectly } from '../utils/git.js';
import { log } from '../utils/logger.js';

function createTeamwiki(root: string, project = 'svc'): void {
  const evidenceDir = path.join(root, 'teamwiki', 'evidence', 'code', project);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, '_manifest.json'), JSON.stringify({ components: [{ slug: 'lib' }] }));
}

beforeEach(() => {
  state.repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-deep-enrich-publish-'));
  state.events = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.mocked(pushRepoDirectly).mockClear();
  fs.rmSync(state.repoPath, { recursive: true, force: true });
});

describe('codebase --deep-enrich publishing (#1537)', () => {
  it('publishes the docs it wrote into the team repo, under the import lock', async () => {
    createTeamwiki(state.repoPath);

    await codebaseCmd({ deepEnrich: true, project: 'svc' });

    expect(process.exitCode).toBeUndefined();
    expect(pushRepoDirectly).toHaveBeenCalledWith(state.repoPath, '[teamai] Deep enrich: svc', ['.']);
    expect(state.events).toEqual(['lock', 'enrich', 'push', 'release']);
  });

  it('reports a failed publish as an error and exits 1', async () => {
    createTeamwiki(state.repoPath);
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    vi.mocked(pushRepoDirectly).mockRejectedValueOnce(new Error('rejected: non-fast-forward'));

    await codebaseCmd({ deepEnrich: true, project: 'svc' });

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rejected: non-fast-forward'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('teamai pull'));
    expect(state.events).toEqual(['lock', 'enrich', 'release']);
  });

  it('publishes nothing for an --output teamwiki', async () => {
    createTeamwiki(state.repoPath);

    await codebaseCmd({ deepEnrich: true, project: 'svc', output: state.repoPath });

    expect(pushRepoDirectly).not.toHaveBeenCalled();
    expect(state.events).toEqual(['lock', 'enrich', 'release']);
  });

  it('publishes nothing on a dry run', async () => {
    createTeamwiki(state.repoPath);

    await codebaseCmd({ deepEnrich: true, project: 'svc', dryRun: true });

    expect(pushRepoDirectly).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });
});

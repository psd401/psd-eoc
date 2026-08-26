import { describe, expect, it } from 'bun:test';

import { readSourceRevision } from '../src/source-revision';

const SHA = 'a'.repeat(40);

describe('deployment source revision', () => {
  it('makes protected cleanliness intrinsic to the deploy command', async () => {
    const manifest = await Bun.file(
      new URL('../package.json', import.meta.url),
    ).json();
    expect(manifest.scripts.deploy).toContain(
      'PSD_EOC_ENFORCE_DEPLOYMENT_TARGET=true cdk deploy',
    );
  });

  it('uses the exact clean Git HEAD', () => {
    const calls: string[][] = [];
    expect(
      readSourceRevision({
        enforceClean: true,
        repositoryRoot: '/synthetic/repository',
        runGit: (args) => {
          calls.push(args);
          return args[0] === 'rev-parse' ? `${SHA}\n` : '';
        },
      }),
    ).toBe(SHA);
    expect(calls).toEqual([
      ['rev-parse', '--verify', 'HEAD'],
      ['status', '--porcelain=v1', '--untracked-files=normal'],
    ]);
  });

  it('refuses a dirty protected deployment', () => {
    expect(() =>
      readSourceRevision({
        enforceClean: true,
        repositoryRoot: '/synthetic/repository',
        runGit: (args) =>
          args[0] === 'rev-parse' ? SHA : ' M infra/src/example.ts\n',
      }),
    ).toThrow('Protected deployment requires a clean Git worktree.');
  });

  it('rejects an unavailable or malformed commit identity', () => {
    for (const revision of ['', 'main', 'A'.repeat(40), '0'.repeat(40)]) {
      expect(() =>
        readSourceRevision({
          enforceClean: false,
          repositoryRoot: '/synthetic/repository',
          runGit: () => revision,
        }),
      ).toThrow('Git HEAD is unavailable for deployment provenance.');
    }
  });
});

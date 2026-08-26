import { execFileSync } from 'node:child_process';

interface SourceRevisionOptions {
  readonly enforceClean: boolean;
  readonly repositoryRoot: string;
  readonly runGit?: (arguments_: string[]) => string;
}

/** Resolves the local commit whose exact bytes CDK packages into the image. */
export function readSourceRevision(options: SourceRevisionOptions): string {
  const runGit =
    options.runGit ??
    ((arguments_: string[]) =>
      execFileSync('git', arguments_, {
        cwd: options.repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      }));
  let revision: string;
  try {
    revision = runGit(['rev-parse', '--verify', 'HEAD']).trim();
  } catch {
    throw new Error('Git HEAD is unavailable for deployment provenance.');
  }
  if (!/^[a-f0-9]{40}$/u.test(revision) || /^0{40}$/u.test(revision)) {
    throw new Error('Git HEAD is unavailable for deployment provenance.');
  }
  if (options.enforceClean) {
    let status: string;
    try {
      status = runGit(['status', '--porcelain=v1', '--untracked-files=normal']);
    } catch {
      throw new Error('Protected deployment requires a clean Git worktree.');
    }
    if (status.trim().length > 0) {
      throw new Error('Protected deployment requires a clean Git worktree.');
    }
  }
  return revision;
}

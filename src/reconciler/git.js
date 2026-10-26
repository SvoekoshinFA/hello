/**
 * Thin, safe wrapper over the git CLI. Arguments are always passed as an array
 * (never through a shell) and every non-zero exit code is turned into a GitError.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export class GitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GitError';
    this.code = details.code ?? 'GIT_FAILED';
    this.args = details.args;
    this.status = details.status;
    this.stderr = details.stderr;
  }
}

/** Runs git; returns stdout. With allowFailure returns { status, stdout } instead of throwing. */
export function git(cwd, args, { env = {}, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    windowsHide: true,
  });
  if (result.error) {
    throw new GitError(`Failed to run git: ${result.error.message}`, { args });
  }
  if (allowFailure) return { status: result.status, stdout: result.stdout };
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new GitError(`git ${args[0]} failed (exit ${result.status}): ${stderr}`, {
      args,
      status: result.status,
      stderr,
    });
  }
  return result.stdout;
}

/** Describes the repository containing cwd. Throws GitError(NOT_A_REPO) outside a repository. */
export function getRepoInfo(cwd) {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    throw new GitError(`Not inside a Git working tree: ${cwd}`, { code: 'NOT_A_REPO' });
  }
  const commonDir = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']).trim());
  const gitDir = path.resolve(cwd, git(cwd, ['rev-parse', '--git-dir']).trim());
  const headRef = git(cwd, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true });
  const head = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { allowFailure: true });
  return {
    commonDir,
    gitDir,
    ref: headRef.status === 0 ? headRef.stdout.trim() : null,
    head: head.status === 0 ? head.stdout.trim() : null,
  };
}

/** Subjects of all commits reachable from HEAD, newest first. */
export function readSubjects(cwd) {
  const out = git(cwd, ['log', '-z', '--format=%H%x1f%s', 'HEAD']);
  return out
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [hash, ...rest] = record.split('\x1f');
      return { hash: hash.trim(), subject: rest.join('\x1f') };
    });
}

/** Paths reported by `git status` (staged, unstaged and untracked). Empty when clean. */
export function dirtyPaths(cwd) {
  const out = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return out.split('\0').filter(Boolean);
}

const BUSY_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'];

/** Name of an in-progress operation (merge, rebase, ...) or null. */
export function busyOperation(gitDir) {
  return BUSY_MARKERS.find((name) => existsSync(path.join(gitDir, name))) ?? null;
}

/**
 * Creates a commit with the same tree as `parent` (no content change, so no working-tree or
 * index files can leak into it) and moves `ref` forward only if it still points at `parent`.
 */
export function createCommit(cwd, { ref, parent, message, utcDate }) {
  const tree = git(cwd, ['rev-parse', `${parent}^{tree}`]).trim();
  const dateEnv = { GIT_AUTHOR_DATE: utcDate, GIT_COMMITTER_DATE: utcDate };
  const commit = git(cwd, ['commit-tree', tree, '-p', parent, '-m', message], { env: dateEnv }).trim();
  git(cwd, ['update-ref', '-m', 'ticker: create pixel commit', ref, commit, parent]);
  return commit;
}

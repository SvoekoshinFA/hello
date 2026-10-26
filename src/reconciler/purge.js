/**
 * Removes every marker commit ("[ticker:v1 ...]") from the current branch by rewriting history.
 *   node src/reconciler/purge.js [--write] [--repo <dir>]
 * Without --write it only reports what would be removed. Destructive part, when --write is given:
 *  - the old branch tip is saved first as refs/ticker-backup/<UTC timestamp> (restore: git reset --hard <that ref>);
 *  - marker commits have the same tree as their parent, so file contents never change;
 *  - other commits are re-created with the same tree, message, author and committer (signatures are lost);
 *  - only the current branch is rewritten; merge commits are kept, with their parents remapped;
 *  - nothing is pushed; a branch that was already pushed needs a manual force push.
 * Exit code: 0 ok, 1 failure, 2 bad usage.
 */
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { busyOperation, getRepoInfo, git } from './git.js';
import { acquireLock } from './lock.js';
import { parseSubject } from './markers.js';

const LOCK_FILE = 'ticker-reconcile.lock';
const FIELDS = ['hash', 'parents', 'tree', 'an', 'ae', 'ad', 'cn', 'ce', 'cd', 'subject', 'body'];

function readHistory(cwd) {
  const format = ['%H', '%P', '%T', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s', '%b'].join('%x1f');
  return git(cwd, ['log', '--reverse', '--topo-order', '-z', `--format=${format}`, 'HEAD'])
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const values = record.split('\x1f');
      const commit = Object.fromEntries(FIELDS.map((name, i) => [name, values[i] ?? '']));
      commit.parents = commit.parents.split(' ').filter(Boolean);
      return commit;
    });
}

/** Returns { removed, kept, rewritten, backupRef, newHead } and rewrites the branch only with write: true. */
export function purge({ write = false, cwd = process.cwd() } = {}) {
  const info = getRepoInfo(cwd);
  if (!info.ref) throw new Error('Refusing to rewrite a detached HEAD');
  if (!info.head) throw new Error('Repository has no commits');
  let release = null;
  try {
    if (write) {
      release = acquireLock(path.join(info.commonDir, LOCK_FILE));
      const busy = busyOperation(info.gitDir);
      if (busy) throw new Error(`Refusing to rewrite while a Git operation is in progress (${busy})`);
    }
    const history = readHistory(cwd);
    const isMarker = (commit) => parseSubject(commit.subject) !== null;
    const removed = history.filter(isMarker).length;
    const kept = history.length - removed;
    const result = { removed, kept, rewritten: 0, backupRef: null, newHead: info.head, written: false };
    if (removed === 0) return result;
    if (kept === 0) throw new Error('Refusing to remove every commit of the branch');

    // mapped: old hash -> new hash of its nearest surviving ancestor (null if none)
    const mapped = new Map();
    let rewritten = 0;
    for (const commit of history) {
      const newParents = [...new Set(commit.parents.map((parent) => mapped.get(parent)).filter(Boolean))];
      if (isMarker(commit)) {
        mapped.set(commit.hash, newParents[0] ?? null);
        continue;
      }
      if (newParents.join() === commit.parents.join()) {
        mapped.set(commit.hash, commit.hash);
        continue;
      }
      rewritten++;
      if (!write) {
        mapped.set(commit.hash, `(new:${commit.hash})`);
        continue;
      }
      const message = commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject;
      const args = ['commit-tree', commit.tree, ...newParents.flatMap((parent) => ['-p', parent]), '-m', message.replace(/\s+$/, '')];
      const env = {
        GIT_AUTHOR_NAME: commit.an,
        GIT_AUTHOR_EMAIL: commit.ae,
        GIT_AUTHOR_DATE: commit.ad,
        GIT_COMMITTER_NAME: commit.cn,
        GIT_COMMITTER_EMAIL: commit.ce,
        GIT_COMMITTER_DATE: commit.cd,
      };
      mapped.set(commit.hash, git(cwd, args, { env }).trim());
    }
    result.rewritten = rewritten;
    if (!write) return result;

    const newHead = mapped.get(info.head);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
    const backupRef = `refs/ticker-backup/${stamp}`;
    git(cwd, ['update-ref', backupRef, info.head]);
    git(cwd, ['update-ref', '-m', 'ticker: purge marker commits', info.ref, newHead, info.head]);
    return { ...result, newHead, backupRef, written: true };
  } finally {
    release?.();
  }
}

export function run(argv, { out = console, cwd } = {}) {
  let write = false;
  let repo = cwd;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write') write = true;
    else if (argv[i] === '--repo' && argv[i + 1]) repo = argv[++i];
    else {
      out.error(`Unknown argument ${argv[i]}\nUsage: node src/reconciler/purge.js [--write] [--repo <dir>]`);
      return 2;
    }
  }
  try {
    out.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', ...purge({ write, cwd: repo }) }, null, 2));
    return 0;
  } catch (error) {
    out.error(`${error.name}: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = run(process.argv.slice(2));
}

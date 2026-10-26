# Reconciler

Brings the Git history of the current branch in line with the pixel map produced by the [Pattern module](../pattern/README.md). Pattern is the only source of truth for *which* pixels are on and *how many* commits each needs; Git history is the only source of truth for *which commits already exist*. Re-running with the same parameters never creates extra commits once the target is reached.

It is a one-shot library function: no daemon, scheduler, timers, push, GitHub API or network access.

## API

```js
import { reconcile } from './reconciler.js';

const report = reconcile({
  startDate: '2019-10-20',   // inclusive; 'YYYY-MM-DD' or { year, month, day }
  endDate: '2019-11-30',     // inclusive
  dryRun: true,              // default; only analyze and report
  cwd: '/path/in/repo',      // optional, default process.cwd()
  pattern,                   // optional Pattern instance, e.g. createPattern({ targetCommits: 5 })
  now: () => Date.now(),     // optional clock (ms); only prevents future-dated commits
});
```

`reconcile` is the single entry point. The plan is `report.plan` (`[{ date, index }]`); with `dryRun: false` the same call performs it. The number of commits per pixel is set through Pattern (`createPattern({ targetCommits })`).

### Report

| Field | Meaning |
|---|---|
| `dryRun`, `startDate`, `endDate`, `branch` | Echo of the normalized request |
| `datesChecked` | Days in the range |
| `datesWithPixels` | Days whose target is above zero |
| `commitsExisting` | Valid generator commits already present for the range |
| `commitsPlanned` | Missing commits that would be / were written (`plan`) |
| `commitsCreated` | Commits written by this call (always `0` in dry-run) |
| `datesAlreadyCorrect` | Days with nothing missing, no warnings, no errors |
| `datesWithWarnings` | Days with warnings |
| `warnings`, `errors` | `{ code, message, ... }` diagnostics |
| `ok` | `true` only when `errors` is empty |

Warning codes: `EXTRA_COMMITS` (more commits than the target), `UNEXPECTED_COMMITS` (commits on a date whose pixel is off), `FUTURE_DATE` (commit time would be after `now`, skipped). Error codes: `DUPLICATE_INDEX`, `INVALID_MARKER`, `VERIFY_FAILED`, `GIT_FAILED`.

Invalid input throws `TypeError`/`RangeError` (empty range, `start > end`, nonexistent date such as `2023-02-29`, non-boolean `dryRun`). Environment problems throw `ReconcilerError` (`DIRTY_WORKTREE`, `DETACHED_HEAD`, `NO_COMMITS`, `REPO_BUSY`), `GitError` (`NOT_A_REPO`, failed git command) or `LockError` (`LOCKED`). A throw after some commits were written carries the partial result in `error.report`. Callers should treat a throw or `ok === false` as a non-zero exit.

## Commit markers

A generator commit subject starts with a machine-readable marker:

```
[ticker:v1 date=2026-10-26 index=1] pixel 2026-10-26 #1
```

- `date` is the pixel's calendar date; `index` is 1-based per date.
- Only the **start of the subject** is parsed. Commits without the marker, including ones that merely quote it elsewhere, are ordinary commits and are ignored.
- A subject starting with `[ticker:` that is malformed (bad date, `index=0`, unknown version, ...) is an `INVALID_MARKER` error. It cannot be attributed to a date, so **all writing is suspended** until it is fixed. Existing commits are never re-labelled.
- Duplicate `(date, index)` pairs are a `DUPLICATE_INDEX` error; writing is skipped for those dates only.

Reconciliation per date (target 3): none → create 1,2,3; `{1}` → 2,3; `{1,3}` → 2; `{1,2,3}` → nothing; `{1,2,3,4}` → nothing, `EXTRA_COMMITS` warning. Nothing is ever deleted.

## UTC rules

Dates are calendar dates handled as integer day numbers (Pattern's `dates.js`). Every commit gets `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` of `<date> 12:00:00 +0000`, regardless of system time zone. A commit whose timestamp is later than `now()` is not created (`FUTURE_DATE`).

## How commits are written

Each commit is built with `git commit-tree` using the **same tree as the current HEAD**, then `git update-ref <branch> <new> <old>` moves the branch only if it still points at the old commit. So no file, index entry or user change can enter a generator commit, no journal file is needed, and no `git add` is used. Git history is re-read after writing to verify the result.

## Safety

- Default is `dryRun: true`; dry-run never modifies the repository (no lock, no refs, no files) and works on a dirty tree.
- Writing requires: inside a work tree, a checked-out branch (no detached HEAD), at least one commit, a clean working tree (including untracked and staged files), and no merge/rebase/cherry-pick in progress.
- A lock file `<git-dir>/ticker-reconcile.lock` prevents parallel runs (the second run fails with `LOCKED`). A lock owned by a dead process is replaced, so a killed run can simply be repeated.
- Git is invoked through `child_process.spawnSync` with an argument array, never a shell. Only read commands plus `commit-tree` and `update-ref` are used: no push, reset, clean, checkout, rebase or amend.
- Not transactional: if a run stops midway, the commits already created stay. The next run reads history and creates only what is missing.

## Examples

Preview a small range (safe, default):

```
node src/reconciler/cli.js 2019-10-22 2019-11-05
```

Write it (requires a clean working tree; does **not** push):

```
node src/reconciler/cli.js 2019-10-22 2019-11-05 --write
```

Seven-year range. Always preview first; on the current default configuration this plans 2031 commits and takes well under a second to analyze:

```
node src/reconciler/cli.js 2019-10-20 2026-10-19
node src/reconciler/cli.js 2019-10-20 2026-10-19 --write
```

CLI options: `--repo <dir>`, `--commits <n>` (commits per pixel). Exit code: `0` ok, `1` errors or failure, `2` bad usage/input. Importing any module here never runs anything; only `cli.js` executed directly does, and without `--write` it only reports.

From code:

```js
import { reconcile } from './src/reconciler/reconciler.js';
const plan = reconcile({ startDate: '2019-10-22', endDate: '2019-11-05' });   // dry-run
if (plan.ok) reconcile({ startDate: '2019-10-22', endDate: '2019-11-05', dryRun: false });
```

## Tests

```
npm test                                          # everything
node --test src/reconciler/reconciler.test.js     # Reconciler only
```

Integration tests create temporary local repositories (path with a space, isolated git config, no remote, network, tokens or SSH keys) and clean them up afterwards.

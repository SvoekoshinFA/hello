/**
 * Reconciler: brings Git history in line with the pixel map produced by the Pattern module.
 *
 * Pattern is the only source of truth for which pixels are on and how many commits each needs.
 * Git history is the only source of truth for which generator commits already exist.
 * The reconciler never deletes, amends or rewrites commits and never pushes.
 */
import path from 'node:path';
import { formatDayNumber, toDayNumber } from '../pattern/dates.js';
import { getPattern } from '../pattern/pattern.js';
import { busyOperation, createCommit, dirtyPaths, getRepoInfo, readSubjects, GitError } from './git.js';
import { acquireLock } from './lock.js';
import { formatSubject, parseSubject } from './markers.js';

/** Hour (UTC) of every generated commit's author and committer timestamp. */
export const COMMIT_HOUR_UTC = 12;
const MS_PER_DAY = 86_400_000;
const LOCK_FILE = 'ticker-reconcile.lock';

export class ReconcilerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconcilerError';
    this.code = code;
  }
}

const DEFAULT_PATTERN = Object.freeze({ getPattern });

function commitTimestampMs(date) {
  return toDayNumber(date) * MS_PER_DAY + COMMIT_HOUR_UTC * 3_600_000;
}

function utcDateString(date) {
  return `${date} ${String(COMMIT_HOUR_UTC).padStart(2, '0')}:00:00 +0000`;
}

/**
 * Pure planning step.
 * @param {{date: string, target: number}[]} days target state for each date in the range
 * @param {{hash: string, subject: string}[]} commits reachable history
 * @param {number} nowMs wall-clock time, used only to avoid creating commits dated in the future
 */
export function buildPlan(days, commits, nowMs) {
  const errors = [];
  const warnings = [];
  const byDate = new Map();
  let invalidMarkers = 0;

  for (const { hash, subject } of commits) {
    const marker = parseSubject(subject);
    if (marker === null) continue;
    if (!marker.valid) {
      invalidMarkers += 1;
      errors.push({ code: 'INVALID_MARKER', hash, message: `Invalid marker in ${hash}: ${marker.reason}` });
      continue;
    }
    if (!byDate.has(marker.date)) byDate.set(marker.date, new Map());
    const indices = byDate.get(marker.date);
    indices.set(marker.index, [...(indices.get(marker.index) ?? []), hash]);
  }

  const plan = [];
  const datesWithWarnings = new Set();
  let commitsExisting = 0;
  let datesAlreadyCorrect = 0;
  let datesWithPixels = 0;

  for (const { date, target } of days) {
    const indices = byDate.get(date) ?? new Map();
    let dateOk = true;
    let blocked = invalidMarkers > 0;

    for (const hashes of indices.values()) commitsExisting += hashes.length;

    for (const [index, hashes] of indices) {
      if (hashes.length > 1) {
        blocked = true;
        dateOk = false;
        errors.push({
          code: 'DUPLICATE_INDEX',
          date,
          index,
          hashes,
          message: `Duplicate marker index ${index} for ${date} in commits ${hashes.join(', ')}`,
        });
      }
    }

    if (target > 0) datesWithPixels += 1;
    const extra = [...indices.keys()].filter((index) => index > target);
    if (extra.length > 0) {
      dateOk = false;
      datesWithWarnings.add(date);
      warnings.push({
        code: target === 0 ? 'UNEXPECTED_COMMITS' : 'EXTRA_COMMITS',
        date,
        message: `${date}: target is ${target} but generator commits with index ${extra.join(', ')} exist (not removed)`,
      });
    }

    const missing = [];
    for (let index = 1; index <= target; index++) if (!indices.has(index)) missing.push(index);

    if (missing.length > 0) {
      dateOk = false;
      if (blocked) {
        // Errors for this date (or global marker errors) already explain why nothing is planned.
      } else if (commitTimestampMs(date) > nowMs) {
        datesWithWarnings.add(date);
        warnings.push({
          code: 'FUTURE_DATE',
          date,
          message: `${date}: commit time is in the future, skipped`,
        });
      } else {
        for (const index of missing) plan.push({ date, index });
      }
    }
    if (blocked) dateOk = false;
    if (dateOk) datesAlreadyCorrect += 1;
  }

  return {
    plan,
    errors,
    warnings,
    commitsExisting,
    datesAlreadyCorrect,
    datesWithPixels,
    datesWithWarnings: datesWithWarnings.size,
  };
}

function normalizeRange(startDate, endDate) {
  const start = toDayNumber(startDate);
  const end = toDayNumber(endDate);
  if (end < start) {
    throw new RangeError(`Empty range: startDate ${formatDayNumber(start)} is after endDate ${formatDayNumber(end)}`);
  }
  return { start: formatDayNumber(start), end: formatDayNumber(end) };
}

/**
 * Reconciles the history of the current branch with the pattern for [startDate, endDate].
 *
 * Throws TypeError/RangeError for invalid input and ReconcilerError/GitError/LockError for
 * environment problems (not a repository, dirty tree, git failure). A thrown error after some
 * commits were created carries the partial result in `error.report`.
 * Integrity problems found in history are returned in `report.errors` (`report.ok === false`).
 *
 * @param {object} options
 * @param {string|{year:number,month:number,day:number}} options.startDate inclusive
 * @param {string|{year:number,month:number,day:number}} options.endDate inclusive
 * @param {boolean} [options.dryRun=true] analyze only; never modifies the repository
 * @param {string} [options.cwd=process.cwd()] directory inside the target repository
 * @param {{getPattern: Function}} [options.pattern] a Pattern instance (createPattern({targetCommits}))
 * @param {() => number} [options.now] clock in epoch ms; only guards against future-dated commits
 */
export function reconcile({
  startDate,
  endDate,
  dryRun = true,
  cwd = process.cwd(),
  pattern = DEFAULT_PATTERN,
  now = () => Date.now(),
} = {}) {
  if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean');
  const { start, end } = normalizeRange(startDate, endDate);

  const days = pattern.getPattern(start, end).map(({ date, commits }) => ({ date, target: commits }));
  const info = getRepoInfo(cwd);

  const report = {
    dryRun,
    startDate: start,
    endDate: end,
    branch: info.ref,
    datesChecked: days.length,
    datesWithPixels: 0,
    commitsExisting: 0,
    commitsPlanned: 0,
    commitsCreated: 0,
    datesAlreadyCorrect: 0,
    datesWithWarnings: 0,
    errors: [],
    warnings: [],
    plan: [],
    ok: true,
  };

  let release = null;
  try {
    if (!dryRun) {
      if (!info.ref) throw new ReconcilerError('DETACHED_HEAD', 'Refusing to write on a detached HEAD');
      if (!info.head) throw new ReconcilerError('NO_COMMITS', 'Repository has no commits; create an initial commit first');
      release = acquireLock(path.join(info.commonDir, LOCK_FILE));
      const busy = busyOperation(info.gitDir);
      if (busy) throw new ReconcilerError('REPO_BUSY', `Refusing to write while a Git operation is in progress (${busy})`);
      const dirty = dirtyPaths(cwd);
      if (dirty.length > 0) {
        throw new ReconcilerError('DIRTY_WORKTREE', `Refusing to write: ${dirty.length} uncommitted change(s) in the working tree`);
      }
    }

    // History is read after the lock is held, so a concurrent run's commits are always seen.
    const history = info.head ? readSubjects(cwd) : [];
    Object.assign(report, summarize(buildPlan(days, history, now())));

    if (!dryRun && report.plan.length > 0) {
      let parent = info.head;
      try {
        for (const { date, index } of report.plan) {
          parent = createCommit(cwd, {
            ref: info.ref,
            parent,
            message: formatSubject(date, index),
            utcDate: utcDateString(date),
          });
          report.commitsCreated += 1;
        }
      } catch (error) {
        report.ok = false;
        report.errors.push({ code: error.code ?? 'GIT_FAILED', message: error.message });
        error.report = report;
        throw error;
      }

      // Only the commits created in this run are verified; older problems are already reported.
      const seen = new Map();
      for (const { subject } of readSubjects(cwd)) {
        const marker = parseSubject(subject);
        if (marker?.valid) {
          const key = `${marker.date}#${marker.index}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
      const problems = report.plan.filter(({ date, index }) => seen.get(`${date}#${index}`) !== 1);
      if (problems.length > 0) {
        report.errors.push({
          code: 'VERIFY_FAILED',
          message: `History re-read after writing is inconsistent for ${problems.length} planned commit(s)`,
        });
      }
    }
  } finally {
    if (release) release();
  }

  report.ok = report.errors.length === 0;
  return report;
}

function summarize(result) {
  return {
    datesWithPixels: result.datesWithPixels,
    commitsExisting: result.commitsExisting,
    commitsPlanned: result.plan.length,
    datesAlreadyCorrect: result.datesAlreadyCorrect,
    datesWithWarnings: result.datesWithWarnings,
    errors: result.errors,
    warnings: result.warnings,
    plan: result.plan,
  };
}

export { GitError };

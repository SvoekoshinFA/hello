/**
 * Daily runner: one-shot processing of the current UTC calendar date.
 *
 * It only decides *which date* to process. The pixel map comes from Pattern and all Git work
 * (history analysis, locking, commit creation, timestamps) is done by Reconciler.
 * No loops, timers or background processes: the process ends when runDaily() returns.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reconcile as defaultReconcile } from '../reconciler/reconciler.js';

export const OPERATION = 'ticker-daily';

export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  /** Another reconciler run holds the lock (EX_TEMPFAIL); nothing was written by this run. */
  LOCKED: 75,
});

const USAGE = 'Usage: node src/daily-runner/daily-runner.js [--dry-run]';

const defaultLogger = Object.freeze({
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});

/** One JSON object per line, easy to read in `journalctl` and to parse. */
function emit(write, event, fields) {
  write(JSON.stringify({ operation: OPERATION, event, ...fields }));
}

function describeError(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    message: error?.message ?? String(error),
  };
}

/**
 * Processes exactly one date: today in UTC. Never throws for operational failures; inspect
 * `result.ok` / `result.status` (see exitCodeFor).
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] analyze only, do not create commits
 * @param {() => Date} [options.clock] injectable clock; called exactly once per run
 * @param {Function} [options.reconcile] Reconciler entry point (replaceable in tests)
 * @param {string} [options.cwd] directory inside the target repository (default: process cwd)
 * @param {object} [options.pattern] Pattern instance; default is the project's configured Pattern
 * @param {{out: Function, err: Function}} [options.logger]
 * @returns {{ok: boolean, status: 'ok'|'incomplete'|'locked'|'failed', date: string|null,
 *   dryRun: boolean, datesChecked: number, commitsExisting: number, commitsPlanned: number,
 *   commitsCreated: number, warnings: object[], errors: object[], error: object|null,
 *   report: object|null}}
 */
export function runDaily({
  dryRun = false,
  clock = () => new Date(),
  reconcile = defaultReconcile,
  cwd,
  pattern,
  logger = defaultLogger,
} = {}) {
  const result = {
    ok: false,
    status: 'failed',
    date: null,
    dryRun,
    datesChecked: 0,
    commitsExisting: 0,
    commitsPlanned: 0,
    commitsCreated: 0,
    warnings: [],
    errors: [],
    error: null,
    report: null,
  };

  try {
    // The date is fixed here, once. The same instant is given to Reconciler as "now", so the
    // date and the future-commit guard can never disagree even if the run crosses midnight UTC.
    const instant = clock();
    const date = instant.toISOString().slice(0, 10);
    const nowMs = instant.getTime();
    result.date = date;

    emit(logger.out, 'start', { date, mode: dryRun ? 'dry-run' : 'write' });

    const options = { startDate: date, endDate: date, dryRun, now: () => nowMs };
    if (cwd !== undefined) options.cwd = cwd;
    if (pattern !== undefined) options.pattern = pattern;
    const report = reconcile(options);

    result.report = report;
    result.datesChecked = report.datesChecked;
    result.commitsExisting = report.commitsExisting;
    result.commitsPlanned = report.commitsPlanned;
    result.commitsCreated = report.commitsCreated;
    result.warnings = report.warnings;
    result.errors = report.errors;

    if (!report.ok) {
      result.status = 'failed';
    } else if (report.warnings.some((w) => w.code === 'FUTURE_DATE')) {
      // The date's commit time (12:00 UTC) has not been reached yet, so nothing could be written.
      result.status = 'incomplete';
    } else {
      result.status = 'ok';
      result.ok = true;
    }
  } catch (error) {
    result.error = describeError(error);
    result.status = error?.code === 'LOCKED' ? 'locked' : 'failed';
    if (error?.report) {
      // Partial progress before the failure (commits already created stay in history).
      result.commitsCreated = error.report.commitsCreated ?? 0;
      result.commitsPlanned = error.report.commitsPlanned ?? 0;
      result.commitsExisting = error.report.commitsExisting ?? 0;
      result.datesChecked = error.report.datesChecked ?? 0;
      result.warnings = error.report.warnings ?? [];
      result.errors = error.report.errors ?? [];
    }
  }

  for (const warning of result.warnings) emit(logger.err, 'warning', { date: result.date, ...warning });
  for (const error of result.errors) emit(logger.err, 'error', { date: result.date, ...error });
  if (result.error) emit(logger.err, 'error', { date: result.date, ...result.error });

  emit(result.ok ? logger.out : logger.err, 'finish', {
    date: result.date,
    datesChecked: result.datesChecked,
    commitsExisting: result.commitsExisting,
    commitsPlanned: result.commitsPlanned,
    commitsCreated: result.commitsCreated,
    warnings: result.warnings.length,
    errors: result.errors.length + (result.error ? 1 : 0),
    status: result.status,
  });
  return result;
}

/** Maps a runDaily() result to a process exit code. */
export function exitCodeFor(result) {
  if (result.ok) return EXIT.OK;
  return result.status === 'locked' ? EXIT.LOCKED : EXIT.FAILURE;
}

/**
 * CLI entry point. Returns the exit code instead of exiting, so it is testable.
 * @param {string[]} argv arguments after the script name
 */
export function main(argv = process.argv.slice(2), options = {}) {
  const logger = options.logger ?? defaultLogger;
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    logger.err(`Unknown argument(s): ${unknown.join(' ')}\n${USAGE}`);
    return EXIT.USAGE;
  }
  const result = runDaily({ ...options, dryRun: argv.includes('--dry-run'), logger });
  return exitCodeFor(result);
}

// Run only when executed directly (node daily-runner.js / npm run ticker:daily), never on import.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}

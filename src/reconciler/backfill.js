/**
 * One-shot backfill: restores marker commits for every date from CONFIG.epoch to today (UTC).
 *   node src/reconciler/backfill.js [--dry-run]
 * Uses reconcile() for the whole range; existing commits are never duplicated.
 * Exit code: 0 ok, 1 failure, 2 bad usage.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG } from '../pattern/config.js';
import { reconcile } from './reconciler.js';

export function run(argv, { out = console, clock = () => new Date(), cwd } = {}) {
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    out.error(`Unknown argument ${unknown[0]}\nUsage: node src/reconciler/backfill.js [--dry-run]`);
    return 2;
  }
  const instant = clock();
  const today = instant.toISOString().slice(0, 10);
  try {
    const report = reconcile({
      startDate: CONFIG.epoch,
      endDate: today,
      dryRun: argv.includes('--dry-run'),
      cwd,
      now: () => instant.getTime(),
    });
    const { plan, ...summary } = report;
    out.log(JSON.stringify({ from: CONFIG.epoch, to: today, ...summary }, null, 2));
    if (!report.ok) {
      out.error(`Finished with ${report.errors.length} error(s); the pattern is not fully reconciled.`);
      return 1;
    }
    return 0;
  } catch (error) {
    out.error(`${error.name}: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = run(process.argv.slice(2));
}

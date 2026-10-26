/**
 * Command-line entry point for the Reconciler (explicit, one-shot; no scheduling).
 *   node src/reconciler/cli.js <startDate> <endDate> [--write] [--repo <dir>] [--commits <n>]
 * Without --write it only prints a plan. Exit code: 0 ok, 1 errors/failure, 2 bad usage.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPattern } from '../pattern/pattern.js';
import { reconcile } from './reconciler.js';

const USAGE = 'Usage: node src/reconciler/cli.js <startDate> <endDate> [--write] [--repo <dir>] [--commits <n>]';

function parseArgs(argv) {
  const positional = [];
  const options = { write: false, repo: undefined, commits: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') options.write = true;
    else if (arg === '--repo') options.repo = argv[++i];
    else if (arg === '--commits') options.commits = Number(argv[++i]);
    else if (arg.startsWith('--')) throw new TypeError(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 2) throw new TypeError('Expected exactly two dates');
  if (options.repo === '' || (options.commits !== undefined && !Number.isInteger(options.commits))) {
    throw new TypeError('Invalid option value');
  }
  return { startDate: positional[0], endDate: positional[1], ...options };
}

/** Runs the CLI and returns the exit code. */
export function run(argv, out = console) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    out.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  try {
    const report = reconcile({
      startDate: args.startDate,
      endDate: args.endDate,
      dryRun: !args.write,
      cwd: args.repo,
      pattern: args.commits === undefined ? undefined : createPattern({ targetCommits: args.commits }),
    });
    const { plan, ...summary } = report;
    out.log(JSON.stringify(summary, null, 2));
    if (!report.ok) {
      out.error(`Finished with ${report.errors.length} error(s); the pattern is not fully reconciled.`);
      return 1;
    }
    return 0;
  } catch (error) {
    out.error(`${error.name}: ${error.message}`);
    return error instanceof TypeError || error instanceof RangeError ? 2 : 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = run(process.argv.slice(2));
}

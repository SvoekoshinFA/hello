import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPattern } from '../pattern/pattern.js';
import { formatSubject } from '../reconciler/markers.js';
import { EXIT, exitCodeFor, main, runDaily } from './daily-runner.js';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const MODULE = join(DIR, 'daily-runner.js');
const PKG = JSON.parse(readFileSync(join(DIR, '..', '..', 'package.json'), 'utf8'));

// Tests own their pattern so they do not depend on the project's default configuration.
const PATTERN = createPattern({ epoch: '2019-10-20', text: 'HELLO, WORLD!' });
const ON_DAY = '2019-10-22'; // Tuesday, stem of the first "H": pixel on, 3 commits
const OFF_DAY = '2019-10-21'; // Monday: never part of the drawing
const at = (date, time = '13:17:00') => () => new Date(`${date}T${time}Z`);

// Isolate git from the machine configuration and from any remote/credentials.
const TMP = mkdtempSync(join(tmpdir(), 'ticker daily '));
const EMPTY_CONFIG = join(TMP, 'empty-gitconfig');
writeFileSync(EMPTY_CONFIG, '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
for (const key of ['EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
  delete process.env[key];
}
after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Read-only git objects can resist deletion on Windows; the OS temp cleaner handles them.
  }
});

const FIXED = { GIT_AUTHOR_DATE: '2020-01-01 00:00:00 +0000', GIT_COMMITTER_DATE: '2020-01-01 00:00:00 +0000' };
const git = (cwd, args, env = {}) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' }).trim();

let repoCounter = 0;
function createRepo() {
  const dir = join(TMP, `repo ${++repoCounter}`);
  mkdirSync(dir);
  git(dir, ['init', '-q']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(dir, 'src.txt'), 'source\n');
  git(dir, ['add', '--', 'src.txt']);
  git(dir, ['commit', '-q', '-m', 'initial'], FIXED);
  return dir;
}

const markedSubjects = (repo) =>
  git(repo, ['log', '--format=%s']).split('\n').filter((s) => s.startsWith('[ticker:v1 '));
const head = (repo) => git(repo, ['rev-parse', 'HEAD']);

function capture() {
  const out = [];
  const err = [];
  return { out, err, logger: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}
const events = (lines) => lines.flatMap((l) => l.split('\n')).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

/** A fake Reconciler that records calls and returns a plausible report. */
function fakeReconcile(overrides = {}) {
  const calls = [];
  const reconcile = (options) => {
    calls.push(options);
    return {
      dryRun: options.dryRun,
      startDate: options.startDate,
      endDate: options.endDate,
      datesChecked: 1,
      datesWithPixels: 1,
      commitsExisting: 0,
      commitsPlanned: 3,
      commitsCreated: options.dryRun ? 0 : 3,
      datesAlreadyCorrect: 0,
      datesWithWarnings: 0,
      errors: [],
      warnings: [],
      ok: true,
      ...overrides,
    };
  };
  return { calls, reconcile };
}

// ---- date handling -------------------------------------------------------------------------

test('1./2. Reconciler receives exactly one date: start equals end', () => {
  const { calls, reconcile } = fakeReconcile();
  const { logger } = capture();
  const result = runDaily({ clock: at('2026-10-26'), reconcile, logger });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].startDate, '2026-10-26');
  assert.equal(calls[0].endDate, '2026-10-26');
  assert.equal(calls[0].startDate, calls[0].endDate);
  assert.equal(calls[0].dryRun, false);
  assert.equal(result.date, '2026-10-26');
  assert.equal(result.datesChecked, 1);
  assert.equal(result.ok, true);
});

test('3. the date is the UTC calendar date, whatever offset the instant is written in', () => {
  const cases = [
    ['2026-10-26T23:30:00-05:00', '2026-10-27'], // evening in New York is already tomorrow in UTC
    ['2026-10-27T01:00:00+14:00', '2026-10-26'], // Kiritimati morning is still yesterday in UTC
    ['2026-10-26T00:00:00Z', '2026-10-26'],
    ['2026-10-26T23:59:59.999Z', '2026-10-26'],
    ['2024-02-29T12:00:00Z', '2024-02-29'],
  ];
  for (const [instant, expected] of cases) {
    const { calls, reconcile } = fakeReconcile();
    runDaily({ clock: () => new Date(instant), reconcile, logger: capture().logger });
    assert.equal(calls[0].startDate, expected, instant);
  }
});

test('Reconciler gets the same instant as "now" so the date and its guard agree', () => {
  const { calls, reconcile } = fakeReconcile();
  runDaily({ clock: at('2026-10-26', '08:15:30'), reconcile, logger: capture().logger });
  assert.equal(calls[0].now(), Date.UTC(2026, 9, 26, 8, 15, 30));
  assert.equal(calls[0].now(), calls[0].now());
});

test('5./14. the clock is read once; crossing midnight UTC cannot split the run', () => {
  const instants = [new Date('2026-10-26T23:59:59.999Z'), new Date('2026-10-27T00:00:00.000Z'), new Date('2026-10-27T00:00:01.000Z')];
  let reads = 0;
  const clock = () => instants[Math.min(reads++, instants.length - 1)];
  const { calls, reconcile } = fakeReconcile();
  const { out } = capture();
  const result = runDaily({ clock, reconcile, logger: { out: (l) => out.push(l), err() {} } });
  assert.equal(reads, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].startDate, '2026-10-26');
  assert.equal(calls[0].endDate, '2026-10-26');
  assert.equal(calls[0].now(), instants[0].getTime());
  assert.equal(result.date, '2026-10-26');
  assert.ok(events(out).every((e) => e.date === '2026-10-26'));
});

test('4. the result is identical for every process time zone', async () => {
  const worker = join(TMP, 'tz-worker.mjs');
  writeFileSync(
    worker,
    `import { runDaily } from ${JSON.stringify(pathToFileURL(MODULE).href)};
const lines = [];
const calls = [];
const result = runDaily({
  clock: () => new Date('2026-10-26T22:30:00Z'),
  reconcile: (o) => { calls.push({ s: o.startDate, e: o.endDate, now: o.now() }); return { ok: true, datesChecked: 1, commitsExisting: 0, commitsPlanned: 0, commitsCreated: 0, warnings: [], errors: [] }; },
  logger: { out: (l) => lines.push(l), err: (l) => lines.push(l) },
});
console.log(JSON.stringify({ calls, date: result.date, lines }));
`,
  );
  const zones = ['UTC', 'Europe/London', 'Europe/Berlin', 'Asia/Tbilisi', 'Pacific/Kiritimati', 'America/Los_Angeles'];
  const outputs = zones.map((TZ) =>
    execFileSync(process.execPath, [worker], { env: { ...process.env, TZ }, encoding: 'utf8' }),
  );
  for (const output of outputs) assert.equal(output, outputs[0]);
  assert.equal(JSON.parse(outputs[0]).date, '2026-10-26'); // 22:30Z is already 27 Oct in Tbilisi and Kiritimati
});

// ---- outcomes through a real Reconciler ----------------------------------------------------

test('6. a pixel that is off creates no commits', () => {
  const repo = createRepo();
  const before = head(repo);
  const result = runDaily({ clock: at(OFF_DAY), cwd: repo, pattern: PATTERN, logger: capture().logger });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.commitsCreated, 0);
  assert.equal(result.commitsPlanned, 0);
  assert.equal(head(repo), before);
});

test('7. a pixel that is on is processed through Reconciler', () => {
  const repo = createRepo();
  const result = runDaily({ clock: at(ON_DAY), cwd: repo, pattern: PATTERN, logger: capture().logger });
  assert.equal(result.ok, true);
  assert.equal(result.commitsCreated, 3);
  assert.deepEqual(markedSubjects(repo).map((s) => s.split(']')[0] + ']').sort(), [1, 2, 3].map((i) => `[ticker:v1 date=${ON_DAY} index=${i}]`));
  assert.equal(git(repo, ['status', '--porcelain', '--untracked-files=all']), '');
});

test('partially filled pixel gets only the missing commits', () => {
  const repo = createRepo();
  git(repo, ['commit', '--allow-empty', '-q', '-m', formatSubject(ON_DAY, 2)], FIXED);
  const result = runDaily({ clock: at(ON_DAY), cwd: repo, pattern: PATTERN, logger: capture().logger });
  assert.equal(result.commitsExisting, 1);
  assert.equal(result.commitsCreated, 2);
  assert.equal(markedSubjects(repo).length, 3);
});

test('8./13. an already complete pixel changes nothing and repeated runs add no duplicates', () => {
  const repo = createRepo();
  runDaily({ clock: at(ON_DAY), cwd: repo, pattern: PATTERN, logger: capture().logger });
  const done = head(repo);
  for (let i = 0; i < 3; i++) {
    const result = runDaily({ clock: at(ON_DAY, `1${i}:00:00`), cwd: repo, pattern: PATTERN, logger: capture().logger });
    assert.equal(result.ok, true);
    assert.equal(result.commitsExisting, 3);
    assert.equal(result.commitsCreated, 0);
  }
  assert.equal(head(repo), done);
  assert.equal(markedSubjects(repo).length, 3);
});

test('dry-run reports the work without touching the repository', () => {
  const repo = createRepo();
  const before = head(repo);
  const { out } = capture();
  const result = runDaily({ dryRun: true, clock: at(ON_DAY), cwd: repo, pattern: PATTERN, logger: { out: (l) => out.push(l), err() {} } });
  assert.equal(result.ok, true);
  assert.equal(result.commitsPlanned, 3);
  assert.equal(result.commitsCreated, 0);
  assert.equal(events(out)[0].mode, 'dry-run');
  assert.equal(head(repo), before);
  assert.equal(markedSubjects(repo).length, 0);
});

test('14b. a run just before midnight UTC processes only that day', () => {
  const repo = createRepo();
  let reads = 0;
  const clock = () => new Date(reads++ === 0 ? `${ON_DAY}T23:59:59.999Z` : '2019-10-23T00:00:00.000Z');
  const result = runDaily({ clock, cwd: repo, pattern: PATTERN, logger: capture().logger });
  assert.equal(reads, 1);
  assert.equal(result.commitsCreated, 3);
  assert.ok(markedSubjects(repo).every((s) => s.includes(`date=${ON_DAY} `)));
});

test('a run before 12:00 UTC cannot write a future-dated commit and is reported as incomplete', () => {
  const repo = createRepo();
  const before = head(repo);
  const { err } = capture();
  const result = runDaily({ clock: at(ON_DAY, '08:00:00'), cwd: repo, pattern: PATTERN, logger: { out() {}, err: (l) => err.push(l) } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'incomplete');
  assert.equal(exitCodeFor(result), EXIT.FAILURE);
  assert.equal(result.commitsCreated, 0);
  assert.equal(head(repo), before);
  assert.ok(events(err).some((e) => e.event === 'warning' && e.code === 'FUTURE_DATE'));
});

// ---- failures ------------------------------------------------------------------------------

test('9./10. a Reconciler exception is a failure and is never reported as success', () => {
  const { out, err, logger } = capture();
  const failing = () => {
    throw Object.assign(new Error('git commit-tree failed (exit 128): boom'), { name: 'GitError', code: 'GIT_FAILED' });
  };
  const result = runDaily({ clock: at(ON_DAY), reconcile: failing, logger });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'GIT_FAILED');
  assert.match(result.error.message, /boom/);
  assert.equal(exitCodeFor(result), EXIT.FAILURE);
  assert.ok(events(out).every((e) => e.event === 'start'), 'stdout carries no success event');
  const finish = events(err).find((e) => e.event === 'finish');
  assert.equal(finish.status, 'failed');
  assert.equal(finish.errors, 1);
  assert.ok(events(err).some((e) => e.event === 'error' && /boom/.test(e.message)));
});

test('a partial result survives a failure after some commits were created', () => {
  const failing = () => {
    throw Object.assign(new Error('late failure'), { report: { commitsCreated: 1, commitsPlanned: 3, commitsExisting: 0, datesChecked: 1, warnings: [], errors: [] } });
  };
  const result = runDaily({ clock: at(ON_DAY), reconcile: failing, logger: capture().logger });
  assert.equal(result.ok, false);
  assert.equal(result.commitsCreated, 1);
  assert.equal(result.commitsPlanned, 3);
});

test('integrity errors in the report (ok: false) fail the run', () => {
  const { reconcile } = fakeReconcile({
    ok: false,
    commitsCreated: 0,
    errors: [{ code: 'DUPLICATE_INDEX', message: 'Duplicate marker index 1' }],
  });
  const { err, logger } = capture();
  const result = runDaily({ clock: at(ON_DAY), reconcile, logger });
  assert.equal(result.ok, false);
  assert.equal(exitCodeFor(result), EXIT.FAILURE);
  assert.equal(events(err).at(-1).status, 'failed');
});

test('invalid clock output becomes a failure instead of a crash', () => {
  const result = runDaily({ clock: () => new Date('not a date'), reconcile: fakeReconcile().reconcile, logger: capture().logger });
  assert.equal(result.ok, false);
  assert.equal(result.date, null);
});

test('a concurrent run holding the lock is reported without writing', () => {
  const repo = createRepo();
  const lock = join(repo, '.git', 'ticker-reconcile.lock');
  writeFileSync(lock, String(process.pid));
  const before = head(repo);
  const result = runDaily({ clock: at(ON_DAY), cwd: repo, pattern: PATTERN, logger: capture().logger });
  assert.equal(result.status, 'locked');
  assert.equal(result.ok, false);
  assert.equal(exitCodeFor(result), EXIT.LOCKED);
  assert.equal(head(repo), before);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  rmSync(lock);
});

test('a dirty working tree fails the run and nothing is written', () => {
  const repo = createRepo();
  writeFileSync(join(repo, 'src.txt'), 'edited\n');
  const before = head(repo);
  const result = runDaily({ clock: at(ON_DAY), cwd: repo, pattern: PATTERN, logger: capture().logger });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DIRTY_WORKTREE');
  assert.equal(head(repo), before);
});

// ---- CLI -----------------------------------------------------------------------------------

test('11. importing the module does not run the operation', () => {
  const plain = join(TMP, 'plain dir');
  mkdirSync(plain);
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(MODULE).href)})`], {
    cwd: plain,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
});

test('12. main() returns the exit code', () => {
  const quiet = capture();
  assert.equal(main(['--bogus'], { logger: quiet.logger }), EXIT.USAGE);
  assert.match(quiet.err.join('\n'), /Usage:/);

  const repo = createRepo();
  assert.equal(main([], { clock: at(OFF_DAY), cwd: repo, pattern: PATTERN, logger: capture().logger }), EXIT.OK);
  assert.equal(main([], { clock: at(ON_DAY), cwd: repo, pattern: PATTERN, logger: capture().logger }), EXIT.OK);
  assert.equal(markedSubjects(repo).length, 3);
  assert.equal(main([], { clock: at(ON_DAY), reconcile: () => { throw new Error('x'); }, logger: capture().logger }), EXIT.FAILURE);

  const dryRepo = createRepo();
  assert.equal(main(['--dry-run'], { clock: at(ON_DAY), cwd: dryRepo, pattern: PATTERN, logger: capture().logger }), EXIT.OK);
  assert.equal(markedSubjects(dryRepo).length, 0);
});

function runCli(cwd, args = []) {
  return spawnSync(process.execPath, [MODULE, ...args], { cwd, encoding: 'utf8' });
}

test('12b. the real CLI process exits with the documented codes', () => {
  assert.equal(PKG.scripts['ticker:daily'], 'node src/daily-runner/daily-runner.js');
  assert.equal(PKG.scripts.test, 'node --test "src/**/*.test.js"');

  assert.equal(runCli(TMP, ['--bogus']).status, EXIT.USAGE);

  const notRepo = join(TMP, 'not a repo');
  mkdirSync(notRepo);
  const outside = runCli(notRepo);
  assert.equal(outside.status, EXIT.FAILURE);
  assert.match(outside.stderr, /"status":"failed"/);
  assert.doesNotMatch(outside.stdout, /"event":"finish"/);

  const dirty = createRepo();
  writeFileSync(join(dirty, 'src.txt'), 'edited\n');
  const dirtyRun = runCli(dirty);
  assert.equal(dirtyRun.status, EXIT.FAILURE);
  assert.match(dirtyRun.stderr, /DIRTY_WORKTREE/);

  const locked = createRepo();
  writeFileSync(join(locked, '.git', 'ticker-reconcile.lock'), String(process.pid));
  assert.equal(runCli(locked).status, EXIT.LOCKED);
});

test('12c. the real CLI processes today in UTC with the real clock and ends on its own', () => {
  const repo = createRepo();
  const run = runCli(repo, ['--dry-run']);
  const lines = events(run.stdout.split('\n').concat(run.stderr.split('\n')));
  const start = lines.find((e) => e.event === 'start');
  const finish = lines.find((e) => e.event === 'finish');
  assert.match(start.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(start.mode, 'dry-run');
  assert.equal(finish.date, start.date);
  assert.equal(finish.datesChecked, 1);
  assert.equal(finish.commitsCreated, 0);
  // Before 12:00 UTC on a lit pixel the run is legitimately "incomplete"; otherwise it succeeds.
  assert.equal(run.status, finish.status === 'ok' ? 0 : 1);
  assert.ok(['ok', 'incomplete'].includes(finish.status), run.stderr);
  assert.equal(run.signal, null);
});

// ---- logging and source hygiene ------------------------------------------------------------

test('16. logs are structured and contain the start and finish details', () => {
  const repo = createRepo();
  const { out, err, logger } = capture();
  runDaily({ clock: at(ON_DAY), cwd: repo, pattern: PATTERN, logger });
  const lines = events(out);
  assert.equal(err.length, 0);
  assert.deepEqual(lines.map((e) => e.event), ['start', 'finish']);
  assert.deepEqual(lines[0], { operation: 'ticker-daily', event: 'start', date: ON_DAY, mode: 'write' });
  assert.deepEqual(lines[1], {
    operation: 'ticker-daily',
    event: 'finish',
    date: ON_DAY,
    datesChecked: 1,
    commitsExisting: 0,
    commitsPlanned: 3,
    commitsCreated: 3,
    warnings: 0,
    errors: 0,
    status: 'ok',
  });
});

test('15. no loops, timers, scheduler, local-time calls, shell or push in the source', () => {
  const source = readFileSync(MODULE, 'utf8');
  const forbidden = [
    /setInterval|setTimeout|setImmediate|node-cron|cron\b/,
    /while\s*\(\s*(true|1)\s*\)|for\s*\(\s*;\s*;\s*\)/,
    /Date\.now|new Date\(\s*\)\.(getDate|getFullYear|getMonth|getHours|getDay)|\.get(Date|Day|FullYear|Month|Hours|Minutes|TimezoneOffset)\(/,
    /toLocale|Intl\./,
    /child_process|spawn|exec\(|shell:|['"`]push['"`]/,
    /fetch\(|https?:\/\/|node:https?|node:net/,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
  assert.match(source, /toISOString\(\)\.slice\(0, 10\)/);
  assert.equal(source.match(/clock\(\)/g).length, 1, 'clock is read in exactly one place');
});

test('the runner does not duplicate Pattern or Reconciler logic', () => {
  const source = readFileSync(MODULE, 'utf8');
  assert.doesNotMatch(source, /pattern\/(font|dates|config)|markers\.js|git\.js|lock\.js|commit-tree|\bglyph/i);
  assert.match(source, /from '\.\.\/reconciler\/reconciler\.js'/);
  assert.ok(existsSync(join(DIR, '..', 'reconciler', 'reconciler.js')));
});

// Kept last: a spawn helper is exercised above; make sure no child outlives the tests.
test('no child process is left behind', () => {
  const child = spawn(process.execPath, [MODULE, '--bogus']);
  return new Promise((resolve) =>
    child.on('close', (code) => {
      assert.equal(code, EXIT.USAGE);
      assert.equal(child.exitCode, EXIT.USAGE);
      resolve();
    }),
  );
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPattern } from '../pattern/pattern.js';
import { buildPlan, reconcile } from './reconciler.js';
import { run } from './cli.js';
import { formatMarker, formatSubject, parseSubject } from './markers.js';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const NOW = Date.UTC(2030, 0, 1);

// Tests own their pattern so they do not depend on the project's default configuration.
const PATTERN = createPattern({ epoch: '2019-10-20', text: 'HELLO, WORLD!' });
// First week column of PATTERN: the stem of "H" is on for Tue 2019-10-22 .. Sat 2019-10-26.
const FIRST = '2019-10-22';
const LAST = '2019-10-26';

// Isolate git from the machine configuration and from any real remote/credentials.
const TMP = mkdtempSync(join(tmpdir(), 'ticker tests '));
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
function createRepo({ identity = true } = {}) {
  const dir = join(TMP, `repo ${++repoCounter}`);
  mkdirSync(dir);
  git(dir, ['init', '-q']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  if (identity) {
    git(dir, ['config', 'user.name', 'Test User']);
    git(dir, ['config', 'user.email', 'test@example.invalid']);
  } else {
    git(dir, ['config', 'user.useConfigOnly', 'true']);
  }
  writeFileSync(join(dir, 'src.txt'), 'source\n');
  git(dir, ['add', '--', 'src.txt']);
  git(dir, ['-c', 'user.name=Test User', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'initial'], FIXED);
  return dir;
}

function userCommit(repo, subject) {
  git(repo, ['-c', 'user.name=Test User', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-q', '-m', subject], FIXED);
}

const marked = (repo, date, index) => userCommit(repo, formatSubject(date, index));
const subjects = (repo) => git(repo, ['log', '--format=%s']).split('\n');
const generatorCommits = (repo) =>
  subjects(repo)
    .map(parseSubject)
    .filter((m) => m?.valid)
    .map(({ date, index }) => `${date}#${index}`)
    .sort();
const snapshot = (repo) => ({
  head: git(repo, ['rev-parse', 'HEAD']),
  status: git(repo, ['status', '--porcelain', '--untracked-files=all']),
  reflog: git(repo, ['reflog']),
  refs: git(repo, ['for-each-ref']),
});

const options = (repo, extra = {}) => ({ cwd: repo, pattern: PATTERN, now: () => NOW, ...extra });
const write = (repo, start, end, extra = {}) =>
  reconcile({ startDate: start, endDate: end, dryRun: false, ...options(repo, extra) });
const dry = (repo, start, end, extra = {}) => reconcile({ startDate: start, endDate: end, ...options(repo, extra) });

// ---- markers and pure planning -------------------------------------------------------------

test('marker format is stable and parsed strictly', () => {
  assert.equal(formatMarker('2026-10-26', 1), '[ticker:v1 date=2026-10-26 index=1]');
  assert.deepEqual(parseSubject(formatSubject('2026-10-26', 2)), { valid: true, date: '2026-10-26', index: 2 });
  assert.equal(parseSubject('feat: add parser'), null);
  assert.equal(parseSubject('fix: mention [ticker:v1 date=2026-10-26 index=1] in text'), null);
  for (const bad of [
    '[ticker:v1 date=2026-02-30 index=1]',
    '[ticker:v1 date=2026-10-26 index=0]',
    '[ticker:v1 date=2026-10-26 index=01]',
    '[ticker:v1 date=2026-10-26 index=x]',
    '[ticker:v2 date=2026-10-26 index=1]',
    '[ticker:v1 date=2026-10-26 index=1]trailing',
    '[ticker:v1 index=1 date=2026-10-26]',
  ]) {
    assert.equal(parseSubject(bad)?.valid, false, bad);
  }
  assert.throws(() => formatMarker('2026-02-30', 1), RangeError);
  assert.throws(() => formatMarker('2026-10-26', 0), RangeError);
});

test('buildPlan follows the reconciliation table', () => {
  const day = [{ date: '2026-10-26', target: 3 }];
  const commits = (...indices) =>
    indices.map((i, n) => ({ hash: `h${n}`, subject: formatSubject('2026-10-26', i) }));
  const plan = (...indices) => buildPlan(day, commits(...indices), NOW).plan.map((p) => p.index);
  assert.deepEqual(plan(), [1, 2, 3]);
  assert.deepEqual(plan(1), [2, 3]);
  assert.deepEqual(plan(1, 2), [3]);
  assert.deepEqual(plan(1, 2, 3), []);
  assert.deepEqual(plan(1, 3), [2]);
  const extra = buildPlan(day, commits(1, 2, 3, 4), NOW);
  assert.deepEqual(extra.plan, []);
  assert.equal(extra.warnings[0].code, 'EXTRA_COMMITS');
  const dup = buildPlan(day, commits(1, 1), NOW);
  assert.equal(dup.errors[0].code, 'DUPLICATE_INDEX');
  assert.deepEqual(dup.plan, []);
  assert.deepEqual(buildPlan([{ date: '2026-10-26', target: 0 }], [], NOW).plan, []);
});

// ---- validation ----------------------------------------------------------------------------

test('1. empty or reversed range and invalid input are rejected', () => {
  assert.throws(() => reconcile({ startDate: LAST, endDate: FIRST }), (e) => e instanceof RangeError && /Empty range/.test(e.message));
  assert.throws(() => reconcile({ startDate: '2023-02-29', endDate: '2023-03-01' }), RangeError);
  assert.throws(() => reconcile({ startDate: '2019-1-1', endDate: '2019-1-2' }), TypeError);
  assert.throws(() => reconcile({ startDate: FIRST, endDate: LAST, dryRun: 'false' }), TypeError);
  assert.throws(() => reconcile({}), TypeError);
});

test('2./3. a single date works and both range ends are inclusive', () => {
  const repo = createRepo();
  const single = dry(repo, FIRST, FIRST);
  assert.equal(single.datesChecked, 1);
  assert.deepEqual(single.plan.map((p) => `${p.date}#${p.index}`), [`${FIRST}#1`, `${FIRST}#2`, `${FIRST}#3`]);

  const range = dry(repo, FIRST, LAST);
  assert.equal(range.datesChecked, 5);
  assert.equal(range.plan[0].date, FIRST);
  assert.equal(range.plan.at(-1).date, LAST);
  assert.equal(range.dryRun, true);
});

test('dry-run is the default and accepts { year, month, day } dates', () => {
  const repo = createRepo();
  const before = snapshot(repo);
  const report = reconcile({ startDate: { year: 2019, month: 10, day: 22 }, endDate: LAST, ...options(repo) });
  assert.equal(report.dryRun, true);
  assert.equal(report.startDate, FIRST);
  assert.deepEqual(snapshot(repo), before);
});

// ---- dry run -------------------------------------------------------------------------------

test('4./5. dry-run changes nothing and counts missing commits', () => {
  const repo = createRepo();
  const before = snapshot(repo);
  const report = dry(repo, FIRST, LAST);
  assert.deepEqual(snapshot(repo), before);
  assert.equal(existsSync(join(repo, '.git', 'ticker-reconcile.lock')), false);
  assert.equal(report.commitsPlanned, 15);
  assert.equal(report.commitsCreated, 0);
  assert.equal(report.commitsExisting, 0);
  assert.equal(report.datesWithPixels, 5);
  assert.equal(report.datesAlreadyCorrect, 0);
  assert.equal(report.ok, true);
});

test('dry-run is allowed on a dirty working tree', () => {
  const repo = createRepo();
  writeFileSync(join(repo, 'src.txt'), 'changed\n');
  assert.equal(dry(repo, FIRST, LAST).commitsPlanned, 15);
});

// ---- writing and idempotency ---------------------------------------------------------------

test('6. a fully restored pattern needs no new commits', () => {
  const repo = createRepo();
  const first = write(repo, FIRST, LAST);
  assert.equal(first.commitsCreated, 15);
  assert.equal(first.ok, true);
  const head = git(repo, ['rev-parse', 'HEAD']);

  for (const report of [write(repo, FIRST, LAST), dry(repo, FIRST, LAST)]) {
    assert.equal(report.commitsPlanned, 0);
    assert.equal(report.commitsCreated, 0);
    assert.equal(report.commitsExisting, 15);
    assert.equal(report.datesAlreadyCorrect, 5);
  }
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
  assert.equal(generatorCommits(repo).length, 15);
});

test('7. a partially restored pattern is completed', () => {
  const repo = createRepo();
  marked(repo, FIRST, 1);
  const report = write(repo, FIRST, FIRST);
  assert.deepEqual(report.plan.map((p) => p.index), [2, 3]);
  assert.equal(report.commitsCreated, 2);
  assert.deepEqual(generatorCommits(repo), [`${FIRST}#1`, `${FIRST}#2`, `${FIRST}#3`]);
});

test('8. index gaps are filled', () => {
  const repo = createRepo();
  marked(repo, FIRST, 1);
  marked(repo, FIRST, 3);
  const report = write(repo, FIRST, FIRST);
  assert.deepEqual(report.plan, [{ date: FIRST, index: 2 }]);
  assert.deepEqual(generatorCommits(repo), [`${FIRST}#1`, `${FIRST}#2`, `${FIRST}#3`]);
});

test('9. duplicate indices are reported and block writing only for the affected date', () => {
  const repo = createRepo();
  marked(repo, FIRST, 1);
  marked(repo, FIRST, 1);
  const report = write(repo, FIRST, '2019-10-23');
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].code, 'DUPLICATE_INDEX');
  assert.equal(report.errors[0].date, FIRST);
  assert.equal(report.commitsCreated, 3); // 2019-10-23 is unaffected
  assert.equal(generatorCommits(repo).filter((c) => c.startsWith(FIRST)).length, 2);
});

test('10. extra commits are reported but never removed', () => {
  const repo = createRepo();
  for (const index of [1, 2, 3, 4]) marked(repo, FIRST, index);
  const before = git(repo, ['rev-list', 'HEAD']);
  const report = write(repo, FIRST, FIRST);
  assert.equal(report.ok, true);
  assert.equal(report.commitsPlanned, 0);
  assert.equal(report.datesWithWarnings, 1);
  assert.equal(report.warnings[0].code, 'EXTRA_COMMITS');
  assert.equal(git(repo, ['rev-list', 'HEAD']), before);
});

test('commits on a date whose pixel is off are reported, not removed', () => {
  const repo = createRepo();
  marked(repo, '2019-10-21', 1); // Monday, never part of the drawing
  const report = write(repo, '2019-10-21', '2019-10-21');
  assert.equal(report.commitsPlanned, 0);
  assert.equal(report.warnings[0].code, 'UNEXPECTED_COMMITS');
  assert.equal(generatorCommits(repo).length, 1);
});

test('11. ordinary commits are not pixel commits', () => {
  const repo = createRepo();
  userCommit(repo, `feat: work on ${FIRST}`);
  userCommit(repo, `fix: see ${formatMarker(FIRST, 1)} in docs`);
  userCommit(repo, `ticker date=${FIRST} index=1`);
  const report = dry(repo, FIRST, FIRST);
  assert.equal(report.commitsExisting, 0);
  assert.equal(report.commitsPlanned, 3);
  assert.equal(report.errors.length, 0);
});

test('12. invalid markers are diagnosed and block writing', () => {
  const repo = createRepo();
  for (const subject of [
    '[ticker:v1 date=2019-02-30 index=1] bad date',
    `[ticker:v1 date=${FIRST} index=0] bad index`,
    `[ticker:v2 date=${FIRST} index=1] unknown version`,
    `[ticker:v1 date=${FIRST} index=x] not a number`,
  ]) {
    userCommit(repo, subject);
  }
  const head = git(repo, ['rev-parse', 'HEAD']);
  const report = write(repo, FIRST, LAST);
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 4);
  assert.ok(report.errors.every((e) => e.code === 'INVALID_MARKER' && e.hash));
  assert.equal(report.commitsCreated, 0);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
});

test('13. leap day is handled and commits carry fixed UTC timestamps', () => {
  const leap = createPattern({ epoch: '2019-10-27', text: 'H' });
  assert.equal(leap.isPixelOn('2024-02-29'), true);
  const expected = leap.getPattern('2024-02-26', '2024-03-10').filter((d) => d.on).map((d) => d.date);
  assert.ok(expected.includes('2024-02-29'));

  const repo = createRepo();
  const report = write(repo, '2024-02-26', '2024-03-10', { pattern: leap });
  assert.equal(report.datesChecked, 14);
  assert.equal(report.commitsCreated, expected.length * 3);
  assert.deepEqual([...new Set(report.plan.map((p) => p.date))], expected);

  const stamps = git(repo, ['log', '--format=%aI|%cI|%s']).split('\n').filter((l) => l.includes('[ticker:'));
  for (const line of stamps) {
    const [author, committer, subject] = line.split('|');
    const { date } = parseSubject(subject);
    const utc = (stamp) => stamp.replace('+00:00', 'Z');
    assert.equal(utc(author), `${date}T12:00:00Z`);
    assert.equal(utc(committer), `${date}T12:00:00Z`);
  }
  assert.ok(stamps.some((l) => l.includes('2024-02-29T12:00:00')));
});

test('commits are never created in the future', () => {
  const repo = createRepo();
  const beforeNoon = Date.UTC(2019, 9, 23, 11, 59, 59);
  const early = dry(repo, FIRST, '2019-10-23', { now: () => beforeNoon });
  assert.equal(early.commitsPlanned, 3);
  assert.equal(early.plan.at(-1).date, FIRST);
  assert.equal(early.warnings[0].code, 'FUTURE_DATE');
  assert.equal(early.warnings[0].date, '2019-10-23');
  assert.equal(write(repo, FIRST, '2019-10-23', { now: () => beforeNoon }).commitsCreated, 3);
  assert.deepEqual(generatorCommits(repo).map((c) => c.slice(0, 10)), [FIRST, FIRST, FIRST]);
  const atNoon = dry(repo, FIRST, '2019-10-23', { now: () => Date.UTC(2019, 9, 23, 12, 0, 0) });
  assert.equal(atNoon.commitsPlanned, 3);
});

test('configured commits per pixel changes only the count', () => {
  const repo = createRepo();
  const five = createPattern({ epoch: '2019-10-20', text: 'HELLO, WORLD!', targetCommits: 5 });
  const report = write(repo, FIRST, FIRST, { pattern: five });
  assert.equal(report.commitsCreated, 5);
  assert.deepEqual(generatorCommits(repo).map((c) => c.split('#')[1]), ['1', '2', '3', '4', '5']);
});

// ---- environment and safety ----------------------------------------------------------------

test('14. result does not depend on the system time zone', async () => {
  const repoA = createRepo();
  const repoB = createRepo();
  const a = await runWorker(repoA, FIRST, '2019-11-05', 'write', 'UTC');
  const b = await runWorker(repoB, FIRST, '2019-11-05', 'write', 'Pacific/Kiritimati');
  const c = await runWorker(createRepo(), FIRST, '2019-11-05', 'dry', 'America/Los_Angeles');
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(c.code, 0, c.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.equal(git(repoA, ['rev-parse', 'HEAD']), git(repoB, ['rev-parse', 'HEAD']));
  assert.equal(JSON.parse(c.stdout).commitsPlanned, JSON.parse(a.stdout).commitsCreated);
});

test('15. writing is refused with uncommitted changes and nothing is touched', () => {
  const cases = {
    modified: (repo) => writeFileSync(join(repo, 'src.txt'), 'edited\n'),
    untracked: (repo) => writeFileSync(join(repo, 'new.txt'), 'new\n'),
    staged: (repo) => {
      writeFileSync(join(repo, 'staged.txt'), 'staged\n');
      git(repo, ['add', '--', 'staged.txt']);
    },
  };
  for (const [name, makeDirty] of Object.entries(cases)) {
    const repo = createRepo();
    makeDirty(repo);
    const before = snapshot(repo);
    assert.throws(() => write(repo, FIRST, LAST), (e) => e.code === 'DIRTY_WORKTREE', name);
    assert.deepEqual(snapshot(repo), before, name);
  }
});

test('writing is refused on a detached HEAD, without commits, and outside a repository', () => {
  const repo = createRepo();
  git(repo, ['checkout', '-q', '--detach']);
  assert.throws(() => write(repo, FIRST, LAST), (e) => e.code === 'DETACHED_HEAD');

  const empty = join(TMP, 'empty repo');
  mkdirSync(empty);
  git(empty, ['init', '-q']);
  assert.throws(() => write(empty, FIRST, LAST), (e) => e.code === 'NO_COMMITS');

  const plain = join(TMP, 'not a repo');
  mkdirSync(plain);
  assert.throws(() => dry(plain, FIRST, LAST), (e) => e.code === 'NOT_A_REPO');
});

test('16. a failing git command is surfaced, not hidden', () => {
  const repo = createRepo({ identity: false });
  const head = git(repo, ['rev-parse', 'HEAD']);
  let caught;
  try {
    write(repo, FIRST, LAST);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected an error');
  assert.equal(caught.name, 'GitError');
  assert.match(caught.message, /commit-tree failed/);
  assert.equal(caught.report.ok, false);
  assert.equal(caught.report.commitsCreated, 0);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
  assert.equal(existsSync(join(repo, '.git', 'ticker-reconcile.lock')), false);
});

test('17. a run interrupted midway is completed by the next run', () => {
  const repo = createRepo();
  // Simulates a process killed after creating some commits: only git history records progress.
  marked(repo, FIRST, 1);
  marked(repo, FIRST, 2);
  marked(repo, '2019-10-23', 1);
  const report = write(repo, FIRST, LAST);
  assert.equal(report.commitsExisting, 3);
  assert.equal(report.commitsCreated, 12);
  assert.equal(generatorCommits(repo).length, 15);
  assert.equal(write(repo, FIRST, LAST).commitsCreated, 0);
});

test('a stale lock from a dead process is replaced; a live lock blocks the run', () => {
  const repo = createRepo();
  const lockPath = join(repo, '.git', 'ticker-reconcile.lock');
  const dead = spawnSync(process.execPath, ['-e', '0']);
  writeFileSync(lockPath, String(dead.pid));
  assert.equal(write(repo, FIRST, FIRST).commitsCreated, 3);
  assert.equal(existsSync(lockPath), false);

  writeFileSync(lockPath, String(process.pid));
  assert.throws(() => write(repo, FIRST, LAST), (e) => e.code === 'LOCKED');
  assert.equal(readFileSync(lockPath, 'utf8'), String(process.pid));
  assert.equal(generatorCommits(repo).length, 3);
  rmSync(lockPath);
});

test('18. concurrent runs never duplicate commits', async () => {
  const repo = createRepo();
  const results = await Promise.all([
    runWorker(repo, FIRST, '2019-11-05', 'write'),
    runWorker(repo, FIRST, '2019-11-05', 'write'),
    runWorker(repo, FIRST, '2019-11-05', 'write'),
  ]);
  assert.ok(results.some((r) => r.code === 0), 'at least one run must succeed');
  for (const r of results.filter((x) => x.code !== 0)) assert.match(r.stderr, /LOCKED/);

  const commits = generatorCommits(repo);
  assert.equal(new Set(commits).size, commits.length, 'no duplicate (date, index)');
  const expected = dry(repo, FIRST, '2019-11-05');
  assert.equal(expected.commitsPlanned, 0);
  assert.equal(commits.length, expected.commitsExisting);
  assert.equal(existsSync(join(repo, '.git', 'ticker-reconcile.lock')), false);
});

test('19. generated commits contain no files and leave the working tree alone', () => {
  const repo = createRepo();
  const initialTree = git(repo, ['rev-parse', 'HEAD^{tree}']);
  write(repo, FIRST, LAST);
  const hashes = git(repo, ['log', '--format=%H', '--grep=ticker:v1', '--fixed-strings']).split('\n');
  assert.equal(hashes.length, 15);
  for (const hash of hashes) assert.equal(git(repo, ['rev-parse', `${hash}^{tree}`]), initialTree);
  assert.equal(git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']), 'src.txt');
  assert.equal(git(repo, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(readFileSync(join(repo, 'src.txt'), 'utf8'), 'source\n');
});

test('20. existing history is preserved, never rewritten', () => {
  const repo = createRepo();
  userCommit(repo, 'feat: user work');
  marked(repo, FIRST, 1);
  userCommit(repo, 'fix: more user work');
  const before = git(repo, ['rev-list', 'HEAD']).split('\n');
  const branch = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  write(repo, FIRST, LAST);
  const after = git(repo, ['rev-list', 'HEAD']).split('\n');
  assert.equal(after.length, before.length + 14);
  assert.deepEqual(after.slice(-before.length), before);
  assert.equal(git(repo, ['symbolic-ref', '--short', 'HEAD']), branch);
  git(repo, ['merge-base', '--is-ancestor', before[0], 'HEAD']);
  assert.equal(git(repo, ['remote']), '');
});

// ---- source hygiene and CLI ----------------------------------------------------------------

test('reconciler sources use no shell, no push/destructive git, and no local time', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  const forbidden = /shell:|\.get(Date|Day|FullYear|Month|Hours|Minutes|TimezoneOffset)\(|new Date\(\s*\)|toLocale|Intl\.|['"`](push|reset|clean|add|checkout|switch|rebase|commit|merge|gc|filter-branch)['"`]/;
  let dateNow = 0;
  for (const file of files) {
    const source = readFileSync(join(SRC, file), 'utf8');
    assert.doesNotMatch(source, forbidden, file);
    dateNow += source.match(/Date\.now/g)?.length ?? 0;
  }
  assert.equal(dateNow, 1, 'the only clock read is the injectable default in reconcile()');
});

test('CLI: usage and validation errors give a non-zero exit code', () => {
  const quiet = { log() {}, error() {} };
  assert.equal(run([], quiet), 2);
  assert.equal(run(['2019-10-26', '2019-10-22'], quiet), 2);
  assert.equal(run(['2023-02-29', '2023-03-01'], quiet), 2);
  assert.equal(run([FIRST, LAST, '--bogus'], quiet), 2);
  assert.equal(run([FIRST, LAST, '--repo', join(TMP, 'not a repo')], quiet), 1);

  const repo = createRepo();
  const lines = [];
  assert.equal(run([FIRST, LAST, '--repo', repo], { log: (l) => lines.push(l), error() {} }), 0);
  assert.equal(JSON.parse(lines[0]).dryRun, true);

  const cli = spawnSync(process.execPath, [join(SRC, 'cli.js'), '2019-10-26', '2019-10-22'], { encoding: 'utf8' });
  assert.equal(cli.status, 2);
});

// ---- worker used by the time-zone and concurrency tests -----------------------------------

const WORKER = join(TMP, 'worker.mjs');
writeFileSync(
  WORKER,
  `import { reconcile } from ${JSON.stringify(pathToFileURL(join(SRC, 'reconciler.js')).href)};
import { createPattern } from ${JSON.stringify(pathToFileURL(join(SRC, '..', 'pattern', 'pattern.js')).href)};
const [repo, start, end, mode] = process.argv.slice(2);
try {
  const report = reconcile({
    startDate: start,
    endDate: end,
    dryRun: mode !== 'write',
    cwd: repo,
    pattern: createPattern({ epoch: '2019-10-20', text: 'HELLO, WORLD!' }),
    now: () => ${NOW},
  });
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error.name + ':' + error.code + ':' + error.message);
  process.exit(1);
}
`,
);

function runWorker(repo, start, end, mode, tz) {
  return new Promise((resolve) => {
    const env = tz ? { ...process.env, TZ: tz } : process.env;
    const child = spawn(process.execPath, [WORKER, repo, start, end, mode], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

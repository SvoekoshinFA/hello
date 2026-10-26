# Daily runner

One-shot job that processes **only the current UTC calendar date**: it asks the [Reconciler](../reconciler/README.md) to bring that single date to the target state defined by the [Pattern](../pattern/README.md) module, prints the result and exits.

It does not compute the drawing, read Git history, create commits, lock, push, call GitHub or schedule itself. There is no loop and no timer; `systemd` provides the schedule.

| Concern | Owner |
|---|---|
| Which pixels are on, how many commits | Pattern (`createPattern` / default config) |
| History analysis, locking, commit creation, commit timestamps | Reconciler (`reconcile`) |
| Which date is "today" (UTC), logging, exit code | Daily runner |

## Run manually

```
npm run ticker:daily              # writes the missing commits for today (UTC)
npm run ticker:daily -- --dry-run # only reports; changes nothing
```

(`npm run` needs the repository's working tree to be clean for writing, same as the Reconciler.) Equivalent without npm: `node src/daily-runner/daily-runner.js [--dry-run]`.

### Example output

One JSON object per line; start and success go to stdout, warnings, errors and failed results to stderr.

```
{"operation":"ticker-daily","event":"start","date":"2026-10-26","mode":"write"}
{"operation":"ticker-daily","event":"finish","date":"2026-10-26","datesChecked":1,"commitsExisting":0,"commitsPlanned":3,"commitsCreated":3,"warnings":0,"errors":0,"status":"ok"}
```

Failure (non-zero exit, nothing reported as success):

```
{"operation":"ticker-daily","event":"error","date":"2026-10-26","name":"ReconcilerError","code":"DIRTY_WORKTREE","message":"Refusing to write: 1 uncommitted change(s) in the working tree"}
{"operation":"ticker-daily","event":"finish","date":"2026-10-26","datesChecked":0,"commitsExisting":0,"commitsPlanned":0,"commitsCreated":0,"warnings":0,"errors":1,"status":"failed"}
```

`status`: `ok`, `incomplete`, `locked`, `failed`. Secrets are never logged and none are needed.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Target reached for today (including: pixel off, or already complete, or `--dry-run` analysis succeeded) |
| `1` | Failure: Git error, not a repository, dirty working tree, integrity problem (duplicate or invalid markers), or `incomplete` |
| `2` | Bad command-line arguments |
| `75` | Another Reconciler run holds the lock; this run wrote nothing (the Reconciler's own lock is used, there is no second one) |

`incomplete` means the pixel is on but its commit time (`12:00 UTC`) has not been reached yet, so the Reconciler refuses to create future-dated commits. Run after 12:00 UTC; the suggested timer (13:17 UTC) does.

## API

```js
import { runDaily, main, exitCodeFor, EXIT } from './daily-runner.js';

const result = runDaily();   // processes today (UTC); never throws for operational failures
process.exitCode = exitCodeFor(result);
```

`runDaily({ dryRun = false, clock, reconcile, cwd, pattern, logger })` returns `{ ok, status, date, dryRun, datesChecked, commitsExisting, commitsPlanned, commitsCreated, warnings, errors, error, report }`. The options other than `dryRun` exist for tests and integration: `clock` returns a `Date` (default: the system clock), `reconcile` replaces the Reconciler, `cwd` selects the repository, `pattern` a Pattern instance, `logger` is `{ out(line), err(line) }`. `main(argv, options)` parses `--dry-run` and returns the exit code. Importing the module never starts anything; only executing the file directly runs `main()`.

## UTC rules

- The clock is read **once** at the start: `instant.toISOString().slice(0, 10)` is the date, and the same instant is handed to the Reconciler as "now". A run that crosses 00:00 UTC still processes exactly one date.
- The server's time zone is irrelevant (tests run the same instant in six zones, including `Pacific/Kiritimati` and `America/Los_Angeles`).
- Commit timestamps are the Reconciler's responsibility (`12:00:00 +0000` of the pixel's date).

## Daily run vs. restoring a range

The Daily runner handles **today only**. It does **not** restore missed days: if the machine was off, or a run failed, the earlier days stay unprocessed. `Persistent=true` makes systemd start one run after downtime, and that run still processes only the date on which it executes. To restore past days use the Reconciler with a range:

```
node src/reconciler/cli.js 2026-10-01 2026-10-25            # preview
node src/reconciler/cli.js 2026-10-01 2026-10-25 --write
```

## systemd (templates in [deploy/](../../deploy))

Nothing is installed or enabled automatically. Schedule: **13:17 UTC** daily (set in the timer file, not in code).

1. Create an unprivileged user that owns the repository clone and give the repository its own Git identity (the service has no home directory access):
   ```
   sudo useradd --system --home-dir /opt/hello --shell /usr/sbin/nologin hello-ticker
   sudo chown -R hello-ticker:hello-ticker /opt/hello
   sudo -u hello-ticker git -C /opt/hello config user.name  "Your Name"
   sudo -u hello-ticker git -C /opt/hello config user.email "you@example.com"
   ```
2. Edit [hello-ticker-daily.service](../../deploy/hello-ticker-daily.service): `WorkingDirectory`, the `ExecStart` path to the repository, `ReadWritePaths`, `RequiresMountsFor`, and the Node.js path (`command -v node`).
3. Install and enable:
   ```
   sudo cp deploy/hello-ticker-daily.service deploy/hello-ticker-daily.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now hello-ticker-daily.timer
   ```
4. Verify:
   ```
   systemctl list-timers hello-ticker-daily.timer     # next run at 13:17 UTC
   sudo systemctl start hello-ticker-daily.service    # run once now (optional)
   systemctl status hello-ticker-daily.service        # "inactive (dead)" + status=0/SUCCESS after a good run
   ```
5. Logs:
   ```
   journalctl -u hello-ticker-daily.service            # all runs
   journalctl -u hello-ticker-daily.service --since today -o cat
   ```

The service runs `Type=oneshot` with the explicit Node.js path (no shell, no `npm` wrapper needed), logs to the journal, limits memory/tasks and filesystem access (`ProtectSystem=strict`, writable only inside the repository) and stores no secrets. A non-zero exit shows up as a failed unit. To remove: `sudo systemctl disable --now hello-ticker-daily.timer` and delete the two files from `/etc/systemd/system/`.

## Tests

```
npm test                                              # everything
node --test src/daily-runner/daily-runner.test.js     # Daily runner only
```

Unit tests inject the clock and a fake Reconciler; integration tests use temporary local Git repositories with an isolated Git configuration (no remote, network, tokens or SSH keys). The systemd templates are not exercised by the tests.

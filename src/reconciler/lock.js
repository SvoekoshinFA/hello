/** Exclusive lock file used to prevent parallel reconciler runs on one repository. */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

export class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockError';
    this.code = 'LOCKED';
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function tryCreate(lockPath) {
  try {
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Acquires the lock and returns a release function. A lock left by a process that no longer
 * exists (crash, forced stop) is treated as stale and replaced.
 */
export function acquireLock(lockPath) {
  if (!tryCreate(lockPath)) {
    let content = '';
    try {
      content = readFileSync(lockPath, 'utf8').trim();
    } catch {
      // The holder released it between our attempts; the retry below decides.
    }
    const pid = Number(content);
    if (Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid)) {
      try {
        if (readFileSync(lockPath, 'utf8').trim() === content) unlinkSync(lockPath);
      } catch {
        // Already removed by someone else.
      }
    }
    if (!tryCreate(lockPath)) {
      throw new LockError(`Another reconciler run holds the lock (${lockPath}${content ? `, pid ${content}` : ''})`);
    }
  }
  return () => {
    try {
      if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath);
    } catch {
      // Lock already gone.
    }
  };
}

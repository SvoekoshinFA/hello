/**
 * Commit markers. Every generator commit subject starts with
 *   [ticker:v1 date=YYYY-MM-DD index=N] ...
 * Only the start of the subject is inspected: any other commit is "ordinary".
 * A subject that starts with "[ticker:" but is malformed is reported as invalid.
 */
import { toDayNumber } from '../pattern/dates.js';

export const MARKER_PREFIX = '[ticker:';
export const MARKER_VERSION = 'v1';

const VALID_MARKER = /^\[ticker:v1 date=(\d{4}-\d{2}-\d{2}) index=([1-9]\d{0,8})\](?: |$)/;

/** Returns the marker text for a date string and a 1-based index. */
export function formatMarker(date, index) {
  toDayNumber(date);
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError('Marker index must be a positive integer');
  }
  return `${MARKER_PREFIX}${MARKER_VERSION} date=${date} index=${index}]`;
}

/** Full commit subject for a generator commit. */
export function formatSubject(date, index) {
  return `${formatMarker(date, index)} pixel ${date} #${index}`;
}

/**
 * @returns {null | {valid: true, date: string, index: number} | {valid: false, reason: string}}
 * null means the subject is not a generator commit at all.
 */
export function parseSubject(subject) {
  if (!subject.startsWith(MARKER_PREFIX)) return null;
  const match = VALID_MARKER.exec(subject);
  if (!match) return { valid: false, reason: 'malformed or unsupported marker' };
  const [, date, index] = match;
  try {
    toDayNumber(date);
  } catch {
    return { valid: false, reason: `nonexistent calendar date ${date}` };
  }
  return { valid: true, date, index: Number(index) };
}

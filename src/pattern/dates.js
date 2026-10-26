/**
 * Calendar-date helpers. A date is represented as an integer day number
 * (days since 1970-01-01). Only Date.UTC and UTC getters are used, so results
 * never depend on the system time zone.
 */

const MS_PER_DAY = 86_400_000;

/** Parses 'YYYY-MM-DD' or { year, month, day } into a day number. Throws on invalid dates. */
export function toDayNumber(input) {
  let year;
  let month;
  let day;
  if (typeof input === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    if (!match) throw new TypeError(`Invalid date string (expected YYYY-MM-DD): ${input}`);
    [year, month, day] = match.slice(1).map(Number);
  } else if (input !== null && typeof input === 'object' && !(input instanceof Date)) {
    ({ year, month, day } = input);
  } else {
    throw new TypeError('Date must be a YYYY-MM-DD string or a { year, month, day } object');
  }
  if (![year, month, day].every(Number.isInteger)) {
    throw new TypeError('year, month and day must be integers');
  }
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new RangeError(`Nonexistent calendar date: ${year}-${month}-${day}`);
  }
  return ms / MS_PER_DAY;
}

/** Formats a day number as 'YYYY-MM-DD'. */
export function formatDayNumber(dayNumber) {
  return new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Row index of a day: Monday = 0 ... Sunday = 6. 1970-01-01 was a Thursday (row 3). */
export function rowOf(dayNumber) {
  return (((dayNumber + 3) % 7) + 7) % 7;
}

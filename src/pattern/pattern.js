/**
 * Pattern module: maps calendar dates to pixels of the scrolling text drawing.
 *
 * Algorithm (all arithmetic on integer day numbers, no time zones):
 *   row    = weekday of the date, Monday = 0 ... Sunday = 6
 *   anchor = first Monday on or after the epoch (column 0 starts here)
 *   column = floor((day - anchor) / 7)            // one column per calendar week
 *   strip  = text columns, 3 glyph columns + gap per character, repeated forever
 *   pixel  = strip[column mod strip.length][row]
 * Dates before the anchor are always off. The text advances one column per week.
 */
import { CONFIG } from './config.js';
import { GLYPH_HEIGHT, GLYPH_WIDTH, getGlyph } from './font.js';
import { formatDayNumber, rowOf, toDayNumber } from './dates.js';

/** Builds the immutable column strip: each column is a frozen array of `rows` booleans. */
function buildStrip(config) {
  const columns = [];
  for (const char of config.text) {
    const glyph = getGlyph(char);
    for (let x = 0; x < GLYPH_WIDTH; x++) {
      const column = new Array(config.rows).fill(false);
      for (let y = 0; y < GLYPH_HEIGHT; y++) {
        column[config.glyphTopRow + y] = glyph[y][x] === '#';
      }
      columns.push(Object.freeze(column));
    }
    for (let g = 0; g < config.glyphGap; g++) {
      columns.push(Object.freeze(new Array(config.rows).fill(false)));
    }
  }
  return Object.freeze(columns);
}

function validateTargetCommits(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError('targetCommits must be a non-negative integer');
  }
}

/**
 * Creates an independent pattern instance. Options override CONFIG
 * (e.g. { targetCommits: 5, epoch: '2019-10-20', text: 'HELLO' }).
 */
export function createPattern(options = {}) {
  const config = { ...CONFIG, ...options };
  validateTargetCommits(config.targetCommits);
  const epoch = toDayNumber(config.epoch);
  const strip = buildStrip(config);
  const anchor = epoch + ((7 - rowOf(epoch)) % 7);

  /** Pixel state for an already-parsed day number. */
  function pixelAt(day) {
    if (day < anchor) return false;
    const column = Math.floor((day - anchor) / 7);
    return strip[column % strip.length][rowOf(day)];
  }

  /** @returns {boolean} whether the pixel for the calendar date is on. */
  function isPixelOn(date) {
    return pixelAt(toDayNumber(date));
  }

  /** @returns {number} target commits: configured value if the pixel is on, else 0. */
  function targetCommits(date) {
    return pixelAt(toDayNumber(date)) ? config.targetCommits : 0;
  }

  /**
   * @param {string|{year:number,month:number,day:number}} weekStartDate must be a Monday
   * @returns {boolean[]} 7 states, Monday first. Throws RangeError if not a Monday.
   */
  function getWeek(weekStartDate) {
    const start = toDayNumber(weekStartDate);
    if (rowOf(start) !== 0) {
      throw new RangeError(`Week start must be a Monday, got ${formatDayNumber(start)}`);
    }
    return Array.from({ length: 7 }, (_, i) => pixelAt(start + i));
  }

  /**
   * @returns {{date: string, row: number, on: boolean, commits: number}[]}
   * one entry per day, start and end inclusive. Throws if end is before start.
   */
  function getPattern(startDate, endDate) {
    const start = toDayNumber(startDate);
    const end = toDayNumber(endDate);
    if (end < start) throw new RangeError('endDate must not be before startDate');
    const result = [];
    for (let day = start; day <= end; day++) {
      const on = pixelAt(day);
      result.push({
        date: formatDayNumber(day),
        row: rowOf(day),
        on,
        commits: on ? config.targetCommits : 0,
      });
    }
    return result;
  }

  return Object.freeze({ isPixelOn, targetCommits, getWeek, getPattern });
}

const defaultPattern = createPattern();

export const isPixelOn = defaultPattern.isPixelOn;
export const targetCommits = defaultPattern.targetCommits;
export const getWeek = defaultPattern.getWeek;
export const getPattern = defaultPattern.getPattern;

/** Renders weeks as ASCII (rows Mon..Sun, '#' on, '.' off) starting at a Monday. */
export function renderAscii(weekStartDate, weeks, pattern = defaultPattern) {
  const start = toDayNumber(weekStartDate);
  const lines = [];
  for (let row = 0; row < 7; row++) {
    let line = '';
    for (let w = 0; w < weeks; w++) {
      line += pattern.getWeek(formatDayNumber(start + w * 7))[row] ? '#' : '.';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

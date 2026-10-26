import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { FONT, GLYPH_HEIGHT, GLYPH_WIDTH, getGlyph } from './font.js';
import { createPattern, getPattern, getWeek, isPixelOn, renderAscii, targetCommits } from './pattern.js';

const EXPECTED_FONT = {
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  E: ['###', '#..', '###', '#..', '###'],
  L: ['#..', '#..', '#..', '#..', '###'],
  O: ['###', '#.#', '#.#', '#.#', '###'],
  W: ['#.#', '#.#', '#.#', '###', '#.#'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  ' ': ['...', '...', '...', '...', '...'],
  ',': ['...', '...', '...', '.#.', '#..'],
  '!': ['.#.', '.#.', '.#.', '...', '.#.'],
};

const dir = fileURLToPath(new URL('.', import.meta.url));

/** Epoch from config.js (a Monday), so column 0 starts on the epoch itself. */
const EPOCH = '2019-08-19';
/** Number of columns before the text repeats: 14 characters * (3 + 1). */
const PERIOD = 56;

/** Day string offset by `days` from a YYYY-MM-DD string, computed in UTC. */
function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole weeks between the epoch and a Monday. */
const weeksSinceEpoch = (monday) => (Date.parse(`${monday}T00:00:00Z`) - Date.parse(`${EPOCH}T00:00:00Z`)) / (7 * 86_400_000);

/** Pixel column (7 booleans, Mon..Sun) for the n-th week after the epoch. */
function columnAt(n) {
  return getWeek(addDays(EPOCH, 7 * n));
}

const glyphColumn = (char, x) =>
  [false, ...Array.from({ length: GLYPH_HEIGHT }, (_, y) => FONT[char][y][x] === '#'), false];

test('1. every font character matches its expected 3x5 matrix', () => {
  assert.deepEqual(Object.keys(FONT).sort(), Object.keys(EXPECTED_FONT).sort());
  for (const [char, rows] of Object.entries(EXPECTED_FONT)) {
    assert.deepEqual(getGlyph(char), rows, `glyph ${char}`);
    assert.equal(rows.length, GLYPH_HEIGHT);
    for (const row of rows) assert.equal(row.length, GLYPH_WIDTH);
  }
  assert.throws(() => getGlyph('Q'), RangeError);
  assert.throws(() => createPattern({ text: 'HELLO?' }), RangeError);
});

test('2. space produces an empty area between words (3 columns + gap)', () => {
  // "HELLO," occupies 6 chars * 4 columns = 24; the space is columns 24..27.
  for (let n = 24; n < 28; n++) assert.deepEqual(columnAt(n), Array(7).fill(false), `column ${n}`);
});

test('3. comma and exclamation mark are rendered with correct shape and position', () => {
  const commaStart = 5 * 4; // 'H','E','L','L','O' precede it
  assert.deepEqual(columnAt(commaStart), [false, false, false, false, false, true, false]);
  assert.deepEqual(columnAt(commaStart + 1), [false, false, false, false, true, false, false]);
  assert.deepEqual(columnAt(commaStart + 2), Array(7).fill(false));
  const bangStart = 12 * 4; // middle column holds the stroke and the dot
  assert.deepEqual(columnAt(bangStart + 1), [false, true, true, true, false, true, false]);
  assert.deepEqual(columnAt(bangStart), Array(7).fill(false));
});

test('4. repeated calls for one date return the same result', () => {
  const results = Array.from({ length: 5 }, () => [isPixelOn('2024-02-29'), targetCommits('2024-02-29')]);
  for (const r of results) assert.deepEqual(r, results[0]);
});

test('5. dates before the epoch are off', () => {
  for (let d = -400; d < 0; d++) assert.equal(isPixelOn(addDays(EPOCH, d)), false);
  assert.equal(isPixelOn('1999-01-01'), false);
  assert.equal(targetCommits('2019-08-20') > 0, true);
  assert.equal(targetCommits('2019-08-18'), 0);
});

test('6. epoch date and following weeks are calculated correctly', () => {
  assert.equal(CONFIG.epoch, EPOCH);
  assert.equal(CONFIG.text, 'HELLO, WORLD! ');
  assert.equal(isPixelOn(EPOCH), false); // epoch Monday, row 0 is blank
  assert.equal(isPixelOn('2019-08-20'), true); // Tuesday of column 0: top of H's left stem
  assert.deepEqual(columnAt(0), glyphColumn('H', 0));
  assert.deepEqual(columnAt(1), glyphColumn('H', 1));
  assert.deepEqual(columnAt(3), Array(7).fill(false)); // gap after H
  assert.deepEqual(columnAt(4), glyphColumn('E', 0));
  assert.deepEqual(getWeek('2019-08-12'), Array(7).fill(false)); // before the first column
});

test('7. Monday maps to row 0 and Sunday to row 6', () => {
  // L column 0 is a full 5-pixel stem: placed at the top it covers Monday..Friday,
  // placed at glyphTopRow 2 it covers Wednesday..Sunday.
  const top = createPattern({ text: 'L', glyphTopRow: 0 });
  assert.deepEqual(top.getWeek(EPOCH), [true, true, true, true, true, false, false]);
  const bottom = createPattern({ text: 'L', glyphTopRow: 2 });
  assert.deepEqual(bottom.getWeek(EPOCH), [false, false, true, true, true, true, true]);
  const week = getPattern(EPOCH, '2019-08-25');
  assert.deepEqual(week.map((d) => d.row), [0, 1, 2, 3, 4, 5, 6]);
});

test('8. month boundary does not reset the sequence', () => {
  assert.deepEqual(getPattern('2019-08-26', '2019-09-08').map((d) => d.on), [
    ...getWeek('2019-08-26'),
    ...getWeek('2019-09-02'),
  ]);
  assert.deepEqual(columnAt(2), glyphColumn('H', 2)); // 2019-09-02 is column 2
  assert.deepEqual(getWeek('2019-09-02'), glyphColumn('H', 2));
});

test('9. 31 Dec -> 1 Jan does not reset the sequence', () => {
  // 2019-12-30 is a Monday and its week spans the year change.
  const n = weeksSinceEpoch('2019-12-30');
  assert.deepEqual(getWeek('2019-12-30'), columnAt(n));
  assert.deepEqual(getWeek('2020-01-06'), columnAt(n + 1));
});

test('10. leap year does not break the sequence', () => {
  assert.equal(addDays('2024-02-28', 2), '2024-03-01'); // 29 Feb exists
  assert.doesNotThrow(() => isPixelOn('2024-02-29'));
  assert.throws(() => isPixelOn('2023-02-29'), RangeError);
  const monday = '2024-02-26';
  const n = weeksSinceEpoch(monday);
  assert.deepEqual(getWeek(monday), columnAt(n));
  assert.deepEqual(getWeek('2024-03-04'), columnAt(n + 1));
});

test('11. end of the text continues into the next repetition', () => {
  const period = CONFIG.text.length * (GLYPH_WIDTH + CONFIG.glyphGap);
  assert.equal(period, PERIOD);
  // '!' occupies columns 48..50 (gap 51); the trailing space adds columns 52..55 (and its gap).
  assert.deepEqual(columnAt(49), glyphColumn('!', 1));
  for (let n = 51; n < PERIOD; n++) assert.deepEqual(columnAt(n), Array(7).fill(false), `column ${n}`);
  assert.deepEqual(columnAt(PERIOD), columnAt(0));
  assert.deepEqual(columnAt(PERIOD + 4), columnAt(4));
  assert.deepEqual(columnAt(PERIOD * 7 + 1), columnAt(1));
});

test('12. changing target commits does not change the pixel map', () => {
  const a = createPattern({ targetCommits: 3 });
  const b = createPattern({ targetCommits: 9 });
  const strip = (p) => p.getPattern('2019-08-12', '2020-12-31').map((d) => d.on);
  assert.deepEqual(strip(a), strip(b));
  assert.equal(a.targetCommits('2019-08-20'), 3);
  assert.equal(b.targetCommits('2019-08-20'), 9);
  assert.equal(b.targetCommits(EPOCH), 0);
  assert.equal(targetCommits('2019-08-20'), CONFIG.targetCommits);
  assert.throws(() => createPattern({ targetCommits: -1 }), RangeError);
});

test('13. get_pattern is identical for identical ranges and inclusive', () => {
  const first = getPattern('2020-01-01', '2020-03-31');
  assert.deepEqual(getPattern('2020-01-01', '2020-03-31'), first);
  assert.equal(first.length, 91); // leap-year Q1, both ends included
  assert.equal(first[0].date, '2020-01-01');
  assert.equal(first.at(-1).date, '2020-03-31');
  assert.throws(() => getPattern('2020-02-02', '2020-02-01'), RangeError);
});

test('get_week requires a Monday', () => {
  assert.throws(() => getWeek('2019-08-20'), /Monday/);
  assert.equal(getWeek(EPOCH).length, 7);
});

test('input accepts strings and plain objects, rejects Date objects', () => {
  assert.equal(isPixelOn({ year: 2019, month: 8, day: 20 }), true);
  assert.throws(() => isPixelOn(new Date()), TypeError);
  assert.throws(() => isPixelOn('2019-1-1'), TypeError);
});

test('14. module does not use local time and is time-zone independent', () => {
  const forbidden =
    /\.get(Date|Day|FullYear|Month|Hours|Minutes|Seconds|TimezoneOffset)\(|Date\.now|new Date\(\s*\)|toLocale|Intl\.|setHours/;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))) {
    assert.doesNotMatch(readFileSync(dir + file, 'utf8'), forbidden, file);
  }
  const script = `
    import { getPattern } from ${JSON.stringify(new URL('./pattern.js', import.meta.url).href)};
    process.stdout.write(JSON.stringify(getPattern('2019-08-12', '2021-12-31')));`;
  const outputs = ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Tbilisi'].map((TZ) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ },
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    }),
  );
  for (const out of outputs) assert.equal(out, outputs[0]);
});

test('ASCII preview renders the text and repeats', () => {
  const art = renderAscii(EPOCH, PERIOD * 2).split('\n');
  assert.equal(art.length, 7);
  assert.equal(art[0], '.'.repeat(PERIOD * 2)); // Monday row is never used
  for (const line of art) assert.equal(line.slice(0, PERIOD), line.slice(PERIOD));
});

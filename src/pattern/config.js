/** Pattern configuration. Geometry constants live here, separate from the algorithm. */
export const CONFIG = Object.freeze({
  /** First date of the drawing (a Sunday), as a calendar date. */
  epoch: '2019-08-19',
  text: 'HELLO, WORLD! ',
  /** Default target commit count for an enabled pixel. Does not affect geometry. */
  targetCommits: 5,
  /** Blank columns after every character (including the last, which separates repetitions). */
  glyphGap: 1,
  /** Calendar rows (Monday = 0 ... Sunday = 6). */
  rows: 7,
  /** Row of the glyph's top line; a 5-row glyph occupies rows 1..5 (Tue..Sat). */
  glyphTopRow: 1,
});

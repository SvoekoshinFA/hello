# Pattern module

Pure logic that turns the text `HELLO, WORLD! ` (with a trailing space, which widens the gap between repetitions) into a deterministic pixel map for a GitHub-style activity calendar. It does no Git/GitHub work, I/O, networking or scheduling.

## Algorithm

All dates are calendar dates (`'YYYY-MM-DD'` or `{ year, month, day }`), converted to an integer day number via `Date.UTC`; the system time zone is never used. `Date` objects are rejected.

```
row    = weekday: Mon 0, Tue 1, ... Sun 6
anchor = first Monday on or after the epoch (2019-08-19, already a Monday -> itself)
column = floor((day - anchor) / 7)           one column per calendar week
strip  = per character: 3 glyph columns + 1 blank column (period 14 * 4 = 56 columns)
pixel  = strip[column mod 56][row]
```

- Dates before the anchor are off; the epoch Monday itself is off because Monday is never used by the glyphs.
- Text scrolls one column per week and repeats with no extra offset: after `!` (columns 48-50) come 5 blank columns (its gap, the space and the space's gap).
- The 3x5 glyph sits on rows 1..5 (Tue..Sat); Monday and Sunday stay empty.
- Unsupported characters throw `RangeError`.

Configuration (epoch, text, default target commits, gap, rows) lives in [config.js](./config.js); the font in [font.js](./font.js).

## API ([pattern.js](./pattern.js))

| Function | Returns |
|---|---|
| `isPixelOn(date)` | `boolean` |
| `targetCommits(date)` | configured count (default `3`) if on, else `0` |
| `getWeek(mondayDate)` | `boolean[7]`, Monday first; throws `RangeError` if not a Monday |
| `getPattern(start, end)` | `{ date, row, on, commits }[]`, both ends inclusive; throws if `end < start` |
| `createPattern(options)` | independent instance with the same four methods; options override config, e.g. `{ targetCommits: 5 }` |
| `renderAscii(mondayDate, weeks)` | ASCII preview, rows Mon..Sun |

## Example

```js
import { isPixelOn, targetCommits } from './pattern.js';

isPixelOn('2019-08-20');       // true  (top of the first H stem)
targetCommits('2019-08-20');   // 3
targetCommits('2019-08-19');   // 0
```

## Preview (56 weeks from 2019-08-19, Mon..Sun)

```
........................................................
#.#.###.#...#...###.........#.#.###.##..#...##...#......
#.#.#...#...#...#.#.........#.#.#.#.#.#.#...#.#..#......
###.###.#...#...#.#.........#.#.#.#.##..#...#.#..#......
#.#.#...#...#...#.#..#......###.#.#.#.#.#...#.#.........
#.#.###.###.###.###.#.......#.#.###.#.#.###.##...#......
........................................................
```

After 56 columns the text repeats (the last 5 columns above are the blank separator).

## Tests

`npm test` (Node's built-in `node:test`, no dependencies). `node src/pattern/example.js` prints the example and preview.

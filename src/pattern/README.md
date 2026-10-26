# Pattern module

Pure logic that turns the text `HELLO, WORLD!` into a deterministic pixel map for a GitHub-style activity calendar. It does no Git/GitHub work, I/O, networking or scheduling.

## Algorithm

All dates are calendar dates (`'YYYY-MM-DD'` or `{ year, month, day }`), converted to an integer day number via `Date.UTC`; the system time zone is never used. `Date` objects are rejected.

```
row    = weekday: Mon 0, Tue 1, ... Sun 6
anchor = first Monday on or after the epoch (2019-10-20, a Sunday -> 2019-10-21)
column = floor((day - anchor) / 7)           one column per calendar week
strip  = per character: 3 glyph columns + 1 blank column (period 13 * 4 = 52 columns)
pixel  = strip[column mod 52][row]
```

- Dates before the anchor (including the epoch Sunday itself) are off.
- Text scrolls one column per week and repeats with no extra offset.
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

isPixelOn('2019-10-22');       // true  (top of the first H stem)
targetCommits('2019-10-22');   // 3
targetCommits('2019-10-21');   // 0
```

## Preview (56 weeks from 2019-10-21, Mon..Sun)

```
........................................................
#.#.###.#...#...###.........#.#.###.##..#...##...#..#.#.
#.#.#...#...#...#.#.........#.#.#.#.#.#.#...#.#..#..#.#.
###.###.#...#...#.#.........#.#.#.#.##..#...#.#..#..###.
#.#.#...#...#...#.#..#......###.#.#.#.#.#...#.#.....#.#.
#.#.###.###.###.###.#.......#.#.###.#.#.###.##...#..#.#.
........................................................
```

After 52 columns the text repeats.

## Tests

`npm test` (Node's built-in `node:test`, no dependencies). `node src/pattern/example.js` prints the example and preview.

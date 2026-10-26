/** Compact 3x5 bitmap font. '#' = pixel on, '.' = off. Rows are listed top to bottom. */
export const GLYPH_WIDTH = 3;
export const GLYPH_HEIGHT = 5;

const raw = {
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

for (const rows of Object.values(raw)) Object.freeze(rows);

export const FONT = Object.freeze(raw);

/** Returns the glyph rows for a character; throws on unsupported characters. */
export function getGlyph(char) {
  if (!Object.hasOwn(FONT, char)) {
    throw new RangeError(`Unsupported character: ${JSON.stringify(char)}`);
  }
  return FONT[char];
}

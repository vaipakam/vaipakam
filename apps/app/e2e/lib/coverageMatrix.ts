/**
 * The coverage matrix's shape rule (#2143): `e2e/COVERAGE.md` is a MATRIX —
 * what is covered, at which tier, and where the driver is — and
 * `e2e/COVERAGE-NOTES.md` holds the long form behind a row.
 *
 * The matrix had grown into long-form narrative inside table cells (one
 * cell passed 60,000 characters), which no renderer shows as a table. The
 * per-PR rule that every behaviour change updates the matrix only ever
 * appends, so the shape needs a check rather than a convention: a cell may
 * hold at most {@link CELL_CAP} characters, and every link from the matrix
 * into the notes must land on an anchor that exists.
 *
 * Pure, so it is unit-tested; `scripts/check-coverage-matrix.ts` runs it
 * over the committed files in the app's typecheck.
 */

/** The most a matrix cell may hold: a sentence or two, then a link. */
export const CELL_CAP = 600;

const NOTES_FILE = 'COVERAGE-NOTES.md';

/** A table row's cells, split on unescaped pipes. Null for a line that is
 *  not a table row, or for a header separator (`| --- | --- |`). */
export function tableCells(line: string): string[] | null {
  if (!line.startsWith('|')) return null;
  const cells = line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim());
  if (cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c))) return null;
  return cells;
}

/** The anchors the notes file declares (`<a id="…"></a>`). */
export function notesAnchors(notes: string): Set<string> {
  return new Set([...notes.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]));
}

export interface MatrixProblem {
  line: number;
  message: string;
}

/** Everything wrong with the matrix and its notes; empty when both hold. */
export function checkCoverageMatrix(matrix: string, notes: string): MatrixProblem[] {
  const problems: MatrixProblem[] = [];
  const anchors = notesAnchors(notes);
  const linked = new Set<string>();
  const linkRe = new RegExp(`${NOTES_FILE.replace('.', '\\.')}#([A-Za-z0-9_-]+)`, 'g');
  matrix.split('\n').forEach((text, i) => {
    const line = i + 1;
    for (const m of text.matchAll(linkRe)) {
      linked.add(m[1]);
      if (!anchors.has(m[1])) {
        problems.push({ line, message: `links to ${NOTES_FILE}#${m[1]}, which has no such anchor` });
      }
    }
    const cells = tableCells(text);
    if (!cells) return;
    cells.forEach((cell, k) => {
      if (cell.length > CELL_CAP) {
        problems.push({
          line,
          message: `cell ${k + 1} holds ${cell.length} characters (cap ${CELL_CAP}): keep a sentence or two here and move the rest to ${NOTES_FILE}`,
        });
      }
    });
  });
  for (const a of anchors) {
    if (!linked.has(a)) {
      problems.push({ line: 0, message: `${NOTES_FILE}#${a} is not linked from the matrix` });
    }
  }
  return problems;
}

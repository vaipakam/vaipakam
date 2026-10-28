/**
 * The coverage matrix's shape rule (#2143): `e2e/COVERAGE.md` is a MATRIX —
 * what is covered, at which tier, and where the driver is — and
 * `e2e/COVERAGE-NOTES.md` holds the long form behind a row.
 *
 * The matrix had grown into long-form narrative inside table cells (one
 * cell passed 60,000 characters), which no renderer shows as a table. The
 * per-PR rule that every behaviour change updates the matrix only ever
 * appends, so the shape needs a check rather than a convention: a cell may
 * hold at most {@link CELL_CAP} characters, a row may hold no more cells
 * than its table has columns, and every link from the matrix into the notes
 * must land on an anchor that exists.
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
  const lines = matrix.split('\n');
  // Columns of the table the current row belongs to: its header row is the
  // line just above a separator (`| --- | --- |`).
  let columns: number | null = null;
  lines.forEach((text, i) => {
    const line = i + 1;
    if (!text.startsWith('|')) columns = null;
    else if (tableCells(text) === null && i > 0) columns = tableCells(lines[i - 1])?.length ?? null;
    for (const m of text.matchAll(linkRe)) {
      linked.add(m[1]);
      if (!anchors.has(m[1])) {
        problems.push({ line, message: `links to ${NOTES_FILE}#${m[1]}, which has no such anchor` });
      }
    }
    const cells = tableCells(text);
    if (!cells) return;
    // GFM splits a cell on EVERY unescaped pipe, inside a code span too, and
    // drops the cells past the header's count without a trace: the matrix
    // carried three rows whose last columns never rendered that way.
    if (columns !== null && cells.length > columns) {
      problems.push({
        line,
        message: `row has ${cells.length} cells but its table has ${columns} columns: escape a pipe inside a cell, code spans included, as \\|`,
      });
    }
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

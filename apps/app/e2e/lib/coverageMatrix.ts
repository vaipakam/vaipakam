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
 * than its table has columns nor sit outside a table, and every link from
 * the matrix into the notes must land on an anchor that exists.
 *
 * Pure, so it is unit-tested; `scripts/check-coverage-matrix.ts` runs it
 * over the committed files in the app's typecheck.
 */

/** The most a matrix cell may hold: a sentence or two, then a link. */
export const CELL_CAP = 600;

const NOTES_FILE = 'COVERAGE-NOTES.md';

/** A table row's cells, read as GFM reads them: an optional leading pipe
 *  and an optional trailing (unescaped) pipe are delimiters, not cells, and
 *  every other unescaped pipe splits, inside a code span too. */
export function rowCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (/(?<!\\)\|$/.test(row)) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((c) => c.trim());
}

/** True for a GFM delimiter row (`| --- | :---: |`). */
function isDelimiterRow(line: string): boolean {
  return line.includes('-') && rowCells(line).every((c) => /^:?-+:?$/.test(c));
}

export interface MatrixTable {
  /** Header cell count, which is every row's rendered column count. */
  columns: number;
  /** Body rows, with their 1-based line numbers. */
  rows: { line: number; cells: string[] }[];
}

/** The tables in a Markdown file, found the way GFM finds them: a header
 *  row followed by a delimiter row with the same cell count, then body rows
 *  up to the first blank line. Locating rows by context rather than by a
 *  leading pipe means a row written without its outer pipes is still read. */
export function matrixTables(markdown: string): MatrixTable[] {
  const lines = markdown.split('\n');
  const tables: MatrixTable[] = [];
  for (let i = 1; i < lines.length; i++) {
    const header = lines[i - 1];
    if (!header.includes('|') || !isDelimiterRow(lines[i])) continue;
    const columns = rowCells(header).length;
    if (rowCells(lines[i]).length !== columns) continue;
    const table: MatrixTable = { columns, rows: [{ line: i, cells: rowCells(header) }] };
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== ''; j++) {
      table.rows.push({ line: j + 1, cells: rowCells(lines[j]) });
    }
    tables.push(table);
    i = j;
  }
  return tables;
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
    for (const m of text.matchAll(linkRe)) {
      linked.add(m[1]);
      if (!anchors.has(m[1])) {
        problems.push({ line: i + 1, message: `links to ${NOTES_FILE}#${m[1]}, which has no such anchor` });
      }
    }
  });
  const tables = matrixTables(matrix);
  const tableLines = new Set(tables.flatMap((t) => [t.rows[0].line + 1, ...t.rows.map((r) => r.line)]));
  matrix.split('\n').forEach((text, i) => {
    // A blank line ends a GFM table: a row written after one renders as text.
    if (text.trimStart().startsWith('|') && !tableLines.has(i + 1)) {
      problems.push({
        line: i + 1,
        message: 'row is outside any table (a blank line above it ended the table, so it renders as text): keep a table\'s rows together',
      });
    }
  });
  for (const { columns, rows } of tables) {
    for (const { line, cells } of rows) {
      // GFM splits a cell on EVERY unescaped pipe, inside a code span too,
      // and drops the cells past the header's count without a trace: the
      // matrix carried three rows whose last columns never rendered that way.
      if (cells.length > columns) {
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
    }
  }
  for (const a of anchors) {
    if (!linked.has(a)) {
      problems.push({ line: 0, message: `${NOTES_FILE}#${a} is not linked from the matrix` });
    }
  }
  return problems;
}

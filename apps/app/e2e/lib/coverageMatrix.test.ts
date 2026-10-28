import { describe, expect, it } from 'vitest';
import { CELL_CAP, checkCoverageMatrix, matrixTables, notesAnchors, rowCells } from './coverageMatrix';

const NOTES = '<a id="cov-a"></a>\n\n## A\n\n**Feature.** long form\n';

describe('the coverage matrix shape rule (#2143)', () => {
  it('splits a row on unescaped pipes only, outer pipes optional', () => {
    expect(rowCells('| a \\| b | c |')).toEqual(['a \\| b', 'c']);
    expect(rowCells('a \\| b | c')).toEqual(['a \\| b', 'c']);
    expect(rowCells('| a | c \\|')).toEqual(['a', 'c \\|']);
  });

  it('finds tables by header and delimiter, not by a leading pipe', () => {
    const md = 'prose | with a pipe\n\nA | B\n--- | :---:\nx | y\n| z | w |\n\nafter | table';
    expect(matrixTables(md)).toEqual([
      { columns: 2, rows: [
        { line: 3, cells: ['A', 'B'] },
        { line: 5, cells: ['x', 'y'] },
        { line: 6, cells: ['z', 'w'] },
      ] },
    ]);
  });

  it('caps the last cell of a row written without its trailing pipe', () => {
    const problems = checkCoverageMatrix(`| Feature | Reason\n| --- | ---\n| A | ${'x'.repeat(CELL_CAP + 1)}`, '');
    expect(problems.map((p) => p.line)).toEqual([3]);
    expect(problems[0].message).toContain('cell 2 holds');
  });

  it('accepts short cells and links that land', () => {
    const matrix = '| Feature | Tier |\n| --- | --- |\n| A | CI [More](COVERAGE-NOTES.md#cov-a) |';
    expect(checkCoverageMatrix(matrix, NOTES)).toEqual([]);
  });

  it('refuses a cell over the cap and names the line', () => {
    const matrix = `| Feature | Tier |\n| --- | --- |\n| ${'x'.repeat(CELL_CAP + 1)} | CI [More](COVERAGE-NOTES.md#cov-a) |`;
    const problems = checkCoverageMatrix(matrix, NOTES);
    expect(problems).toHaveLength(1);
    expect(problems[0].line).toBe(3);
    expect(problems[0].message).toContain(`${CELL_CAP + 1} characters`);
  });

  it('refuses a row with more cells than its table has columns', () => {
    const header = '| Feature | Tier |\n| --- | --- |\n';
    const problems = checkCoverageMatrix(`${header}| A | \`a || b\` |`, '');
    expect(problems).toHaveLength(1);
    expect(problems[0].line).toBe(3);
    expect(problems[0].message).toContain('row has 4 cells but its table has 2 columns');
    expect(checkCoverageMatrix(`${header}| A | \`a \\|\\| b\` |`, '')).toEqual([]);
  });

  it('refuses a row that a blank line cut off from its table', () => {
    const problems = checkCoverageMatrix('| Feature | Tier |\n| --- | --- |\n| A | CI |\n\n| B | CI |', '');
    expect(problems.map((p) => p.line)).toEqual([5]);
    expect(problems[0].message).toContain('outside any table');
  });

  it('refuses a link to an anchor the notes do not declare', () => {
    const matrix = '| A | B |\n| --- | --- |\n| A | [More](COVERAGE-NOTES.md#cov-a) [More](COVERAGE-NOTES.md#cov-b) |';
    expect(checkCoverageMatrix(matrix, NOTES).map((p) => p.message)).toEqual([
      'links to COVERAGE-NOTES.md#cov-b, which has no such anchor',
    ]);
  });

  it('refuses a notes section nothing links to', () => {
    expect(checkCoverageMatrix('| A | CI |\n| --- | --- |', NOTES).map((p) => p.message)).toEqual([
      'COVERAGE-NOTES.md#cov-a is not linked from the matrix',
    ]);
  });

  it('reads the anchors the notes declare', () => {
    expect([...notesAnchors(`${NOTES}<a id="cov-b"></a>`)]).toEqual(['cov-a', 'cov-b']);
  });
});

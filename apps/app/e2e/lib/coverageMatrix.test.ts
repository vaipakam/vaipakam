import { describe, expect, it } from 'vitest';
import { CELL_CAP, checkCoverageMatrix, notesAnchors, tableCells } from './coverageMatrix';

const NOTES = '<a id="cov-a"></a>\n\n## A\n\n**Feature.** long form\n';

describe('the coverage matrix shape rule (#2143)', () => {
  it('splits a row on unescaped pipes only', () => {
    expect(tableCells('| a \\| b | c |')).toEqual(['a \\| b', 'c']);
    expect(tableCells('| --- | :---: |')).toBeNull();
    expect(tableCells('prose | with a pipe')).toBeNull();
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

  it('refuses a link to an anchor the notes do not declare', () => {
    const matrix = '| A | [More](COVERAGE-NOTES.md#cov-a) [More](COVERAGE-NOTES.md#cov-b) |';
    expect(checkCoverageMatrix(matrix, NOTES).map((p) => p.message)).toEqual([
      'links to COVERAGE-NOTES.md#cov-b, which has no such anchor',
    ]);
  });

  it('refuses a notes section nothing links to', () => {
    expect(checkCoverageMatrix('| A | CI |', NOTES).map((p) => p.message)).toEqual([
      'COVERAGE-NOTES.md#cov-a is not linked from the matrix',
    ]);
  });

  it('reads the anchors the notes declare', () => {
    expect([...notesAnchors(`${NOTES}<a id="cov-b"></a>`)]).toEqual(['cov-a', 'cov-b']);
  });
});

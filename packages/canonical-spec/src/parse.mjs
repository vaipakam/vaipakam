/**
 * The canonical specification's parser (#3948, CanonicalSpecDesign §3, §4).
 *
 * It reads the blocks of `docs/CanonicalSpec/` (and of a draft) into plain
 * data: statements, lifecycle models, record entries, parameters, mistakes and
 * the glossary. It FAILS CLOSED: anything under a statement or model heading
 * that it cannot read is returned as a parse error with its file and line, and
 * never skipped, because a skipped statement would owe no tests and nobody
 * would see it missing (§4 item 13).
 *
 * The grammar is written out in `packages/canonical-spec/README.md`.
 */

export const KINDS = ['rule', 'refusal', 'fund movement', 'authority', 'setting', 'never', 'always possible'];

/** Parts every statement carries, and parts each kind adds (§3.1). */
export const REQUIRED_PARTS = {
  common: ['Tests owed'],
  rule: [],
  refusal: ['Refused as'],
  'fund movement': ['From', 'To', 'Comes to rest in', 'Amount', 'Rounding'],
  authority: ['Held by', 'Changed by'],
  setting: ['Parameter'],
  never: ['Against', 'Watch'],
  'always possible': ['From', 'By', 'Except under'],
};
export const OPTIONAL_PARTS = ['For the mistake'];
export const KNOWN_PARTS = new Set([
  ...REQUIRED_PARTS.common,
  ...Object.values(REQUIRED_PARTS).flat(),
  ...OPTIONAL_PARTS,
]);

export const ID_RE = /\b([A-Z]{3})-(\d{3})\b/g;
export const MISTAKE_ID_RE = /\b([A-Z]{3})-M(\d{2,3})\b/g;
export const THREAT_ID_RE = /\b([A-Z]{3})-T(\d{2,3})\b/g;
export const PARAM_ID_RE = /\bPRM-(\d{3})\b/g;
/** The owed form of a reference to a domain not yet drafted: "(DPL owed: where the treasury is)". */
export const OWED_RE = /\(([A-Z]{3}) owed: ([^)]+)\)/g;

const STATEMENT_HEADING = /^### ([A-Z]{3})-(\d{3}) · ([a-z ]+?)( · held)?$/;
/** A heading that LOOKS like a statement's: an id at its start. Anything so shaped must parse. */
const STATEMENT_SHAPED = /^### [A-Z]{2,4}-\d+\b/;
const MISTAKE_HEADING = /^### ([A-Z]{3})-M(\d{2,3}) · (.+)$/;
const MODEL_HEADING = /^### Model: (.+)$/;
const PART_LINE = /^- \*\*([A-Za-z ]+):\*\*\s*(.*)$/;
const LEAD_LINE = /^\*\*(Who|When):\*\*\s*(.*)$/;

/** Split a file into lines with 1-based numbers. */
const linesOf = (text) => text.split('\n').map((t, i) => ({ t, n: i + 1 }));

/** A Markdown table starting at `i` (header, separator, rows). Returns {header, rows, end}. */
export function readTable(lines, i) {
  const cells = (t) => t.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const header = cells(lines[i].t);
  if (!lines[i + 1] || !/^\|\s*:?-{3,}/.test(lines[i + 1].t.trim())) return null;
  const rows = [];
  let j = i + 2;
  for (; j < lines.length && lines[j].t.trim().startsWith('|'); j++) rows.push({ cells: cells(lines[j].t), line: lines[j].n });
  return { header, rows, end: j };
}

/**
 * Parse one statement block, from its heading to the next heading. Returns
 * {statement, errors}. The block's shape (§3.1):
 *
 *   ### VLT-014 · refusal          (optionally " · held")
 *   **Who:** …                     (one line, may continue)
 *   **When:** …
 *   <body: one or more lines>
 *   - **Part:** …                  (continuation lines indented by two spaces)
 */
function parseStatement(file, lines, start, end) {
  const errors = [];
  const h = STATEMENT_HEADING.exec(lines[start].t);
  const err = (line, message) => errors.push({ file, line, message });
  if (!h || !KINDS.includes(h[3])) {
    err(lines[start].n, `a heading shaped like a statement's that is not one: "${lines[start].t}" (kinds: ${KINDS.join(', ')})`);
    return { errors };
  }
  const s = { id: `${h[1]}-${h[2]}`, code: h[1], number: Number(h[2]), kind: h[3], held: !!h[4], file, line: lines[start].n, who: null, when: null, body: [], parts: {}, partLines: {}, lines: [] };
  let phase = 'lead'; // lead → body → parts
  let lastField = null; // where a continuation line goes
  for (let i = start + 1; i < end; i++) {
    const { t, n } = lines[i];
    s.lines.push({ t, n });
    if (!t.trim()) {
      lastField = phase === 'parts' ? lastField : null;
      continue;
    }
    if (/^```/.test(t.trim())) {
      err(n, `${s.id}: a code block in a statement; a statement names no code`);
      continue;
    }
    const lead = LEAD_LINE.exec(t);
    if (lead) {
      if (phase !== 'lead') err(n, `${s.id}: **${lead[1]}:** after the body; Who and When come first`);
      const key = lead[1].toLowerCase();
      if (s[key] != null) err(n, `${s.id}: **${lead[1]}:** given twice`);
      s[key] = lead[2];
      lastField = key;
      continue;
    }
    const part = PART_LINE.exec(t);
    if (part) {
      phase = 'parts';
      const name = part[1];
      if (!KNOWN_PARTS.has(name)) err(n, `${s.id}: unknown part "${name}" (known: ${[...KNOWN_PARTS].join(', ')})`);
      if (s.parts[name] != null) err(n, `${s.id}: part "${name}" given twice`);
      s.parts[name] = part[2];
      s.partLines[name] = n;
      lastField = `part:${name}`;
      continue;
    }
    if (phase === 'parts') {
      // Only an indented continuation of the part above may follow a part.
      if (/^ {2,}\S/.test(t) && lastField?.startsWith('part:')) {
        const name = lastField.slice(5);
        s.parts[name] = `${s.parts[name]} ${t.trim()}`;
        continue;
      }
      err(n, `${s.id}: cannot read this line as a part of the statement (a part is "- **Name:** text", continued by lines indented two spaces): "${t}"`);
      continue;
    }
    if (phase === 'lead' && lastField && (lastField === 'who' || lastField === 'when') && !/^[-*|#>]/.test(t)) {
      // A line straight after Who/When with no blank line continues it.
      s[lastField] = `${s[lastField]} ${t.trim()}`;
      continue;
    }
    if (/^[-*] |^\d+\. |^\||^>/.test(t)) {
      err(n, `${s.id}: a list, table or quote in the body; the body is plain sentences, and parts are "- **Name:** text"`);
      continue;
    }
    phase = 'body';
    lastField = null;
    s.body.push({ t, n });
  }
  return { statement: s, errors };
}

/** Parse a `### Model: <thing>` block (§3.3). */
function parseModel(file, lines, start, end) {
  const errors = [];
  const name = MODEL_HEADING.exec(lines[start].t)[1].trim();
  const m = { name, file, line: lines[start].n, states: [], start: null, ends: [], steps: [], refusals: [], dimensions: [], accounts: [], texts: [] };
  const err = (line, message) => errors.push({ file, line, message: `model "${name}": ${message}` });
  let section = null;
  for (let i = start + 1; i < end; i++) {
    const { t, n } = lines[i];
    if (!t.trim()) continue;
    const sec = /^\*\*(States|Steps|Refusals out of state|Dimensions|Accounts):\*\*\s*$/.exec(t);
    if (sec) {
      section = sec[1];
      continue;
    }
    if (section === 'States' || section === 'Accounts') {
      const item = /^- (.+)$/.exec(t);
      if (!item) {
        err(n, `cannot read "${t}" under ${section} (a list item "- …")`);
        continue;
      }
      m.texts.push({ line: n, text: item[1] });
      if (section === 'Accounts') m.accounts.push(item[1].trim());
      else {
        const st = /^([^:(]+?)(?: \((start|end)\))?:\s*(.+)$/.exec(item[1]);
        if (!st) {
          err(n, `cannot read the state "${item[1]}" (write "Name: definition", with "(start)" or "(end)" after the name where it applies)`);
          continue;
        }
        const state = st[1].trim();
        m.states.push(state);
        if (st[2] === 'start') {
          if (m.start) err(n, `two start states, ${m.start} and ${state}`);
          m.start = state;
        }
        if (st[2] === 'end') m.ends.push(state);
      }
      continue;
    }
    if (section === 'Steps' || section === 'Refusals out of state' || section === 'Dimensions') {
      if (!t.trim().startsWith('|')) {
        err(n, `cannot read "${t}" under ${section} (a table)`);
        continue;
      }
      const table = readTable(lines, i);
      if (!table) {
        err(n, `the ${section} table has no header separator`);
        continue;
      }
      const want = { Steps: ['From', 'Step', 'Who', 'Guarded by', 'To'], 'Refusals out of state': ['Step', 'Refused by'], Dimensions: ['Dimension', 'Values', 'Named by'] }[section];
      if (want.join('|') !== table.header.join('|')) err(n, `the ${section} table's columns must be ${want.join(' | ')}`);
      for (const r of table.rows) {
        const row = Object.fromEntries(want.map((k, j) => [k, r.cells[j] ?? '']));
        row.line = r.line;
        // The cells a figure could hide in; citation cells hold ids only.
        const prose = want.filter((k) => !['Guarded by', 'Refused by', 'Named by'].includes(k)).map((k) => row[k]).join(' ');
        m.texts.push({ line: r.line, text: prose });
        if (section === 'Steps') m.steps.push(row);
        else if (section === 'Refusals out of state') m.refusals.push(row);
        else m.dimensions.push(row);
      }
      i = table.end - 1;
      continue;
    }
    err(n, `cannot read "${t}" (a model has **States:**, **Steps:**, **Refusals out of state:**, **Dimensions:** and **Accounts:**)`);
  }
  if (!m.start) err(m.line, 'no state is marked (start)');
  if (!m.ends.length) err(m.line, 'no state is marked (end)');
  return { model: m, errors };
}

/** Parse a mistake block (§8.2): `### VLT-M04 · title`, then `**Field:** …` lines. */
function parseMistake(file, lines, start, end) {
  const h = MISTAKE_HEADING.exec(lines[start].t);
  const fields = {};
  let last = null;
  for (let i = start + 1; i < end; i++) {
    const f = /^\*\*([A-Za-z ]+):\*\*\s*(.*)$/.exec(lines[i].t);
    if (f) {
      fields[f[1]] = f[2];
      last = f[1];
    } else if (last && lines[i].t.trim()) fields[last] += ` ${lines[i].t.trim()}`;
  }
  return { mistake: { id: `${h[1]}-M${h[2]}`, code: h[1], title: h[3], file, line: lines[start].n, fields } };
}

/**
 * Parse one Markdown file. Returns everything found in it and every parse
 * error. A heading shaped like a statement's that is not one is an error;
 * a block of a recognised kind that does not read is an error.
 */
export function parseFile(file, text) {
  const lines = linesOf(text);
  const out = { file, lines, statements: [], models: [], mistakes: [], tables: [], errors: [] };
  const headingAt = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3} /.test(lines[i].t)) headingAt.push(i);
    // A statement, mistake or model heading at any level but the third would
    // otherwise be read as plain prose and its block would vanish unchecked.
    const off = /^(#{1,2}|#{4,6}) +(?:[A-Z]{2,4}-[MT]?\d+\b|Model:)/.exec(lines[i].t);
    if (off) out.errors.push({ file, line: lines[i].n, message: `a heading shaped like a statement, mistake or model at level ${off[1].length}; these blocks are level-3 headings ("### …")` });
  }
  headingAt.push(lines.length);
  for (let k = 0; k < headingAt.length - 1; k++) {
    const i = headingAt[k];
    const end = headingAt[k + 1];
    const t = lines[i].t;
    if (MISTAKE_HEADING.test(t)) {
      out.mistakes.push(parseMistake(file, lines, i, end).mistake);
    } else if (STATEMENT_SHAPED.test(t)) {
      const r = parseStatement(file, lines, i, end);
      out.errors.push(...r.errors);
      if (r.statement) out.statements.push(r.statement);
    } else if (MODEL_HEADING.test(t)) {
      const r = parseModel(file, lines, i, end);
      out.errors.push(...r.errors);
      out.models.push(r.model);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t.trim().startsWith('|') && (i === 0 || !lines[i - 1].t.trim().startsWith('|'))) {
      const table = readTable(lines, i);
      if (table) out.tables.push({ ...table, line: lines[i].n });
    }
  }
  return out;
}

/** Record tables: header "Id | Mark | Sources | …" (§3.4). Retired ids: header "Id | Retired by". */
export function recordEntries(parsed) {
  const entries = [];
  const retired = [];
  const owed = [];
  for (const tbl of parsed.tables) {
    const hdr = tbl.header.map((h) => h.toLowerCase());
    if (hdr[0] === 'id' && hdr[1] === 'mark' && hdr[2] === 'sources') {
      const approvedCol = hdr.indexOf('approved');
      for (const r of tbl.rows) {
        entries.push({ id: r.cells[0], mark: r.cells[1], sources: r.cells[2] ?? '', approved: approvedCol >= 0 ? r.cells[approvedCol] ?? '' : '', file: parsed.file, line: r.line });
      }
    } else if (hdr[0] === 'id' && hdr[1] === 'retired by') {
      for (const r of tbl.rows) retired.push({ id: r.cells[0], by: r.cells[1] ?? '', file: parsed.file, line: r.line });
    } else if (hdr[0] === 'owed' && hdr[1] === 'cited by') {
      for (const r of tbl.rows) owed.push({ ref: r.cells[0], by: r.cells[1] ?? '', file: parsed.file, line: r.line });
    }
  }
  return { entries, retired, owed };
}

/** Parameters table: header "Id | Name | Value | …" (§3.2). */
export function parameterRows(parsed) {
  const out = [];
  for (const tbl of parsed.tables) {
    const hdr = tbl.header.map((h) => h.toLowerCase());
    if (hdr[0] === 'id' && hdr[1] === 'name' && hdr[2] === 'value') {
      for (const r of tbl.rows) out.push({ id: r.cells[0], name: r.cells[1], file: parsed.file, line: r.line });
    }
  }
  return out;
}

/** Glossary table: header "Term | Meaning | Instead of" — the words not to use in its place. */
export function glossaryRows(parsed) {
  const out = [];
  for (const tbl of parsed.tables) {
    const hdr = tbl.header.map((h) => h.toLowerCase());
    if (hdr[0] === 'term' && hdr[1] === 'meaning') {
      const insteadCol = hdr.indexOf('instead of');
      for (const r of tbl.rows) {
        const instead = insteadCol >= 0 ? (r.cells[insteadCol] ?? '').split(/[,;]/).map((x) => x.trim().toLowerCase()).filter(Boolean) : [];
        out.push({ term: r.cells[0], instead, file: parsed.file, line: r.line });
      }
    }
  }
  return out;
}

/** The text a statement says, every part included, for the wording and code checks. */
export function statementText(s) {
  return [s.who ?? '', s.when ?? '', ...s.body.map((b) => b.t), ...Object.values(s.parts)].join('\n');
}

/** The normalised text the owner approves: who, when, body and parts, whitespace collapsed. */
export function approvalText(s) {
  const parts = Object.keys(s.parts).sort().map((k) => `${k}: ${s.parts[k]}`);
  return [`${s.id} · ${s.kind}`, `Who: ${s.who ?? ''}`, `When: ${s.when ?? ''}`, ...s.body.map((b) => b.t), ...parts].join('\n').replace(/\s+/g, ' ').trim();
}

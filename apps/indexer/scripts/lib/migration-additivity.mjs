/**
 * The additive-migration rule for the shared D1 database (#2412), as one
 * function the CI check and its tests both call.
 *
 * A shared migration is applied while the previous Workers are still serving
 * (the indexer's deploy applies first and publishes second, #2214 / #2409), so
 * each one must leave the database readable and writable by the code already
 * deployed. That is expand/contract: a migration may ADD (a table, a nullable
 * column, a column with a default, an index) and must not take away or
 * re-shape what live code uses. A destructive change is a coordinated two-step
 * release: stop using the thing in one release, remove it in a later one.
 *
 * What counts as destructive here, and why each:
 *   - `DROP TABLE`                     — live code may still read or write it.
 *   - `ALTER TABLE … DROP COLUMN`      — same, for one column.
 *   - `ALTER TABLE … RENAME …`         — renaming a table or a column is a
 *                                         drop of the old name to every reader.
 *   - `ALTER TABLE … ADD COLUMN … NOT NULL` with no `DEFAULT` — an INSERT from
 *                                         code that predates the column fails.
 *                                         (SQLite refuses this outright on a
 *                                         table with rows; on an empty table it
 *                                         applies, and the old code then breaks.)
 *
 * The SQL is read through a small lexer, never matched as raw text (#2409 r3):
 * comments, quoted strings and quoted identifiers are removed before the
 * statements are split on `;`, so a comment that says "we do not DROP TABLE
 * here" or a string literal holding SQL is not a statement. A `CREATE TRIGGER`
 * body holds `;`-terminated statements of its own until its `END`; those run
 * when the trigger fires, not when the migration applies, so they are skipped.
 *
 * Not covered, on purpose: `DROP INDEX` (an index changes speed, not what a
 * query returns), `DROP TRIGGER` and `DROP VIEW` (no Worker reads a view and
 * triggers here only maintain derived rows), and data statements such as
 * `DELETE` or `UPDATE`, which change rows and not the shape code relies on.
 */

/**
 * The migration with comments, strings and quoted identifiers blanked out,
 * keeping every `;` that separates statements.
 * @param {string} sql
 * @returns {string}
 */
export function stripSql(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated /* comment');
      i = end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error(`unterminated ${c} quote`);
        if (sql[j] === close) {
          // A doubled closing quote is an escaped one, not the end.
          if (close !== ']' && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      // A quoted identifier keeps a placeholder word so `"t" NOT NULL` still
      // reads as a column; a string literal becomes an empty literal.
      out += c === "'" ? "''" : ' q ';
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * The top-level statements of a migration, normalized to single-spaced upper
 * case. Statements inside a `CREATE TRIGGER … BEGIN … END` body are folded
 * into the trigger's own statement.
 * @param {string} sql
 * @returns {string[]}
 */
export function statements(sql) {
  const parts = stripSql(sql)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim().toUpperCase());
  const out = [];
  let trigger = null;
  for (const part of parts) {
    if (trigger !== null) {
      trigger += `; ${part}`;
      if (/(^|\s)END$/.test(part) || part === 'END') {
        out.push(trigger);
        trigger = null;
      }
      continue;
    }
    if (part === '') continue;
    if (/^CREATE (TEMP |TEMPORARY )?TRIGGER\b/.test(part) && /\bBEGIN\b/.test(part)) {
      trigger = part;
      continue;
    }
    out.push(part);
  }
  if (trigger !== null) throw new Error('unterminated CREATE TRIGGER body');
  return out;
}

/**
 * Why a statement is destructive, or null when it is additive.
 * @param {string} stmt one entry of {@link statements}
 * @returns {string | null}
 */
export function destructiveReason(stmt) {
  if (/^DROP TABLE\b/.test(stmt)) return 'DROP TABLE';
  const alter = /^ALTER TABLE \S+ (.*)$/.exec(stmt);
  if (!alter) return null;
  const action = alter[1];
  if (/^DROP\b/.test(action)) return 'ALTER TABLE … DROP COLUMN';
  if (/^RENAME\b/.test(action)) return 'ALTER TABLE … RENAME';
  if (/^ADD\b/.test(action) && /\bNOT NULL\b/.test(action) && !/\bDEFAULT\b/.test(action)) {
    return 'ADD COLUMN … NOT NULL without a DEFAULT';
  }
  return null;
}

/**
 * Every destructive statement in a migration, as `{ reason, statement }`.
 * @param {string} sql
 */
export function destructiveStatements(sql) {
  const found = [];
  for (const statement of statements(sql)) {
    const reason = destructiveReason(statement);
    if (reason) found.push({ reason, statement });
  }
  return found;
}

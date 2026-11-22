/**
 * The folder check (#3948, CanonicalSpecDesign §4).
 *
 * `checkSpec(files, opts)` takes parsed files (from parse.mjs) and returns
 * every finding as {file, line, rule, message}. A finding is a refusal: the
 * command exits non-zero on any. The two modes differ twice. In §4 item 10,
 * `draft` lets a record entry marked new name what raised it in place of a
 * source; `folder` does not. A mistake marked `**Waits for:** <section>` is
 * accepted while nothing answers it, in both modes, until its domain is
 * marked complete.
 *
 * What a machine cannot judge (two statements in different words that
 * contradict each other) is left to the conflict read; `neighbours()` prints
 * what could conflict, side by side.
 */
import { createHash } from 'node:crypto';
import {
  ID_RE,
  MISTAKE_ID_RE,
  OWED_RE,
  PARAM_ID_RE,
  REQUIRED_PARTS,
  THREAT_ID_RE,
  approvalText,
  glossaryRows,
  parameterRows,
  recordEntries,
  statementText,
} from './parse.mjs';

export const MAX_LINE = 100;
export const MAX_BODY_LINES = 8;
export const HELD_RANGE = [900, 999];

/**
 * Words of history (§3.1 "No history"): words that place the RULE in time.
 * Whole words, case-insensitive. "Now", "since" and "no longer" are left out
 * on purpose: a statement uses them for the thing's own time ("whoever holds
 * the token now", "interest since that change", "a source no longer
 * flagged"), and a word list cannot tell the two uses apart. The conflict
 * read reads for the rest.
 */
export const HISTORY_WORDS = ['previously', 'formerly', 'used to', 'originally', 'legacy', 'nowadays', 'henceforth', 'until now', 'from now on', 'going forward', 'no more than before', 'as before', 'was changed', 'has been changed', 'changed from'];
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

export const approvalHash = (s) => createHash('sha256').update(approvalText(s)).digest('hex').slice(0, 16);

/** An owed phrase as compared: whitespace collapsed, trailing full stop dropped. */
const normaliseOwed = (t) => t.replace(/\s+/g, ' ').trim().replace(/\.$/, '');

const wordRe = (w) => new RegExp(`(^|[^A-Za-z])${w.replace(/ /g, '\\s+')}(?=$|[^A-Za-z])`, 'i');

/** Strip what a statement may legitimately contain that looks like a figure or code: ids and section numbers. */
function scrub(text) {
  return text
    .replace(/\b[A-Z]{3}-[MT]?\d{2,3}\b/g, ' ID ')
    .replace(/\bPRM-\d{3}\b/g, ' ID ')
    .replace(/\bsections? \d+(\.\d+)*((,| and| to) \d+(\.\d+)*)*/gi, ' section ');
}

/**
 * §4 item 4 on any text: a date, or a figure other than zero and one (ids and
 * section numbers aside). Used on statements and on lifecycle models, whose
 * states, step names and dimension values could otherwise carry a limit.
 */
export function figureFindings(text) {
  const out = [];
  if (/\b\d{4}-\d{2}-\d{2}\b|\b(19|20)\d{2}\b/.test(text) || new RegExp(`\\b(${MONTHS})\\b\\s+\\d`).test(text)) out.push({ rule: 'date', message: 'a date; keep it in the record' });
  const fig = /(^|[^A-Za-z0-9_])(\d+(?:[.,]\d+)*)(?=$|[^A-Za-z0-9_])/g;
  for (const m of scrub(text).matchAll(fig)) {
    if (m[2] !== '0' && m[2] !== '1') {
      out.push({ rule: 'figure', message: `a figure, "${m[2]}"; name the parameter (PRM-…), whose value is in the parameters table` });
      break;
    }
  }
  return out;
}

/** The text checks of §4 items 3–6, on one statement. Returns [{rule, message}]. */
export function textFindings(s, { glossary = [], refused = null } = {}) {
  const out = [];
  const text = statementText(s);
  for (const w of HISTORY_WORDS) if (wordRe(w).test(text)) out.push({ rule: 'history', message: `a word of history, "${w}"; where a statement came from is kept in the record` });
  if (/#\d+|\bissues? \d+|\bpull requests?\b|\bPR \d/i.test(text)) out.push({ rule: 'issue', message: 'an issue or pull request reference; keep it in the record' });
  const scrubbed = scrub(text);
  out.push(...figureFindings(text));
  if (/`/.test(text)) out.push({ rule: 'code', message: 'text in code type; a statement names no code' });
  const ident = scrubbed.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Za-z]+_[A-Za-z0-9_]+\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b|\b\w+\(\)|\b0x[0-9a-fA-F]+\b|\b\w+\.(sol|ts|tsx|mjs|js|json|md)\b/);
  if (ident) out.push({ rule: 'code', message: `a word shaped like code, "${ident[0]}"; a statement names no function, contract, error, event or file` });
  const lower = text.toLowerCase();
  for (const g of glossary) {
    for (const w of g.instead) if (wordRe(w).test(lower)) out.push({ rule: 'glossary', message: `"${w}": the glossary's word for it is "${g.term}"` });
  }
  if (refused) {
    const hit = refused.find(lower);
    if (hit) out.push({ rule: 'wording', message: `a word or phrase the wording list refuses (${hit.words} word${hit.words > 1 ? 's' : ''} at "${hit.at}")` });
  }
  return out;
}

/**
 * The refused words of `wording.json`, stored as salted hashes of the
 * normalised word or phrase of one to three words (§15). `find(text)` hashes
 * every run of one, two and three words and reports the first hit.
 */
export function refusedList(wording, code) {
  if (!wording) return null;
  const salt = wording.salt ?? '';
  const hashes = new Set([...(wording.refused?.['*'] ?? []), ...(wording.refused?.[code] ?? [])]);
  if (!hashes.size) return null;
  return {
    find(text) {
      const words = text.toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        for (let k = 1; k <= 3 && i + k <= words.length; k++) {
          const phrase = words.slice(i, i + k).join(' ');
          if (hashes.has(hashWord(salt, phrase))) return { words: k, at: words.slice(Math.max(0, i - 1), i + k + 1).join(' ') };
        }
      }
      return null;
    },
  };
}

export const normaliseWord = (w) => w.toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim();
export const hashWord = (salt, phrase) => createHash('sha256').update(`${salt}:${normaliseWord(phrase)}`).digest('hex');

/**
 * Check a whole set of parsed files. `opts`: {mode: 'folder'|'draft',
 * wording, readme: {completeDomains: Set}}. Returns findings.
 */
export function checkSpec(parsed, opts = {}) {
  const mode = opts.mode ?? 'folder';
  const findings = [];
  const add = (file, line, rule, message) => findings.push({ file, line, rule, message });

  for (const p of parsed) for (const e of p.errors) add(e.file, e.line, 'unreadable', e.message);

  // Item 12: no line over the limit, in every file checked. A table row is
  // exempt: Markdown cannot wrap one, and a cell's change still shows as one
  // changed row.
  for (const p of parsed) {
    for (const { t, n } of p.lines) {
      if (t.trim().startsWith('|')) continue;
      if ([...t].length > MAX_LINE) add(p.file, n, 'line', `a line of ${[...t].length} characters; the limit is ${MAX_LINE}`);
    }
  }

  const statements = parsed.flatMap((p) => p.statements);
  const models = parsed.flatMap((p) => p.models);
  const mistakes = parsed.flatMap((p) => p.mistakes);
  const record = { entries: [], retired: [], owed: [] };
  for (const p of parsed) {
    const r = recordEntries(p);
    record.entries.push(...r.entries);
    record.retired.push(...r.retired);
    record.owed.push(...r.owed);
  }
  const params = parsed.flatMap(parameterRows);
  const glossary = parsed.flatMap(glossaryRows);
  const codes = new Set(statements.map((s) => s.code));
  const complete = opts.completeDomains ?? new Set();

  // Item 1: ids.
  const byId = new Map();
  for (const s of statements) {
    if (byId.has(s.id)) add(s.file, s.line, 'duplicate', `${s.id} is used twice (also ${byId.get(s.id).file}:${byId.get(s.id).line})`);
    else byId.set(s.id, s);
  }
  const retired = new Map(record.retired.map((r) => [r.id, r]));
  // §3.6: ids in the held range are kept in the private records. A public
  // check without them (no --held) never reports one as missing; a retired
  // held id is still refused.
  const isHeldId = (id) => {
    const n = Number(id.slice(4));
    return n >= HELD_RANGE[0] && n <= HELD_RANGE[1];
  };
  const missing = (id) => !byId.has(id) && !isHeldId(id);
  for (const s of statements) if (retired.has(s.id)) add(s.file, s.line, 'retired', `${s.id} is a retired id (retired by ${retired.get(s.id).by}); an id is never reused`);

  // Item 2: the parts each kind requires, the body, the mistake answer.
  for (const s of statements) {
    if (!s.who) add(s.file, s.line, 'part', `${s.id}: no **Who:**`);
    if (!s.when) add(s.file, s.line, 'part', `${s.id}: no **When:**`);
    if (!s.body.length) add(s.file, s.line, 'part', `${s.id}: no body; a statement says what happens`);
    if (s.body.length > MAX_BODY_LINES) add(s.file, s.body[0].n, 'part', `${s.id}: a body of ${s.body.length} lines; the limit is ${MAX_BODY_LINES}`);
    for (const part of [...REQUIRED_PARTS.common, ...REQUIRED_PARTS[s.kind]]) {
      if (!s.parts[part]?.trim()) add(s.file, s.line, 'part', `${s.id}: a ${s.kind} needs **${part}:**`);
    }
    if (s.kind === 'never' && s.parts.Against && !s.parts.Against.match(THREAT_ID_RE)) add(s.file, s.partLines.Against, 'part', `${s.id}: **Against:** names no threat id (<CODE>-T<nn>)`);
    if (s.kind === 'setting' && s.parts.Parameter && !s.parts.Parameter.match(PARAM_ID_RE)) add(s.file, s.partLines.Parameter, 'part', `${s.id}: **Parameter:** names no parameter id (PRM-…)`);
    if (s.held && (s.number < HELD_RANGE[0] || s.number > HELD_RANGE[1])) add(s.file, s.line, 'held', `${s.id} is marked held outside the held range ${HELD_RANGE.join(' to ')}`);
    if (!s.held && s.number >= HELD_RANGE[0]) add(s.file, s.line, 'held', `${s.id} is in the held range but not marked held`);
    for (const f of textFindings(s, { glossary, refused: refusedList(opts.wording, s.code) })) add(s.file, s.line, f.rule, `${s.id}: ${f.message}`);
  }

  // Item 9: references by id, or in the owed form.
  for (const s of statements) {
    const text = statementText(s);
    for (const m of text.matchAll(ID_RE)) {
      const ref = `${m[1]}-${m[2]}`;
      if (ref === s.id || m[1] === 'PRM') continue;
      if (retired.has(ref)) add(s.file, s.line, 'reference', `${s.id} cites ${ref}, which is retired`);
      else if (missing(ref)) {
        if (codes.has(m[1])) add(s.file, s.line, 'reference', `${s.id} cites ${ref}, which does not exist`);
        else add(s.file, s.line, 'reference', `${s.id} cites ${ref}, but no statement of ${m[1]} is in the checked set; a domain not yet drafted is cited as "(${m[1]} owed: …)"`);
      }
    }
    if (/\bthe (?!same\b|one\b)[a-z]+(?: [a-z]+)? domains?\b/i.test(text.replace(OWED_RE, ''))) {
      add(s.file, s.line, 'reference', `${s.id} refers to another domain by name; cite a statement by id, or write "(<CODE> owed: …)"`);
    }
    for (const m of text.matchAll(OWED_RE)) {
      const code = m[1];
      const phrase = normaliseOwed(m[2]);
      if (complete.has(code)) add(s.file, s.line, 'owed', `${s.id}: "(${code} owed: ${phrase})" names a domain that is complete; cite its statement by id`);
      const listed = record.owed.some((o) => normaliseOwed(o.ref) === `${code} owed: ${phrase}` && o.by.includes(s.id));
      if (!listed) add(s.file, s.line, 'owed', `${s.id}: "(${code} owed: ${phrase})" is not listed in its domain's record (a row "| ${code} owed: ${phrase} | ${s.id} |" in a table "| Owed | Cited by |")`);
    }
  }

  // Item 10: the record.
  const entryById = new Map();
  for (const e of record.entries) {
    if (entryById.has(e.id)) add(e.file, e.line, 'record', `${e.id} has two record entries`);
    entryById.set(e.id, e);
  }
  for (const s of statements) {
    const e = entryById.get(s.id);
    if (!e) {
      add(s.file, s.line, 'record', `${s.id} has no entry in the record`);
      continue;
    }
    const mark = e.mark.trim().toLowerCase();
    const isNew = mark === 'n' || mark === 'new';
    const hasSource = e.sources.trim().length > 0;
    const raisedBy = /\b[A-Z]{3}-[MT]\d{2,3}\b|\bmodel\b|\bconflict read\b|\braised by\b/i.test(e.sources);
    const ownerApproval = /\b(owner|approv)\w*\b.*\b\d{4}-\d{2}-\d{2}\b|\b\d{4}-\d{2}-\d{2}\b.*\b(owner|approv)\w*\b/i.test(e.sources);
    if (!hasSource) add(e.file, e.line, 'record', `${s.id}: the record entry names no source`);
    else if (isNew && mode === 'folder' && !ownerApproval) add(e.file, e.line, 'record', `${s.id}: a new statement enters the folder only with the owner's approval, by date, as its source`);
    else if (isNew && mode === 'draft' && !ownerApproval && !raisedBy && !/\b[A-Z]{2,3} "|"\d/.test(e.sources)) add(e.file, e.line, 'record', `${s.id}: a new statement's entry names what raised it (a threat or mistake id, a model row, the conflict read) or a source`);
    if (!e.approved && mode === 'folder') add(e.file, e.line, 'approval', `${s.id}: the record entry carries no approval hash; the committed folder holds only approved text (${approvalHash(s)} now)`);
    else if (e.approved && e.approved !== approvalHash(s)) add(s.file, s.line, 'approval', `${s.id}: its text differs from the text the owner approved (record ${e.approved}, now ${approvalHash(s)}); a change needs a new approval`);
  }

  // Item 11: parameters.
  const paramIds = new Set();
  const paramAt = new Map();
  for (const p of params) {
    // §3.2: one row per parameter; per-network values are columns.
    if (paramAt.has(p.id)) add(p.file, p.line, 'parameter', `${p.id} has two rows (also ${paramAt.get(p.id).file}:${paramAt.get(p.id).line}); a parameter is defined once`);
    else paramAt.set(p.id, p);
    paramIds.add(p.id);
  }
  const used = new Set();
  for (const s of statements) for (const m of statementText(s).matchAll(PARAM_ID_RE)) used.add(`PRM-${m[1]}`);
  for (const s of statements) for (const m of statementText(s).matchAll(PARAM_ID_RE)) {
    const id = `PRM-${m[1]}`;
    if (params.length && !paramIds.has(id)) add(s.file, s.line, 'parameter', `${s.id} names ${id}, which the parameters table lacks`);
  }
  for (const p of params) if (!used.has(p.id)) add(p.file, p.line, 'parameter', `${p.id} (${p.name}) is used by no statement`);
  if (!params.length && used.size) add(parsed[0]?.file ?? '', 1, 'parameter', `statements name ${[...used].join(', ')}, but no parameters table was checked`);

  // Items 7 and 8: lifecycle models.
  for (const m of models) {
    const states = new Set(m.states);
    const stepNames = new Set();
    const seen = new Map();
    for (const r of m.steps) {
      stepNames.add(r.Step);
      for (const st of [r.From, r.To]) if (!states.has(st)) add(m.file, r.line, 'model', `model "${m.name}": the state "${st}" is not in its States list`);
      const cites = [...r['Guarded by'].matchAll(ID_RE)].map((x) => `${x[1]}-${x[2]}`);
      if (!cites.length) add(m.file, r.line, 'model', `model "${m.name}": the row ${r.From} → ${r.Step} → ${r.To} cites no statement`);
      for (const c of cites) {
        if (retired.has(c)) add(m.file, r.line, 'model', `model "${m.name}": the row ${r.From} → ${r.Step} cites ${c}, which is retired`);
        else if (missing(c)) add(m.file, r.line, 'model', `model "${m.name}": the row ${r.From} → ${r.Step} cites ${c}, which does not exist`);
      }
      const key = `${r.From}|${r.Step}|${r.Who}|${[...new Set(cites)].sort().join(',')}`;
      if (seen.has(key)) add(m.file, r.line, 'model', `model "${m.name}": two rows it cannot tell apart (${r.From}, ${r.Step}, ${r.Who}, guarded by the same statements; also line ${seen.get(key)})`);
      seen.set(key, r.line);
    }
    const refused = new Set(m.refusals.map((r) => r.Step));
    for (const r of m.refusals) {
      const cites = [...r['Refused by'].matchAll(ID_RE)].map((x) => `${x[1]}-${x[2]}`);
      if (!cites.length) add(m.file, r.line, 'model', `model "${m.name}": the refusal of "${r.Step}" out of state cites no statement`);
      for (const c of cites) {
        if (retired.has(c)) add(m.file, r.line, 'model', `model "${m.name}": the refusal of "${r.Step}" cites ${c}, which is retired`);
        else if (missing(c)) add(m.file, r.line, 'model', `model "${m.name}": the refusal of "${r.Step}" cites ${c}, which does not exist`);
      }
    }
    for (const st of stepNames) if (!refused.has(st)) add(m.file, m.line, 'model', `model "${m.name}": the step "${st}" has no refusal out of state`);
    // Reachability from the start state.
    const reach = new Set(m.start ? [m.start] : []);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of m.steps) if (reach.has(r.From) && !reach.has(r.To)) {
        reach.add(r.To);
        grew = true;
      }
    }
    for (const st of m.states) if (!reach.has(st)) add(m.file, m.line, 'model', `model "${m.name}": no route from "${m.start}" reaches the ${m.ends.includes(st) ? 'end ' : ''}state "${st}"`);
    for (const d of m.dimensions) {
      const cites = [...d['Named by'].matchAll(ID_RE)].map((x) => `${x[1]}-${x[2]}`);
      if (!cites.length) add(m.file, d.line, 'model', `model "${m.name}": the dimension "${d.Dimension}" is named by no statement`);
      for (const c of cites) {
        if (retired.has(c)) add(m.file, d.line, 'model', `model "${m.name}": the dimension "${d.Dimension}" is named by ${c}, which is retired`);
        else if (missing(c)) add(m.file, d.line, 'model', `model "${m.name}": the dimension "${d.Dimension}" is named by ${c}, which does not exist`);
      }
    }
    // §4 item 4 holds in a model too: a limit lives in the parameters table.
    for (const t of m.texts) for (const f of figureFindings(t.text)) add(m.file, t.line, f.rule, `model "${m.name}": ${f.message}`);
  }
  const accountsByCode = new Map();
  for (const m of models) {
    const code = (statements.find((s) => s.file === m.file) ?? {}).code;
    if (!code) continue;
    if (!accountsByCode.has(code)) accountsByCode.set(code, new Set());
    for (const a of m.accounts) accountsByCode.get(code).add(a.toLowerCase().replace(/\.$/, ''));
  }
  for (const s of statements.filter((x) => x.kind === 'fund movement')) {
    const rest = (s.parts['Comes to rest in'] ?? '').toLowerCase().replace(/\.$/, '').trim();
    const allowed = accountsByCode.get(s.code);
    if (!allowed?.size) add(s.file, s.line, 'account', `${s.id}: no model of ${s.code} lists the kinds of account a balance may rest in`);
    else if (rest && !allowed.has(rest)) add(s.file, s.partLines['Comes to rest in'], 'account', `${s.id}: comes to rest in "${rest}", a kind of account no model of ${s.code} lists`);
  }

  // §8.2 / item 17: every mistake has exactly one answering statement.
  const answers = new Map();
  for (const s of statements) {
    const fm = s.parts['For the mistake'];
    if (!fm) continue;
    const ids = [...fm.matchAll(MISTAKE_ID_RE)].map((x) => `${x[1]}-M${x[2]}`);
    // "VLT-M15, M18 and M21": bare M-numbers after a full id belong to its domain.
    const first = ids[0]?.slice(0, 3);
    if (first) for (const x of fm.matchAll(/(?<![A-Z]-)\bM(\d{2,3})\b/g)) ids.push(`${first}-M${x[1]}`);
    const ans = /\b(refuse|bound|undo|warn only)\b/i.exec(fm);
    if (!ids.length) add(s.file, s.partLines['For the mistake'], 'mistake', `${s.id}: **For the mistake:** names no mistake id`);
    if (!ans) add(s.file, s.partLines['For the mistake'], 'mistake', `${s.id}: **For the mistake:** names no answer (refuse, bound, undo or warn only)`);
    else if (/warn only/i.test(ans[1]) && fm.slice(ans.index + ans[0].length).replace(/[^A-Za-z]/g, '').length < 12) {
      add(s.file, s.partLines['For the mistake'], 'mistake', `${s.id}: a warn-only answer needs its reason, since a direct caller never sees the warning`);
    }
    for (const id of new Set(ids)) {
      if (!answers.has(id)) answers.set(id, []);
      answers.get(id).push(s.id);
    }
  }
  const mistakeIds = new Set(mistakes.map((x) => x.id));
  for (const mk of mistakes) {
    const a = answers.get(mk.id) ?? [];
    // `**Waits for:** <section>`: a draft mistake whose answer belongs to a
    // section not yet drafted. It stays in the read set and is counted, so it
    // can never drop out of sight; the committed folder holds none.
    const waits = (mk.fields['Waits for'] ?? '').trim();
    if ('Waits for' in mk.fields && !waits) add(mk.file, mk.line, 'mistake', `${mk.id}: **Waits for:** names no section`);
    // In the folder a waiting mistake is accepted only while its domain is not
    // marked complete in the README: a domain cannot be complete with one.
    if (waits && mode !== 'draft' && complete.has(mk.code)) add(mk.file, mk.line, 'mistake', `${mk.id} still waits for ${waits}, but ${mk.code} is marked complete; a complete domain holds no waiting mistake`);
    else if (waits && a.length) add(mk.file, mk.line, 'mistake', `${mk.id} is answered by ${a.join(', ')} but still marked as waiting for ${waits}: remove the mark`);
    if (waits && !a.length) continue;
    if (!a.length) add(mk.file, mk.line, 'mistake', `${mk.id} (${mk.title}) has no answering statement`);
    else if (a.length > 1) add(mk.file, mk.line, 'mistake', `${mk.id} is answered by ${a.length} statements (${a.join(', ')}); a mistake has exactly one answer`);
  }
  if (mistakes.length) {
    for (const [id, by] of answers) {
      if (!mistakeIds.has(id) && mistakes.some((x) => x.code === id.slice(0, 3))) add(byId.get(by[0]).file, byId.get(by[0]).line, 'mistake', `${by.join(', ')} answer${by.length > 1 ? '' : 's'} ${id}, which is not on the mistake list`);
    }
  }

  return findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/**
 * The neighbours report (§4): every set of statements that share a thing and a
 * step, side by side, from the models' rows. Returns [{model, step, ids}].
 */
export function neighbours(parsed) {
  const groups = new Map();
  for (const m of parsed.flatMap((p) => p.models)) {
    for (const r of [...m.steps.map((x) => ({ step: x.Step, cites: x['Guarded by'] })), ...m.refusals.map((x) => ({ step: x.Step, cites: x['Refused by'] }))]) {
      const key = `${m.name}|${r.step}`;
      if (!groups.has(key)) groups.set(key, { model: m.name, step: r.step, ids: new Set() });
      for (const x of r.cites.matchAll(ID_RE)) groups.get(key).ids.add(`${x[1]}-${x[2]}`);
    }
  }
  return [...groups.values()].filter((g) => g.ids.size > 1).map((g) => ({ ...g, ids: [...g.ids].sort() }));
}

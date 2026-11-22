// The folder check (#3948, CanonicalSpecDesign §4 and §16 tests 1–6, 9, 17, 25, 37, 38).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../src/parse.mjs';
import { approvalHash, checkSpec, hashWord, neighbours } from '../src/check.mjs';

const STMT = (id, kind, extra = '', body = 'The withdrawal is refused, and nothing moves.') => `### ${id} · ${kind}

**Who:** the vault's owner.
**When:** a withdrawal asks for more than the free balance.

${body}

${extra}- **Tests owed:** the defaults for a ${kind}.
`;

const REFUSAL = (id) => STMT(id, 'refusal', '- **Refused as:** more than the free balance.\n');

const RECORD = (rows, extra = '') => `# Record

| Id | Mark | Sources | Build |
| --- | --- | --- | --- |
${rows.map((r) => `| ${r[0]} | ${r[1] ?? 'K'} | ${r[2] ?? 'OP "3.3", the Owner row'} | built |`).join('\n')}
${extra}`;

const run = (files, opts = {}) => checkSpec(files.map(([name, text]) => parseFile(name, text)), opts);
const rules = (f) => f.map((x) => x.rule);
const has = (f, rule, re) => f.some((x) => x.rule === rule && re.test(x.message));

test('a clean statement with its record passes', () => {
  const f = run([['vlt.md', `# Vaults\n\n## 1. Out\n\n${REFUSAL('VLT-012')}`], ['record.md', RECORD([['VLT-012']])]]);
  assert.deepEqual(f, []);
});

test('test 1: duplicate id, retired id, date, issue reference, figure, code name and a long line are refused, each with the line', () => {
  const retired = '\n| Id | Retired by |\n| --- | --- |\n| VLT-013 | owner approval 2026-11-22 |\n';
  const files = [
    ['vlt.md', [
      REFUSAL('VLT-012'),
      REFUSAL('VLT-012'),
      REFUSAL('VLT-013'),
      STMT('VLT-014', 'rule', '', 'The rule changed on 2026-11-22 under #3900.'),
      STMT('VLT-015', 'rule', '', 'At most 25 items are listed.'),
      STMT('VLT-016', 'rule', '', 'The vault calls withdrawERC20 to pay.'),
      STMT('VLT-017', 'rule', '', `${'A very long sentence '.repeat(6)}ends here.`),
    ].join('\n')],
    ['record.md', RECORD([['VLT-012'], ['VLT-013'], ['VLT-014'], ['VLT-015'], ['VLT-016'], ['VLT-017']], retired)],
  ];
  const f = run(files);
  assert.ok(has(f, 'duplicate', /VLT-012 is used twice/));
  assert.ok(has(f, 'retired', /VLT-013 is a retired id/));
  assert.ok(has(f, 'date', /VLT-014: a date/));
  assert.ok(has(f, 'issue', /VLT-014: an issue/));
  assert.ok(has(f, 'figure', /VLT-015: a figure, "25"/));
  assert.ok(has(f, 'code', /VLT-016: a word shaped like code, "withdrawERC20"/));
  assert.ok(f.some((x) => x.rule === 'line' && x.line > 0));
  for (const x of f) assert.ok(x.file && x.line > 0, `every finding names its file and line: ${JSON.stringify(x)}`);
});

test('one and zero, ids, parameter ids and section numbers are not figures', () => {
  const body = 'One record is made, and zero or 1 moves follow (VLT-001, section 3.2, [PRM-001]).';
  const f = run([
    ['vlt.md', STMT('VLT-012', 'rule', '', body) + STMT('VLT-001', 'rule')],
    ['record.md', RECORD([['VLT-012'], ['VLT-001']])],
    ['parameters.md', '| Id | Name | Value |\n| --- | --- | --- |\n| PRM-001 | The escape period | 7 |\n'],
  ]);
  assert.deepEqual(f, []);
});

test('test 2: a fund movement without rounding and a never without a threat id are refused', () => {
  const fm = STMT('VLT-020', 'fund movement', '- **From:** the owner\'s vault.\n- **To:** the other party\'s vault.\n- **Comes to rest in:** the other party\'s vault.\n- **Amount:** the amount owed.\n');
  const nv = STMT('VLT-021', 'never', '- **Against:** the attack on the vault.\n- **Watch:** every fall in a balance has a record.\n');
  const f = run([['vlt.md', fm + nv], ['record.md', RECORD([['VLT-020'], ['VLT-021']])]]);
  assert.ok(has(f, 'part', /VLT-020: a fund movement needs \*\*Rounding:\*\*/));
  assert.ok(has(f, 'part', /VLT-021: \*\*Against:\*\* names no threat id/));
});

test('test 3 and 37: no record entry, and a new entry: draft mode takes what raised it, folder mode needs the owner\'s approval', () => {
  const f1 = run([['vlt.md', REFUSAL('VLT-012')], ['record.md', RECORD([])]]);
  assert.ok(has(f1, 'record', /VLT-012 has no entry in the record/));
  const raised = [['vlt.md', REFUSAL('VLT-012')], ['record.md', RECORD([['VLT-012', 'N', 'Raised by VLT-M15']])]];
  assert.deepEqual(rules(run(raised, { mode: 'draft' })), []);
  assert.ok(has(run(raised, { mode: 'folder' }), 'record', /enters the folder only with the owner's approval/));
  const approved = [['vlt.md', REFUSAL('VLT-012')], ['record.md', RECORD([['VLT-012', 'N', 'Owner approval 2026-11-22, question 1']])]];
  assert.deepEqual(rules(run(approved, { mode: 'folder' })), []);
  const nothing = [['vlt.md', REFUSAL('VLT-012')], ['record.md', RECORD([['VLT-012', 'N', 'Nothing states it.']])]];
  assert.ok(has(run(nothing, { mode: 'draft' }), 'record', /names what raised it/));
  assert.ok(has(run(nothing, { mode: 'folder' }), 'record', /owner's approval/));
});

test('test 4: an approved statement edited without a new approval is refused', () => {
  const text = REFUSAL('VLT-012');
  const s = parseFile('vlt.md', text).statements[0];
  const rec = (h) => `| Id | Mark | Sources | Approved |\n| --- | --- | --- | --- |\n| VLT-012 | K | OP "3.3" | ${h} |\n`;
  assert.deepEqual(run([['vlt.md', text], ['record.md', rec(approvalHash(s))]]), []);
  const edited = text.replace('nothing moves', 'nothing at all moves');
  assert.ok(has(run([['vlt.md', edited], ['record.md', rec(approvalHash(s))]]), 'approval', /differs from the text the owner approved/));
});

const MODEL = (rows, refusals, states = '- Not created (start): no vault.\n- Open: a vault.\n- Recovered (end): a recovered vault.') => `
### Model: a vault

**States:**
${states}

**Steps:**
| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

**Refusals out of state:**
| Step | Refused by |
| --- | --- |
${refusals.join('\n')}

**Accounts:**
- A vault's free balance.
`;

test('test 5: a step with no refusal out of state, two rows it cannot tell apart, and an end state no route reaches are refused', () => {
  const stmts = REFUSAL('VLT-012') + STMT('VLT-013', 'rule');
  const model = MODEL(
    ['| Not created | Create | Anyone | VLT-013 | Open |', '| Open | Withdraw | The owner | VLT-012 | Open |', '| Open | Withdraw | The owner | VLT-012 | Open |'],
    ['| Create | VLT-012 |'],
  );
  const f = run([['vlt.md', stmts + model], ['record.md', RECORD([['VLT-012'], ['VLT-013']])]]);
  assert.ok(has(f, 'model', /the step "Withdraw" has no refusal out of state/));
  assert.ok(has(f, 'model', /two rows it cannot tell apart/));
  assert.ok(has(f, 'model', /no route from "Not created" reaches the end state "Recovered"/));
});

test('a model row that cites no statement is refused, and a fund movement resting outside the model\'s accounts', () => {
  const fm = STMT('VLT-020', 'fund movement', '- **From:** the owner\'s vault.\n- **To:** a wallet.\n- **Comes to rest in:** a pool.\n- **Amount:** the amount owed.\n- **Rounding:** down, in the vault\'s favour.\n');
  const model = MODEL(['| Not created | Create | Anyone | | Open |', '| Open | Recover | The owner | VLT-020 | Recovered |'], ['| Create | VLT-020 |', '| Recover | VLT-020 |']);
  const f = run([['vlt.md', fm + model], ['record.md', RECORD([['VLT-020']])]]);
  assert.ok(has(f, 'model', /the row Not created → Create → Open cites no statement/));
  assert.ok(has(f, 'account', /comes to rest in "a pool", a kind of account no model of VLT lists/));
});

test('test 6: the neighbours report lists statements sharing a thing and a step', () => {
  const model = MODEL(['| Open | Withdraw | The owner | VLT-012, VLT-013 | Open |'], ['| Withdraw | VLT-014 |']);
  const g = neighbours([parseFile('vlt.md', model)]);
  assert.deepEqual(g, [{ model: 'a vault', step: 'Withdraw', ids: ['VLT-012', 'VLT-013', 'VLT-014'] }]);
});

test('test 9 and 38: a reference to a retired id is refused; an owed reference needs its record row and a domain not complete', () => {
  const retired = '\n| Id | Retired by |\n| --- | --- |\n| VLT-013 | owner approval 2026-11-22 |\n';
  const f1 = run([['vlt.md', STMT('VLT-012', 'rule', '', 'This holds with VLT-013.')], ['record.md', RECORD([['VLT-012']], retired)]]);
  assert.ok(has(f1, 'reference', /cites VLT-013, which is retired/));
  const owed = STMT('VLT-012', 'rule', '', 'The treasury is elsewhere (DPL owed: where the treasury is).');
  const listed = '\n| Owed | Cited by |\n| --- | --- |\n| DPL owed: where the treasury is | VLT-012 |\n';
  assert.deepEqual(run([['vlt.md', owed], ['record.md', RECORD([['VLT-012']], listed)]]), []);
  assert.ok(has(run([['vlt.md', owed], ['record.md', RECORD([['VLT-012']])]]), 'owed', /not listed in its domain's record/));
  assert.ok(has(run([['vlt.md', owed], ['record.md', RECORD([['VLT-012']], listed)]], { completeDomains: new Set(['DPL']) }), 'owed', /names a domain that is complete/));
  const named = run([['vlt.md', STMT('VLT-012', 'rule', '', 'Who may change it is in the authority domain.')], ['record.md', RECORD([['VLT-012']])]]);
  assert.ok(has(named, 'reference', /refers to another domain by name/));
  const unloaded = run([['vlt.md', STMT('VLT-012', 'rule', '', 'As DPL-004 says.')], ['record.md', RECORD([['VLT-012']])]]);
  assert.ok(has(unloaded, 'reference', /no statement of DPL is in the checked set/));
});

test('test 17: a mistake with no answer, with two, or with a warn-only answer with no reason is refused', () => {
  const mistakes = `## 1\n\n### VLT-M01 · A zero amount\n\n**Who:** the owner.\n\n### VLT-M02 · Wrong unit\n\n**Who:** the owner.\n\n### VLT-M03 · Approving the vault\n\n**Who:** the owner.\n`;
  const a = STMT('VLT-012', 'refusal', '- **Refused as:** zero.\n- **For the mistake:** VLT-M02, refuse.\n');
  const b = STMT('VLT-013', 'rule', '- **For the mistake:** VLT-M02, bound.\n');
  const c = STMT('VLT-014', 'rule', '- **For the mistake:** VLT-M03, warn only.\n');
  const f = run([['vlt.md', a + b + c], ['mistakes.md', mistakes], ['record.md', RECORD([['VLT-012'], ['VLT-013'], ['VLT-014']])]]);
  assert.ok(has(f, 'mistake', /VLT-M01 \(A zero amount\) has no answering statement/));
  assert.ok(has(f, 'mistake', /VLT-M02 is answered by 2 statements \(VLT-012, VLT-013\)/));
  assert.ok(has(f, 'mistake', /VLT-014: a warn-only answer needs its reason/));
  const reasoned = STMT('VLT-014', 'rule', '- **For the mistake:** VLT-M03, warn only, because the contract cannot tell the two apart.\n');
  assert.ok(!has(run([['vlt.md', reasoned], ['mistakes.md', mistakes], ['record.md', RECORD([['VLT-014']])]]), 'mistake', /VLT-014/));
});

test('a mistake waiting for a section: counted, accepted in draft mode while unanswered, refused in the folder and once answered', () => {
  const mistakes = '### VLT-M30 · Locking by mistake\n\n**Who:** the owner.\n**Waits for:** vault section 5\n\n### VLT-M31 · Empty mark\n\n**Waits for:**\n';
  const draft = run([['mistakes.md', mistakes]], { mode: 'draft' });
  assert.ok(!has(draft, 'mistake', /VLT-M30/), JSON.stringify(draft));
  assert.ok(has(draft, 'mistake', /VLT-M31: \*\*Waits for:\*\* names no section/));
  assert.ok(has(run([['mistakes.md', mistakes]]), 'mistake', /VLT-M30 still waits for vault section 5; the committed folder holds no waiting mistake/));
  const a = STMT('VLT-012', 'rule', '- **For the mistake:** VLT-M30, undo.\n');
  const answered = run([['vlt.md', a], ['mistakes.md', mistakes], ['record.md', RECORD([['VLT-012']])]], { mode: 'draft' });
  assert.ok(has(answered, 'mistake', /VLT-M30 is answered by VLT-012 but still marked as waiting for vault section 5/));
});

test('a mistake answer "VLT-M15, M18 and M21, refuse" answers all three', () => {
  const mistakes = '### VLT-M15 · a\n\n### VLT-M18 · b\n\n### VLT-M21 · c\n';
  const a = STMT('VLT-012', 'refusal', '- **Refused as:** more.\n- **For the mistake:** VLT-M15, M18 and M21, refuse.\n');
  assert.deepEqual(run([['vlt.md', a], ['mistakes.md', mistakes], ['record.md', RECORD([['VLT-012']])]]), []);
});

test('test 25: a block the parser cannot read stops with its file and line, and the statement is still counted', () => {
  const bad = `${REFUSAL('VLT-012')}\nA stray paragraph after the parts.\n`;
  const parsed = parseFile('vlt.md', bad);
  assert.equal(parsed.statements.length, 1, 'the statement is not silently dropped');
  const f = checkSpec([parsed, parseFile('record.md', RECORD([['VLT-012']]))]);
  assert.ok(f.some((x) => x.rule === 'unreadable' && x.file === 'vlt.md' && x.line === 11), JSON.stringify(f));
  const shaped = parseFile('vlt.md', '### VLT-099 · rul\n\n**Who:** x.\n');
  assert.equal(shaped.errors.length, 1);
  assert.match(shaped.errors[0].message, /a heading shaped like a statement's that is not one/);
});

test('an unknown part, a missing Who, and a body over eight lines are refused', () => {
  const unknown = STMT('VLT-012', 'rule', '- **Because:** reasons.\n');
  const noWho = '### VLT-013 · rule\n\n**When:** always.\n\nIt holds.\n\n- **Tests owed:** the defaults for a rule.\n';
  const long = STMT('VLT-014', 'rule', '', Array.from({ length: 9 }, (_, i) => `Line ${i ? 'more' : 'first'} of the body.`).join('\n'));
  const f = run([['vlt.md', unknown + noWho + long], ['record.md', RECORD([['VLT-012'], ['VLT-013'], ['VLT-014']])]]);
  assert.ok(has(f, 'unreadable', /unknown part "Because"/));
  assert.ok(has(f, 'part', /VLT-013: no \*\*Who:\*\*/));
  assert.ok(has(f, 'part', /VLT-014: a body of 9 lines/));
});

test('test 30: a refused word fails the check, and the list holds only its hash', () => {
  const salt = 'test-salt';
  const wording = { salt, refused: { '*': [hashWord(salt, 'liquidity pool')] } };
  assert.ok(!JSON.stringify(wording).includes('liquidity pool'));
  const f = run([['vlt.md', STMT('VLT-012', 'rule', '', 'The funds sit in a Liquidity  Pool.')], ['record.md', RECORD([['VLT-012']])]], { wording });
  assert.ok(has(f, 'wording', /refuses \(2 words/));
});

test('the glossary\'s term is required where it lists the word not to use', () => {
  const glossary = '| Term | Meaning | Instead of |\n| --- | --- | --- |\n| instant market | Where Auto-lend slots are filled | pool, liquidity pool |\n';
  const f = run([['vlt.md', STMT('VLT-012', 'rule', '', 'The slot joins the pool.')], ['glossary.md', glossary], ['record.md', RECORD([['VLT-012']])]]);
  assert.ok(has(f, 'glossary', /"pool": the glossary's word for it is "instant market"/));
});

test('parameters: one no statement uses, and an id the table lacks, are refused', () => {
  const params = '| Id | Name | Value |\n| --- | --- | --- |\n| PRM-001 | The escape period | 7 |\n| PRM-002 | Unused | 3 |\n';
  const f = run([['vlt.md', STMT('VLT-012', 'rule', '', 'It waits [PRM-001] and [PRM-009].')], ['parameters.md', params], ['record.md', RECORD([['VLT-012']])]]);
  assert.ok(has(f, 'parameter', /PRM-002 \(Unused\) is used by no statement/));
  assert.ok(has(f, 'parameter', /VLT-012 names PRM-009, which the parameters table lacks/));
});

test('test 42: a held statement sits in the held range; the public check reports nothing missing for it', () => {
  const held = STMT('VLT-901', 'rule · held');
  const parsedHeld = parseFile('held.md', held.replace('rule · held', 'rule · held'));
  assert.equal(parsedHeld.statements[0].held, true);
  const f = checkSpec([parsedHeld, parseFile('record.md', RECORD([['VLT-901']]))]);
  assert.deepEqual(f.filter((x) => x.rule === 'held'), []);
  const wrong = checkSpec([parseFile('held.md', STMT('VLT-050', 'rule · held')), parseFile('record.md', RECORD([['VLT-050']]))]);
  assert.ok(has(wrong, 'held', /outside the held range/));
});

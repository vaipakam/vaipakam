# @vaipakam/canonical-spec

The folder check for `docs/CanonicalSpec/` (#3948). The design is
`docs/DesignsAndPlans/CanonicalSpecDesign.md`, §3 (the blocks) and §4 (what
the check refuses). This package has no dependencies.

```bash
node packages/canonical-spec/bin/check.mjs                  # folder mode, docs/CanonicalSpec
node packages/canonical-spec/bin/check.mjs --draft <paths>  # draft mode: files or folders
  --held <dir>     also read the held statements kept in the private records
  --neighbours     print the neighbours report (statements on one model step)
  --hashes         print each statement's approval hash, for the record's Approved column
  --wording <file> the wording list (default: wording.json in the folder)
pnpm --filter @vaipakam/canonical-spec test
```

Exit 0 when nothing is refused, 1 on any finding, 2 on a usage error. Each
finding prints as `file:line: [rule] message`.

**Draft mode vs folder mode.** In draft mode a new record entry may name what
raised it and carry no approval. Folder mode needs the owner's approval hash
on every entry, and every entry's source is a document (a code and a quoted
section, or "Same …" for the row above's document) or the owner's approval by
date; an entry whose only source is what raised the statement (a threat or
mistake id, a model row, the conflict read) is a draft note, not a source. A domain the README marks `complete` may owe nothing to
another domain.

The parser **fails closed.** It reports any line under a statement or model
heading that it cannot read, with the file and line, and never skips it. A
skipped statement would owe no tests, and nobody would notice it was gone.

## The blocks

### Statement

```markdown
### VLT-012 · refusal

**Who:** the vault's owner.
**When:** a withdrawal asks for more than the free balance.

The withdrawal is refused, and nothing moves.   ← the body, at most 8 lines

- **Refused as:** more than the free balance.
- **Tests owed:** the defaults for a refusal.
  a continuation line is indented two spaces.
```

- **Id.** The id is three capitals, a hyphen and three digits. Ids 900–999 are
  held statements (`### VLT-912 · never · held`), which are kept in the
  private records.
- **Kinds and their required parts.** Every kind needs **Tests owed**. The
  other required parts depend on the kind:

  | Kind | Required parts |
  | --- | --- |
  | rule | none |
  | refusal | Refused as |
  | fund movement | From, To, Comes to rest in, Amount, Rounding |
  | authority | Held by, Changed by |
  | setting | Parameter |
  | never | Against (a threat id, `VLT-T01`), Watch |
  | always possible | From, By, Except under |

  **For the mistake** is optional and names the mistakes the statement
  answers.
- **What the text may not contain.** No figures (name a `PRM-NNN`), no dates,
  no issue or PR references, no words of history and no code or code-shaped
  words. Use the glossary's terms instead of the words it lists, and avoid
  any phrase on the wording list. No line may run past 100 characters; a table
  row is exempt.
- **Referring to other statements.** A reference is to an existing id. A
  reference to a domain not drafted yet takes the owed form,
  `(DPL owed: where the treasury is)`, and is listed in that file's Owed
  table.

### Mistake

`### VLT-M15 · title`. At least one statement must answer each mistake through
**For the mistake**, and no mistake may be answered by more than one. The
part says how it answers it: refuse, bound, undo or warn only.

A draft mistake whose answer belongs to a section not drafted yet carries
`**Waits for:** <section>` (for example `**Waits for:** vault section 5`). It
stays in the files the check reads and is counted in the summary as waiting,
so it cannot drop out of sight. It is accepted while nothing answers it, and
the mark is refused once a statement does. In folder mode a domain the README
marks `complete` may hold no waiting mistake, so the mistake list lands in
the folder with its domain and the domain cannot close with one waiting.

### Lifecycle model

```markdown
### Model: a loan

**States:**
- Open (start): offered and not yet taken.
- Repaid (end): nothing is owed.

**Steps:**
| From | Step | Who | Guarded by | To |

**Refusals out of state:**
| Step | Refused by |

**Dimensions:**
| Dimension | Values | Named by |

**Accounts:**
- the lender's vault
```

The check refuses any of these:

- a state named in a row that is not in the States list;
- a row, a refusal out of state or a dimension that cites no statement, or
  cites one that does not exist;
- a step with no refusal out of state;
- two rows it cannot tell apart (same From, Step and Who, guarded by the same
  statements);
- a state that no route from the start state reaches.

A fund movement's **Comes to rest in** must be one of the accounts a model of
its domain lists.

### Tables

| Table | Columns | Where |
| --- | --- | --- |
| Record | Id, Mark, Sources[, Approved] | the record file; every statement has exactly one entry, and in folder mode an Approved hash |
| Retired | Id, Retired by | a retired id is never reused |
| Owed | Owed, Cited by | every owed reference |
| Parameters | Id, Name, Value | the only place a figure appears; one row per parameter (per-network values are columns) |
| Glossary | Term, Meaning, Instead of | the words a statement uses instead |

### Wording list

```json
{ "salt": "<hex>", "refused": { "*": ["<hash>"], "VLT": ["<hash>"] } }
```

Each hash is `sha256("<salt>:<phrase>")` over the phrase, lower-cased and
with its punctuation stripped. The check compares runs of one to three words.
The list holds only hashes, so the refused words do not appear in the
public tree.

### Approval hash

`--hashes` prints the first 16 hex characters of the SHA-256 of a statement's
heading, Who, When, body and parts. Editing any of them changes the hash. The
record's Approved column must then be signed again, or folder mode refuses
the statement. Folder mode also refuses an entry with no hash at all.

### Held ids

Ids 900 to 999 are held statements, kept in the private records. A check run
without `--held` never reports a reference to one as missing, in a statement
or a model. A retired held id is still refused. A held statement released
(its `held` mark removed) keeps its id; an id is never renumbered. A heading
or table inside a fenced code region is an example and is never read.

### Figures in models

A model's states, step names, who, dimension values and accounts carry no
figure or date either: a limit lives in the parameters table.

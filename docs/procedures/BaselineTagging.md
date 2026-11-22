# Cutting a baseline tag

How a tag of the reference series is made (#3964). The rule behind it is
`docs/DesignsAndPlans/RefactorRulesDesign.md`, section 3.2 ("What tagged
means"). The series is `v0.9-pre-refactor`, `v0.9-pre-refactor.N`,
`v1.0-audit-freeze`, `v1.0-audit-fix.N` and `v1.0-mainnet.N`. Every tag in it
is made this way and checked the same way.

## Before you start

- The owner has given the go-ahead for this tag. Each tag in the series needs
  its own.
- The repository rule on the series' tag pattern is set in **both**
  repositories (this one and the public keeper bot): no update, no deletion,
  and no bypass list. Setting it is an owner step.
- The commit to tag is on `main`, its CI is green, and nothing is waiting to
  land on it.
- You can sign tags (`git config user.signingkey` and `gpg.format` set), with
  a key GitHub shows as verified for the account that pushes.

## 1. Build and measure the commit

From a clean checkout of exactly that commit, in `contracts/`:

```bash
FOUNDRY_PROFILE=default forge build --skip test --ast
bash script/run-regression.sh --manifest ../baseline-manifests/full.tsv
```

The regression runs the gas suite with everything else and writes its figures
to `out-gas-suite/`. `--ast` changes no code: it lets the record name every
value a contract fixes at construction. A sharded run works too: put every
shard's manifest in the same folder, at any depth.

## 2. Write the record

```bash
node script/baseline-record.mjs --tag v0.9-pre-refactor --manifests ../baseline-manifests
```

It refuses a working tree with uncommitted changes, a missing gas suite, a
build without the AST, and manifests that `run-regression.sh --verify-shards`
does not accept. The record holds every contract compiled from `src/` that
has runtime code, read from the build itself, so a contract a deploy script
creates is in it whether or not an app ships its interface. It writes
`contracts/baseline/v0.9-pre-refactor.json` and prints the line the tag
message must carry:

```
record sha256 <64 hex characters>
```

## 3. Commit the record alone

```bash
git add contracts/baseline/v0.9-pre-refactor.json
git commit -m "Baseline record for v0.9-pre-refactor"
```

That commit changes nothing else. The record names its parent (the commit it
was built from) and the digest of its source: every tracked file except those
under `contracts/baseline/`, as the sorted lines of path and git object id,
hashed once. The commit you tag is the one that adds the record. Land it on `main` through a pull request like any other
change; a record is docs-sized and needs no Codex loop beyond a docs pass.

## 4. Tag it, signed and annotated

On the merged commit (the one whose parent is the record's `source.commit`):

```bash
git tag -s v0.9-pre-refactor -m "v0.9-pre-refactor: the reference before the refactor pass

record sha256 <the line from step 2>"
git push origin v0.9-pre-refactor
```

If the pull request was squashed, the merged commit's parent is `main` as it
stood before, which must be the record's `source.commit`. When something else
landed on `main` in between, the parent is wrong and the check refuses: make
the record again from the new `main`.

## 5. Check it

```bash
node contracts/script/baseline-check.mjs --tag v0.9-pre-refactor
```

The check always verifies the tag's signature with `git tag -v`, so import
the signer's public key first (the key GitHub shows as verified for the
account that pushed). A message that only looks signed is refused. It rebuilds the tagged commit in a temporary worktree and refuses, by name, on
any difference: the tag unsigned or lightweight, the message without the
record's hash, the commit changing more than the record, another source
digest, another library pin or storage layout, another build tool or
compiler, or any deployable's runtime code hash, size, interface hash or
immutables. It must pass before
anything below happens.

## 6. The same point everywhere else

- **Keeper bot.** Sync the bot's ABIs from the tagged commit
  (`contracts/script/exportAbis.sh`, see `CLAUDE.md` "Keeper-bot ABI sync"),
  commit, and put a signed, annotated tag of the same name on that commit in
  the bot's repository.
- **Private review copy.** Refresh it to exactly the tagged commit, so the
  coverage ledger's hashes and the record describe one tree.
- **Testnet fresh deploy.** The fresh deploy that comes before the pass is made
  from exactly the tagged commit; each chain's deployment record names the tag.

## Later

- The differential run (#3926) runs `baseline-check.mjs --tag <tag> --out
  <its reference build>` and does not start unless it passes.
- A fix needed on the old code is made on a branch cut from the tag on the day
  it is needed. There is no long-lived branch of the old code.
- A tag is never moved. If a tag turns out wrong, the next name in the series
  is cut and the wrong one is recorded as superseded in the release notes.

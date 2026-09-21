import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The reconciliation decision table from the cutover tool (#2214). It is a
// plain-Node operator script rather than Worker source, so it is imported
// by path; the module guards its own `main()` behind a direct-execution
// check precisely so this import cannot start carrying rows.
// @ts-expect-error — untyped .mjs operator script, imported for its pure exports
import {
  classifyAgainstManifestOnly,
  classifyForReconcile,
  collapseOutsideLiterals,
  compareSequences,
  isMissingSequenceTable,
  makeFingerprinter,
  coverageProblems,
  manifestEntry,
  parseEvidence,
  readAll,
  safeKey,
  situationOf,
  splitUniquesByEvaluability,
  stopsBeforeVerification,
  unsupportedUniqueReason,
  verdictProblems,
  writeManifest,
} from "../scripts/d1-carry-rows.mjs";

/**
 * WHY THIS TEST EXISTS. Post-switch reconciliation decides, per row,
 * whether to carry it, leave it, or stop and ask. Two of those cases
 * CANNOT be produced by rehearsing against the live pair — the
 * destination is inert before the switch, so it deletes nothing and
 * allocates no keys — and the branch that decides whether a deleted row
 * gets resurrected is not one to leave unexercised because a rehearsal
 * happened not to reach it.
 *
 * Each case below is one row of the table in
 * `docs/ops/D1CutoverArchiveToWarm.md` §"Reconcile, and keep reconciling".
 */

const cols = ["id", "value"];
const key = ["id"];
const k = (id: number) => JSON.stringify([id]);

/** The hash the tool stores per row — sha256 of the canonical encoding. */
function hashOf(row: Record<string, unknown>) {
  // Mirrors `rowHash`: JSON of the values in declared column order.
  const canonical = JSON.stringify(cols.map((c) => row[c] ?? null));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * `held` may be given as bare ids — in which case the destination row is
 * assumed identical to the source row with that id — or as whole rows,
 * for the cases where the destination holds something DIFFERENT under the
 * same key. That distinction is the point of several cases below.
 */
function classify(opts: {
  rows: Record<string, unknown>[];
  held: (number | Record<string, unknown>)[];
  mirrored: Record<string, unknown>[];
  uniques?: { name: string; columns: string[] }[];
  /** The destination's OWN columns, when they differ from the source's. */
  destCols?: string[];
}) {
  const wasSeen: Record<string, string> = {};
  for (const r of opts.mirrored) wasSeen[k(r.id as number)] = hashOf(r);
  const heldByKey = new Map<string, Record<string, unknown>>();
  for (const h of opts.held) {
    const row =
      typeof h === "number"
        ? (opts.rows.find((r) => r.id === h) ??
          opts.mirrored.find((r) => r.id === h) ?? { id: h, value: null })
        : h;
    heldByKey.set(k(row.id as number), row);
  }
  return classifyForReconcile({
    table: "t",
    cols,
    key,
    rows: opts.rows,
    sourceKeys: new Set(opts.rows.map((r) => k(r.id as number))),
    heldByKey,
    wasSeen,
    uniques: opts.uniques ?? [],
    destCols: opts.destCols ? new Set(opts.destCols) : null,
  });
}

describe("reconciliation decision table", () => {
  it("identifies a row the source gained after the mirror as the one to apply", () => {
    // `classifyForReconcile` returns it under `insert` — the candidate
    // set. That is NOT the tool carrying it: `main()` runs reconcile with
    // `reportOnly`, so this becomes a reported row for a person to apply.
    // The old name said "the only automatic case", which described the
    // write path removed in r14 (#2267 r29).
    const row = { id: 1, value: "new" };
    const { insert, conflicts } = classify({
      rows: [row],
      held: [],
      mirrored: [],
    });
    expect(insert).toEqual([row]);
    expect(conflicts).toEqual([]);
  });

  it("leaves an unchanged mirrored row alone", () => {
    const row = { id: 1, value: "same" };
    const { insert, conflicts } = classify({
      rows: [row],
      held: [1],
      mirrored: [row],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("reports a row the source changed after the mirror, and does not carry it", () => {
    const { insert, conflicts } = classify({
      rows: [{ id: 1, value: "after" }],
      held: [{ id: 1, value: "before" }],
      mirrored: [{ id: 1, value: "before" }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("changed on the source after the mirror");
  });

  it("says nothing when only the DESTINATION moved on", () => {
    // After the switch the destination is the live database: indexer_cursor
    // advances every minute while archive stays exactly as the mirror saw
    // it. The two sides differ, but the source did not change — so this is
    // the destination doing its job, not a conflict. Reporting it would
    // make the two required clean passes impossible to reach.
    const mirrored = { id: 1, value: "as mirrored" };
    const { insert, conflicts } = classify({
      rows: [mirrored],
      held: [{ id: 1, value: "destination has moved on" }],
      mirrored: [mirrored],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("reports when BOTH sides moved differently", () => {
    const { insert, conflicts } = classify({
      rows: [{ id: 1, value: "source moved" }],
      held: [{ id: 1, value: "destination moved elsewhere" }],
      mirrored: [{ id: 1, value: "as mirrored" }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("changed on the source after the mirror");
  });

  it("accepts a late update an operator has already resolved", () => {
    // The operator picked a value and made both sides agree. Comparing the
    // source against the MANIFEST alone would keep reporting this forever,
    // so repeat-until-clean could never come clean after resolving
    // anything — which is what the procedure asks the operator to do.
    const resolved = { id: 1, value: "after" };
    const { insert, conflicts } = classify({
      rows: [resolved],
      held: [resolved],
      mirrored: [{ id: 1, value: "before" }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("refuses to resurrect a row the DESTINATION deleted", () => {
    // The mirror carried it, so the destination had it and has since
    // dropped it — a retention prune, possibly a privacy obligation.
    // Absence alone looks identical to "never arrived", which is why the
    // manifest is what tells them apart.
    const row = { id: 1, value: "pruned there" };
    const { insert, conflicts } = classify({
      rows: [row],
      held: [],
      mirrored: [row],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("deleted on the destination");
  });

  it("reports a key both sides allocated independently, and does not carry it", () => {
    // AUTOINCREMENT on both sides after the mirror: one id, two DIFFERENT
    // records. An insert would be a no-op and the source's record lost.
    const { insert, conflicts } = classify({
      rows: [{ id: 7, value: "source record" }],
      held: [{ id: 7, value: "a different record" }],
      mirrored: [],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("key allocated on both sides");
  });

  it("accepts a row a previous pass already carried, so the procedure converges", () => {
    // Same shape as the case above — not in the manifest, present on both
    // sides — but the destination row is the one the last pass inserted.
    // Content is what tells them apart; without it, repeat-until-clean
    // could never come clean after carrying anything.
    const row = { id: 7, value: "carried last pass" };
    const { insert, conflicts } = classify({
      rows: [row],
      held: [row],
      mirrored: [],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("reports a logical row the destination already holds under a different key", () => {
    // Absent by primary key is not the same as insertable: a secondary
    // unique index (notifications.dedup_key) can already hold this row's
    // tuple, and ON CONFLICT (pk) would not catch it — the insert fails
    // with a raw constraint error and aborts the reconciliation.
    const { insert, conflicts } = classify({
      rows: [{ id: 9, value: "dedup-abc" }],
      held: [{ id: 4, value: "dedup-abc" }],
      mirrored: [],
      uniques: [{ name: "idx_value", columns: ["value"] }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("already present under a different key");
  });

  it("does not treat a NULL unique column as a collision", () => {
    // SQLite treats NULLs in a unique index as distinct, so two rows with
    // a NULL there do not collide and must still be carried.
    const row = { id: 9, value: null };
    const { insert, conflicts } = classify({
      rows: [row],
      held: [{ id: 4, value: null }],
      mirrored: [],
      uniques: [{ name: "idx_value", columns: ["value"] }],
    });
    expect(insert).toEqual([row]);
    expect(conflicts).toEqual([]);
  });

  it("reports a row the SOURCE deleted after the mirror while the destination still holds it", () => {
    // Invisible to anything iterating the source — it is in no row at all.
    const { insert, conflicts } = classify({
      rows: [],
      held: [1],
      mirrored: [{ id: 1, value: "gone from source" }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("deleted on the source after the mirror");
  });

  it("says nothing when both sides deleted the same row", () => {
    const { insert, conflicts } = classify({
      rows: [],
      held: [],
      mirrored: [{ id: 1, value: "gone from both" }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  // THREE REPORTED SITUATIONS HAVE NO RESOLUTION THAT MAKES THE NEXT RUN
  // CLEAN, and the runbook now says so where it asserts the two-clean-runs
  // rule. The reason is structural rather than a missing branch: the
  // classifier compares DATA, and the legitimate resolution of each of
  // these is a DECISION to leave the data as it is. Nothing either database
  // holds records a decision, so the next pass sees the same two rows.
  //
  // These are pinned as tests because the limitation is easier to
  // re-introduce as a bug than to remember as prose, and because #2279's
  // fix — recording ratified decisions in the manifest — is exactly the
  // change that should flip them. A failure here after that work is the
  // test doing its job; update it with the new expectation rather than
  // deleting it.
  it("key-collision does not converge when the operator keeps BOTH records", () => {
    // The operator applies the source record under a new id, leaving the
    // destination's own record where it is. Both are now preserved, which
    // is the right outcome — and the contested id is still allocated on
    // both sides to different records, so the next pass reports it again.
    const before = classify({
      rows: [{ id: 7, value: "source record" }],
      held: [{ id: 7, value: "a different record" }],
      mirrored: [],
    });
    const after = classify({
      rows: [{ id: 7, value: "source record" }],
      held: [
        { id: 7, value: "a different record" },
        { id: 99, value: "source record" },
      ],
      mirrored: [],
    });
    expect(before.conflicts[0].kind).toBe("key allocated on both sides");
    expect(after.conflicts.map((c) => c.kind)).toEqual([
      "key allocated on both sides",
    ]);
  });

  it("destination-deleted does not converge when the deletion is allowed to stand", () => {
    // The operator confirms the retention prune was correct. Acting on that
    // decision means changing nothing, so the row is still on the source
    // and still absent from the destination next week.
    const args = {
      rows: [{ id: 1, value: "pruned there" }],
      held: [] as number[],
      mirrored: [{ id: 1, value: "pruned there" }],
    };
    expect(classify(args).conflicts[0].kind).toBe("deleted on the destination");
    expect(classify(args).conflicts.map((c) => c.kind)).toEqual([
      "deleted on the destination",
    ]);
  });

  it("source-deleted does not converge when the destination row is kept", () => {
    // The mirror image of the case above. Deleting the destination's row to
    // silence the report would discard a setting a user may since have
    // changed, which is why the tool never does it — and why keeping the
    // row, the safe answer, leaves the difference in place.
    const args = {
      rows: [] as Record<string, unknown>[],
      held: [1],
      mirrored: [{ id: 1, value: "gone from source" }],
    };
    expect(classify(args).conflicts[0].kind).toBe(
      "deleted on the source after the mirror",
    );
    expect(classify(args).conflicts.map((c) => c.kind)).toEqual([
      "deleted on the source after the mirror",
    ]);
  });

  it("source-changed DOES converge, which is what makes the other three a limitation", () => {
    // The contrast is the whole argument. Here the resolution — apply the
    // source's value — is itself a data change, so the next pass is clean.
    // If every situation behaved like this one there would be nothing to
    // document; if none did, "repeat until clean" would simply be wrong.
    const before = classify({
      rows: [{ id: 3, value: "late value" }],
      held: [{ id: 3, value: "as mirrored" }],
      mirrored: [{ id: 3, value: "as mirrored" }],
    });
    const after = classify({
      rows: [{ id: 3, value: "late value" }],
      held: [{ id: 3, value: "late value" }],
      mirrored: [{ id: 3, value: "as mirrored" }],
    });
    expect(before.conflicts[0].kind).toBe(
      "changed on the source after the mirror",
    );
    expect(after.conflicts).toEqual([]);
    expect(after.insert).toEqual([]);
  });

  // A COLUMN THE DESTINATION DROPPED IS NOT A COLUMN HOLDING NULL
  // (#2267 r39). Both of these arise only in the weekly reconciliation,
  // where the two sides may legitimately declare a table differently
  // because the live destination took a migration the retained source
  // never will.
  it("does not read a dropped destination column as agreement with a late NULL", () => {
    // The straggler set `value` to NULL on the source after the mirror —
    // a real late write. The destination has since dropped that column,
    // so its row carries no such field. Projected as NULL the two rows
    // hash identically and the run reports clean, which is the late write
    // vanishing inside the only check still looking for it.
    const mirrored = { id: 1, value: "before" };
    const args = {
      rows: [{ id: 1, value: null }],
      held: [{ id: 1 }],
      mirrored: [mirrored],
    };
    expect(classify(args).conflicts).toEqual([]);
    expect(
      classify({ ...args, destCols: ["id"] }).conflicts.map((c) => c.kind),
    ).toEqual(["changed on the source after the mirror"]);
  });

  it("stays quiet about a dropped destination column when the source has not moved", () => {
    // The other half of the same rule, and the reason it is a projection
    // rather than a refusal: a dropped column must not turn every row of
    // that table into a permanent report. The source is exactly as the
    // mirror saw it, so this is the destination having moved on.
    const row = { id: 1, value: "as mirrored" };
    const { insert, conflicts } = classify({
      rows: [row],
      held: [{ id: 1 }],
      mirrored: [row],
      destCols: ["id"],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("does not turn a hand-applied row into a permanent collision over a dropped column", () => {
    // Found self-reviewing the fix above, before it was reviewed
    // (#2267 r39). The marker that keeps a dropped column from reading
    // as NULL belongs to the manifest-backed question only. For a row
    // the mirror never carried there is no manifest hash to fall through
    // to, so the same marker would make a row the operator applied by
    // hand look like two records wearing one id — and nothing could ever
    // resolve it, because nothing can make a dropped column match.
    //
    // Those rows are compared over the columns both sides have.
    const { insert, conflicts } = classify({
      rows: [{ id: 7, value: "applied by hand" }],
      held: [{ id: 7 }],
      mirrored: [],
      destCols: ["id"],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("still collides when the two records differ on a column both sides have", () => {
    // The other side of that narrowing: it must not become a blanket
    // "anything outside the manifest agrees".
    const { conflicts } = classify({
      rows: [{ id: 7, value: "source record" }],
      held: [{ id: 7, value: "a different record" }],
      mirrored: [],
      destCols: ["id", "value"],
    });
    expect(conflicts.map((c) => c.kind)).toEqual([
      "key allocated on both sides",
    ]);
  });

  it("refuses to reconcile a table the manifest has no record of", () => {
    const { insert, conflicts } = classifyForReconcile({
      table: "t",
      cols,
      key,
      rows: [{ id: 1, value: "x" }],
      sourceKeys: new Set([k(1)]),
      heldByKey: new Map(),
      wasSeen: null,
      uniques: [],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("no record");
  });
});

/**
 * The three facts collapse to one name, and the classifier handles every
 * name or throws. Pinning the names here is what keeps that promise
 * checkable: a situation added without a matching case in the classifier
 * fails loudly, and a case quietly dropped from the classifier — which has
 * happened twice — cannot pass this file.
 */
describe("situationOf — the three facts as one name", () => {
  const h = (value: unknown) => hashOf({ id: 1, value });
  const row = (value: unknown) => ({ id: 1, value });

  it.each([
    ["new-on-source", undefined, h("a"), undefined],
    ["destination-deleted", h("a"), h("a"), undefined],
    ["agreed", h("a"), h("a"), row("a")],
    ["agreed (after an operator resolved it)", h("old"), h("new"), row("new")],
    ["key-collision", undefined, h("a"), row("b")],
    ["destination-moved", h("a"), h("a"), row("b")],
    ["source-changed", h("old"), h("new"), row("other")],
  ])("%s", (name, mirroredHash, sourceHash, destRow) => {
    expect(situationOf({ mirroredHash, sourceHash, destRow, cols })).toBe(
      String(name).split(" ")[0],
    );
  });

  it("handles every situation reachable from any input, with no list to keep", () => {
    // THIS USED TO BE A HAND-WRITTEN SET COMPARED WITH ITS OWN SIZE, which
    // is the enumeration trap the rest of this change exists to remove:
    // it read as coverage, checked nothing, and stayed green while a
    // seventh situation was added (#2267 r27).
    //
    // What actually matters is that no input can produce a situation the
    // classifier does not handle. So the situations are DERIVED by driving
    // `situationOf` across its whole input space — the manifest holding
    // nothing / the source's row / a different row, crossed with the
    // destination holding nothing / the source's row / a different row —
    // and each combination is then run through the classifier, whose
    // `default` throws on an unhandled name. Add a situation without a
    // case and this fails; add one WITH a case and it passes untouched.
    const rowA = { id: 1, value: "a" };
    const rowB = { id: 1, value: "b" };
    const manifests = {
      nothing: [],
      theSourceRow: [rowA],
      aDifferentRow: [rowB],
    };
    const destinations = {
      nothing: [],
      theSourceRow: [rowA],
      aDifferentRow: [rowB],
    };

    const reached = new Set<string>();
    for (const [mName, mirrored] of Object.entries(manifests)) {
      for (const [dName, held] of Object.entries(destinations)) {
        reached.add(
          situationOf({
            mirroredHash: mirrored.length ? hashOf(mirrored[0]) : undefined,
            sourceHash: hashOf(rowA),
            destRow: held.length ? held[0] : undefined,
            cols,
          }),
        );
        expect(
          () => classify({ rows: [rowA], held, mirrored }),
          `manifest=${mName} destination=${dName}`,
        ).not.toThrow();
      }
    }

    // Every name the input space can produce was handled above. The count
    // is asserted only to catch a situation becoming UNREACHABLE, which is
    // dead code rather than a hazard — hence the message.
    expect([...reached].sort()).toEqual([
      "agreed",
      "destination-deleted",
      "destination-deleted-source-changed",
      "destination-moved",
      "key-collision",
      "new-on-source",
      "source-changed",
    ]);
  });
});

/**
 * THE SUCCESS PATH, which had never executed. Three stale references sat
 * in the branch that prints VERIFIED through four review rounds, because
 * every live run had conflicts and left on the failure path — so the
 * live-run evidence reported each round covered only half the code.
 * Reaching that branch against the real databases needs a source holding
 * still, which is the cutover condition itself; a test reaches it now.
 */
describe("verdict", () => {
  const d = (digest: string, count: number) => ({ digest, count });
  const both = (digest: string, count: number) =>
    [
      new Map([["t", d(digest, count)]]),
      new Map([["t", d(digest, count)]]),
    ] as const;

  it("reports NOTHING when a mirror left both sides identical", () => {
    const [srcD, dstD] = both("aaaa", 3);
    expect(
      verdictProblems({
        srcD,
        dstD,
        refused: [],
        conflicts: [],
        reconciling: false,
      }),
    ).toEqual([]);
  });

  it("reports NOTHING when a reconciliation finds the destination complete", () => {
    // The destination may legitimately hold MORE than the source by then.
    const srcD = new Map([["t", d("aaaa", 3)]]);
    const dstD = new Map([["t", d("bbbb", 5)]]);
    expect(
      verdictProblems({
        srcD,
        dstD,
        refused: [],
        conflicts: [],
        reconciling: true,
      }),
    ).toEqual([]);
  });

  it("reports a digest difference after a mirror", () => {
    const srcD = new Map([["t", d("aaaa", 3)]]);
    const dstD = new Map([["t", d("bbbb", 3)]]);
    const problems = verdictProblems({
      srcD,
      dstD,
      refused: [],
      conflicts: [],
      reconciling: false,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("!=");
  });

  it("reports a destination holding fewer rows than the source", () => {
    const srcD = new Map([["t", d("aaaa", 5)]]);
    const dstD = new Map([["t", d("bbbb", 2)]]);
    expect(
      verdictProblems({
        srcD,
        dstD,
        refused: [],
        conflicts: [],
        reconciling: true,
      }),
    ).toHaveLength(1);
  });

  it("fails on a refused table rather than reporting success", () => {
    const [srcD, dstD] = both("aaaa", 3);
    const problems = verdictProblems({
      srcD,
      dstD,
      refused: [{ table: "t", refused: "no primary key" }],
      conflicts: [],
      reconciling: false,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("NOT CARRIED");
  });

  it("names a conflict by table and key, and never by its contents", () => {
    const [srcD, dstD] = both("aaaa", 3);
    const problems = verdictProblems({
      srcD,
      dstD,
      refused: [],
      conflicts: [
        {
          table: "support_tickets",
          key: '["tk_1"]',
          kind: "changed on the source after the mirror",
          detail: "the destination holds a different row under that key",
        },
      ],
      reconciling: true,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('support_tickets ["tk_1"]');
    // The row's values must never reach a report that gets pasted into logs.
    expect(problems[0]).not.toContain("@");
  });
});

describe("verdict — a table only the destination has", () => {
  const d = (digest: string, count: number) => ({ digest, count });

  it("fails rather than reporting VERIFIED", () => {
    // A mirror says it makes the destination IDENTICAL to the source. A
    // table the destination alone holds makes that claim false, and the
    // loop over the source can never see it — so the run would have
    // printed VERIFIED with an unexamined table of user records sitting
    // there.
    const srcD = new Map([["t", d("aaaa", 3)]]);
    const dstD = new Map([
      ["t", d("aaaa", 3)],
      ["left_behind", d("bbbb", 40)],
    ]);
    const problems = verdictProblems({
      srcD,
      dstD,
      refused: [],
      conflicts: [],
      reconciling: false,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("left_behind");
    expect(problems[0]).toContain("ABSENT from the source");
  });

  it("does NOT fail a reconciliation, where it is what a migration looks like", () => {
    // REVERSED at #2267 r39, and the reversal is the point. This used to
    // fail in both directions, on the reasoning that reconcile compares
    // against a manifest taken in parity. But after the switch the
    // destination keeps taking migrations and the retained source never
    // will, so the first one that CREATES a table puts the two here
    // permanently — and the weekly run could never come clean again. A
    // table the source does not have cannot hold a late source write,
    // which is the only thing this run looks for, so it is drift the
    // caller prints rather than a finding. Losing the weekly check at
    // the first schema change is the larger failure by far.
    const srcD = new Map([["t", d("aaaa", 3)]]);
    const dstD = new Map([
      ["t", d("zzzz", 9)],
      ["added_by_migration", d("bbbb", 40)],
    ]);
    expect(
      verdictProblems({
        srcD,
        dstD,
        refused: [],
        conflicts: [],
        reconciling: true,
      }),
    ).toEqual([]);
  });

  it("does not double-report a table already refused", () => {
    const srcD = new Map([["t", d("aaaa", 3)]]);
    const dstD = new Map([
      ["t", d("aaaa", 3)],
      ["odd", d("bbbb", 1)],
    ]);
    const problems = verdictProblems({
      srcD,
      dstD,
      refused: [{ table: "odd", refused: "destination-only" }],
      conflicts: [],
      reconciling: false,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("NOT CARRIED");
  });
});

/**
 * WHY THIS TEST EXISTS. `readAll` pages a table with `LIMIT/OFFSET`, and
 * each page is a separate statement against a database that may be
 * changing: a row inserted between pages whose sort position falls into a
 * page already read is returned by none of them. The tool answers that by
 * reading the whole table TWICE and comparing — which only works if a row
 * the first pass skipped really does come back in the result.
 *
 * Nothing about that is visible from a rehearsal against the live pair,
 * because a quiesced source agrees on the first comparison every time.
 * These drive `readAll` against an in-memory table that moves underneath
 * it on purpose.
 */
describe("readAll — a paged read is not a snapshot", () => {
  const COLS = ["id"];
  const PAGE = 500;
  const id = (n: number) => `r${String(n).padStart(5, "0")}`;

  /**
   * A table that answers `LIMIT/OFFSET` from its current contents, with a
   * hook that runs strictly BETWEEN statements — which is exactly where a
   * straggler's write lands.
   */
  function fakeTable(initial: string[]) {
    const state = {
      rows: [...initial],
      statements: 0,
      afterStatement: (_n: number, _s: { rows: string[] }) => {},
    };
    const run = async (_dbId: string, sql: string) => {
      const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql);
      if (!m) throw new Error(`unexpected SQL: ${sql}`);
      const page = [...state.rows]
        .sort()
        .slice(Number(m[2]), Number(m[2]) + Number(m[1]))
        .map((v) => ({ id: v }));
      state.statements += 1;
      state.afterStatement(state.statements, state);
      return page;
    };
    return { state, run };
  }

  it("reads a single-statement table once and does not re-read it", async () => {
    const { state, run } = fakeTable([id(1), id(2), id(3)]);
    const rows = await readAll("db", "t", COLS, run);
    expect(rows.map((r: { id: string }) => r.id)).toEqual([
      id(1),
      id(2),
      id(3),
    ]);
    expect(state.statements).toBe(1);
  });

  it("re-reads a table that actually paged, and agrees when it is still", async () => {
    const all = Array.from({ length: PAGE + 100 }, (_, i) => id(i + 1));
    const { state, run } = fakeTable(all);
    const rows = await readAll("db", "t", COLS, run);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(all);
    // Two full passes of two statements each — the second pass is the
    // check, and it is not skipped just because the table was quiet.
    expect(state.statements).toBe(4);
  });

  it("returns a row the first pass skipped entirely", async () => {
    const all = Array.from({ length: PAGE + 100 }, (_, i) => id(i + 1));
    const { state, run } = fakeTable(all);
    // A straggler commits after the first page is read, sorting ahead of
    // everything already returned — the one insert a single paged pass
    // cannot see.
    const straggler = id(0);
    state.afterStatement = (n, s) => {
      if (n === 1) s.rows.push(straggler);
    };

    const rows = await readAll("db", "t", COLS, run);
    const seen = rows.map((r: { id: string }) => r.id);

    expect(seen).toContain(straggler);
    expect([...new Set(seen)].sort()).toEqual([straggler, ...all].sort());
  });
});

/**
 * WHY THESE TESTS EXIST. Both behaviours below decide whether a run that
 * looks clean actually is, and neither is reachable from a rehearsal
 * against the live pair — the first needs a source that moves mid-run,
 * the second needs two schemas that differ only inside a quoted literal.
 */
describe("a verdict is only as good as the reading it was drawn from", () => {
  const d = (digest: string, count: number) => ({ digest, count });

  it("reports a source that changed between classification and the verdict", () => {
    // The trap: an UPDATE leaves the row count identical, and reconcile
    // mode only checks that the destination has at least as many rows. So
    // a straggler updating an archive row after its table was classified
    // produced no conflict and printed VERIFIED.
    const problems = verdictProblems({
      srcD: new Map([["offers", d("after", 12)]]),
      dstD: new Map([["offers", d("whatever", 12)]]),
      refused: [],
      conflicts: [],
      reconciling: true,
      classifiedSource: new Map([["offers", "before"]]),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      "the source CHANGED while this run was working",
    );
    expect(problems[0]).toContain("before");
    expect(problems[0]).toContain("after");
  });

  it("stays silent when the source held still, whatever the destination did", () => {
    // The destination is live during a reconcile and legitimately differs;
    // only the SOURCE moving invalidates the classification.
    const problems = verdictProblems({
      srcD: new Map([["offers", d("same", 12)]]),
      dstD: new Map([["offers", d("destination moved on", 14)]]),
      refused: [],
      conflicts: [],
      reconciling: true,
      classifiedSource: new Map([["offers", "same"]]),
    });
    expect(problems).toEqual([]);
  });

  it("does not apply the check to a mirror, which compares digests outright", () => {
    const problems = verdictProblems({
      srcD: new Map([["offers", d("aaaa", 3)]]),
      dstD: new Map([["offers", d("aaaa", 3)]]),
      refused: [],
      conflicts: [],
      reconciling: false,
      classifiedSource: new Map([["offers", "something else"]]),
    });
    expect(problems).toEqual([]);
  });
});

describe("schema comparison — whitespace outside literals only", () => {
  it("keeps two defaults that SQLite keeps distinct, distinct", () => {
    expect(collapseOutsideLiterals("x TEXT DEFAULT 'a  b'")).not.toBe(
      collapseOutsideLiterals("x TEXT DEFAULT 'a b'"),
    );
  });

  it("still collapses whitespace outside quotes", () => {
    expect(collapseOutsideLiterals("CREATE   TABLE\n  t (a)")).toBe(
      "CREATE TABLE t (a)",
    );
  });

  it("preserves spacing inside quoted identifiers and CHECK values", () => {
    expect(collapseOutsideLiterals('CREATE TABLE "x  y" (a)')).toBe(
      'CREATE TABLE "x  y" (a)',
    );
    expect(collapseOutsideLiterals("a CHECK (a <> 'p  q')")).toBe(
      "a CHECK (a <> 'p  q')",
    );
  });

  it("handles a doubled quote, where one literal closes and the next opens", () => {
    expect(collapseOutsideLiterals("x DEFAULT 'it''s  here'")).toBe(
      "x DEFAULT 'it''s  here'",
    );
  });
});

/**
 * WHY THIS TEST EXISTS. The AUTOINCREMENT check queries `sqlite_sequence`,
 * which SQLite does not create until something allocates — so on a
 * database where nothing has, the query is an error rather than an empty
 * result, and treating that as empty is correct. Treating anything ELSE
 * as empty would be a check reporting success when it never ran, which is
 * the failure this tool exists to avoid.
 */
describe('the one error that means "nothing has ever allocated"', () => {
  const live = (m: string) =>
    new Error(`HTTP 400 on /d1/database/x/query\n${m}`);

  it("recognises the real D1 shape", () => {
    expect(
      isMissingSequenceTable(
        live(
          '{"errors":[{"code":7500,"message":"no such table: sqlite_sequence: SQLITE_ERROR"}]}',
        ),
      ),
    ).toBe(true);
  });

  it("does NOT match a table whose name merely starts the same way", () => {
    expect(
      isMissingSequenceTable(
        live(
          '{"errors":[{"message":"no such table: sqlite_sequence_nope: SQLITE_ERROR"}]}',
        ),
      ),
    ).toBe(false);
  });

  it("does not swallow a missing application table", () => {
    expect(
      isMissingSequenceTable(
        live("no such table: notifications: SQLITE_ERROR"),
      ),
    ).toBe(false);
  });

  it("does not swallow a transport or auth failure", () => {
    expect(isMissingSequenceTable(new Error("fetch failed"))).toBe(false);
    expect(isMissingSequenceTable(live("Authentication error"))).toBe(false);
  });
});

/**
 * WHY THESE TESTS EXIST. A key the mirror carried that the source no
 * longer has appears in NO row of the source, so the per-row loop never
 * reaches it — it is handled by a separate pass over the manifest, and
 * that pass had been asserting the destination's row is stale after
 * checking only that its KEY still exists.
 *
 * Several of these keys are natural and reusable (`user_thresholds` is
 * keyed by the setting, not by an allocated id), so the destination may
 * hold a row a user changed after the mirror.
 */
describe("a source-side deletion, against a destination that may have moved", () => {
  it("calls it stale only when the destination still holds what was mirrored", () => {
    const mirrored = { id: 1, value: "as mirrored" };
    const { conflicts } = classify({
      rows: [], // deleted on the source
      held: [mirrored], // destination still has the mirrored row
      mirrored: [mirrored],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("deleted on the source after the mirror");
  });

  it("reports both sides moving when the destination row has since changed", () => {
    const { conflicts } = classify({
      rows: [], // deleted on the source
      held: [{ id: 1, value: "the user changed this after the mirror" }],
      mirrored: [{ id: 1, value: "as mirrored" }],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe(
      "deleted on the source, and CHANGED on the destination",
    );
    expect(conflicts[0].detail).toContain("its own newer value");
  });

  it("says nothing when both sides dropped it", () => {
    const { conflicts } = classify({
      rows: [],
      held: [],
      mirrored: [{ id: 1, value: "gone from both" }],
    });
    expect(conflicts).toEqual([]);
  });
});

describe("a destination deletion does not hide a late source change", () => {
  it("names both when the source also changed the row", () => {
    const { insert, conflicts } = classify({
      rows: [{ id: 1, value: "source changed it late" }],
      held: [], // destination deleted it
      mirrored: [{ id: 1, value: "as mirrored" }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe(
      "deleted on the destination, and CHANGED on the source",
    );
    expect(conflicts[0].detail).toContain(
      "no reading of the destination will show",
    );
  });

  it("still names only the deletion when the source did not change it", () => {
    const row = { id: 1, value: "untouched on the source" };
    const { conflicts } = classify({ rows: [row], held: [], mirrored: [row] });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("deleted on the destination");
  });
});

describe("situationOf names the seventh case", () => {
  it("separates a plain destination deletion from one with a late source change", () => {
    expect(
      situationOf({
        mirroredHash: "a",
        sourceHash: "a",
        destRow: undefined,
        cols,
      }),
    ).toBe("destination-deleted");
    expect(
      situationOf({
        mirroredHash: "a",
        sourceHash: "b",
        destRow: undefined,
        cols,
      }),
    ).toBe("destination-deleted-source-changed");
  });
});

/**
 * WHY THIS TEST EXISTS. `telegram_links` is keyed BY the six-digit
 * handshake code — the credential itself is the primary key. Conflict
 * reports name the row and withhold its contents precisely because they
 * get pasted into run logs and issues, and for this one table that rule
 * published the secret and kept the harmless part.
 *
 * The test asserts the PROPERTY — no report carries the raw code — rather
 * than checking the sites that build one, because the first fix covered
 * the conflict paths and missed the pending-row path (#2267 r31).
 */
describe("a key that is itself a credential never reaches a report", () => {
  const CODE = "481920";
  const tkCols = ["code", "wallet"];
  const tkKey = ["code"];
  const tkRow = (code: string, wallet: string) => ({ code, wallet });
  const kOf = (code: string) => JSON.stringify([code]);

  function classifyTelegram(opts: {
    rows: Record<string, unknown>[];
    held: Record<string, unknown>[];
    mirrored: Record<string, unknown>[];
  }) {
    const { createHash } = require("node:crypto");
    const h = (r: Record<string, unknown>) =>
      createHash("sha256")
        .update(JSON.stringify(tkCols.map((c) => r[c] ?? null)))
        .digest("hex")
        .slice(0, 16);
    const wasSeen: Record<string, string> = {};
    for (const r of opts.mirrored) wasSeen[kOf(r.code as string)] = h(r);
    return classifyForReconcile({
      table: "telegram_links",
      cols: tkCols,
      key: tkKey,
      rows: opts.rows,
      sourceKeys: new Set(opts.rows.map((r) => kOf(r.code as string))),
      heldByKey: new Map(opts.held.map((r) => [kOf(r.code as string), r])),
      wasSeen,
      uniques: [],
    });
  }

  const cases: [string, Parameters<typeof classifyTelegram>[0]][] = [
    [
      "changed on the source",
      {
        rows: [tkRow(CODE, "after")],
        held: [tkRow(CODE, "before")],
        mirrored: [tkRow(CODE, "before")],
      },
    ],
    [
      "deleted on the destination",
      { rows: [tkRow(CODE, "w")], held: [], mirrored: [tkRow(CODE, "w")] },
    ],
    [
      "key allocated on both sides",
      { rows: [tkRow(CODE, "a")], held: [tkRow(CODE, "b")], mirrored: [] },
    ],
    [
      "deleted on the source",
      { rows: [], held: [tkRow(CODE, "w")], mirrored: [tkRow(CODE, "w")] },
    ],
  ];

  for (const [name, opts] of cases) {
    it(`fingerprints the code in the "${name}" report`, () => {
      const { conflicts } = classifyTelegram(opts);
      expect(conflicts.length).toBeGreaterThan(0);
      for (const c of conflicts) {
        expect(JSON.stringify(c)).not.toContain(CODE);
        expect(c.key).toContain("fp:");
      }
    });
  }

  it("fingerprints the pending-row key the same way the report path does", () => {
    // The pending path (a row present only on the source) builds its key
    // separately in `main()`. That is the site the first fix missed, so
    // this asserts the same transformation applies to it.
    expect(safeKey("telegram_links", tkKey, kOf(CODE))).not.toContain(CODE);
    expect(safeKey("telegram_links", tkKey, kOf(CODE))).toContain("fp:");
  });

  it('leaves an ordinary table"s key readable, which is the point of the report', () => {
    expect(safeKey("support_tickets", ["id"], JSON.stringify([42]))).toBe(
      JSON.stringify([42]),
    );
  });
});

/**
 * WHY THIS TEST EXISTS. The first redaction hashed the six-digit code
 * with an unsalted sha256, which is an ENCODING and not a redaction: the
 * whole domain is a million candidates, so a reader of the report
 * recovers the live credential by enumerating it. That was demonstrated
 * against the shipped code in about a second (#2267 r33).
 *
 * The properties below are what separate the two, so they are asserted
 * rather than described.
 */
describe("a fingerprint of a low-entropy secret needs a key", () => {
  const { randomBytes } =
    require("node:crypto") as typeof import("node:crypto");
  const CODE = "481920";

  it("is stable within a run, so a reader can match report lines", () => {
    const f = makeFingerprinter(randomBytes(32));
    expect(f(CODE)).toBe(f(CODE));
  });

  it("distinguishes different codes", () => {
    const f = makeFingerprinter(randomBytes(32));
    expect(f(CODE)).not.toBe(f("654321"));
  });

  it("differs across runs, which is what defeats a precomputed table", () => {
    expect(makeFingerprinter(randomBytes(32))(CODE)).not.toBe(
      makeFingerprinter(randomBytes(32))(CODE),
    );
  });

  it("does not yield the code to exhaustive search of the whole domain", () => {
    // The actual attack: hold a fingerprint from one run, try every
    // six-digit code under a different key. This is the test that fails
    // if anyone replaces the HMAC with a plain hash again.
    const fromAnotherRun = makeFingerprinter(randomBytes(32))(CODE);
    const mine = makeFingerprinter(randomBytes(32));
    let recovered: string | null = null;
    for (let i = 0; i < 1_000_000; i += 1) {
      if (mine(String(i).padStart(6, "0")) === fromAnotherRun) {
        recovered = String(i).padStart(6, "0");
        break;
      }
    }
    expect(recovered).toBeNull();
  }, 30_000);
});

/**
 * WHY THIS TEST EXISTS. A straggler that allocates an identifier after
 * the mirror and then deletes the row leaves the ROWS matching on both
 * sides while the source's allocation counter has moved. Nothing else in
 * a reconciliation looks at that, so the identifier ends up spent on one
 * side and free on the other — the key-collision case arriving by a
 * route the row comparison cannot see (#2267 r36).
 */
describe("late allocations on the source are reported", () => {
  it("reports a table whose sequence advanced past the mirror", () => {
    const problems = compareSequences(new Map([["notifications", 52]]), {
      notifications: { seq: 46 },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("up to 52");
    expect(problems[0]).toContain("recorded 46");
    expect(problems[0]).toContain("inserted 6 row(s)");
  });

  it("says nothing when the sequence has not moved", () => {
    expect(
      compareSequences(new Map([["notifications", 46]]), {
        notifications: { seq: 46 },
      }),
    ).toEqual([]);
  });

  it("ignores a manifest written before the baseline was recorded", () => {
    // `seq: null` is what an older mirror leaves. Treating it as zero
    // would report every allocation the source has ever made as late,
    // burying the real signal on the first weekly run.
    expect(
      compareSequences(new Map([["notifications", 46]]), {
        notifications: { seq: null },
      }),
    ).toEqual([]);
  });

  it("ignores a table the mirror never carried", () => {
    expect(compareSequences(new Map([["notifications", 46]]), {})).toEqual([]);
  });
});

describe("a never-allocated baseline is zero, not unknown", () => {
  it("reports the first allocation after the mirror", () => {
    // diag_legal_hold_audit is empty today. A straggler inserting and
    // then deleting its FIRST row leaves the rows matching and the
    // sequence at 1 — which a null baseline would have skipped, because
    // null means "this manifest predates the field" (#2267 r37).
    const problems = compareSequences(new Map([["diag_legal_hold_audit", 1]]), {
      diag_legal_hold_audit: { seq: 0 },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("inserted 1 row(s)");
  });

  it("still skips a legacy manifest that recorded no baseline", () => {
    expect(
      compareSequences(new Map([["diag_legal_hold_audit", 1]]), {
        diag_legal_hold_audit: { seq: null },
      }),
    ).toEqual([]);
  });
});

describe("a sequence advance is not resolved by the destination counting up", () => {
  it("still reports when the destination has reached the same number", () => {
    // REVERSED at #2267 r39. r38 read the destination catching up as
    // proof the late row had been applied. It is not: the live
    // destination allocates identifiers for its own records every
    // minute, and by number that is indistinguishable from having
    // applied this one. The state it silently blessed — one identifier
    // naming two different records — is the one a reverse mirror would
    // collapse.
    const problems = compareSequences(
      new Map([["notifications", 52]]),
      { notifications: { seq: 46 } },
      new Map([["notifications", 52]]),
    );
    expect(problems).toHaveLength(1);
    // The destination's own figure is still shown, as context.
    expect(problems[0]).toContain("reached 52");
    expect(problems[0]).toContain("not resolution");
  });

  it("is quiet when the source has not allocated since the mirror", () => {
    // The reason reversing r38 does not make ordinary runs noisy: the
    // source of a reconciliation is the database the writers LEFT, so
    // its sequence moves only if a straggler allocated on it.
    expect(
      compareSequences(
        new Map([["notifications", 46]]),
        { notifications: { seq: 46 } },
        new Map([["notifications", 91]]),
      ),
    ).toEqual([]);
  });

  it("still reports while the destination is behind", () => {
    expect(
      compareSequences(
        new Map([["notifications", 52]]),
        { notifications: { seq: 46 } },
        new Map([["notifications", 46]]),
      ),
    ).toHaveLength(1);
  });

  it("reports when the destination has never allocated at all", () => {
    expect(
      compareSequences(new Map([["notifications", 52]]), {
        notifications: { seq: 46 },
      }),
    ).toHaveLength(1);
  });
});

describe("whose unique indexes decide what a reported row would hit", () => {
  // The destination is the database that would reject — or silently
  // duplicate — a row the operator applies on the strength of a run.
  // After the switch the two sides may declare a table differently, so
  // the retained source's indexes are not a safe stand-in (#2267 r39).
  it("keeps an index the source row can be projected onto", () => {
    const idx = { name: "idx_dedup", columns: ["dedup_key"] };
    const { usable, unevaluable } = splitUniquesByEvaluability(
      [idx],
      ["id", "dedup_key"],
    );
    expect(usable).toEqual([idx]);
    expect(unevaluable).toEqual([]);
  });

  it("names an index it cannot evaluate rather than dropping it quietly", () => {
    // The tuple is built from a SOURCE row, so an index over a column the
    // source lacks cannot be looked up at all. Silently ignoring it would
    // report a row as plainly missing while the destination's own new
    // constraint already holds it — and send the operator at an insert
    // that fails.
    const idx = { name: "idx_added_later", columns: ["added_by_migration"] };
    const { usable, unevaluable } = splitUniquesByEvaluability(
      [idx],
      ["id", "value"],
    );
    expect(usable).toEqual([]);
    expect(unevaluable).toEqual([idx]);
  });

  it("splits a mixed set both ways", () => {
    const ok = { name: "idx_ok", columns: ["value"] };
    const no = { name: "idx_no", columns: ["value", "added_by_migration"] };
    const { usable, unevaluable } = splitUniquesByEvaluability(
      [ok, no],
      ["id", "value"],
    );
    expect(usable).toEqual([ok]);
    expect(unevaluable).toEqual([no]);
  });
});

describe("a reconciliation never stops before its late-write checks", () => {
  // THE TRAPDOOR THIS CLOSES. The sequence comparison and the re-read
  // that notices the source moved both run after the report — and #2279
  // means a reconciliation can carry a conflict permanently, because
  // three situations are resolved by a decision that changes no data.
  // Stopping on a conflict therefore switched both checks off for good,
  // on the one procedure still looking for late writes (#2267 r39).
  const conflict = [{ table: "t", kind: "k", detail: "d" }];
  const refusal = [{ table: "t", refused: "r" }];

  it("carries on through a conflict that will report every week", () => {
    expect(
      stopsBeforeVerification({ reconciling: true, conflicts: conflict }),
    ).toBe(false);
  });

  it("carries on through a refusal too", () => {
    expect(
      stopsBeforeVerification({ reconciling: true, refused: refusal }),
    ).toBe(false);
  });

  it("still stops a CARRY, which wrote nothing and has minutes of digests ahead", () => {
    expect(
      stopsBeforeVerification({ reconciling: false, conflicts: conflict }),
    ).toBe(true);
    expect(
      stopsBeforeVerification({ reconciling: false, refused: refusal }),
    ).toBe(true);
  });

  it("does not stop a clean carry", () => {
    expect(stopsBeforeVerification({ reconciling: false })).toBe(false);
  });
});

describe("a table the destination no longer has", () => {
  // A migration that DROPS a table leaves the retained source holding it
  // and the comparison with nothing to compare against — but not with
  // nothing to ask. Refusing it made every later weekly run emit the same
  // generic refusal, so a straggler writing into that table was
  // indistinguishable from schema drift everyone already knew about,
  // permanently (#2267 r40).
  const seenOf = (rows: Record<string, unknown>[]) => {
    const w: Record<string, string> = {};
    for (const r of rows) w[k(r.id as number)] = hashOf(r);
    return w;
  };

  it("says nothing when the source has not been written to since the mirror", () => {
    const rows = [{ id: 1, value: "a" }];
    expect(
      classifyAgainstManifestOnly({
        table: "dropped_by_migration",
        cols,
        key,
        rows,
        wasSeen: seenOf(rows),
      }).conflicts,
    ).toEqual([]);
  });

  it("reports a late insert and a late update, with counts and no rows", () => {
    const mirrored = [{ id: 1, value: "a" }];
    const { conflicts } = classifyAgainstManifestOnly({
      table: "dropped_by_migration",
      cols,
      key,
      rows: [
        { id: 1, value: "changed since" },
        { id: 2, value: "arrived since" },
      ],
      wasSeen: seenOf(mirrored),
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].detail).toContain(
      "1 row(s) added, 1 changed and 0 DELETED",
    );
    expect(conflicts[0].detail).toContain("DROPPED this table");
    // There is nowhere to apply them and cutover output gets pasted into
    // run logs, so the finding carries no row and no key.
    expect(JSON.stringify(conflicts[0])).not.toContain("arrived since");
  });

  it("says so plainly when the manifest has no record of the table either", () => {
    const { conflicts } = classifyAgainstManifestOnly({
      table: "unknown",
      cols,
      key,
      rows: [{ id: 1, value: "a" }],
      wasSeen: null,
    });
    expect(conflicts.map((c) => c.kind)).toEqual(["no record"]);
  });

  it("does not fail a reconciliation verdict, which would end the weekly run", () => {
    const srcD = new Map([
      ["dropped_by_migration", { digest: "aaaa", count: 1 }],
    ]);
    expect(
      verdictProblems({ srcD, dstD: new Map(), reconciling: true }),
    ).toEqual([]);
  });

  it("still fails a MIRROR verdict, where it means the carry did not finish", () => {
    const srcD = new Map([["t", { digest: "aaaa", count: 1 }]]);
    const problems = verdictProblems({
      srcD,
      dstD: new Map(),
      reconciling: false,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("absent from the destination");
  });
});

describe("the source-moved check answers a question about the SOURCE", () => {
  // It sat at the end of an else-if chain whose every other branch is a
  // statement about the destination, so any destination-side finding
  // suppressed it — including a table the destination has dropped, which
  // is precisely a table whose late writes are all that is left to look
  // for (#2267 r40, found in self-review).
  const d = (digest: string, count: number) => ({ digest, count });

  it("fires for a table the destination has dropped", () => {
    const problems = verdictProblems({
      srcD: new Map([["dropped_by_migration", d("now", 4)]]),
      dstD: new Map(),
      reconciling: true,
      classifiedSource: new Map([["dropped_by_migration", "when-classified"]]),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("CHANGED while this run was working");
  });

  it("fires alongside a destination-side finding rather than instead of it", () => {
    const problems = verdictProblems({
      srcD: new Map([["t", d("now", 9)]]),
      dstD: new Map([["t", d("other", 2)]]),
      reconciling: true,
      classifiedSource: new Map([["t", "when-classified"]]),
    });
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("rows are still missing");
    expect(problems.join("\n")).toContain("CHANGED while this run was working");
  });

  it("stays quiet when the source read the same both times", () => {
    expect(
      verdictProblems({
        srcD: new Map([["t", d("same", 2)]]),
        dstD: new Map([["t", d("whatever", 5)]]),
        reconciling: true,
        classifiedSource: new Map([["t", "same"]]),
      }),
    ).toEqual([]);
  });
});

describe("a uniqueness this tool cannot reproduce is named, not simplified", () => {
  // `PRAGMA index_info` answers with bare column names, which discards
  // three things that change what the index actually rejects. Both
  // readings used here — `index_xinfo`'s per-term collation and
  // `index_list`'s `partial` — were verified against the live D1 before
  // being relied on (#2267 r41).
  const term = (name: string | null, coll = "BINARY") => ({
    name,
    coll,
    key: 1,
  });

  it("passes an ordinary index", () => {
    expect(
      unsupportedUniqueReason({ partial: 0 }, [term("dedup_key")]),
    ).toBeNull();
  });

  it("names a partial index, which constrains only some rows", () => {
    // Treating it as total invents collisions the destination would not
    // raise — the inverse of the collation error below.
    expect(unsupportedUniqueReason({ partial: 1 }, [term("x")])).toContain(
      "PARTIAL",
    );
  });

  it("names an expression index rather than dropping the term", () => {
    // This is the one that was actively wrong before: the old filter
    // dropped nameless terms and KEPT the rest, turning a two-term index
    // into a one-term index and reporting collisions on the wrong tuple.
    expect(
      unsupportedUniqueReason({ partial: 0 }, [term("tenant"), term(null)]),
    ).toContain("EXPRESSION");
  });

  it("names a collation, under which two values this tool separates are one row", () => {
    const why = unsupportedUniqueReason({ partial: 0 }, [
      term("name", "NOCASE"),
    ]);
    expect(why).toContain("NOCASE");
    expect(why).toContain("the same row");
  });

  it("is not fooled by the spelling of BINARY", () => {
    expect(
      unsupportedUniqueReason({ partial: 0 }, [term("x", "binary")]),
    ).toBeNull();
  });
});

describe("an unusable index that merely restates the primary key", () => {
  // Not worth reporting: the primary key is already how rows are
  // matched. But the test for "restates the key" has to look at EVERY
  // term, and `columns` is the named subset — so an expression index
  // whose named part happens to equal the key would be dropped on a
  // partial list, which is the same mistake this change exists to fix
  // (self-review, #2267 r41).
  const term = (name: string | null, coll = "BINARY") => ({
    name,
    coll,
    key: 1,
  });

  it("is still reported when one of its terms is an expression", () => {
    // UNIQUE(id, lower(email)) on a table keyed by id: the named subset
    // is exactly ['id'], but the index is not the key.
    const terms = [term("id"), term(null)];
    const named = terms.map((t) => t.name).filter((n) => typeof n === "string");
    expect(named.join()).toBe("id");
    expect(named.length === terms.length).toBe(false);
    expect(unsupportedUniqueReason({ partial: 0 }, terms)).toContain(
      "EXPRESSION",
    );
  });
});

describe("a live side is read without being asked to hold still", () => {
  // The two-pass gate is right for a mirror's SOURCE, which is supposed
  // to be stopped. Pointed at the weekly reconciliation's destination it
  // asks a database taking writes every minute to stop, which the
  // runbook explicitly does not do — so a busy paged table would abort
  // the run and tell the operator to close a barrier that should not
  // exist (#2267 r42).
  const PAGE = 500;
  const rowsOf = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      id: from + i,
      value: `v${from + i}`,
    }));

  it("pages by key, so a delete on an earlier page cannot hide a later row", async () => {
    // This is the failure the gate existed to catch, and the reason the
    // fix is a different read rather than the same read with the check
    // switched off. Under OFFSET paging, deleting a row from page one
    // shifts every later row up by one and the row at the page boundary
    // is never returned.
    const live = new Map(rowsOf(1, PAGE + 3).map((r) => [r.id as number, r]));
    const seen: string[] = [];
    const run = async (_db: string, sql: string, params: unknown[] = []) => {
      seen.push(sql);
      expect(sql).not.toContain("OFFSET");
      const after = params.length > 0 ? Number(params[0]) : 0;
      const rows = [...live.values()]
        .filter((r) => (r.id as number) > after)
        .slice(0, PAGE);
      // A writer deletes the first row between pages, which is exactly
      // what shifts an OFFSET window.
      if (seen.length === 1) live.delete(1);
      return rows;
    };
    const out = await readAll("db", "t", ["id", "value"], run, {
      key: ["id"],
      live: true,
    });
    const ids = out.map((r: Record<string, unknown>) => r.id);
    // Every row that was present for the whole read is returned exactly
    // once — including the ones straddling the page boundary.
    for (const id of [PAGE, PAGE + 1, PAGE + 2, PAGE + 3])
      expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not abort when the live side keeps changing", async () => {
    // The same input aborts the gated read after three disagreements.
    let n = 0;
    const run = async (_db: string, _sql: string, params: unknown[] = []) => {
      const after = params.length > 0 ? Number(params[0]) : 0;
      n += 1;
      return rowsOf(after + 1, after + PAGE).slice(
        0,
        after >= PAGE * 2 ? 1 : PAGE,
      );
    };
    const out = await readAll("db", "t", ["id", "value"], run, {
      key: ["id"],
      live: true,
    });
    expect(out.length).toBeGreaterThan(PAGE);
    expect(n).toBeGreaterThan(1);
  });

  it("refuses a live read with no key rather than paging by OFFSET without a gate", async () => {
    // Without a key the only paging available is OFFSET, which a
    // concurrent DELETE tears silently — the precise failure the gate
    // catches, with the gate turned off. The tool reports and exits, so
    // the assertion is on both: it stopped, and it said why.
    const said: string[] = [];
    const err = vi
      .spyOn(console, "error")
      .mockImplementation((m) => said.push(String(m)));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);
    try {
      await expect(
        readAll("db", "t", ["id"], async () => [], { key: null, live: true }),
      ).rejects.toThrow("exited");
      expect(said.join("\n")).toContain("without a key to page by");
    } finally {
      err.mockRestore();
      exit.mockRestore();
    }
  });
});

describe("the cursor must be unique in the database being READ", () => {
  // Paging and matching are two different jobs, and one key was doing
  // both. The cursor has to be unique where it is used to page, or rows
  // are skipped — and the source's key is exactly what a re-keying
  // migration may have stopped being unique on the destination. Two rows
  // sharing an old key across a page boundary would be read as one, so
  // the duplicate check that exists to catch that migration would have
  // nothing to catch (#2267 r43).
  const PAGE = 500;

  it("reads both duplicates when paging by a key that is unique there", async () => {
    // The destination was re-keyed: `old_key` now repeats, `id` does not.
    // Rows 500 and 501 share old_key 500, straddling the page boundary.
    const rows = Array.from({ length: PAGE + 2 }, (_, i) => ({
      id: i + 1,
      old_key: i + 1 === PAGE + 1 ? PAGE : i + 1,
    }));
    const byOldKey = async (
      _db: string,
      _sql: string,
      params: unknown[] = [],
    ) => {
      const after = params.length > 0 ? Number(params[0]) : 0;
      return rows.filter((r) => r.old_key > after).slice(0, PAGE);
    };
    const byId = async (_db: string, _sql: string, params: unknown[] = []) => {
      const after = params.length > 0 ? Number(params[0]) : 0;
      return rows.filter((r) => r.id > after).slice(0, PAGE);
    };
    const viaOldKey = await readAll("db", "t", ["id", "old_key"], byOldKey, {
      key: ["old_key"],
      live: true,
    });
    const viaId = await readAll("db", "t", ["id", "old_key"], byId, {
      key: ["id"],
      live: true,
    });
    // Paging by the non-unique key loses the second duplicate: the
    // cursor moves past 500 and `> 500` never returns the other row.
    expect(viaOldKey.length).toBeLessThan(rows.length);
    expect(
      viaOldKey.filter((r: Record<string, unknown>) => r.old_key === PAGE),
    ).toHaveLength(1);
    // Paging by the destination's own key returns both, so the
    // duplicate check downstream can see them.
    expect(viaId).toHaveLength(rows.length);
    expect(
      viaId.filter((r: Record<string, unknown>) => r.old_key === PAGE),
    ).toHaveLength(2);
  });
});

describe("a destination out of the comparison is not a question dropped", () => {
  // Two situations put the destination out of reach — a migration
  // dropped the table, or dropped the key this run needs to read it
  // coherently while live — and both still leave the source and the
  // manifest, which is where a late write actually shows up. The keyless
  // case used to skip the table entirely, so the run printed a note and
  // then said VERIFIED having not looked (#2267 r44).
  const seenOf = (rows: Record<string, unknown>[]) => {
    const w: Record<string, string> = {};
    for (const r of rows) w[k(r.id as number)] = hashOf(r);
    return w;
  };

  it("reports the late write, and says which situation the operator is in", () => {
    const { conflicts } = classifyAgainstManifestOnly({
      table: "lost_its_key",
      cols,
      key,
      rows: [{ id: 1, value: "changed since" }],
      wasSeen: seenOf([{ id: 1, value: "as mirrored" }]),
      why:
        "the destination still HAS this table but has dropped its primary " +
        "key, so its rows cannot be read coherently while it is live",
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].detail).toContain(
      "0 row(s) added, 1 changed and 0 DELETED",
    );
    expect(conflicts[0].detail).toContain("dropped its primary key");
    // The two situations are different facts about what to do next, so
    // the wording must not claim the table is gone when it is not.
    expect(conflicts[0].detail).not.toContain("DROPPED this table");
  });
});

describe("a deletion on the source is a late write too", () => {
  // Iterating the source's CURRENT rows can never see one: the row is in
  // no row at all, only the manifest remembers it. It matters most in
  // exactly the case that reaches this classifier — a destination whose
  // key was dropped still HOLDS the row, so a deletion the source made
  // for a retention or privacy reason has not happened there, and the
  // one report that would have said so said nothing (#2267 r45).
  const seenOf = (rows: Record<string, unknown>[]) => {
    const w: Record<string, string> = {};
    for (const r of rows) w[k(r.id as number)] = hashOf(r);
    return w;
  };

  it("counts a manifest key the source no longer has", () => {
    const { conflicts } = classifyAgainstManifestOnly({
      table: "telegram_links",
      cols,
      key,
      rows: [],
      wasSeen: seenOf([{ id: 1, value: "deleted since, for a reason" }]),
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].detail).toContain("1 DELETED");
    expect(conflicts[0].detail).toContain(
      "may still be undone on the destination",
    );
  });

  it("still says nothing when the source has not moved at all", () => {
    const rows = [{ id: 1, value: "as mirrored" }];
    expect(
      classifyAgainstManifestOnly({
        table: "t",
        cols,
        key,
        rows,
        wasSeen: seenOf(rows),
      }).conflicts,
    ).toEqual([]);
  });

  it("counts all three kinds together", () => {
    const { conflicts } = classifyAgainstManifestOnly({
      table: "t",
      cols,
      key,
      rows: [
        { id: 1, value: "changed since" },
        { id: 3, value: "arrived since" },
      ],
      wasSeen: seenOf([
        { id: 1, value: "as mirrored" },
        { id: 2, value: "gone since" },
      ]),
    });
    expect(conflicts[0].detail).toContain(
      "1 row(s) added, 1 changed and 1 DELETED",
    );
  });
});

describe("a count comparison assumes the two sides were lined up", () => {
  // For a table whose rows were never matched — the destination dropped
  // its table, its key, or the columns this run matches by — putting the
  // two row counts side by side is not evidence of anything. A migration
  // that re-keyed and filtered, or a retention cron since, leaves the
  // destination legitimately holding fewer, and reading that as "rows
  // are still missing" fails the weekly run every week over a difference
  // the run has already said it cannot interpret (#2267 r46).
  const d = (digest: string, count: number) => ({ digest, count });

  it("does not read a smaller destination as missing rows when nothing was matched", () => {
    expect(
      verdictProblems({
        srcD: new Map([["rekeyed", d("aaa", 40)]]),
        dstD: new Map([["rekeyed", d("bbb", 12)]]),
        reconciling: true,
        manifestOnly: new Set(["rekeyed"]),
      }),
    ).toEqual([]);
  });

  it("still reads it as missing rows for a table that WAS matched", () => {
    const problems = verdictProblems({
      srcD: new Map([["ordinary", d("aaa", 40)]]),
      dstD: new Map([["ordinary", d("bbb", 12)]]),
      reconciling: true,
      manifestOnly: new Set(["rekeyed"]),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("rows are still missing");
  });

  it("does not suppress the source-moved check for such a table", () => {
    // Suppressing the count comparison must not suppress the question
    // about the SOURCE, which is answerable for every table.
    const problems = verdictProblems({
      srcD: new Map([["rekeyed", d("now", 40)]]),
      dstD: new Map([["rekeyed", d("bbb", 12)]]),
      reconciling: true,
      manifestOnly: new Set(["rekeyed"]),
      classifiedSource: new Map([["rekeyed", "when-classified"]]),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("CHANGED while this run was working");
  });
});

describe("the manifest survives a failed write", () => {
  // It is the ONLY baseline a later reconciliation and the documented
  // rollback have, and the runbook promises in as many words that a
  // failed mirror leaves the last good one intact. `writeFileSync` opens
  // for truncation first, so an interrupted write destroyed the previous
  // manifest and left an incomplete one in its place (#2267 r47).
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  const src = { name: "vaipakam-archive", id: "abc" };

  it("leaves the previous one untouched when the write fails", () => {
    const path = join(dir, "cutover-mirror.json");
    writeManifest(path, src, {
      t: { key: ["id"], cols: ["id"], seq: 0, rows: {} },
    });
    const good = readFileSync(path, "utf8");

    // THE FAILURE HAS TO HAPPEN AFTER THE FILE IS OPENED, or the test
    // proves nothing. A value JSON cannot serialise was the first thing
    // written here and it throws BEFORE any write — passing whether or
    // not the fix exists, which is the inert-test shape this PR has
    // already been caught by twice.
    //
    // So the temporary path is made unwritable for real: the name is
    // deterministic, so creating a DIRECTORY there makes the write fail
    // with EISDIR at exactly the point a full disk would.
    const tmp = `${path}.tmp-${process.pid}`;
    mkdirSync(tmp);
    try {
      expect(() =>
        writeManifest(path, src, {
          t: { key: ["id"], cols: ["id"], seq: 9, rows: {} },
        }),
      ).toThrow();
      // The promise the runbook makes: the last good baseline is still
      // there, byte for byte.
      expect(readFileSync(path, "utf8")).toBe(good);
      expect(JSON.parse(good).tables.t.seq).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("replaces it completely when the write succeeds", () => {
    const path = join(dir, "second.json");
    writeManifest(path, src, {
      a: { key: ["id"], cols: ["id"], seq: 1, rows: {} },
    });
    writeManifest(path, src, {
      b: { key: ["id"], cols: ["id"], seq: 2, rows: {} },
    });
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(doc.tables)).toEqual(["b"]);
    // 0600 holds across the rename, not only on first creation.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  // #2281 r8 — the reconstruction's refusal to replace has to hold at
  // the moment of WRITING, not at a check taken minutes earlier. This
  // is the state the manifest verb is actually in when it finishes: it
  // found the path free, then read a remote database, and by now
  // somebody has restored the original.
  it("refuses to replace a file that appeared during the read", () => {
    const path = join(dir, "appeared.json");
    const original = '{"the":"original manifest, restored from a backup"}\n';
    writeFileSync(path, original);
    expect(() =>
      writeManifest(
        path,
        src,
        { t: { key: ["id"], cols: ["id"], seq: 7, rows: {} } },
        null,
        { noReplace: true },
      ),
    ).toThrow();
    // Byte for byte: the reconstruction was not written, and neither
    // was a half of it.
    expect(readFileSync(path, "utf8")).toBe(original);
    // And nothing is left behind to be mistaken for a manifest later.
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
  });

  it("still writes when the path is free", () => {
    const path = join(dir, "free.json");
    writeManifest(
      path,
      src,
      { t: { key: ["id"], cols: ["id"], seq: 7, rows: {} } },
      null,
      { noReplace: true },
    );
    expect(JSON.parse(readFileSync(path, "utf8")).tables.t.seq).toBe(7);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
  });
});

describe("one manifest shape, however it was taken", () => {
  // There are two producers of a baseline now — the mirror, and the
  // read-only `manifest` verb — and a baseline whose shape depends on
  // which verb wrote it is one the reconciliation cannot read. Both go
  // through this, so they cannot drift apart (#2281).
  it("carries exactly the four fields the reconciliation reads", () => {
    const e = manifestEntry({
      key: ["id"],
      cols: ["id", "value"],
      seq: 7,
      rows: { a: "h" },
    });
    expect(Object.keys(e).sort()).toEqual(["cols", "key", "rows", "seq"]);
    expect(e).toEqual({
      key: ["id"],
      cols: ["id", "value"],
      seq: 7,
      rows: { a: "h" },
    });
  });

  it("keeps a known-zero baseline distinct from an unknown one", () => {
    // ZERO AND NULL MEAN DIFFERENT THINGS: a table that has never
    // allocated has a KNOWN baseline of zero, while null means unknown
    // and the sequence comparison skips it. A straggler inserting and
    // then deleting the FIRST row of a table is exactly the case that
    // distinction catches, so the entry must not normalise one to the
    // other.
    expect(
      manifestEntry({ key: ["id"], cols: ["id"], seq: 0, rows: {} }).seq,
    ).toBe(0);
    expect(
      manifestEntry({ key: ["id"], cols: ["id"], seq: null, rows: {} }).seq,
    ).toBeNull();
  });

  it("is what the sequence comparison reads a baseline through", () => {
    // A zero baseline is compared; a null one is skipped. Pinned here
    // because it is the reason the previous case matters.
    const known = {
      t: manifestEntry({ key: ["id"], cols: ["id"], seq: 0, rows: {} }),
    };
    const unknown = {
      t: manifestEntry({ key: ["id"], cols: ["id"], seq: null, rows: {} }),
    };
    expect(compareSequences(new Map([["t", 3]]), known)).toHaveLength(1);
    expect(compareSequences(new Map([["t", 3]]), unknown)).toEqual([]);
  });
});

describe("a baseline says which kind of baseline it is", () => {
  // A manifest the MIRROR wrote observes the moment it describes. One
  // taken afterwards observes a LATER moment and only stands in for the
  // earlier one — and which of the two a reader holds changes what the
  // contents mean. Leaving that to a run log kept elsewhere is a
  // recovery artifact making a claim about itself that may be false
  // (#2281 r1).
  const dir = mkdtempSync(join(tmpdir(), "provenance-"));
  const src = { name: "vaipakam-archive", id: "abc" };
  const tables = {
    t: manifestEntry({ key: ["id"], cols: ["id"], seq: 0, rows: {} }),
  };

  it("records a mirror as observing its own moment", () => {
    const path = join(dir, "mirror.json");
    writeManifest(path, src, tables);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.provenance.producer).toBe("carry --mirror");
    expect(doc.provenance.standsFor).toBeNull();
  });

  it("records a reconstruction with the claim it was taken under", () => {
    const path = join(dir, "reconstructed.json");
    writeManifest(path, src, tables, {
      producer: "manifest (reconstructed)",
      observes: "vaipakam-archive as read at the time below",
      standsFor: "the 19:56 mirror; digests at 19:40 and 19:51 identical",
    });
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.provenance.producer).toBe("manifest (reconstructed)");
    expect(doc.provenance.standsFor).toContain("19:56 mirror");
    // The artifact carries both times: when it was read, and what it is
    // claimed to stand for. A reader needs the pair to know what an
    // absence of findings means.
    expect(doc.takenAt).toBeTruthy();
  });
});

describe("a reconstructed baseline says whether it covers the gap", () => {
  // `--stands-for` is prose for a human, and prose cannot gate anything.
  // Whether the evidence COVERS the interval since the mirror decides
  // whether a clean reconciliation may license the rollback's reverse
  // mirror — a destructive step — so it is recorded as a value (#2281 r2).
  const dir = mkdtempSync(join(tmpdir(), "interval-"));
  const src = { name: "vaipakam-archive", id: "abc" };
  const tables = {
    t: manifestEntry({ key: ["id"], cols: ["id"], seq: 0, rows: {} }),
  };

  it("records the verdict and the bounds of the read, not the file-write time", () => {
    // `takenAt` is stamped when the artifact is written, AFTER the last
    // read — so a transaction committing in between precedes it and is
    // absent from the baseline. A claim phrased against `takenAt` would
    // say the opposite of what the file holds.
    const path = join(dir, "m.json");
    writeManifest(path, src, tables, {
      producer: "manifest (reconstructed)",
      readStartedAt: "2026-09-21T21:20:41.857Z",
      readCompletedAt: "2026-09-21T21:22:09.483Z",
      observes: "vaipakam-archive as read between the two times above",
      standsFor: "the 19:56 mirror",
      interval: "uncovered",
    });
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.provenance.interval).toBe("uncovered");
    expect(doc.provenance.readStartedAt).toBe("2026-09-21T21:20:41.857Z");
    expect(doc.provenance.readCompletedAt).toBe("2026-09-21T21:22:09.483Z");
    expect(new Date(doc.takenAt).getTime()).toBeGreaterThanOrEqual(
      new Date(doc.provenance.readCompletedAt).getTime(),
    );
  });

  it("leaves a mirror carrying no interval, because it has no gap to cover", () => {
    const path = join(dir, "mirror.json");
    writeManifest(path, src, tables);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.provenance.producer).toBe("carry --mirror");
    expect(doc.provenance.interval).toBeUndefined();
  });
});

describe("coverage is checked, not asserted", () => {
  // An earlier revision took `--interval covered` on the command that
  // TAKES the baseline — persisting the claim before printing the
  // digests meant to substantiate it, so no operator could have compared
  // anything at the moment the artifact said "covered" (#2281 r3).
  // Reconstructions are now always written uncovered and promoted only
  // by a comparison.
  const entry = (digest: string, seq: number) =>
    manifestEntry({ key: ["id"], cols: ["id"], seq, rows: {}, digest });

  it("reads the digest command own output as evidence", () => {
    const e = parseEvidence(
      [
        "  notifications                        38  8f7df07287a4c8e3",
        "  telegram_links                        0  e3b0c44298fc1c14",
        "  seq notifications                46",
        "  seq-listing complete",
      ].join("\n"),
    );
    expect(e.digests.get("notifications")).toBe("8f7df07287a4c8e3");
    expect(e.seqs.get("notifications")).toBe(46);
    expect(e.seqListingComplete).toBe(true);
  });

  it("promotes nothing when the rows agree but the sequence moved", () => {
    // THE CASE THAT MAKES ROWS INSUFFICIENT: a straggler inserts an
    // AUTOINCREMENT row after the mirror and deletes it again. Every row
    // digest and count still matches, and the high-water mark has moved
    // — so a reconstruction absorbs the moved value, and promoting on
    // row evidence alone would make the sequence check treat the late
    // allocation as original.
    const tables = { notifications: entry("8f7df07287a4c8e3", 47) };
    const evidence = parseEvidence(
      "notifications 8f7df07287a4c8e3\nseq notifications 46\nseq-listing complete",
    );
    const problems = coverageProblems(tables, evidence);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("sequence 46");
    expect(problems[0]).toContain("allocated in between");
  });

  it("will not read a missing sequence line as zero unless the listing says it is whole", () => {
    // Absence is ambiguous — "never allocated" and "not pasted in" look
    // identical — and `cover` must not guess between them.
    const tables = { t: entry("aaaaaaaaaaaaaaaa", 0) };
    const partial = parseEvidence("t aaaaaaaaaaaaaaaa");
    expect(coverageProblems(tables, partial)[0]).toContain(
      "does not say the listing is complete",
    );

    const whole = parseEvidence("t aaaaaaaaaaaaaaaa\nseq-listing complete");
    expect(coverageProblems(tables, whole)).toEqual([]);
  });

  it("refuses a table the evidence never mentions, in either direction", () => {
    const tables = {
      a: entry("aaaaaaaaaaaaaaaa", 0),
      b: entry("bbbbbbbbbbbbbbbb", 0),
    };
    const evidence = parseEvidence("a aaaaaaaaaaaaaaaa\nseq-listing complete");
    expect(coverageProblems(tables, evidence)[0]).toContain(
      "records no digest",
    );

    const extra = parseEvidence(
      "a aaaaaaaaaaaaaaaa\nb bbbbbbbbbbbbbbbb\nc cccccccccccccccc\nseq-listing complete",
    );
    expect(coverageProblems(tables, extra)[0]).toContain(
      "and this baseline does not",
    );
  });

  it("cannot promote a baseline that recorded no digest of its own", () => {
    const tables = {
      t: manifestEntry({ key: ["id"], cols: ["id"], seq: 0, rows: {} }),
    };
    const evidence = parseEvidence("t aaaaaaaaaaaaaaaa\nseq-listing complete");
    expect(coverageProblems(tables, evidence)[0]).toContain(
      "records no digest",
    );
  });
});

describe("a run log holds several readings, and they may disagree", () => {
  // The documented barrier takes two digests ten minutes apart and a
  // third after the carry, so pasting the log into --expect means
  // repeated table names. Taking the LAST silently prefers the reading
  // that agrees with the reconstruction — backwards, when a straggler
  // changed a row during the mirror: the earlier reading differs, the
  // later one matches, and coverage would be granted over the top of the
  // recorded disagreement (#2281 r4).
  const entry = (digest: string, seq: number) =>
    manifestEntry({ key: ["id"], cols: ["id"], seq, rows: {}, digest });

  it("accepts identical repeats, which is what a clean barrier produces", () => {
    const e = parseEvidence(
      ["t 1111111111111111", "t 1111111111111111", "seq-listing complete"].join(
        "\n",
      ),
    );
    expect(e.conflicts).toEqual([]);
    expect(coverageProblems({ t: entry("1111111111111111", 0) }, e)).toEqual(
      [],
    );
  });

  it("refuses when two readings of the same table disagree", () => {
    const e = parseEvidence(
      ["t 1111111111111111", "t 2222222222222222", "seq-listing complete"].join(
        "\n",
      ),
    );
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0]).toContain("two different digest readings");
    // And it refuses even against the reading that WOULD have matched —
    // which is the whole point: the disagreement is itself evidence.
    const problems = coverageProblems({ t: entry("2222222222222222", 0) }, e);
    expect(
      problems.some((p: string) => p.includes("two different digest readings")),
    ).toBe(true);
  });

  it("refuses disagreeing sequence readings inside one listing", () => {
    const e = parseEvidence(
      ["seq t 46", "seq t 47", "seq-listing complete"].join("\n"),
    );
    expect(e.conflicts[0]).toContain("one sequence listing gives it twice");
  });

  it("refuses disagreeing sequence readings ACROSS listings", () => {
    const e = parseEvidence(
      [
        "t 1111111111111111",
        "seq t 46",
        "seq-listing complete",
        "t 1111111111111111",
        "seq t 47",
        "seq-listing complete",
      ].join("\n"),
    );
    expect(e.conflicts[0]).toContain("two different sequence readings");
    expect(e.seqs.has("t")).toBe(false);
  });

  it("reads an absence in a COMPLETE listing as zero, and a later value as a conflict", () => {
    // THE CASE A GLOBAL FLAG DESTROYED (#2281 r5). A first complete
    // listing with no line for `t` says its sequence is zero. A later
    // listing saying `seq t 1` is the log PROVING an allocation
    // happened in between. Flattened into one map that parsed as the
    // single value 1, with nothing to disagree with — so a
    // reconstruction sitting at 1 passed, on evidence that contained
    // the proof it should not.
    const e = parseEvidence(
      [
        "t 1111111111111111",
        "seq-listing complete",
        "t 1111111111111111",
        "seq t 1",
        "seq-listing complete",
      ].join("\n"),
    );
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0]).toContain("Something allocated between them");
    expect(
      coverageProblems({ t: entry("1111111111111111", 1) }, e).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a table the evidence knows about and the baseline does not, by sequence alone", () => {
    // The digest line may simply be missing from a cropped paste. A
    // sequence line still says the mirror held state this
    // reconstruction does not represent — and checking only the digest
    // side let an empty baseline pass with no findings at all.
    const e = parseEvidence(["seq t 1", "seq-listing complete"].join("\n"));
    const problems = coverageProblems({}, e);
    expect(problems.length).toBeGreaterThan(0);
    expect(
      problems.some((p: string) => p.includes("this baseline does not")),
    ).toBe(true);
  });
});

describe("a table set that changed is evidence too", () => {
  // A complete run's digest section ends with the rule-and-count line
  // `printDigest` prints — that line is what makes the run a reading of
  // the TABLE SET, and it is printed even when the count is zero.
  const run = (...tables: string[]) => [
    ...tables,
    `${"\u2014".repeat(8)}   0  (${tables.length} tables)`,
    "seq-listing complete",
  ];

  // The sequence side learned this a round earlier; the digest side had
  // the same hole. A table created between two recorded runs is absent
  // from the first complete output and present in the second — one
  // digest, no disagreement, a clean comparison — while the log records
  // that the database gained a table in the window (#2281 r6).
  it("refuses when a table appears in only some complete readings", () => {
    const e = parseEvidence(
      [
        ...run("a 1111111111111111"),
        ...run("a 1111111111111111", "b 2222222222222222"),
      ].join("\n"),
    );
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0]).toContain("missing from 1 of");
    expect(e.conflicts[0]).toContain("a database that");
  });

  it("accepts a table present in every complete reading", () => {
    const e = parseEvidence(
      [...run("a 1111111111111111"), ...run("a 1111111111111111")].join("\n"),
    );
    expect(e.conflicts).toEqual([]);
  });

  it("says nothing about table sets when there is only one reading", () => {
    // One output cannot disagree with itself about which tables exist.
    const e = parseEvidence(run("a 1111111111111111").join("\n"));
    expect(e.conflicts).toEqual([]);
  });

  // #2281 r7 — the same table arriving mid-log, one door over. The r6
  // check compared complete readings against each other, so a table
  // whose ONLY appearance is in the unterminated tail was seen in zero
  // of them and skipped. The log still proves it was there after a
  // reading that says it was not.
  it("refuses a table named only after the last complete reading", () => {
    const e = parseEvidence(
      [
        ...run("a 1111111111111111"),
        "a 1111111111111111",
        "b 2222222222222222",
      ].join("\n"),
    );
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0]).toContain("b:");
    expect(e.conflicts[0]).toContain("missing from 1 of");
  });

  it("refuses when the tail names a new table only in a sequence line", () => {
    // A sequence line is a positive appearance too: `sqlite_sequence`
    // loses a table's row when the table is dropped, so a line for `b`
    // says `b` was there when it was written.
    const e = parseEvidence(
      [...run("a 1111111111111111"), "a 1111111111111111", "seq b 5"].join(
        "\n",
      ),
    );
    // The sequence check independently reports `b` as 0-then-5, which
    // is a second true statement about the same table. What this test
    // pins is the TABLE-SET one, because that is the fact the sequence
    // check cannot make on its own: a table with no allocations at all
    // would arrive in the tail with no sequence line to disagree with.
    expect(e.conflicts.some((c) => c.includes("missing from 1 of"))).toBe(true);
  });

  it("accepts a tail that names only tables the readings already had", () => {
    const e = parseEvidence(
      [...run("a 1111111111111111"), "a 1111111111111111"].join("\n"),
    );
    expect(e.conflicts).toEqual([]);
  });

  it("does not treat a sequence-only complete listing as an empty table set", () => {
    // A listing with no digest section at all did not read the table
    // set. Counting it as one would report every table in the database
    // as missing from it.
    const e = parseEvidence(
      [
        "seq a 5",
        "seq-listing complete",
        "a 1111111111111111",
        `${"—".repeat(8)}   0  (1 tables)`,
        "seq a 5",
        "seq-listing complete",
      ].join("\n"),
    );
    expect(e.conflicts).toEqual([]);
  });

  // #2281 r8 — an EMPTY enumeration is still an enumeration. A real
  // complete run over a database with no tables prints `(0 tables)`,
  // and discarding it as though its digest section had merely been
  // omitted left a later run as the only enumeration — so a table that
  // demonstrably appeared between the two stopped being a conflict, and
  // a matching reconstruction could be marked covered.
  it("keeps a complete reading that enumerated zero tables", () => {
    const e = parseEvidence(
      [...run(), ...run("b 2222222222222222")].join("\n"),
    );
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0]).toContain("b:");
    expect(e.conflicts[0]).toContain("2 complete reading(s)");
  });

  // The other half of the same rule: a digest section with no
  // rule-and-count line has not said it is whole, so what it does not
  // name is not a table that was absent — it may simply not have been
  // pasted.
  it("does not let a digest section without its count testify to absence", () => {
    const e = parseEvidence(
      [
        "a 1111111111111111",
        "seq-listing complete",
        ...run("a 1111111111111111", "b 2222222222222222"),
      ].join("\n"),
    );
    expect(e.conflicts).toEqual([]);
  });

  // #2281 r9 — the three boundaries. Rounds 5 through 9 each found
  // another way for one block structure, delimited by the sequence
  // marker, to answer three different questions wrongly.
  it("closes a digest reading at its count line, not at the sequence marker", () => {
    // The first run's count line survived the paste; its
    // `seq-listing complete` did not. Under one shared boundary the two
    // runs merged, the first declared count was overwritten, and `b`
    // arriving in the second run was invisible.
    const e = parseEvidence(
      [
        "a 1111111111111111",
        `${"\u2014".repeat(8)}   0  (1 tables)`,
        "a 1111111111111111",
        "b 2222222222222222",
        `${"\u2014".repeat(8)}   0  (2 tables)`,
        "seq-listing complete",
      ].join("\n"),
    );
    expect(e.conflicts.some((c) => c.includes("missing from 1 of"))).toBe(true);
  });

  it("counts appearances in a closed block that did not enumerate", () => {
    // The second block is closed by the sequence marker but carries no
    // count line, so it is not an enumeration — and it is not the tail
    // either. The tables it names are still named.
    const e = parseEvidence(
      [
        "a 1111111111111111",
        `${"\u2014".repeat(8)}   0  (1 tables)`,
        "seq-listing complete",
        "a 1111111111111111",
        "b 2222222222222222",
        "seq-listing complete",
      ].join("\n"),
    );
    expect(e.conflicts.some((c) => c.includes("missing from 1 of"))).toBe(true);
  });

  // THE VERB, not just the parser. The parser returning the right shape
  // proves nothing about whether `cover` accepts it, and the guard that
  // rejected this case lives in the verb (#2281 r9).
  it("promotes an empty reconstruction against empty-database evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "cover-empty-"));
    const manifest = join(dir, "reconstructed.json");
    const expected = join(dir, "evidence.txt");
    writeFileSync(
      manifest,
      JSON.stringify({
        source: { name: "vaipakam-archive", id: "abc" },
        takenAt: new Date().toISOString(),
        provenance: {
          producer: "manifest (reconstructed)",
          interval: "uncovered",
          standsFor: "a database with no tables",
        },
        tables: {},
      }),
    );
    // Exactly what `digest` prints over a source with no application
    // tables: a complete reading of an empty table set, and a complete
    // reading of an empty sequence table.
    writeFileSync(
      expected,
      `${"\u2014".repeat(8)}   0  (0 tables)\nseq-listing complete\n`,
    );
    const out = execFileSync(
      process.execPath,
      [
        new URL("../scripts/d1-carry-rows.mjs", import.meta.url).pathname,
        "cover",
        "--manifest",
        manifest,
        "--expect",
        expected,
      ],
      { encoding: "utf8" },
    );
    expect(out).toContain("COVERED");
    expect(JSON.parse(readFileSync(manifest, "utf8")).provenance.interval).toBe(
      "covered",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a database with no tables as a reading, not as silence", () => {
    // `digest` over a source carrying no application tables prints
    // exactly this. Both value maps come back empty, which is why the
    // count of closed readings is reported separately.
    const e = parseEvidence(
      [`${"\u2014".repeat(8)}   0  (0 tables)`, "seq-listing complete"].join(
        "\n",
      ),
    );
    expect(e.conflicts).toEqual([]);
    expect(e.digests.size).toBe(0);
    expect(e.readings.tableSets).toBe(1);
    expect(e.readings.sequences).toBe(1);
  });

  it("refuses a complete reading whose count does not match its lines", () => {
    // Pasted in part, with the summary line included: the count says
    // three tables and two are present, so the section is not a reading
    // of the table set either.
    const e = parseEvidence(
      [
        "a 1111111111111111",
        "b 2222222222222222",
        `${"\u2014".repeat(8)}   0  (3 tables)`,
        "seq-listing complete",
      ].join("\n"),
    );
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0]).toContain("declares 3 table(s) but carries 2");
  });
});

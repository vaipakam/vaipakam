RESEARCH NOTES — NOT LEGAL ADVICE — REVIEW WITH A LICENSED ATTORNEY BEFORE ACTING

> **Prior context:** This PIA follows the `use-case-triage` run on 2026-05-16,
> which classified the activity **PIA REQUIRED** (house trigger met; no mandatory
> GDPR DPIA; no policy conflict as of Privacy Policy v2). That severity is the floor.
>
> **Citation note:** No legal-research connector is configured, so every statutory
> citation below is tagged `[model knowledge — verify]` and must be checked against
> a primary source before anyone relies on it.

---

# Privacy Impact Assessment: Server-Side Error Capture

**Prepared by:** Vaipakam (operator) · assisted draft | **Date:** 2026-05-16 | **Status:** DRAFT
**Product owner:** Operator (solo) | **Privacy reviewer:** Operator — *counsel review recommended on §2 and §3*

> **Rev. 2026-05-17:** the ±5-entry journey-log slice (the §2.2 open
> question) is **descoped** — server capture is the single error
> record only. The fuller trail remains available solely via the
> consensual "Report on GitHub" path. This PIA and Privacy Policy v2
> are updated to match. Rationale: §2.2.

---

## Executive summary

Vaipakam will capture UI errors server-side (Cloudflare D1) to troubleshoot and
harden the app. Each record is a single wallet-keyed error event; records
auto-delete at 90 days. Processing is data-light,
pseudonymous, implemented in the diagnostics Worker, and now disclosed in Privacy
Policy v2. The legitimate-interest basis still needs the assessment in §2, and
that basis does **not cleanly carry to India's DPDP Act**. No blockers that can't
be cleared pre-launch; the remaining conditions in §8 are legal/rollout controls,
not build blockers for the existing capture path.

**Overall risk:** 🟡 **Medium** *(reviewer to confirm)* — low data sensitivity and
short retention, offset by the DPDP lawful-basis gap and a missing right-to-object
mechanism.

---

## 1. Description of processing

**What:** On a UI error (e.g. a reverted transaction, a failed oracle read), the
app posts an error report to a Cloudflare Worker endpoint, stored in Cloudflare D1.
**Data categories:** per-event UUID; redacted wallet (`0x…abcd`); error
type/name/selector; a truncated technical error message (machine-generated; no
user-typed free text); screen/flow/step; chain id; interface locale; theme;
viewport size; app version. One record per error event — **no** journey-log slice
(descoped, see the Rev. 2026-05-17 note and §2.2).
**Data subjects:** Vaipakam's end users (wallet-connecting), global.
**Purpose:** debugging, service reliability, security/fraud prevention.
**New collection?** Yes — error events were previously surfaced only in the
browser; server-side storage of the error record is net-new.

---

## 2. Lawful basis — and legitimate-interests assessment (LIA)

| Purpose | Basis | Notes |
|---|---|---|
| Server-side error capture | **Legitimate interest** — GDPR/UK GDPR Art. 6(1)(f) `[model knowledge — verify]` | LIA below |
| (CCPA/CPRA) | "Debugging to identify and repair errors" — enumerated **business purpose**, Cal. Civ. Code § 1798.140 `[model knowledge — verify]` | Favourable; no opt-out required for a business purpose |
| (India DPDP Act 2023) | **⚠️ Unresolved** | DPDP has no general legitimate-interest basis — see below |

**LIA (three-part test, GDPR Art. 6(1)(f)):**

1. **Purpose test — is the interest legitimate?** Yes. Keeping the app working,
   diagnosing failures, and detecting abuse are well-recognised legitimate interests.
2. **Necessity test — is the processing necessary?** Largely yes, and the design
   shows minimisation: a single error record (not a session trace), redacted
   wallet only, no IP/user-agent/free-form text, 90-day deletion. The ±5-entry
   journey-log slice that an earlier draft proposed was **deliberately descoped**
   (Rev. 2026-05-17): the single record — screen/flow/step plus the error
   type/name/selector/message — already locates the failure, and the deeper
   navigation trail remains available through the consensual "Report on GitHub"
   path, which carries it only when a user actively chooses to file. Capturing a
   navigation window for *every* error, without that choice, was not necessary.
3. **Balancing test — does it override users' interests/rights?** Probably yes,
   given the minimisation — but two things weaken it: (a) the data is pseudonymous,
   not anonymous (see Risk 4), and (b) an LI basis carries a right to object
   (Art. 21) that currently has no mechanism (see §6).

**India DPDP divergence — flagged for counsel.** DPDP 2023 runs on consent plus a
closed list of enumerated "legitimate uses"; troubleshooting/security is not an
obvious entry on that list. For India-resident users, this processing may need
consent or a different DPDP justification. The GDPR LIA does not dispose of this.
`[model knowledge — verify]`

---

## 3. Data flow

**Collection:** app → Cloudflare Worker endpoint, on each UI error.
**Storage:** Cloudflare D1. Cloudflare encrypts at rest by default; confirm D1
region/locality settings. `[verify]`
**Access:** the operator (solo), via Cloudflare account credentials. No other
internal access.
**Sharing:** none for third-party purposes. Cloudflare acts as **processor**
(review Cloudflare's DPA — `/privacy-legal:dpa-review`). The per-event UUID may
also appear in a GitHub issue the user files — the UUID alone is not personal data
without the D1 record, so this is low-risk, but note GitHub is then a recipient of
whatever the user pastes.
**Retention:** auto-deleted 90 days after capture. Wallet-keyed records can also
be erased by signed user request (see §6). Retention-override → §7.

---

## 4. Privacy policy consistency

| Policy commitment (Privacy Policy v2) | Consistent? | Notes |
|---|---|---|
| "Server-side error capture … pruned after 90 days" | 🟢 | v2 describes the implemented Worker + D1 capture path and retention prune |
| Truncated technical error message captured | 🟢 | Disclosed in v2 §"Server-side error capture" (Rev. 2026-05-17) |
| No journey-log slice in server capture | 🟢 | Slice descoped; v2 + this PIA updated to match (Rev. 2026-05-17) |
| Signed self-service erasure for D1 records | 🟢 | T-075 adds the wallet-signed erasure endpoint, keyed wallet hash, and legal-hold skip path |
| Legal basis stated as Art. 6(1)(f) legitimate interest | 🟡 | Stated in policy; the LIA backing it (§2) must exist before launch — and DPDP is unaddressed |
| "Delete my data" button = local only; D1 erasure via signed request | 🟢 | Disclosed; consistent with §6 |
| Plugin config `## Privacy policy commitments` | 🔴 | Stale — still records v1 ("browser-only, never uploaded"). Must be updated to v2. |

⚠️ The v2 policy text describes processing that exists in the Worker. Pre-live
rollout still depends on the legal and operational controls in §8 staying true
at launch.

---

## 5. Risks and mitigations

| # | Risk | L | I | Mitigation | Status | Owner |
|---|---|---|---|---|---|---|
| 1 | Policy v2 describes server-side capture, but the feature isn't built — at launch the policy misrepresents reality, or ships differing from the policy text | M | M | Build feature to match v2 text (D1, 90-day prune) before any real user; verify parity | Gap | Operator (dev) |
| 2 | India-resident users' data captured with no valid DPDP basis (no LI equivalent) | M | H | Confirm DPDP basis with counsel; if consent is needed, add a consent path or geo-scoped handling | Gap | Counsel |
| 3 | "Redacted" wallet + chain id + timestamps may be re-identifiable against public on-chain data — pseudonymous, not anonymous | M | M | Treat records as personal data (this PIA does); keep retention short; one minimal record per error, no navigation window | Planned | Operator |
| 4 | LI basis triggers a right to object (Art. 21) and an access/portability expectation, but the "Download my data" / objection flows don't reach D1 — erasure also depends on a support process a solo operator must actually staff | M | M | Add a way to object to / opt out of error capture, or document why infeasible; extend access + deletion to cover D1; confirm support intake works | Gap | Operator (dev) |

> The earlier draft's Risk on the journey-log slice ("a window of
> user navigation, broader than the error, users may not expect it")
> is **removed** — the slice is descoped (Rev. 2026-05-17), so the
> risk no longer exists rather than being merely mitigated.

**Residual risk after mitigations:** Low-to-Medium. The activity is inherently
low-sensitivity; residual risk concentrates in the DPDP basis question (Risk 2)
and the rights-mechanism gap (Risk 4).

---

## 6. Data subject rights

| Right | Can be exercised? | How |
|---|---|---|
| Access | 🟡 Partial | "Download my data" exports browser data; D1 records not covered — needs a support-routed access path |
| Deletion | 🟢 Yes for wallet-keyed records | Browser data via button; D1 error records via signed erasure request keyed by wallet HMAC; records under valid legal hold are skipped and 90-day auto-delete remains the backstop |
| Correction | 🟢 N/A in practice | Error logs are factual machine records; correction is not meaningful |
| Portability | 🟡 Partial | JSON export covers browser data only; D1 not included |
| Objection | 🔴 Gap | LI basis ⇒ Art. 21 right to object, but no mechanism to object to error capture specifically |

**Erasure (Art 17).** Users erase their own `diag_errors` records via a
signed-request endpoint; identity is a server-side keyed hash of the wallet
(`HMAC`, key never client-side). Records under a valid legal hold are skipped.
The erasure endpoint returns a uniform response and never enumerates retained
records; a separate signed status endpoint discloses retention only when an
operator has explicitly enabled disclosure for that wallet — gagged retention
orders are handled by leaving disclosure off.

---

## 7. Legal-hold / retention-override procedure

The 90-day auto-delete is the default. The policy's "unless legally required to
preserve" carve-out should operate as a narrow, reactive exception — not a standing
reason to keep data:

1. **Default = delete.** A deletion request, or the 90-day timer, removes the
   D1 records.
2. **Hold is the exception.** If, at the time of a request or scheduled purge,
   specific records are subject to an active legal preservation duty, those records
   are not deleted — they are placed on legal hold: segregated, access-restricted,
   used only for the legal purpose, and deleted the moment the hold lifts.
3. **Record-specific.** A hold on a few records does not justify retaining anything
   else.
4. **No pre-emptive retention.** A hold only binds records still held when it
   attaches; data already deleted need not be reconstructed.
5. **Inform the user** of a partial refusal of erasure and the reason — unless a
   confidentiality/gag obligation legally bars disclosure (fact-specific; counsel
   question).

Basis: the right to erasure is not absolute — GDPR Art. 17(3) (and the DPDP / CCPA
equivalents) carve out retention required by law. `[model knowledge — verify]` For
a pre-live solo project a legal hold on error logs will be rare; the value here is
having the procedure written down before it's ever needed.

---

## 8. Recommendation

**APPROVED WITH CONDITIONS** *(operator sign-off; counsel review recommended on §2
DPDP point and the LIA).*

Conditions before a real user touches the live app:

- [x] Confirm the implemented server-side capture matches Privacy Policy v2 (D1, 90-day prune; single error record, no journey-log slice) — *Operator (dev)*
- [ ] Confirm the India DPDP lawful basis with counsel; implement consent or geo-scoping if required — *Counsel*
- [ ] Have counsel review this LIA (§2) — *Counsel*
- [ ] Add a right-to-object / opt-out path for error capture, or document why it's infeasible; extend access to cover D1 records — *Operator (dev)*
- [ ] Sync `PrivacyPage.tsx`, verify the signed D1 erasure path works, announce v2 on Discord/X at launch — *Operator*
- [ ] Update the plugin config `## Privacy policy commitments` from v1 → v2 — *Operator / assistant*

**Sign-off:** _________________ (operator), date _______

*This is an internal PIA — it is not being submitted to a regulator, so no
regulator-submission gate applies.*

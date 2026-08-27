# The keeper's liquidation scan was never actually batching

The keeper checks every active loan's health factor on each pass. That scan
was written to ask for all of them together in one grouped request, with a
fall-back to asking one loan at a time if a chain could not support the
grouped form — described as a rare case.

The rare case was the only case. The grouped request was being rejected
immediately, before it ever left the Worker, because the connection it was
issued on carries no chain identity and the grouped-call helper needs to be
told explicitly where to send it. The scan then quietly did what it was
designed to do when grouping is unavailable: it fell back to asking for each
loan separately.

Nothing looked wrong from the outside. The pass still finished, still logged
its completion, and the only trace was a single error line that read like a
passing network blip. What it cost was one request per active loan, per
chain, on every pass — against a fixed per-invocation request budget. A busy
chain could exhaust that budget and leave the tail of its loan list unscanned.

The grouped request is now told where to send itself, so the scan batches as
intended. A test asserts the batched path actually runs and that no
one-at-a-time fallback happens.

The same defect had already been found and fixed in the reward-remittance
path; the address it needed now lives in one shared place rather than being
repeated, so a third caller cannot reintroduce it by copying an older call
site.

Issue: #1946

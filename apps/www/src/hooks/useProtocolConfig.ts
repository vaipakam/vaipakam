/**
 * Wallet-free stub for the marketing surface.
 *
 * The marketing site never reads governance-tunable knobs from the
 * chain — those numbers only matter on connected-app surfaces. The
 * one component that consumes this hook in labs (`<LiveValue>`,
 * inline-rendered in markdown content) treats a null config as
 * "fall back to the bundled compile-time default" for every knob.
 *
 * Typing `config` as `unknown` keeps the read functions in
 * `LiveValue`'s `KNOB_REGISTRY` type-safe (every read uses
 * `config?.<field> ?? defaultValue`, which is valid against
 * `unknown`'s optional-chaining) without requiring labs to
 * redefine the full ProtocolConfig shape.
 */
// `any` is intentional — `<LiveValue>`'s KNOB_REGISTRY read
// functions access governance-knob fields via optional chaining
// (`config?.treasuryFeeBps`, `config?.tierDiscountBps`, etc.) and
// fall back to compile-time defaults via `?? null`. Typing the
// stub config as `any` keeps those reads valid without forcing
// labs to re-declare the full ProtocolConfig shape from defi.
// At runtime, config is always null on the marketing surface and
// every read returns the bundled default — see LiveValue.tsx.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useProtocolConfig(): { config: any; loading: boolean } {
  return { config: null, loading: false };
}

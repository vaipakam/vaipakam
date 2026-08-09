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
export interface ProtocolConfigResult {
  // `any` is intentional — `<LiveValue>`'s KNOB_REGISTRY read
  // functions access governance-knob fields via optional chaining
  // (`config?.treasuryFeeBps`, `config?.tierDiscountBps`, etc.) and
  // fall back to compile-time defaults via `?? null`. Typing the
  // stub config as `any` keeps those reads valid without forcing
  // labs to re-declare the full ProtocolConfig shape from defi.
  // At runtime, config is always null on the marketing surface and
  // every read returns the bundled default — see LiveValue.tsx.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any;
  loading: boolean;
  /**
   * Whether this surface ATTEMPTS a chain read at all — declared, not
   * inferred (#1612).
   *
   * A consumer cannot tell "the read came back empty" from "no read was
   * ever made": both arrive as `config === null`. `<LiveValue>` used to
   * collapse them and told every reader of a public page that the figure
   * they hovered was a "chain read pending or unavailable" — describing a
   * transient failure, on a surface where nothing is pending and nothing
   * has failed. A reader was being shown a broken-looking mechanism that
   * does not exist here.
   *
   * `false` on the marketing site, and it is the honest value rather than
   * a temporary one: see the module comment above. Wire real reads and
   * this flips, without the consumer needing to change.
   */
  chainReads: boolean;
}

export function useProtocolConfig(): ProtocolConfigResult {
  return { config: null, loading: false, chainReads: false };
}

/**
 * How often the agent's scheduled tick does work (#2236).
 *
 * Its own module rather than an export of the Worker entry: a named export of
 * the main module is read by the runtime as a candidate entrypoint, so plain
 * values stay out of it.
 */

/** Minutes between the ticks that do work. See the note at the top of
 *  `scheduled()` in `index.ts` for why five. */
export const AGENT_TICK_CADENCE_MINUTES = 5;

/**
 * Launcher run-selection logic: which run the panel follows and whether that
 * run is still live. Kept pure for tests; the panel drives it on a poll tick.
 */

/** Statuses that count as "still running" for the live badge. */
export const ACTIVE_STATUSES = new Set(['preparing', 'running', 'waiting-human'])

/** The run the launcher presents, with its live-ness. */
export interface RunSelection {
  runId: string | null
  /** True while the selected run is still preparing/running/waiting-human. */
  active: boolean
}

/** The run fields selection reads. */
export interface SelectableRun {
  runId: string
  status: string
  startedAt: string
}

/**
 * Choose which run the launcher follows:
 * - any active run wins (a new run takes over a finished one);
 * - otherwise the current selection sticks, then the remembered last run,
 *   then the newest recent run, until each ages out of the recent window;
 * - no candidates yield an empty selection.
 */
export function selectRun(
  current: RunSelection,
  remembered: string | null,
  runs: readonly SelectableRun[],
): RunSelection {
  const activeRun = runs.find((run) => ACTIVE_STATUSES.has(run.status))
  const next =
    activeRun?.runId ??
    (current.runId !== null && runs.some((run) => run.runId === current.runId) ? current.runId : undefined) ??
    (remembered !== null && runs.some((run) => run.runId === remembered) ? remembered : undefined) ??
    runs[0]?.runId ??
    null
  const active =
    next !== null && runs.some((run) => run.runId === next && ACTIVE_STATUSES.has(run.status))
  return next === current.runId && active === current.active ? current : { runId: next, active }
}

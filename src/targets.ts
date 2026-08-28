// What this scheduler starts, and when.
//
// Before adding a target, confirm all three. Nothing here can check them, and a target that
// fails any of them is dispatched into silence:
//
//   1. Its workflow declares `workflow_dispatch:` in `on:`.
//   2. Its workflow declares a `concurrency` group with `cancel-in-progress: false`, so a
//      dispatch arriving during a run queues instead of doubling up. GitHub keeps exactly
//      one pending run per group.
//   3. The workload pings its own healthcheck. This repo never learns whether a run passed,
//      so a workload without one is unmonitored.
//
// These workflows carry no `schedule:` of their own, so this list is the only clock they
// have. A slot lost here is a run that does not happen, and the workload's own healthcheck
// is what says so.
//
// `cron` must appear verbatim in wrangler.jsonc's triggers.crons; the tests assert it both
// ways. The free plan allows 5 cron expressions per Cloudflare account, in total.

export type Target = {
  /** "owner/name" */
  repo: string
  /** workflow file name, e.g. "sync.yml" */
  workflow: string
  /** 5-field cron, parsed by Cloudflare, not by us */
  cron: string
  /** git ref to run on; GitHub defaults to the default branch */
  ref?: string
  inputs?: Record<string, string>
}

export const TARGETS: readonly Target[] = [
  // Hourly. GitHub's own schedule: event delivered 3 of 51 consecutive slots here, which is
  // what this repo exists to replace.
  { repo: "jshvn/ctan", workflow: "sync.yml", cron: "42 * * * *" },
  // Daily.
  { repo: "jshvn/tlnet", workflow: "sync.yml", cron: "30 3 * * *" },
]

/** Targets claiming this cron expression. More than one may share an expression. */
export const selectTargets = (cron: string, targets: readonly Target[] = TARGETS): Target[] =>
  targets.filter((t) => t.cron === cron)

/**
 * The instance id for one firing. Deterministic, so a slot that Cloudflare invokes twice
 * asks for an id that already exists instead of dispatching twice. The cron belongs in the
 * id because two expressions can match the same minute.
 *
 * Cloudflare allows `[A-Za-z0-9_-]` and 100 characters, so the four cron characters outside
 * that set are escaped. Upper-casing first is what makes the escape unambiguous: a cron may
 * name a month or weekday (`SUN`, `DEC`), and upper-casing leaves the lower-case escapes
 * with nothing to collide against. `-` is already legal and passes through, which keeps a
 * range (`1-5`) distinct from a list (`1,5`).
 */
const ESCAPE: Record<string, string> = { " ": "_", "*": "x", "/": "s", ",": "c" }

export const instanceId = (cron: string, scheduledTime: number): string =>
  `${scheduledTime}-${cron.toUpperCase().replace(/[ */,]/g, (c) => ESCAPE[c] as string)}`

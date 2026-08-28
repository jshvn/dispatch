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
  // GitHub's own schedule: event delivered 3 of 51 hourly slots here, so this drives it.
  { repo: "jshvn/ctan", workflow: "sync.yml", cron: "42 * * * *" },
  // TEMPORARY, 2026-08-27: a second ctan slot to prove the App contract end to end.
  // Remove this and its trigger once a dispatched run has landed.
  { repo: "jshvn/ctan", workflow: "sync.yml", cron: "7 * * * *" },
  // Daily, in the same slot its own schedule: block asks for, so the fallback and this
  // agree on when the run belongs.
  { repo: "jshvn/tlnet", workflow: "sync.yml", cron: "30 3 * * *" },
]

/** Targets claiming this cron expression. More than one may share an expression. */
export const selectTargets = (cron: string, targets: readonly Target[] = TARGETS): Target[] =>
  targets.filter((t) => t.cron === cron)

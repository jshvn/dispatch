// What this scheduler starts, and when. One file per GitHub repo, named for the half of
// "owner/name" after the slash; this file is the list of them.
//
// Before adding a workflow to any of them, confirm all three. Nothing here can check them,
// and a workflow that fails any of them is dispatched into silence:
//
//   1. It declares `workflow_dispatch:` in `on:`.
//   2. It declares a `concurrency` group with `cancel-in-progress: false`, so a dispatch
//      arriving during a run queues instead of doubling up. GitHub keeps exactly one
//      pending run per group.
//   3. The workload pings its own healthcheck. This repo never learns whether a run passed,
//      so a workload without one is unmonitored.
//
// These workflows carry no `schedule:` of their own, so this directory is the only clock
// they have. A slot lost here is a run that does not happen, and the workload's own
// healthcheck is what says so.
//
// The imports below are the whole registry: Workers bundling is static, so there is no glob
// and a file this list omits never runs. test/schedules.test.ts reads the directory and
// asserts the two match, both ways.
//
// They carry the .ts extension because `task crons` and `task targets` import this file
// with node's own resolver, which does not guess one. tsconfig.json allows it.

import ctan from "./ctan.ts"
import tlnet from "./tlnet.ts"

export type Workflow = {
  /** workflow file name, e.g. "sync.yml" */
  workflow: string
  /** 5-field cron, parsed by Cloudflare, not by us */
  cron: string
  /** git ref to run on; GitHub defaults to the default branch */
  ref?: string
  inputs?: Record<string, string>
}

/** One repo's file: what a `schedules/<name>.ts` default-exports. */
export type Repo = {
  /** "owner/name" */
  repo: string
  workflows: readonly Workflow[]
}

/** One workflow on one schedule -- everything a single dispatch needs. */
export type Target = Workflow & { repo: string }

// Annotated here rather than in each repo file, so a leaf stays plain data with no import
// of its own. A typo in one still fails to compile; it fails on this line.
const REPOS: readonly Repo[] = [ctan, tlnet]

export const TARGETS: readonly Target[] = REPOS.flatMap((r) =>
  r.workflows.map((w) => ({ repo: r.repo, ...w })),
)

/**
 * The cron expressions wrangler.jsonc must carry, which `task crons` writes there. Deduped,
 * because targets share expressions and the free plan allows 5 per Cloudflare account; and
 * sorted, so reordering the registry above does not rewrite generated JSON.
 */
export const crons = (targets: readonly Target[] = TARGETS): string[] =>
  [...new Set(targets.map((t) => t.cron))].sort()

/** Targets claiming this cron expression. More than one may share an expression. */
export const selectTargets = (cron: string, targets: readonly Target[] = TARGETS): Target[] =>
  targets.filter((t) => t.cron === cron)

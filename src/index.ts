// Cloudflare creates one instance of this workflow per cron match in wrangler.jsonc and
// tells the instance which expression fired. All this has to do is look up the targets
// claiming that expression and dispatch them.
//
// It does not watch what happens next. Each workload pings its own healthcheck, which is
// what alerts when a run fails or never starts -- including when this repo is the thing
// that broke.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { appJwt, dispatchWorkflow, installationToken } from "./github"
import { selectTargets } from "./targets"

export type Env = {
  GITHUB_APP_ID: string
  /** PKCS#8 PEM. See the conversion note in github.ts. */
  GITHUB_APP_PRIVATE_KEY: string
  GITHUB_APP_INSTALLATION_ID: string
}

// A dispatch is a single POST. Retrying it is safe: the target's concurrency group keeps at
// most one run pending, so a duplicate queues rather than doubling the work.
const RETRY = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "1 minute",
} as const

export class Dispatch extends WorkflowEntrypoint<Env> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const cron = event.schedule?.cron
    if (!cron) throw new Error("instance carried no schedule; this workflow only runs on a cron")

    const targets = selectTargets(cron)
    // wrangler.jsonc and targets.ts disagree. The tests catch this before deploy; if it
    // reaches production, failing loudly beats a schedule that silently does nothing.
    if (targets.length === 0) throw new Error(`no target in targets.ts claims cron "${cron}"`)

    const dispatched: string[] = []
    for (const target of targets) {
      // The token is minted inside the step rather than in one shared step above, so it is
      // never written to workflow state (step output persists for 3 days). One extra
      // subrequest per target, against a ceiling of 50.
      await step.do(`dispatch ${target.repo} ${target.workflow}`, RETRY, async () => {
        const jwt = await appJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY)
        const token = await installationToken(jwt, this.env.GITHUB_APP_INSTALLATION_ID)
        await dispatchWorkflow(token, target)
        return { repo: target.repo, workflow: target.workflow }
      })
      dispatched.push(`${target.repo}/${target.workflow}`)
    }

    return { cron, scheduledTime: event.schedule?.scheduledTime, dispatched }
  }
}

export default {
  // Wrangler requires a fetch handler. Nothing should reach this Worker over HTTP, and an
  // endpoint that created instances would let anyone start every workload on the list.
  fetch: () => new Response("not found", { status: 404 }),
}

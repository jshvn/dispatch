// A cron trigger in wrangler.jsonc invokes `scheduled` once per matching expression, and it
// creates one Workflow instance carrying that expression. All the instance has to do is look
// up the targets claiming it and dispatch them.
//
// The cron lives on the Worker rather than on the Workflow binding's own `schedules`, which
// are a paid-plan feature: `wrangler deploy` rejects them on the free plan. The cost is this
// one indirection, and a ceiling of 5 cron expressions per Cloudflare account.
//
// It does not watch what happens next. Each workload pings its own healthcheck, which is
// what alerts when a run fails or never starts -- including when this repo is the thing
// that broke.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import { appJwt, dispatchWorkflow, installationToken, isFatal } from "./github"
import { instanceId, selectTargets } from "./targets"

/** What `scheduled` hands the instance. The cron string is the whole lookup key. */
export type Params = {
  /** The expression that fired, verbatim as Cloudflare configured it. */
  cron: string
  /** Epoch ms of the slot, for the log line. */
  scheduledTime: number
}

/**
 * The bindings come from `Cloudflare.Env`, which `wrangler types` generates from
 * wrangler.jsonc -- a binding renamed there stops compiling here instead of failing at
 * runtime. Secrets are set with `wrangler secret put`, so they are never in that file and
 * have to be declared.
 */
export type Env = Cloudflare.Env & {
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

export class Dispatch extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const cron = event.payload?.cron
    if (!cron) throw new Error("instance carried no cron; only the scheduled handler creates these")

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
        try {
          const jwt = await appJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY)
          const token = await installationToken(jwt, this.env.GITHUB_APP_INSTALLATION_ID)
          await dispatchWorkflow(token, target)
        } catch (err) {
          // A 404 for a workflow file that is not there, a 403 for a permission the App was
          // never granted: three retries only delay the message by a minute.
          if (isFatal(err)) throw new NonRetryableError((err as Error).message)
          throw err
        }
        return { repo: target.repo, workflow: target.workflow }
      })
      dispatched.push(`${target.repo}/${target.workflow}`)
    }

    return { cron, scheduledTime: event.payload.scheduledTime, dispatched }
  }
}

export default {
  // One instance per firing, under an id derived from the slot. `createBatch` rather than
  // `create` because it is the documented idempotent one: an id still inside its retention
  // window is skipped, so a slot Cloudflare invokes twice dispatches once. A batch of one
  // is the whole batch -- this handler is called once per expression.
  scheduled: async (controller: ScheduledController, env: Env) => {
    await env.DISPATCH.createBatch([
      {
        id: instanceId(controller.cron, controller.scheduledTime),
        params: { cron: controller.cron, scheduledTime: controller.scheduledTime },
      },
    ])
  },

  // Wrangler requires a fetch handler. Nothing should reach this Worker over HTTP, and an
  // endpoint that created instances would let anyone start every workload on the list.
  fetch: () => new Response("not found", { status: 404 }),
}

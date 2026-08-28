# dispatch

A private Cloudflare Workflow that starts GitHub Actions workloads on a schedule.

GitHub's own `schedule:` event delivers about 6% of hourly slots (measured: 3 of 51
consecutive slots on `jshvn/ctan`, 2026-08-26 to 2026-08-28). Low-frequency crons on the
same account deliver reliably -- 12 of 12 weekly and 5 of 5 monthly on
`jshvn/everything-claude-code` -- so the failure is specific to the hourly cadence.
This repo replaces the trigger, not the workloads.

## Scope

It dispatches GitHub Actions workflows. That is all.

It does not monitor outcomes, does not run work itself, and does not backfill missed
slots. Each workload owns its own healthcheck and remains fully monitored whether it was
started by this scheduler, by hand, or by the GitHub cron left in place as a fallback.

## Architecture

    wrangler.jsonc
      workflows[0].schedules = ["42 * * * *", "30 3 * * *", ...]
            |
            |  Cloudflare creates one instance per cron match
            v
    Dispatcher workflow instance
      event.schedule.cron           <- the expression that fired
      event.schedule.scheduledTime  <- intended slot, ms epoch
            |
            |  step "dispatch <repo> <workflow>"  one per matching target;
            |    mints its own installation token, then POSTs
            v
    POST /repos/{repo}/actions/workflows/{file}/dispatches   -> 204
            |
            v
    GitHub queues the run; the workload's own `concurrency` group
    keeps at most one run pending
            |
            v
    Workload runs and pings its own healthcheck on success

Cloudflare parses the cron. There is no cron matcher in this repo, and no scheduling
state -- an instance is a pure function of `(event.schedule.cron, targets)`.

## Configuration

`src/targets.ts` is the source of truth.

    export type Target = {
      repo: string                        // "jshvn/ctan"
      workflow: string                    // "sync.yml"
      cron: string                        // verbatim in wrangler schedules
      ref?: string                        // default "main"
      inputs?: Record<string, string>
    }

    export const TARGETS: Target[] = [
      { repo: "jshvn/ctan", workflow: "sync.yml", cron: "42 * * * *" },
    ]

`wrangler.jsonc` carries the same cron strings on the workflow binding:

    "workflows": [{
      "name": "dispatcher",
      "binding": "DISPATCHER",
      "class_name": "Dispatcher",
      "schedules": ["42 * * * *"]
    }]

Two files holding the same cron strings is the one fragile seam in the design. A test
asserts they agree and prints the exact array to paste when they do not. Generating the
wrangler schedules from `TARGETS` would make the seam impossible to break; it costs a
build step, and the test is enough until the list is long.

### Invariants

Machine-checked:

1. Every `target.cron` appears in `wrangler.jsonc`'s `schedules`.
2. Every schedule in `wrangler.jsonc` is claimed by at least one target.
3. Every `(repo, workflow)` pair appears once.

Checklist, in the README and the PR template, because this repo cannot verify them:

4. The target workflow declares `workflow_dispatch:` in its `on:` block.
5. The target workflow declares a `concurrency` group with `cancel-in-progress: false`.
6. The target workload pings its own healthcheck. **A target without one is
   unmonitored: nothing here will notice it stopped.**

## Authentication

A GitHub App, not a PAT. Installation tokens are minted per instance, live one hour, and
are scoped to the repos the App is installed on. Nothing expires on a calendar, and access
is granted or revoked per repo from the GitHub UI without touching this repo.

Worker secrets:

    GITHUB_APP_ID
    GITHUB_APP_PRIVATE_KEY        PKCS#8 PEM
    GITHUB_APP_INSTALLATION_ID

Per instance:

    RS256 JWT (iss=app id, exp=+9 min), signed with WebCrypto
      -> POST /app/installations/{id}/access_tokens
      -> installation token, 1 hour
      -> POST /repos/{repo}/actions/workflows/{file}/dispatches

The token is minted *inside* each dispatch step rather than in a shared step above it.
Step output is persisted for 3 days, so a shared step would write a live GitHub credential
into workflow state. Minting per step costs one extra subrequest per target, against a
ceiling of 50, and keeps the token in memory only. It also makes a retry re-mint, which is
what you want when a dispatch fails near the token's expiry.

GitHub issues App private keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`). WebCrypto only imports
PKCS#8. Convert once before storing the secret:

    openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem

## Cost

Everything sits on the Workers Free plan. Billing for Workflows steps and storage began
2026-08-10, so these allowances are enforced, not theoretical.

| Resource | Free allowance | Projected use |
| --- | --- | --- |
| Workflow steps | 3,000 / day | ~26 / day (0.9%) |
| Requests | 100,000 / day | ~26 / day |
| Cron expressions per account | 100 (workflow schedules) | 4 |
| Subrequests per invocation | 50 | 2 per target |
| Storage | 1 GB | none |
| Concurrent instances | 100 | 1 |

Step arithmetic: one step per target per fire. ctan hourly is 24 steps/day; tlnet daily 1;
ecc weekly and monthly round to nothing.

Workers cron triggers are capped at 5 per account on the free plan, but workflow
`schedules` are a separate allowance of 100. This repo uses zero Workers cron triggers.

Verified 2026-08-27 against the Cloudflare docs. Re-check before adding a design that
polls run outcomes: polling costs roughly 13 steps per run instead of 2.

## Failure modes

| Failure | What happens | How you find out |
| --- | --- | --- |
| Dispatch returns 5xx | step retries 3x with backoff, then the instance fails | workload's healthcheck grace expires |
| App key wrong or revoked | every dispatch fails | every workload's healthcheck fires at once |
| Cloudflare drops a schedule | that slot is lost, next slot proceeds | absorbed by the workload's grace |
| Target repo renamed or deleted | 404 after retries | that workload's healthcheck fires |
| Target has no healthcheck | silent | nothing. See invariant 6 |
| This repo is broken entirely | nothing dispatches | every workload's healthcheck fires |

Failed instances and their step history are visible in the Workflows dashboard for 3 days
on the free plan.

## Testing

The one runnable check is `vitest run`, covering the parts that can break silently:

All of it lives in `test/dispatch.test.ts`:

- The invariants above, read straight out of `wrangler.jsonc`. This is the fragile seam.
- `selectTargets` -- the right targets for a given `event.schedule.cron`, including two
  targets sharing one expression, and no match for an equivalent-but-different string.
- `appJwt` -- the signed JWT carries the header and claims GitHub accepts and verifies
  against the matching public key, using a key generated in the test. A PKCS#1 key is
  rejected with the conversion command in the message.
- `dispatchWorkflow` -- URL, method and body, and a throw on any status but 204.

`fetch` is injected into the dispatch path, so no test touches the network.

Unit tests cannot prove the GitHub App contract. One manual smoke does: deploy, add a
`*/5 * * * *` schedule pointing at a scratch repo, confirm a run appears within ten
minutes, remove the schedule.

## Deployment

- Push to `main` runs `wrangler deploy` from GitHub Actions, using `CLOUDFLARE_API_TOKEN`.
- Pull requests run `biome check`, `tsc --noEmit`, `vitest run`, `wrangler deploy --dry-run`.
- `schedules` on a workflow binding needs a recent Wrangler; pin it in `package.json`.

## Rollout

1. Create the App, install it on `jshvn/ctan` with Actions read and write.
2. Deploy with ctan as the only target.
3. Watch 24 hours. Expect 24 runs where the last two days produced 3.
4. Add `jshvn/tlnet`, then the two `everything-claude-code` workflows, once ctan is proven.

Leave the `schedule:` block in each target workflow. It delivers roughly one run a day for
free, costs nothing, and the workload's `concurrency` group absorbs any overlap. It is the
fallback for this repo being broken.

## Known ceilings

Each is a deliberate simplification with a named upgrade path.

- **No backfill.** A dropped Cloudflare schedule loses that slot outright. Upgrade:
  persist the last fire time per target and evaluate the gap on the next instance.
- **No outcome monitoring.** This repo learns nothing about whether a run passed. Upgrade:
  a per-target `monitor: "scheduler"` mode that correlates the dispatch to a run id via a
  UUID input surfaced as `run-name`, polls to completion, and pings on the workload's
  behalf. Costs roughly 13 steps per run instead of 2, and requires editing the target
  workflow.
- **Config lives in two files.** Upgrade: generate the wrangler schedules from `TARGETS`.
- **Dispatches sharing one cron are capped at ~48** by the 50-subrequest ceiling.

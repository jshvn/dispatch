# dispatch

Starts GitHub Actions workloads on a schedule, because GitHub's own `schedule:` event does
not.

Measured on `jshvn/ctan`: **3 of 51 consecutive hourly slots fired**, about 6%. Lower
frequencies on the same account are fine -- 12 of 12 weekly and 5 of 5 monthly on
`jshvn/everything-claude-code` -- so the failure is specific to the hourly cadence. A
Cloudflare Workflow triggers the runs instead. The `schedule:` blocks stay in the target
repos as a fallback.

## How it works

`wrangler.jsonc` lists cron expressions on the Workflow binding. Cloudflare parses them,
creates one instance per match, and tells the instance which expression fired via
`event.schedule.cron`. `src/targets.ts` says which repo and workflow that expression means.

    schedules ──▶ instance (event.schedule.cron) ──▶ selectTargets ──▶ workflow_dispatch

There is no cron parser here, and no scheduling state: an instance is a pure function of
the expression and the target list.

It dispatches and stops there. It never learns whether a run passed. **Each workload pings
its own healthcheck**, which is what alerts when a run fails, when a run never starts, and
when this repo is itself the thing that broke.

## Adding a target

1. Add an entry to `TARGETS` in `src/targets.ts`.
2. Add the same cron string to `schedules` in `wrangler.jsonc`. `npm test` fails if the two
   disagree and prints what to paste.
3. Install the GitHub App on the target repo.
4. Confirm the target workflow has all three. Nothing here can check them:
   - `workflow_dispatch:` in its `on:` block.
   - a `concurrency` group with `cancel-in-progress: false`, so a dispatch arriving mid-run
     queues instead of doubling up. GitHub keeps exactly one pending run per group.
   - its own healthcheck ping. **A workload without one is unmonitored.**

## Setup

A GitHub App, not a token: installation tokens are minted per run, live an hour, are scoped
to the repos the App is installed on, and never expire on a calendar.

Create an App with **Actions: read and write**, install it on the target repos, then:

    # GitHub issues App keys as PKCS#1; WebCrypto only imports PKCS#8.
    openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem

    npx wrangler secret put GITHUB_APP_ID
    npx wrangler secret put GITHUB_APP_INSTALLATION_ID
    npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste app.pkcs8.pem

Deploys run from `.github/workflows/deploy.yml` on push to `main` and need
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets.

## Commands

    npm test          # the checks that matter; see docs/ for what they cover
    npm run typecheck # wrangler types && tsc --noEmit
    npm run lint      # biome
    npm run deploy    # wrangler deploy

## Cost

Everything is inside the Workers free plan, which matters because Workflows billing began
2026-08-10.

| Resource | Free | Used |
| --- | --- | --- |
| Workflow steps | 3,000 / day | ~26 / day |
| Requests | 100,000 / day | ~26 / day |
| Cron expressions per account | 100 | 1 |
| Subrequests per invocation | 50 | 2 per target |

One step per target per fire. Verified 2026-08-27; re-check before adding anything that
polls run outcomes, which costs roughly 13 steps per run instead of one.

`docs/superpowers/specs/` has the design, the failure modes and the known ceilings.

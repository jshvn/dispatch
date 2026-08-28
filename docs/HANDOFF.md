# Handoff

State as of 2026-08-27. **This document expires once setup is finished** -- once the App
exists, the secrets are set and the first scheduled run has landed, everything below is
history and `README.md` plus `CLAUDE.md` are the live documents. Delete it then.

## Where things stand

The code is written, reviewed and pushed. Nothing has ever run.

| | |
| --- | --- |
| Repo | `jshvn/dispatch`, `main` |
| CI `check` | green |
| CI `deploy` | fails on the absent `CLOUDFLARE_API_TOKEN`, and only that |
| Deployed to Cloudflare | no |
| GitHub App | does not exist |
| Worker secrets | not set |
| Scheduled runs so far | none |

Verified locally and in CI: `tsc --noEmit` clean, 12 of 12 tests pass, `biome check` clean,
`wrangler deploy --dry-run` resolves the Workflow binding. Free-tier limits were checked
against Cloudflare's docs on 2026-08-27 and are recorded in the spec.

Not verified by anything: the GitHub App contract. No JWT this repo produced has ever been
exchanged for a token, and no dispatch has ever been sent. That is the whole risk left.

## Remaining setup

**1. Create the GitHub App.** Owner `jshvn`, one permission: **Repository permissions ->
Actions -> Read and write**. No webhook. Install it on `jshvn/ctan`. Keep the App ID from
the settings page and the installation ID from the end of the installation's URL.

**2. Convert the private key.** GitHub issues PKCS#1; WebCrypto imports PKCS#8 only.

    openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem

**3. Set the Worker secrets.**

    npx wrangler secret put GITHUB_APP_ID
    npx wrangler secret put GITHUB_APP_INSTALLATION_ID
    npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste all of app.pkcs8.pem

**4. Set the repo secrets** so `deploy` can run: `CLOUDFLARE_API_TOKEN` (scoped to Edit
Cloudflare Workers) and `CLOUDFLARE_ACCOUNT_ID`. Re-run the failed `deploy` job.

**5. Smoke test the App contract**, because nothing else does. Point a fast schedule at a
scratch repo, confirm a run appears, then revert:

    # in wrangler.jsonc schedules and src/targets.ts, temporarily add
    { repo: "jshvn/<scratch>", workflow: "<something>.yml", cron: "*/5 * * * *" }

A run should appear within ten minutes. If it does not, read the instance in the Cloudflare
dashboard under Workers -> Workflows; failed steps and their errors are kept for three days
on the free plan.

## How you know it worked

The measurement that started this project, on `jshvn/ctan`:

| Cadence | Delivered |
| --- | --- |
| ctan `42 * * * *` hourly | **3 of 51 slots (6%)** |
| ecc `0 9 * * 1` weekly | 12 of 12 (100%) |
| ecc `0 14 1 * *` monthly | 5 of 5 (100%) |

After a day, `gh run list --repo jshvn/ctan --workflow sync.yml --limit 30` should show
roughly 24 `workflow_dispatch` runs where the two days before this showed 3 scheduled ones.
`curl -s https://ctan.ijosh.com/timestamp` should never be more than about two hours stale.

## Deliberately not done

- **`jshvn/tlnet` is not a target.** Its cron is daily, and daily cadences deliver fine on
  this account. Watch it for a week before assuming it needs this.
- **The two `everything-claude-code` workflows are not targets.** Both deliver at 100%.
  Nothing is broken there to fix.
- **GitHub's `schedule:` blocks stay in every target repo.** About one run a day, free, and
  the fallback for `dispatch` itself being broken.
- **No monitoring here.** Each workload's own healthcheck is the alert. Before adding a
  target, confirm it has one -- the checklist is in `README.md`.

## If you pick this up cold

Read `CLAUDE.md` for the design and the traps, then `docs/superpowers/specs/` for why each
decision went the way it did, including the three alternatives that were rejected
(Durable Objects with alarms, a minutely cron matcher, and scheduler-owned monitoring).

The single most useful thing to understand: the cron strings live in **two files** and must
agree. `npm test` is what stops that from reaching production.

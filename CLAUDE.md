# dispatch

Starts GitHub Actions workloads on a schedule from a Cloudflare Workflow, because GitHub's
own `schedule:` event delivered 3 of 51 consecutive hourly slots on `jshvn/ctan`. Runs on
the Workers free plan.

`README.md` is for users. This file is the design.

Everything is in five files:

- `wrangler.jsonc`: the cron expressions, as Worker cron triggers. Cloudflare parses them
  and invokes `scheduled` once per match.
- `src/targets.ts`: which repo and workflow each expression means. The only file a routine
  change touches.
- `src/github.ts`: App JWT, installation token, `workflow_dispatch`. No SDK, two requests.
- `src/index.ts`: `scheduled` creates one instance per firing; the Workflow looks up the
  targets for the cron it was handed, dispatches them, ends.
- `test/dispatch.test.ts`: the whole suite.

Deliberate ceilings, each with an upgrade path: no backfill (a dropped firing loses that
slot), no outcome monitoring, the cron strings duplicated across two files, and at most ~48
targets on one expression before the 50-subrequest limit bites.

## Constraints

- It dispatches. It does not poll, monitor run outcomes, or run work itself.
- Free plan only. 3,000 workflow steps a day is the budget; one step per target per fire.
- No secrets in the repo. Three Worker secrets set by hand with `wrangler secret put`:
  `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`. Two repo secrets
  for deploying: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- The only network endpoint is `api.github.com`.
- No cron parser. Cloudflare parses the expressions; this repo looks up strings.

## Must knows

Each of these fails silently, or fails only in production. Do not undo them.

- **The cron strings live in two files.** `triggers.crons` in `wrangler.jsonc` and `cron` in
  `src/targets.ts`. A target whose cron is not a trigger never runs; a trigger no target
  claims throws every time it fires. The tests assert both directions and print what to
  paste. Never edit one without the other.
- **Lookup is verbatim.** Cloudflare hands back the literal string it was configured with,
  so `0 */1 * * *` and `0 * * * *` are different keys even though cron treats them alike.
- **The installation token is minted inside each dispatch step, never in a shared step
  above it.** Step output persists for three days, so a shared token step would write a
  live GitHub credential into workflow state. The cost is one extra subrequest per target,
  against a ceiling of 50.
- **This repo never learns whether a run passed.** Each workload pings its own healthcheck.
  That is the only alert, and it is what catches this repo being the thing that broke. A
  target added without a healthcheck of its own is dispatched into silence.
- **The target's `concurrency` group is what makes a retried dispatch safe.** GitHub keeps
  exactly one pending run per group and cancels an older pending one, which is why a
  duplicate queues instead of doubling the work. A target without
  `cancel-in-progress: false` can stack runs.
- **The cron reaches the instance as `event.payload.cron`, put there by `scheduled`.**
  `run()` throws without it on purpose: nothing else should be creating instances. The
  binding's own `schedules` would carry it as `event.schedule` instead, but they need a paid
  plan, which is why the handler exists.
- **Cron triggers are capped at 5 per Cloudflare account on the free plan** -- every Worker
  on the account shares that allowance. Targets sharing one expression share one trigger.
- **The `fetch` handler must exist and must not create instances.** Wrangler requires a
  default export, and an endpoint that started a run would let anyone trigger every
  workload on the list.
- **GitHub issues App keys as PKCS#1; WebCrypto imports PKCS#8 only.** `github.ts` throws
  with the `openssl pkcs8 -topk8` command rather than failing inside the signature.
- **Polling run outcomes would cost roughly 13 steps per run instead of one.** That is a
  different design with a different budget. One step per target per fire is what keeps this
  inside the free plan's 3,000 steps a day.

## Verifying a change

- `npm test` -- the two-file seam, the lookup, the JWT, the dispatch request. No network.
- `npm run typecheck` -- runs `wrangler types` first. `worker-configuration.d.ts` is
  gitignored, so tsc fails against a missing or stale `Env` without it.
- `npm run lint`
- `npx wrangler deploy --dry-run` -- proves wrangler still parses `wrangler.jsonc` and
  resolves the Workflow binding.

None of that covers the GitHub App contract. The only proof is a real dispatch, and the
cheapest one takes seconds -- a production instance carrying the payload `scheduled` would
have given it:

    npx wrangler workflows trigger dispatch '{"cron":"42 * * * *","scheduledTime":0}'

It dispatches for real. `npx wrangler workflows instances describe dispatch <id>` then shows
the step and its output. Without the JSON params the instance has no cron to look up and
`run()` throws, which is the whole reason the argument matters.

Hazards, each of which has cost time:

- **A new cron expression does not fire immediately after deploy.** Cloudflare documents up
  to 15 minutes to propagate; measured here, a slot 59 seconds out was missed and one 6
  minutes out fired. Changing or removing an expression counts as a change too. An
  unchanged expression keeps firing across deploys, so this only bites on the first slot of
  a new one.

- **`wrangler types` regenerates from `wrangler.jsonc`.** Change a binding without rerunning
  it and tsc checks against a stale `Env`.
- **npm 11 gates package install scripts.** A fresh clone needs
  `npm install-scripts approve esbuild workerd`, or wrangler and vitest have no binaries.
- **A PEM private-key header in Bash tool text is blocked by the secret-scan hook**, test
  fixtures included. `test/dispatch.test.ts` builds the header from fragments for that
  reason; write such files with Write or Edit instead.
- **Published versions move faster than memory.** TypeScript is on 7, vitest on 4,
  `@cloudflare/workers-types` is superseded by `wrangler types`. Check with `npm view`
  before pinning anything.

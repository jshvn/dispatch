# dispatch

Starts GitHub Actions workflows on a schedule, from a Cloudflare Workflow. GitHub's own
`schedule:` event delivered 3 of 51 consecutive hourly slots on `jshvn/ctan`. Free plan.

`README.md` is for users. This file is the design.

## The files

- `schedules/` -- one file per GitHub repo, named for the half of `owner/name` after the
  slash, listing that repo's workflows and the cron each one runs on. Routine changes touch
  only this directory, then `task crons`. `schedules/index.ts` imports them all: it holds the
  types, the registry and `selectTargets`.
- `wrangler.jsonc` -- the same expressions as Worker cron triggers, generated into it by
  `task crons`. Cloudflare parses them.
- `src/github.ts` -- App JWT, installation token, `workflow_dispatch`. No SDK, two requests.
- `src/index.ts` -- `scheduled` creates one instance per firing, under `instanceId`. The
  instance dispatches every target claiming that cron, then ends.
- `test/` -- one file per source it covers: `schedules.test.ts`, `github.test.ts`,
  `index.test.ts`. The last mocks `src/github`.

## Constraints

- It dispatches. It does not poll, monitor outcomes, or run work itself.
- Free plan. 3,000 workflow steps a day, one step per target per fire. Polling outcomes
  would cost about 13 steps a run.
- No secrets in the repo. Worker secrets `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and
  `GITHUB_APP_INSTALLATION_ID`, set with `task secrets`. Repo secrets
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, for deploying.
- The only network endpoint is `api.github.com`.
- No cron parser. Cloudflare parses the expressions; this repo looks up strings.

Accepted ceilings: no backfill, no outcome monitoring, the crons copied into
`wrangler.jsonc` by a generator rather than read from one place, a registry that lists its
own files by hand, and a subrequest budget that bounds how many targets one expression can
carry.

## Must knows

Each of these fails silently, or only in production.

- **`wrangler.jsonc`'s crons are generated; do not edit them.** `task crons` writes
  `triggers.crons` from `schedules/`. The strings are copied rather than shared because
  `wrangler.jsonc` is JSON and cannot import. A target that is not also a trigger never runs;
  a trigger no target claims throws every time it fires. `test/schedules.test.ts` fails until
  the two match exactly, order included.
- **A file in `schedules/` that `index.ts` does not import never runs.** Workers bundling is
  static, so there is no glob and the import list is the registry. The tests read the
  directory and assert it against `TARGETS` both ways, matching a file name to the half of
  `owner/name` after the slash. `ponytail:` two owners with the same repo name would collide;
  the fix is `schedules/<owner>/<repo>.ts`.
- **`schedules/index.ts` imports its leaves with a `.ts` extension.** `task crons` and
  `task targets` load that file with node's own resolver, which does not guess one.
  `allowImportingTsExtensions` in `tsconfig.json` is what lets tsc accept it.
- **Lookup is verbatim.** `0 */1 * * *` and `0 * * * *` are different keys.
- **Mint the installation token inside each dispatch step.** Step output persists three
  days, so a shared token step would store a live credential. Costs one subrequest per
  target.
- **This is the targets' only clock, and it never learns whether a run passed.** Their
  workflows carry no `schedule:`. Each workload pings its own healthcheck; that is the only
  alert, and it is what catches this repo being the thing that broke.
- **The target's `concurrency` group is what makes a retried dispatch safe.** GitHub keeps
  one pending run per group. Without `cancel-in-progress: false` a target can stack runs.
- **The instance id is the slot: `<scheduledTime>-<slugged cron>`.** In `src/index.ts`,
  beside its only caller. `scheduled` uses
  `createBatch`, which skips an id still in its retention window, so a slot Cloudflare
  invokes twice dispatches once. `create` would throw. The cron belongs in the id because
  two expressions can match the same minute.
- **A 4xx from GitHub is a typo, not a bad day.** `isFatal` names the statuses a retry
  cannot fix; the step rethrows those as `NonRetryableError`. 408 and 429 stay retryable.
- **`Env` is `Cloudflare.Env` plus the secrets.** Bindings come from the generated types, so
  a binding renamed in `wrangler.jsonc` stops compiling. Declaring `DISPATCH` by hand would
  typecheck clean and fail in production.
- **The cron arrives as `event.payload.cron`, put there by `scheduled`.** `run()` throws
  without it: nothing else should create instances. The binding's own `schedules` would
  carry it instead, but they need a paid plan, which is why the handler exists.
- **5 cron expressions per Cloudflare account** on the free plan, shared by every Worker on
  the account. Targets sharing an expression share one trigger, and `test/schedules.test.ts`
  holds the generated count at 5 -- otherwise `wrangler deploy` is where it is found out.
- **The `fetch` handler must exist and must not create instances.** Wrangler requires a
  default export, and an endpoint that started runs would let anyone fire every workload.
- **GitHub issues App keys as PKCS#1; WebCrypto imports PKCS#8 only.** `github.ts` throws
  with the `openssl` command rather than failing inside the signature. `task pkcs8`
  converts.

## Verifying a change

`task check` is everything CI runs: typecheck, format, tests, dry-run deploy. After changing
a cron, run `task crons` first -- `check` verifies the generated triggers, it does not write
them.

- Typecheck runs `wrangler types` first. `worker-configuration.d.ts` is gitignored and
  carries the runtime types and the bindings. Rerun after any binding change.
- Format is Biome, formatting only. No lint rules, so it will not catch `any`, an unused
  binding or a stray `console.log`.
- The dry run proves wrangler still parses `wrangler.jsonc` and resolves the binding.

None of that covers the GitHub App contract. Only a real dispatch does:

    npx wrangler workflows trigger dispatch '{"cron":"42 * * * *","scheduledTime":0}'

It dispatches for real, and `task inspect` shows the step and its output. Without the JSON
the instance has no cron to look up and `run()` throws.

## Hazards

- **A new cron does not fire straight away.** Cloudflare takes up to 15 minutes to
  propagate one. Measured here: a slot 59 seconds out was missed, one 6 minutes out fired.
  Changing or removing an expression counts as a change. Unchanged ones keep firing across
  deploys.
- **A push touching only docs, `LICENSE`, `Taskfile.yml` or `.github/` does not deploy.**
  `deploy.yml` uses a `paths-ignore` deny-list, so a new shipping file deploys without being
  added to anything. `check` still runs on every push. `workflow_dispatch` forces a deploy.
- **npm 11 gates package install scripts.** A fresh clone needs
  `npm install-scripts approve esbuild workerd`, or wrangler and vitest have no binaries.
- **A PEM private-key header in Bash tool text trips the secret-scan hook**, test fixtures
  included. `test/github.test.ts` builds the header from fragments. Write such files with
  Write or Edit.
- **Check `npm view` before pinning anything.** TypeScript is on 7, vitest on 4;
  `@cloudflare/workers-types` is superseded by `wrangler types`.

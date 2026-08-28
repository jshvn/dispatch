# dispatch

Dispatches GitHub Actions workflows on a schedule from a Cloudflare Workflow.

## How it works

```
wrangler.jsonc          Cloudflare parses these crons and creates one instance per match,
  schedules: [...]      handing it the expression that fired as event.schedule.cron
        │
        ▼
src/targets.ts          which repo and workflow that expression means
        │
        ▼
src/github.ts           App JWT -> installation token -> POST .../dispatches
```

Four files, and `test/dispatch.test.ts` over them. No cron parser, no scheduling state: an
instance is a pure function of the cron string and the target list.

Two things to know before editing anything:

- **The cron strings live in two files** and must agree. A target whose cron is not
  scheduled never runs; a schedule no target claims throws every time it fires. `task check`
  asserts both directions and prints what to paste.
- **Lookup is verbatim.** Cloudflare returns the literal string it was configured with, so
  `0 */1 * * *` and `0 * * * *` are different keys even though cron treats them alike.

## Adding a target

1. Add an entry to `TARGETS` in `src/targets.ts`.
2. Add the same cron string, character for character, to `schedules` in `wrangler.jsonc`.
3. Install the GitHub App on the target repo (App settings -> Install App -> Configure).
4. Confirm the target's workflow has all three of these. Nothing here can check them, and a
   target failing any of them is dispatched into silence:
   - `workflow_dispatch:` in its `on:` block, or the dispatch 404s.
   - a `concurrency` group with `cancel-in-progress: false`, so a dispatch arriving mid-run
     queues instead of doubling up. GitHub keeps exactly one pending run per group, which is
     what makes a retried dispatch safe.
   - its own healthcheck ping. **A workload without one is unmonitored.**
5. `task check`, then push to `main`. Deploy runs itself.

## Removing a target

1. Delete its entry from `src/targets.ts`.
2. Delete its cron from `schedules` in `wrangler.jsonc` -- unless another target still
   claims that exact string.
3. `task check`, then push to `main`.
4. Optional: uninstall the App from that repo, and check its `schedule:` block is still
   there, because it is the only clock left.

## Setup

### 1. GitHub App

An App, not a PAT: its installation tokens are minted per dispatch, live an hour, are scoped
to the repos the App is installed on, and never expire on a calendar.

1. Create it under the `jshvn` account with exactly one permission: **Repository permissions
   -> Actions -> Read and write**. No webhook.
2. Install it on the target repos.
3. Keep the **App ID** from the settings page and the **installation ID** from the end of
   the installation's URL (`.../installations/<id>`).
4. Generate a private key and convert it -- GitHub issues PKCS#1, WebCrypto imports PKCS#8
   only, and `src/github.ts` throws on anything else:

   ```sh
   task pkcs8 KEY=app.private-key.pem   # writes app.pkcs8.pem
   ```

### 2. Worker secrets

Set on Cloudflare, once, by hand. `task secrets` prompts for all three:

| Secret | What it is |
| --- | --- |
| `GITHUB_APP_ID` | App ID from the App's settings page |
| `GITHUB_APP_INSTALLATION_ID` | trailing number of the installation's URL |
| `GITHUB_APP_PRIVATE_KEY` | the whole `app.pkcs8.pem`, `BEGIN` and `END` lines included |

Delete both `.pem` files afterwards. They are not in the repo and must never be.

### 3. Cloudflare API token

`.github/workflows/deploy.yml` deploys on push to `main` and needs a token of its own.
Dashboard -> **My Profile -> API Tokens -> Create Token -> Create Custom Token**:

| Scope | Permission | Access |
| --- | --- | --- |
| Account | Workers Scripts | Edit |

That is the whole minimum. Under **Account Resources**, include only the account this Worker
lives in. Nothing else is needed because this Worker binds no KV, R2, D1 or Queues, serves
no route or custom domain, and is given its account ID directly, so nothing has to list
accounts.

The dashboard's **Edit Cloudflare Workers** template also works and is what Cloudflare's own
guide points at, but it grants seven permissions this repo never uses: Workers KV Storage
Write, Workers R2 Storage Write, Workers Tail Read, Account Settings Read, Workers Routes
Write on every zone, User Details Read and User Memberships Read.

Add **Account -> Workers Tail -> Read** only if you want to run `task logs` with this token
rather than an interactive `npx wrangler login`.

### 4. GitHub Actions secrets

The minimum set. Repo -> Settings -> Secrets and variables -> Actions:

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 3 | shown once, at creation |
| `CLOUDFLARE_ACCOUNT_ID` | the account the Worker deploys into | Workers & Pages overview, or the hex in any dashboard URL |

`check.yml` needs neither -- it types, lints, tests and dry-run deploys on every push and
pull request without touching Cloudflare.

## Use

`task` on its own prints the menu.

| Command | What it does |
| --- | --- |
| `task check` | everything CI runs: types, lint, tests, dry-run deploy |
| `task targets` | what gets dispatched and when, read from `src/targets.ts` |
| `task runs` | recent runs of each target; `workflow_dispatch` ones came from here |
| `task deploy` | deploy by hand; pushing to `main` already does this |
| `task logs` | live logs from the deployed Worker |
| `task instances` | recent Workflow instances, one per cron that fired |
| `task instance` | one instance's steps, retries and errors (`ID=<id>`, default latest) |
| `task pkcs8`, `task secrets` | the setup steps above |

There is no way to test a dispatch by hand: an instance created without a cron has nothing
to look up, so `wrangler workflows trigger` throws on purpose. To try a change end to end,
add a temporary `*/5 * * * *` schedule and target, watch `task runs`, then revert.

# dispatch

Runs GitHub Actions workflows on a schedule, from a Cloudflare Worker.

## Setup

Once, by hand.

### GitHub App

1. Create an App under `jshvn` with one permission -- Repository permissions -> Actions ->
   Read and write -- and no webhook.
2. Install it on the target repos.
3. Note the App ID from the App's settings page, and the installation ID from the end of the
   installation's URL.
4. Generate a private key and convert it. GitHub issues PKCS#1; WebCrypto imports PKCS#8
   only.

   ```sh
   task pkcs8 KEY=app.private-key.pem   # writes app.pkcs8.pem
   ```

### Worker secrets

1. Run `task secrets`. It prompts for all three: `GITHUB_APP_ID`,
   `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY` -- the whole `app.pkcs8.pem`,
   `BEGIN` and `END` lines included.
2. Delete both `.pem` files.

### Cloudflare API token

1. My Profile -> API Tokens -> Create Token -> Create Custom Token.
2. Give it one permission: Account -> Workers Scripts -> Edit. Add Account -> Workers Tail
   -> Read to run `task logs` with it.
3. Under Account Resources, include only the account this Worker lives in.

### Repo secrets

1. Settings -> Secrets and variables -> Actions.
2. `CLOUDFLARE_API_TOKEN` -- the token above, shown once at creation.
3. `CLOUDFLARE_ACCOUNT_ID` -- from the Workers & Pages overview.

Push to `main` deploys. The checks run on every push without either secret.

## Changing the target list

A target is a repo, a workflow file and a cron, in `TARGETS` in `src/targets.ts`. The same
cron string must also be a trigger in `triggers.crons` in `wrangler.jsonc` -- one file
without the other and nothing runs.

To add one:

- Add the entry to `src/targets.ts`, and its cron to `wrangler.jsonc` character for
  character.
- Install the App on that repo.
- Check three things in the target's own workflow. Nothing here can, and a target failing
  any of them is dispatched into silence:
  - `workflow_dispatch:` in its `on:` block, or the dispatch 404s.
  - a `concurrency` group with `cancel-in-progress: false`, so a retried dispatch queues
    instead of doubling the work.
  - a healthcheck ping. This repo never learns whether a run passed.
- `task check`, which asserts the two files agree, then push to `main`.

To remove one:

- Delete its entry from `src/targets.ts`.
- Delete its cron from `wrangler.jsonc`, unless another target claims that exact string.
- Give that workflow a `schedule:` of its own. This list was its only clock.
- `task check`, then push to `main`.

## Day to day

`task` on its own prints the menu.

- `task check` -- everything CI runs: types, format, tests, dry-run deploy.
- `task targets` -- what gets dispatched, and when.
- `task runs` -- recent runs of each target on GitHub.
- `task instances` -- the Cloudflare side, one instance per cron that fired.
- `task inspect` -- one instance's steps, retries and errors. `ID=<id>`, default latest.
- `task format` -- fix formatting in place.
- `task dev`, `task logs`, `task deploy` -- run locally, live logs, deploy by hand.

To prove a change for real, trigger a production instance with the payload a cron would have
given it:

```sh
npx wrangler workflows trigger dispatch '{"cron":"42 * * * *","scheduledTime":0}'
```

It dispatches for real. Without the JSON the instance has no cron to look up and throws.

## Notes

- Cloudflare parses the crons; this repo only looks up strings, so `0 * * * *` and
  `0 */1 * * *` are different keys.
- The free plan allows 5 cron expressions per Cloudflare account. Targets sharing an
  expression share a trigger.
- A newly added cron takes up to 15 minutes to propagate, so its first slot may be missed.
  Existing expressions keep firing across deploys.

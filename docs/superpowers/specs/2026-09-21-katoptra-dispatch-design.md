# katoptra/dispatch design

2026-09-21. Starts the katoptra mirrors' GitHub Actions workflows on a schedule, from a
systemd timer on one NixOS host.

## Purpose and scope

- Dispatches `workflow_dispatch` to katoptra repositories on fixed daily slots. It does not
  run work, poll run outcomes, or monitor the mirrors; each mirror pings its own healthcheck.
- katoptra repositories only. `jshvn/terraform`'s `drift.yml` stays on `jshvn/dispatch`.
- Code lives here. The host (`bendalloy.jgrid.net`) is configured in `jshvn/jgrid.net`.

## Requirements

1. systemd is the clock: a timer starts a oneshot, there is no long-running process.
2. 24 slots a day, `S0`..`S23`, at `HH:42` UTC. No daylight-saving handling of any kind.
3. Named slots are aliases of hourly slots: `Evening = S5`, `Overnight = S11`,
   `Morning = S17`, `Afternoon = S23` (Pacific 21, 03, 09, 15 in winter, an hour later in
   summer). `Hourly` is all 24.
4. At-most-once per slot per job, and catch-up after any outage: however many slots a job
   missed, it fires once, for its latest one. No lookback limit.
5. Errors go to the journal. One healthcheck ping per tick reports whether the tick was clean.

## Repositories

### katoptra/dispatch (this repo)

- Go module, standard library only.
- `flake.nix` outputs:
  - `packages.x86_64-linux.default`: `buildGoModule`, `vendorHash = null`; `checkPhase`
    runs `go vet` and `go test`, so a failing test fails the host's build.
  - `nixosModules.default`: the service below.
  - `checks`: the package, and the module evaluated in a minimal `nixosSystem`.
- `schedules/`: one Go file per repo, compiled into the binary. A schedule change is a
  commit here, then a `flake.lock` bump in `jshvn/jgrid.net`, then a deploy (the host's
  nightly pull-and-switch, or by hand).

### jshvn/jgrid.net (the host)

- Flake input `katoptra-dispatch`.
- `nix/fleet.nix`: `bendalloy = { roles = [ "dispatcher" ]; tunnels = [ "jgrid-net" ]; }`.
  No `lanIp`, no `publicTcpPorts`: the firewall is closed to the outside, as on iron and
  pewter; ssh arrives only through the tunnel. Portainer stays on, as on every host.
- `nix/roles/dispatcher.nix`: imports the module, enables it, adds three
  `jgrid.secretTemplates` entries from the jgrid.net vault item `bendalloy.jgrid.net`
  (`GITHUB_APP/id`, `GITHUB_APP/private_key`, `HEALTHCHECK/url`; field names settled when the
  item is made), and orders the service `after`/`wants` `jgrid-secrets.service` with a
  `ConditionPathExists` per secret file.
- Disk is 10 GB. Set `nix.gc` and a small `boot.loader.*.configurationLimit` on bendalloy.
  The host builds this package itself (not in cache.nixos.org), fetching the Go toolchain
  (~250 MB) until the next GC.

## The NixOS module

`services.katoptra-dispatch`:

| option               | type | meaning                                         |
|----------------------|------|-------------------------------------------------|
| `enable`             | bool |                                                 |
| `appIdFile`          | path | the GitHub App's id                             |
| `privateKeyFile`     | path | the App's private key, PKCS#1 or PKCS#8 PEM     |
| `healthcheckUrlFile` | path | the healthchecks.io ping URL                    |

It knows nothing of 1Password or jgrid: it takes file paths.

Units:

- `katoptra-dispatch.timer`: `OnCalendar=*:02/5` with `UTC` (fires :02, :07 .. :42 .. :57,
  so the slot minute is always a tick). No `Persistent=`: every tick reconciles from state.
- `katoptra-dispatch.service`: `Type=oneshot`, `DynamicUser=yes`,
  `StateDirectory=katoptra-dispatch`, `LoadCredential=` for the three files (root-owned 0400
  files stay unreadable to anyone else), `TimeoutStartSec=4min`, and the standard hardening
  (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, empty
  `CapabilityBoundingSet`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`).

## Schedules

```go
// schedules/ctan.go
var _ = register(Job{Repo: "katoptra/ctan", File: "sync.yml", Slots: Hourly})
```

`Slot` is a bitmask of UTC hours with named constants, so two slots are `Morning | Evening`
and a misspelt slot fails to compile. A job's identity
is `<repo>/<file>`, e.g. `katoptra/ctan/sync.yml`. Every dispatch is `ref: "main"` with empty
inputs; `ref` and `inputs` fields come back when a job needs them.

Starting set, carried over from `jshvn/dispatch`:

| job                          | slot      | UTC       |
|------------------------------|-----------|-----------|
| `katoptra/ctan/sync.yml`     | Hourly    | every :42 |
| `katoptra/tlnet/sync.yml`    | Evening   | 05:42     |
| `katoptra/dropbox/sync.yml`  | Overnight | 11:42     |
| `katoptra/github/sync.yml`   | Morning   | 17:42     |

A workflow added here must declare `workflow_dispatch`, a `concurrency` group with
`cancel-in-progress: false`, and ping its own healthcheck. Nothing here can check these.

## A tick

1. `flock` the state directory. systemd already refuses to start a running oneshot; the lock
   covers a hand-run binary.
2. Read `state.json`: job id to the last slot fired, an RFC 3339 UTC timestamp.
3. For each job, `due` is its latest registered slot time at or before now (today's and
   yesterday's slots are always enough).
4. A job fires when it has no entry, or when `due` is after its entry. An entry after `due`
   (clock went backwards) is a journal warning and no fire.
5. Write-ahead: record `due` for every job about to fire in one atomic write (temp file,
   fsync, rename, fsync the directory). Entries for jobs no longer in `schedules/` are
   dropped in the same write.
6. Dispatch each (below). Jobs are independent; one failing does not stop the rest.
7. Ping (below). Exit non-zero if anything failed.

Consequences:

- After any outage each job fires once, for its latest missed slot.
- A crash between the write and the POST loses that slot; it never repeats one.
- A new job fires once at the next tick.
- A tick with nothing due makes no GitHub calls; it only pings.

## Dispatching

Only when something is due:

1. Sign an App JWT (RS256, `iat` backdated 60 s, `exp` 9 min). The key parses as PKCS#1,
   falling back to PKCS#8.
2. `GET /orgs/katoptra/installation`, then `POST /app/installations/<id>/access_tokens`.
   The token lives in memory for the tick and is never written anywhere.
3. `POST /repos/<repo>/actions/workflows/<file>/dispatches` with
   `{"ref":"main","inputs":{}}`. Any 2xx is success.

Retries: 5xx, 408, 429 and network errors get three retries, after 10 s, 20 s, 40 s. Any other
4xx is fatal at once (missing workflow file, App not installed, missing permission) and the
error names the job.

## Errors, journal, ping

- One journal line per fire (`fired katoptra/ctan/sync.yml for slot 2026-09-21T17:42Z`) and
  per skip warning. Errors on stderr carry the sd-daemon `<3>` prefix, so
  `journalctl -p err -u katoptra-dispatch` finds them.
- The unit fails on any dispatch failure or state read/write failure. The next tick runs
  anyway: a timer starts a failed oneshot again.
- Ping, always last: a clean tick pings `<url>`; any error pings `<url>/fail` with the error
  lines as the body, truncated to 10 KB. Three quick attempts; a ping that never gets through
  is logged and does not change the exit code.
- Silence covers the rest: a dead host, a stopped timer, a hung tick. The healthchecks.io
  check is period 5 min, grace 10 min.
- A corrupt or unreadable `state.json` fails the tick loudly and fires nothing. It never
  falls back to empty state, which would repeat slots already fired. The fix is by hand;
  deleting the file means every job fires once, knowingly.

## The binary

`katoptra-dispatch` reads its secrets from `$CREDENTIALS_DIRECTORY` (files `app-id`,
`private-key`, `healthcheck-url`) and its state from `$STATE_DIRECTORY`. Two flags:
`--dry-run` prints what is due and why, writes nothing, POSTs nothing, pings nothing;
`--list` prints every job and its UTC slot times, for `task targets` and `task runs`.

## Testing

`go test`, run in the Nix `checkPhase` and in CI:

- Slot math, table-driven: :41:59 against :42:00, midnight crossing, yesterday's S23 seen at
  00:10, Hourly against a single named slot.
- The tick, with an injected clock, a fake dispatcher and a temp state directory: ten missed
  slots fire once; the same slot never fires twice; a dispatcher failing mid-POST leaves the
  slot recorded; corrupt state fires nothing and exits non-zero.
- GitHub, against `httptest`: 204 succeeds; 500 is retried; 404 is fatal without retry; the
  JWT verifies against the key's public half.
- Schedules: every job is under `katoptra/`, has at least one slot, and ids are unique.
- The module: `nix flake check` evaluates it. `ponytail:` no `nixosTest` VM; add one if a
  unit bug gets past evaluation.

## Repo tooling

- Taskfile with a banner menu: `task check` (vet, gofmt, test), `task targets` (schedules and
  their UTC times), `task runs` (recent `gh run list` per target).
- Tooling runs in a digest-pinned official `golang` image.
- `.github/workflows/check.yml` runs `task check` on pull requests.
- `README.md` for users, `CLAUDE.md` for the design.

## Cutover

Catch-up makes the order safe; there is no double-firing window.

1. Create a GitHub App owned by the `katoptra` org: Actions read and write, no webhook,
   installed on all repositories. Put its id, its key and a new healthchecks.io check's URL
   (period 5 min, grace 10 min) in the jgrid.net vault, item `bendalloy.jgrid.net`.
2. Provision bendalloy: tunnel in `jshvn/terraform`, fleet entry, `nix/roles/dispatcher.nix`,
   flake input, install.
3. Remove the four katoptra schedules from `jshvn/dispatch`; terraform stays.
4. Enable the service. Its first tick fires each job once, covering any slot missed between
   steps 3 and 4.
5. Watch each mirror's healthcheck and `task runs` through a day of slots.

## Decisions

- **Go over TypeScript on Node.** The host has 10 GB of disk; Node adds ~100-200 MB per
  generation kept, Go a few MB, and Go's compile is the type check inside the Nix build.
- **UTC, not Pacific.** No DST edge cases. Named slots drift an hour against Pacific in
  summer, as they do in `jshvn/dispatch` today.
- **One 5-minute timer, not a timer per slot.** A timer per slot with `Persistent=true`
  would fire each missed slot on recovery, not once per job.
- **Write-ahead state.** At-most-once over at-least-once: a lost slot is caught up by the
  next one; a duplicate would be a second run.
- **A katoptra-owned App, secrets in the jgrid.net vault.** Retiring either scheduler never
  touches the other's credentials, and the host's service account token gains no access to
  the mirrors' secrets.
- **`/fail` on a failed dispatch.** A typo in a schedule alerts within one tick instead of
  when a daily mirror's grace runs out.

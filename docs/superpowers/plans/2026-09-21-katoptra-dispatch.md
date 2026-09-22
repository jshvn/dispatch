# katoptra/dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Go binary plus NixOS module that dispatches the katoptra mirrors' workflows on
UTC slots from a 5-minute systemd timer, at most once per slot, with catch-up.

**Architecture:** `schedules/` holds slot types and the job list. The root `main` package is
a oneshot: lock, read state, plan what is due, write state ahead, dispatch through GitHub,
ping healthchecks. `module.nix` wraps it in a timer and a hardened service; `flake.nix`
exports both.

**Tech Stack:** Go 1.26 standard library, Nix flake (nixos-26.05), go-task, Apple
`container`/Docker with `golang:1.26-alpine`.

**Spec:** `docs/superpowers/specs/2026-09-21-katoptra-dispatch-design.md`

## Global Constraints

- Standard library only; `vendorHash = null`.
- Go 1.26: nixos-26.05's `buildGoModule` is `buildGo126Module`; the image is
  `golang:1.26-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c`.
- Slots `HH:42` UTC. `Evening = S5`, `Overnight = S11`, `Morning = S17`, `Afternoon = S23`.
- Timer `OnCalendar=*:02/5 UTC`. Service oneshot, `DynamicUser`, `StateDirectory`,
  `LoadCredential` files `app-id`, `private-key`, `healthcheck-url`, `TimeoutStartSec=4min`.
- Dispatch body `{"ref":"main","inputs":{}}`; any 2xx is success.
- Retries: 5xx, 408, 429, network errors; three retries after 10 s, 20 s, 40 s.
- Ping body truncated to 10 KB; three attempts.
- No AI attribution; commit format `<type>(<scope>): <summary>`.

## File map

| file | responsibility |
|---|---|
| `go.mod` | module `github.com/katoptra/dispatch`, `go 1.26` |
| `schedules/schedules.go` | `Slot` bitmask, names, `Latest`, `Job`, `Jobs()` |
| `schedules/{ctan,tlnet,dropbox,github}.go` | one repo each |
| `schedules/schedules_test.go` | slot math table; registry sanity |
| `tick.go` | `State`, load/save, `Plan`, `Tick` |
| `tick_test.go` | catch-up, no repeat, write-ahead, corrupt state |
| `github.go` | key parse, JWT, installation token, dispatch, retry |
| `github_test.go` | httptest: 204, 500 retried, 404 fatal, JWT verifies |
| `main.go` | flags, credentials, logging, ping, exit code |
| `module.nix`, `flake.nix`, `flake.lock` | NixOS module and flake |
| `Dockerfile`, `Taskfile.yml`, `.github/workflows/check.yml` | tooling, CI |
| `README.md`, `CLAUDE.md`, `.gitignore` | docs |

### Task 1: Slots and schedules

**Interfaces — Produces:**
- `type Slot uint32`; `S0`..`S23`; `Evening, Overnight, Morning, Afternoon, Hourly Slot`
- `func (s Slot) Latest(now time.Time) (time.Time, bool)` — latest `HH:42` UTC at or before
  `now` among the set bits; false when `s == 0`
- `type Job struct{ Repo, File string; Slots Slot }`; `func (j Job) ID() string` = `Repo+"/"+File`
- `func Jobs() []Job`

- [ ] Test: table for `Latest` — `Hourly` at 12:41:59 -> 11:42; at 12:42:00 -> 12:42;
  `Afternoon` at 00:10 -> yesterday 23:42; `Evening` at 05:41 -> yesterday 05:42;
  `Morning|Evening` at 18:00 -> 17:42; `0` -> false. Registry: all under `katoptra/`,
  non-zero slots, unique IDs.
- [ ] Run `go test ./schedules/` — fails (undefined).
- [ ] Implement; run — passes. Commit `feat(schedules): add utc slots and the katoptra jobs`.

### Task 2: State and the tick

**Interfaces — Consumes:** `schedules.Job`, `Slot.Latest`.
**Produces:**
- `type State map[string]time.Time`
- `func LoadState(dir string) (State, error)` — missing file is empty state; unreadable or
  corrupt is an error
- `func SaveState(dir string, s State) error` — temp, fsync, rename, fsync dir
- `type Fire struct{ Job schedules.Job; Slot time.Time }`
- `func Plan(jobs []schedules.Job, s State, now time.Time) (fires []Fire, warnings []string)`
- `type Dispatcher interface{ Dispatch(ctx context.Context, repo, file string) error }`
- `func Tick(ctx context.Context, dir string, jobs []schedules.Job, now time.Time, d Dispatcher, dryRun bool, log *Log) error`
- `type Log struct` with `Info`, `Warn`, `Error(format, ...)` and `Errors() []string`

- [ ] Tests: ten missed hourly slots fire once with the latest slot; second tick in the same
  slot fires nothing; dispatcher reading `state.json` during `Dispatch` sees its slot
  (write-ahead); dispatch failure still records the slot and `Tick` returns an error;
  corrupt `state.json` dispatches nothing and errors; clock behind state warns, no fire;
  removed job's entry is dropped; dry run writes nothing and dispatches nothing.
- [ ] Run — fails. Implement with `syscall.Flock` on the directory. Run — passes.
  Commit `feat(tick): plan due slots and record them before dispatch`.

### Task 3: GitHub

**Produces:**
- `func ParseKey(pem []byte) (*rsa.PrivateKey, error)` — PKCS#1, then PKCS#8
- `func AppJWT(appID string, key *rsa.PrivateKey, now time.Time) (string, error)`
- `type GitHub struct{ API, AppID, Org string; Key *rsa.PrivateKey; HTTP *http.Client; Sleep func(time.Duration) }` implementing `Dispatcher`; mints one token lazily per process
- `type StatusError struct{ Status int; Msg string }`; `func fatal(err error) bool`

- [ ] Tests (httptest): full happy path hits installation, token, dispatch with the body
  above; a 500 then 204 dispatch succeeds after one retry (Sleep recorded 10 s); 404 fails
  with no retry; JWT signature verifies with `rsa.VerifyPKCS1v15`; PKCS#8 key parses.
- [ ] Run — fails. Implement. Run — passes. Commit `feat(github): mint app tokens and dispatch workflows`.

### Task 4: main, ping

- [ ] `main.go`: `--dry-run`; reads `$STATE_DIRECTORY` and, unless dry run,
  `$CREDENTIALS_DIRECTORY/{app-id,private-key,healthcheck-url}`; runs `Tick`; pings
  `<url>` or `<url>/fail` with `Log.Errors()` joined (10 KB cap, three attempts); exit 1 on
  any error. Journal priority prefixes `<3>`/`<4>` only when `JOURNAL_STREAM` is set.
- [ ] Test: `ping` against httptest — clean posts to `/`, failure posts to `/fail` with body
  capped at 10 KB. Commit `feat: wire the tick, credentials and healthcheck ping`.

### Task 5: Nix

- [ ] `flake.nix`: packages (buildGoModule, `preCheck = "go vet ./..."`), `nixosModules.default`,
  `checks` building the package and the two generated unit files from a minimal
  `nixosSystem`. `module.nix` per the spec. Generate `flake.lock` and run `nix flake check`
  inside `nixos/nix`. Commit `feat(nix): add the flake and the nixos module`.

### Task 6: Tooling and docs

- [ ] `Dockerfile` (golang 1.26 alpine, digest), `Taskfile.yml` (banner; `check`, `targets`,
  `runs`, `run`, `image`, `clean`), `check.yml`, `README.md`, `CLAUDE.md`, `.gitignore`.
  `task check` green. Commit `chore: add toolbox image, taskfile, ci and docs`.

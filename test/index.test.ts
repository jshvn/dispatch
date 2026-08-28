import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env, Params } from "../src/index"
import { instanceId, selectTargets, TARGETS } from "../src/targets"

// src/index.ts: the two handlers and the instance body. Everything GitHub-facing is mocked
// -- what matters here is which targets get a step, what reaches the instance, and that the
// fetch handler stays inert.
vi.mock("../src/github", () => ({
  appJwt: vi.fn(async () => "jwt"),
  installationToken: vi.fn(async () => "tok"),
  dispatchWorkflow: vi.fn(async () => undefined),
  isFatal: vi.fn(() => false),
}))

const { Dispatch, default: worker } = await import("../src/index")
const github = await import("../src/github")

/** An env whose Workflow binding records every instance asked for and creates none. */
const recordingEnv = () => {
  const created: { id: string; params: Params }[] = []
  const env = {
    DISPATCH: {
      create: vi.fn(async () => {
        throw new Error("create() must not be called; scheduled uses createBatch")
      }),
      createBatch: vi.fn(async (batch: { id: string; params: Params }[]) => {
        created.push(...batch)
      }),
    },
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "pem",
    GITHUB_APP_INSTALLATION_ID: "2",
  }
  return { created, env: env as unknown as Env }
}

/** A step that runs its callback inline and remembers the step names, in order. */
const recordingStep = () => {
  const names: string[] = []
  const step = {
    do: async (name: string, _opts: unknown, fn: () => Promise<unknown>) => {
      names.push(name)
      return fn()
    },
  }
  return { names, step: step as unknown as WorkflowStep }
}

const runWith = (payload: Partial<Params>, env: Env, step: WorkflowStep) =>
  new Dispatch(undefined as never, env).run({ payload } as unknown as WorkflowEvent<Params>, step)

// The handler declares no parameters at all, so within this codebase it cannot reach the
// binding even if it wanted to. Handing it one anyway is what shows the runtime agrees.
const callFetch = worker.fetch as unknown as (req: Request, env: Env) => Response

describe("fetch handler", () => {
  it("404s and never creates an instance", async () => {
    const { created, env } = recordingEnv()
    const res = callFetch(new Request("https://dispatch/"), env)

    expect(res.status).toBe(404)
    expect(created).toEqual([])
    expect(env.DISPATCH.create).not.toHaveBeenCalled()
    expect(env.DISPATCH.createBatch).not.toHaveBeenCalled()
  })

  it("stays a 404 for the paths that would be worth guessing", async () => {
    const { env } = recordingEnv()
    for (const path of ["/", "/__scheduled", "/dispatch", "/42%20*%20*%20*%20*"]) {
      const res = callFetch(new Request(`https://dispatch${path}`), env)
      expect(res.status, path).toBe(404)
    }
  })
})

describe("scheduled handler", () => {
  it("asks for exactly one instance, keyed to the slot, carrying the cron", async () => {
    const { created, env } = recordingEnv()
    const at = 1_756_000_000_000
    await worker.scheduled({ cron: "42 * * * *", scheduledTime: at } as ScheduledController, env)

    expect(created).toEqual([
      { id: instanceId("42 * * * *", at), params: { cron: "42 * * * *", scheduledTime: at } },
    ])
  })

  it("gives the same slot the same id twice, so a repeated invocation collides", async () => {
    const { created, env } = recordingEnv()
    const slot = { cron: "42 * * * *", scheduledTime: 1_756_000_000_000 } as ScheduledController
    await worker.scheduled(slot, env)
    await worker.scheduled(slot, env)

    expect(created[0]?.id).toBe(created[1]?.id)
  })
})

describe("Dispatch.run", () => {
  beforeEach(() => vi.mocked(github.dispatchWorkflow).mockClear())

  it("throws when the instance carries no cron", async () => {
    const { env } = recordingEnv()
    await expect(runWith({}, env, recordingStep().step)).rejects.toThrow(/no cron/)
  })

  it("throws when no target claims the cron", async () => {
    const { env } = recordingEnv()
    const { step } = recordingStep()
    await expect(runWith({ cron: "0 0 31 2 *" }, env, step)).rejects.toThrow(/no target/)
  })

  it("runs one step per target and reports what it dispatched", async () => {
    const { env } = recordingEnv()
    const { names, step } = recordingStep()
    const cron = TARGETS[0]?.cron as string
    const claiming = selectTargets(cron)

    const out = await runWith({ cron, scheduledTime: 0 }, env, step)

    expect(names).toEqual(claiming.map((t) => `dispatch ${t.repo} ${t.workflow}`))
    expect(out.dispatched).toEqual(claiming.map((t) => `${t.repo}/${t.workflow}`))
    expect(vi.mocked(github.dispatchWorkflow)).toHaveBeenCalledTimes(claiming.length)
  })

  it("mints the token inside the step and keeps it out of the step's output", async () => {
    const { env } = recordingEnv()
    const outputs: unknown[] = []
    const step = {
      do: async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => {
        const out = await fn()
        outputs.push(out)
        return out
      },
    } as unknown as WorkflowStep

    await runWith({ cron: TARGETS[0]?.cron as string, scheduledTime: 0 }, env, step)

    // Step output persists for three days. A token reaching it would be a stored credential.
    expect(vi.mocked(github.installationToken)).toHaveBeenCalled()
    for (const out of outputs) expect(JSON.stringify(out)).not.toContain("tok")
  })
})

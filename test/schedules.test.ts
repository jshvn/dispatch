import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { crons, selectTargets, TARGETS } from "../schedules"

const dir = join(import.meta.dirname, "../schedules")

// wrangler.jsonc is JSON with // comments. No cron or key in it contains "//", so stripping
// line comments is enough; a URL in that file would break this.
const wrangler = JSON.parse(
  readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
)
const configured: string[] = wrangler.triggers.crons

/** The name a repo's file must carry: the half of "owner/name" after the slash. */
const fileNames = () =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => f.replace(/\.ts$/, ""))

// The fragile seam: the crons live in schedules/ and again in wrangler.jsonc, which is JSON
// and cannot import. `task crons` writes the second from the first, and this is what says it
// was run. A mismatch is either a trigger firing into nothing or a target that never runs,
// and neither is visible at deploy.
describe("wrangler.jsonc and schedules/ agree", () => {
  it("carries exactly the crons schedules/ asks for, in the generated order", () => {
    expect(configured, "run `task crons`").toEqual(crons())
  })

  // 5 cron expressions per Cloudflare account on the free plan, shared by every Worker on
  // it. Deploy is where this is otherwise found out.
  it("stays inside the free plan's five expressions per account", () => {
    expect(crons().length, crons().join(", ")).toBeLessThanOrEqual(5)
  })
})

// index.ts imports each file by name -- Workers bundling is static, so there is no glob. A
// file nobody imported never runs, and nothing else in the repo would notice.
describe("the registry in schedules/index.ts", () => {
  it("imports every file in schedules/", () => {
    const named = new Set(TARGETS.map((t) => t.repo.split("/")[1]))
    expect(fileNames().filter((f) => !named.has(f))).toEqual([])
  })

  it("has a file named for every repo it registers", () => {
    const files = new Set(fileNames())
    const named = [...new Set(TARGETS.map((t) => t.repo.split("/")[1] as string))]
    expect(named.filter((n) => !files.has(n))).toEqual([])
  })

  // One workflow on two expressions is legitimate -- a second slot for the same workload.
  // Two identical entries are not: they would dispatch the same run twice in one firing.
  it("registers no repo, workflow and cron triple twice", () => {
    const keys = TARGETS.map((t) => `${t.repo}/${t.workflow}@${t.cron}`)
    expect(keys.length).toBe(new Set(keys).size)
  })

  it("names a workflow file and an owner/name repo on every target", () => {
    for (const t of TARGETS) {
      expect(t.repo, t.repo).toMatch(/^[\w.-]+\/[\w.-]+$/)
      expect(t.workflow, t.workflow).toMatch(/\.ya?ml$/)
    }
  })
})

describe("crons", () => {
  const targets = [
    { repo: "o/b", workflow: "b.yml", cron: "30 3 * * *" },
    { repo: "o/a", workflow: "a.yml", cron: "0 * * * *" },
    { repo: "o/c", workflow: "c.yml", cron: "30 3 * * *" },
  ]

  it("dedupes an expression more than one target claims", () => {
    expect(crons(targets)).toEqual(["0 * * * *", "30 3 * * *"])
  })

  // The array it writes is generated, so its order has to come from the crons themselves
  // and not from the order the repos happen to be imported in.
  it("sorts, so reordering the registry does not rewrite wrangler.jsonc", () => {
    const moved = [targets[1], targets[2], targets[0]] as typeof targets
    expect(crons(moved)).toEqual(crons(targets))
  })

  // Lookup is verbatim everywhere else in this repo, so two spellings are two expressions
  // here too, and both have to reach wrangler.jsonc.
  it("keeps two spellings of one schedule apart", () => {
    const spellings = [
      { repo: "o/a", workflow: "a.yml", cron: "0 0 * * sun" },
      { repo: "o/b", workflow: "b.yml", cron: "0 0 * * SUN" },
    ]
    expect(crons(spellings)).toHaveLength(2)
  })
})

describe("selectTargets", () => {
  const targets = [
    { repo: "o/a", workflow: "a.yml", cron: "0 * * * *" },
    { repo: "o/b", workflow: "b.yml", cron: "0 * * * *" },
    { repo: "o/c", workflow: "c.yml", cron: "30 3 * * *" },
  ]

  it("returns every target sharing the expression", () => {
    expect(selectTargets("0 * * * *", targets).map((t) => t.repo)).toEqual(["o/a", "o/b"])
  })

  it("matches the expression verbatim, never by equivalence", () => {
    // "0 */1 * * *" means the same thing to cron, but Cloudflare hands back the literal
    // string it was configured with, so the lookup is exact.
    expect(selectTargets("0 */1 * * *", targets)).toEqual([])
  })

  it("returns nothing for an unclaimed expression", () => {
    expect(selectTargets("@daily", targets)).toEqual([])
  })
})

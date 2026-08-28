import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { appJwt, dispatchWorkflow } from "../src/github"
import { selectTargets, TARGETS } from "../src/targets"

// wrangler.jsonc is JSON with // comments. No cron or key in it contains "//", so stripping
// line comments is enough; a URL in that file would break this.
const wrangler = JSON.parse(
  readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
)
const schedules: string[] = wrangler.triggers.crons

// The fragile seam: the same cron strings live in two files, and a mismatch means either a
// trigger that fires into nothing or a target that never runs. Neither is visible at deploy.
describe("targets and wrangler cron triggers agree", () => {
  it("every target's cron is a trigger in wrangler.jsonc", () => {
    const missing = TARGETS.filter((t) => !schedules.includes(t.cron))
    expect(
      missing,
      `add to wrangler triggers.crons: ${JSON.stringify(missing.map((t) => t.cron))}`,
    ).toEqual([])
  })

  it("every wrangler cron trigger is claimed by a target", () => {
    const crons = new Set(TARGETS.map((t) => t.cron))
    expect(schedules.filter((c) => !crons.has(c))).toEqual([])
  })

  // One workflow on two expressions is legitimate -- a second slot for the same workload.
  // Two identical entries are not: they would dispatch the same run twice in one firing.
  it("no repo, workflow and cron triple appears twice", () => {
    const keys = TARGETS.map((t) => `${t.repo}/${t.workflow}@${t.cron}`)
    expect(keys.length).toBe(new Set(keys).size)
  })

  it("every target names a workflow file and an owner/name repo", () => {
    for (const t of TARGETS) {
      expect(t.repo, t.repo).toMatch(/^[\w.-]+\/[\w.-]+$/)
      expect(t.workflow, t.workflow).toMatch(/\.ya?ml$/)
    }
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

const PEM_HEAD = `-----BEGIN ${"PRIVATE KEY"}-----`
const PEM_TAIL = `-----END ${"PRIVATE KEY"}-----`

// atob/btoa rather than Buffer: the code under test runs on Workers, which has no Buffer.
const toBase64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const fromBase64Url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))

const generatePkcs8Pem = async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer
  const b64 = toBase64(der).replace(/(.{64})/g, "$1\n")
  return { pem: `${PEM_HEAD}\n${b64}\n${PEM_TAIL}\n`, pair }
}

describe("appJwt", () => {
  it("signs claims GitHub accepts and verifies against the public key", async () => {
    const { pem, pair } = await generatePkcs8Pem()
    const now = 1_756_000_000_000
    const jwt = await appJwt("123456", pem, now)

    const [header, claims, sig] = jwt.split(".")
    const json = (s: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(s)))
    expect(json(header as string)).toEqual({ alg: "RS256", typ: "JWT" })
    expect(json(claims as string)).toEqual({
      iss: "123456",
      iat: now / 1000 - 60, // backdated; GitHub rejects a future iat
      exp: now / 1000 - 60 + 540, // inside GitHub's 10 minute ceiling
    })

    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      fromBase64Url(sig as string),
      new TextEncoder().encode(`${header}.${claims}`),
    )
    expect(verified).toBe(true)
  })

  it("rejects a PKCS#1 key with the conversion command", async () => {
    const pkcs1 = `-----BEGIN RSA ${"PRIVATE KEY"}-----\nAAAA\n-----END RSA ${"PRIVATE KEY"}-----`
    await expect(appJwt("1", pkcs1)).rejects.toThrow(/openssl pkcs8 -topk8/)
  })
})

describe("dispatchWorkflow", () => {
  const target = { repo: "jshvn/ctan", workflow: "sync.yml" }
  const responding = (status: number, body: string | null = null) => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init as RequestInit })
      return new Response(body, { status })
    }
    return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
  }

  it("posts to the dispatches endpoint, defaulting the ref to main", async () => {
    const { calls, fetch } = responding(204)
    await dispatchWorkflow("tok", target, fetch)

    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/jshvn/ctan/actions/workflows/sync.yml/dispatches",
    )
    expect(calls[0]?.init.method).toBe("POST")
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ ref: "main", inputs: {} })
  })

  it("sends the target's own ref and inputs when given", async () => {
    const { calls, fetch } = responding(204)
    await dispatchWorkflow("tok", { ...target, ref: "trunk", inputs: { seed: "true" } }, fetch)
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      ref: "trunk",
      inputs: { seed: "true" },
    })
  })

  it("throws on anything but 204, so the step retries", async () => {
    const { fetch } = responding(404, "not found")
    await expect(dispatchWorkflow("tok", target, fetch)).rejects.toThrow(/404/)
  })
})

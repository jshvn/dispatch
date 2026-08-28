// Minting an installation token and dispatching a workflow. No SDK: two requests.

const API = "https://api.github.com"
const UA = "jshvn-dispatch"

/** A refusal from GitHub, carrying the status so the caller can decide whether to retry. */
export class GitHubError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * GitHub refused the request itself -- a missing workflow file, an App without
 * `actions: write`, a ref that does not exist. Retrying cannot change the answer, so the
 * step should fail now and say so rather than spend three attempts on a typo. 429 and 408
 * are the two 4xx that do clear on their own.
 */
export const isFatal = (err: unknown): boolean =>
  err instanceof GitHubError &&
  err.status >= 400 &&
  err.status < 500 &&
  ![408, 429].includes(err.status)

const b64url = (bytes: ArrayBuffer): string => {
  let s = ""
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const b64urlJson = (value: unknown): string =>
  b64url(new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer)

/**
 * GitHub issues App keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto only imports
 * PKCS#8. Convert once before storing the secret:
 *   openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
 */
const importKey = (pkcs8Pem: string): Promise<CryptoKey> => {
  if (pkcs8Pem.includes("BEGIN RSA PRIVATE KEY"))
    throw new Error("private key is PKCS#1; convert it with `openssl pkcs8 -topk8 -nocrypt`")
  const body = pkcs8Pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
}

/** A short-lived App JWT. Backdated 60s because GitHub rejects a future `iat`. */
export const appJwt = async (
  appId: string,
  pkcs8Pem: string,
  now = Date.now(),
): Promise<string> => {
  const iat = Math.floor(now / 1000) - 60
  const signed = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({ iat, exp: iat + 540, iss: appId })}`
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importKey(pkcs8Pem),
    new TextEncoder().encode(signed),
  )
  return `${signed}.${b64url(sig)}`
}

const headers = (auth: string) => ({
  authorization: `Bearer ${auth}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": UA,
})

/** Exchange an App JWT for an installation token. Valid one hour; never persisted. */
export const installationToken = async (
  jwt: string,
  installationId: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> => {
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: headers(jwt),
  })
  if (!res.ok)
    throw new GitHubError(res.status, `installation token: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { token?: string }
  if (!body.token) throw new Error("installation token: response carried no token")
  return body.token
}

/** POST a workflow_dispatch. GitHub answers 204 with no body, so there is no run id here. */
export const dispatchWorkflow = async (
  token: string,
  target: { repo: string; workflow: string; ref?: string; inputs?: Record<string, string> },
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> => {
  const url = `${API}/repos/${target.repo}/actions/workflows/${target.workflow}/dispatches`
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers(token), "content-type": "application/json" },
    body: JSON.stringify({ ref: target.ref ?? "main", inputs: target.inputs ?? {} }),
  })
  if (res.status !== 204)
    throw new GitHubError(
      res.status,
      `dispatch ${target.repo}/${target.workflow}: ${res.status} ${await res.text()}`,
    )
}

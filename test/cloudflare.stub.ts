// Runtime stand-ins for the `cloudflare:` modules, aliased in by vitest.config.ts so
// src/index.ts can be imported under plain Node. Types still come from the real ambient
// declarations in worker-configuration.d.ts -- the alias is resolution only, so tsc checks
// the production shapes and only the runtime is substituted here.

/** The real one hands the constructor its context and env, which is all `run` uses. */
export class WorkflowEntrypoint<E = unknown> {
  protected ctx: unknown
  protected env: E
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx
    this.env = env
  }
}

/** Thrown to tell a step not to spend its remaining retries. */
export class NonRetryableError extends Error {}

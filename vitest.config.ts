import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// `cloudflare:workers` and `cloudflare:workflows` only exist inside workerd. Aliasing both
// to one stub is what lets the suite import src/index.ts and cover the scheduled and fetch
// handlers without pulling in a Workers test runtime.
const stub = fileURLToPath(new URL("./test/cloudflare.stub.ts", import.meta.url))

export default defineConfig({
  test: {
    alias: {
      "cloudflare:workers": stub,
      "cloudflare:workflows": stub,
    },
  },
})

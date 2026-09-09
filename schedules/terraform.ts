// jshvn/terraform -- Cloudflare as code. drift.yml plans every onboarded stack against
// what is live, with no diff filter on purpose, and opens an issue on a finding.
export default {
  repo: "jshvn/terraform",
  workflows: [{ workflow: "drift.yml", slots: ["evening"] }],
} as const

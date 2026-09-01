// jshvn/terraform -- Cloudflare as code. drift.yml plans every onboarded stack against
// what is live, with no diff filter on purpose, and opens an issue on a finding.
export default {
  repo: "jshvn/terraform",
  workflows: [
    // Nightly, minutes offset from the hour: GitHub sheds top-of-the-hour dispatches first.
    { workflow: "drift.yml", cron: "15 4 * * *" },
  ],
}

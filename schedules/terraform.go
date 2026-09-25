package schedules

// jshvn/terraform is Cloudflare as code. drift.yml plans every onboarded stack against what
// is live, opens an issue on a finding, and pings its own healthcheck.
var _ = register(Job{Repo: "jshvn/terraform", File: "drift.yml", Slots: Evening})

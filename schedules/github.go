package schedules

// jshvn/github bundles every repo of jshvn and katoptra into Proton Drive, and pings its own
// healthcheck.
var _ = register(Job{Repo: "jshvn/github", File: "sync.yml", Slots: Morning})

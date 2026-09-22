package schedules

// katoptra/github mirrors every repository under jshvn and katoptra into Proton Drive.
var _ = register(Job{Repo: "katoptra/github", File: "sync.yml", Slots: Morning})

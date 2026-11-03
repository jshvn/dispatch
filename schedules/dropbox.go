package schedules

// jshvn/dropbox copies my Dropbox account into Proton Drive. A run with batches left starts
// the next one itself, so one start a day is enough. It pings its own healthcheck.
var _ = register(Job{Repo: "jshvn/dropbox", File: "sync.yml", Slots: Overnight})

package schedules

// katoptra/dropbox mirrors a Dropbox account into Proton Drive. The run chains itself until
// every batch is done, so one dispatch a day starts the whole pass.
var _ = register(Job{Repo: "katoptra/dropbox", File: "sync.yml", Slots: Overnight})

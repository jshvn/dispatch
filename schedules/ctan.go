package schedules

// katoptra/ctan mirrors CTAN into R2.
var _ = register(Job{Repo: "katoptra/ctan", File: "sync.yml", Slots: Hourly})

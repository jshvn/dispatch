package schedules

// katoptra/tlnet mirrors the TeX Live network installation tree.
var _ = register(Job{Repo: "katoptra/tlnet", File: "sync.yml", Slots: Evening})

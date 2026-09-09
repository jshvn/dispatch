// katoptra/dropbox -- mirrors a Dropbox account into Proton Drive. The run chains itself
// until every batch is done, so one dispatch a day starts the whole pass.
export default {
  repo: "katoptra/dropbox",
  workflows: [{ workflow: "sync.yml", slots: ["overnight"] }],
} as const

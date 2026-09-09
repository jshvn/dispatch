// katoptra/dropbox -- mirrors a Dropbox account into Proton Drive. The run chains itself
// until every batch is done, so one dispatch a day starts the whole pass.
export default {
  repo: "katoptra/dropbox",
  workflows: [
    // Nightly at 03:20 PST, 04:20 PDT. Minutes offset from the hour on purpose.
    { workflow: "sync.yml", cron: "20 11 * * *" },
  ],
}

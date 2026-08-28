// jshvn/ctan -- mirrors CTAN and republishes it.
export default {
  repo: "jshvn/ctan",
  workflows: [
    // Hourly. GitHub's own schedule: event delivered 3 of 51 consecutive slots here, which
    // is what this repo exists to replace.
    { workflow: "sync.yml", cron: "42 * * * *" },
  ],
}

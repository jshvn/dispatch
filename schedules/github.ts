// katoptra/github -- mirrors every repository under jshvn and katoptra into Proton Drive.
export default {
  repo: "katoptra/github",
  workflows: [{ workflow: "sync.yml", slots: ["morning"] }],
} as const

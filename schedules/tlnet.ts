// katoptra/tlnet -- mirrors the TeX Live network installation tree.
export default {
  repo: "katoptra/tlnet",
  workflows: [{ workflow: "sync.yml", slots: ["evening"] }],
} as const

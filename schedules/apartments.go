package schedules

import "time"

// jshvn/apartments watches apartment pricing pages. watch.yml reports new, gone and repriced
// units as a comment on its report issue, which is also where a failed run says so. It pings
// no healthcheck, by choice: a run GitHub accepts and never starts goes unnoticed. Every four
// hours, each up to half an hour late, so the scrape does not land on a clock.
var _ = register(Job{
	Repo:   "jshvn/apartments",
	File:   "watch.yml",
	Slots:  S0 | S4 | S8 | S12 | S16 | S20,
	Jitter: 30 * time.Minute,
})

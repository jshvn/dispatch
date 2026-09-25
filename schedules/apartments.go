package schedules

import "time"

// jshvn/apartments watches apartment pricing pages. watch.yml reports new, gone and repriced
// units as a comment on its report issue, which is also where a failed run says so. It pings
// no healthcheck, by choice: a run GitHub accepts and never starts goes unnoticed. Every other
// hour from 07:42 to 19:42 PST (08:42 to 20:42 PDT), each up to half an hour late, so the
// scrape does not land on a clock. Nothing runs between 22:00 and 06:00 Pacific in either
// season.
var _ = register(Job{
	Repo:   "jshvn/apartments",
	File:   "watch.yml",
	Slots:  S1 | S3 | S15 | S17 | S19 | S21 | S23,
	Jitter: 30 * time.Minute,
})

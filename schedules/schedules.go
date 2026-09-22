// Package schedules is what the scheduler starts, and when. One file per katoptra repo,
// named for the half of "owner/name" after the slash, each adding its jobs to the list
// below. Changing what runs touches only this directory.
//
// Before adding a workflow, confirm all three. Nothing here can check them, and a workflow
// that fails any of them is dispatched into silence:
//
//  1. It declares `workflow_dispatch:` in `on:`.
//  2. It declares a `concurrency` group with `cancel-in-progress: false`, so a dispatch
//     arriving during a run queues instead of doubling up.
//  3. The workload pings its own healthcheck. This repo never learns whether a run passed.
package schedules

import (
	"fmt"
	"strings"
	"time"
)

// Slot is a set of hours of the UTC day. Each hour's slot fires at HH:42. Slots combine
// with |, so a job in two slots says `Morning | Evening`, and a misspelt name fails to
// compile.
type Slot uint32

// The 24 hourly slots, S0 at 00:42 UTC through S23 at 23:42 UTC.
const (
	S0 Slot = 1 << iota
	S1
	S2
	S3
	S4
	S5
	S6
	S7
	S8
	S9
	S10
	S11
	S12
	S13
	S14
	S15
	S16
	S17
	S18
	S19
	S20
	S21
	S22
	S23
)

// Names for the daily slots, six hours apart. Pacific in the comments is winter time; in
// summer each is an hour later.
const (
	Evening   = S5  // 05:42 UTC, 21:42 PST
	Overnight = S11 // 11:42 UTC, 03:42 PST
	Morning   = S17 // 17:42 UTC, 09:42 PST
	Afternoon = S23 // 23:42 UTC, 15:42 PST
	Hourly    = Slot(1<<24 - 1)
)

// Minute is the minute past the hour every slot fires at: off the hour, which GitHub sheds
// first, and on a tick of the */5 timer that starts at :02.
const Minute = 42

// Latest is the most recent slot time in s at or before now, in UTC. Today's and
// yesterday's slots are always enough to find it. False when s holds no hour.
func (s Slot) Latest(now time.Time) (time.Time, bool) {
	now = now.UTC()
	for day := 0; day < 2; day++ {
		d := now.AddDate(0, 0, -day)
		for hour := 23; hour >= 0; hour-- {
			if s&(1<<hour) == 0 {
				continue
			}
			t := time.Date(d.Year(), d.Month(), d.Day(), hour, Minute, 0, 0, time.UTC)
			if !t.After(now) {
				return t, true
			}
		}
	}
	return time.Time{}, false
}

// Times is each slot's firing time, "HH:42" UTC, earliest first.
func (s Slot) Times() []string {
	var out []string
	for hour := 0; hour < 24; hour++ {
		if s&(1<<hour) != 0 {
			out = append(out, fmt.Sprintf("%02d:%02d", hour, Minute))
		}
	}
	return out
}

var names = map[Slot]string{
	Hourly: "Hourly", Evening: "Evening", Overnight: "Overnight", Morning: "Morning", Afternoon: "Afternoon",
}

// String names s as a schedule file would: "Hourly", "Morning", "Evening | Morning", "S3".
func (s Slot) String() string {
	if n, ok := names[s]; ok {
		return n
	}
	var parts []string
	for hour := 0; hour < 24; hour++ {
		h := Slot(1) << hour
		if s&h == 0 {
			continue
		}
		if n, ok := names[h]; ok {
			parts = append(parts, n)
		} else {
			parts = append(parts, fmt.Sprintf("S%d", hour))
		}
	}
	return strings.Join(parts, " | ")
}

// Job is one workflow in one repo, dispatched on `main` in every slot it holds.
type Job struct {
	Repo  string // "katoptra/<name>"
	File  string // workflow file name, e.g. "sync.yml"
	Slots Slot
}

// ID is the job's key in the state file: "katoptra/ctan/sync.yml".
func (j Job) ID() string { return j.Repo + "/" + j.File }

var jobs []Job

func register(j ...Job) bool {
	jobs = append(jobs, j...)
	return true
}

// Jobs is every registered job.
func Jobs() []Job { return append([]Job(nil), jobs...) }

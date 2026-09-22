package schedules

import (
	"strings"
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestLatest(t *testing.T) {
	cases := []struct {
		name  string
		slots Slot
		now   string
		want  string
	}{
		{"hourly, a second before the minute", Hourly, "2026-09-21T12:41:59Z", "2026-09-21T11:42:00Z"},
		{"hourly, on the minute", Hourly, "2026-09-21T12:42:00Z", "2026-09-21T12:42:00Z"},
		{"hourly, just after midnight", Hourly, "2026-09-21T00:10:00Z", "2026-09-20T23:42:00Z"},
		{"afternoon seen at 00:10 is yesterday's", Afternoon, "2026-09-21T00:10:00Z", "2026-09-20T23:42:00Z"},
		{"evening before its minute is yesterday's", Evening, "2026-09-21T05:41:00Z", "2026-09-20T05:42:00Z"},
		{"two named slots pick the later", Morning | Evening, "2026-09-21T18:00:00Z", "2026-09-21T17:42:00Z"},
		{"a non-UTC clock gives the same answer", Morning, "2026-09-21T11:00:00-07:00", "2026-09-21T17:42:00Z"},
	}
	for _, c := range cases {
		got, ok := c.slots.Latest(at(c.now))
		if !ok || !got.Equal(at(c.want)) {
			t.Errorf("%s: Latest(%s) = %v, %v; want %s", c.name, c.now, got, ok, c.want)
		}
	}
	if _, ok := Slot(0).Latest(at("2026-09-21T12:00:00Z")); ok {
		t.Error("an empty slot set has no latest slot")
	}
}

func TestNamedSlots(t *testing.T) {
	for name, pair := range map[string][2]Slot{
		"evening": {Evening, S5}, "overnight": {Overnight, S11},
		"morning": {Morning, S17}, "afternoon": {Afternoon, S23},
	} {
		if pair[0] != pair[1] {
			t.Errorf("%s is not its hour", name)
		}
	}
	if got := (Morning | Evening).Times(); len(got) != 2 || got[0] != "05:42" || got[1] != "17:42" {
		t.Errorf("Times() = %v", got)
	}
	for slot, want := range map[Slot]string{Hourly: "Hourly", Morning: "Morning", Morning | Evening: "Evening | Morning", S3 | Morning: "S3 | Morning"} {
		if slot.String() != want {
			t.Errorf("String() = %q, want %q", slot.String(), want)
		}
	}
	if Hourly != 1<<24-1 {
		t.Error("hourly is not all 24 slots")
	}
}

func TestJobs(t *testing.T) {
	seen := map[string]bool{}
	for _, j := range Jobs() {
		if !strings.HasPrefix(j.Repo, "katoptra/") || strings.Count(j.Repo, "/") != 1 {
			t.Errorf("%s: not a katoptra repository", j.ID())
		}
		if j.Slots == 0 || j.Slots > Hourly {
			t.Errorf("%s: slots %b outside S0..S23 or empty", j.ID(), j.Slots)
		}
		if j.File == "" || strings.Contains(j.File, "/") {
			t.Errorf("%s: workflow file should be a bare file name", j.ID())
		}
		if seen[j.ID()] {
			t.Errorf("%s: listed twice", j.ID())
		}
		seen[j.ID()] = true
	}
	if len(seen) == 0 {
		t.Error("no jobs")
	}
}

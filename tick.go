package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/jshvn/dispatch/schedules"
)

// stateFile holds, per job id, the last slot that job was fired for.
const stateFile = "state.json"

// State maps a job id to the last slot fired for it, in UTC.
type State map[string]time.Time

// LoadState reads dir's state file. A missing file is empty state, the first run; anything
// unreadable or malformed is an error, never empty state, because empty state would fire
// every job again for slots already sent.
func LoadState(dir string) (State, error) {
	b, err := os.ReadFile(filepath.Join(dir, stateFile))
	if errors.Is(err, os.ErrNotExist) {
		return State{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read state: %w", err)
	}
	var s State
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("state file %s is corrupt: %w", filepath.Join(dir, stateFile), err)
	}
	if s == nil { // `null` parses; it is not a missing file, and must not act like one
		return nil, fmt.Errorf("state file %s holds no object", filepath.Join(dir, stateFile))
	}
	return s, nil
}

// SaveState replaces dir's state file atomically: a crash leaves the old file or the new
// one, never half of either.
func SaveState(dir string, s State) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, stateFile+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once renamed
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(dir, stateFile)); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// Fire is one job due for one slot.
type Fire struct {
	Job  schedules.Job
	Slot time.Time
}

// Plan returns the jobs due at now: those with no recorded slot, or whose latest slot, its
// jitter passed, is after the one recorded. However many slots a job missed, it is due
// once, for the latest.
func Plan(jobs []schedules.Job, s State, now time.Time) (fires []Fire, warnings []string) {
	for _, j := range jobs {
		due, ok := j.Due(now)
		if !ok {
			continue
		}
		last, seen := s[j.ID()]
		switch {
		case !seen || due.After(last):
			fires = append(fires, Fire{j, due})
		case last.After(due):
			warnings = append(warnings, fmt.Sprintf(
				"%s: state records slot %s, after the latest slot %s; is the clock behind? not firing",
				j.ID(), stamp(last), stamp(due)))
		}
	}
	return fires, warnings
}

// next is the state to write before dispatching fires: every current job's entry, with the
// fired slots recorded. Entries for jobs no longer registered are dropped.
func next(jobs []schedules.Job, s State, fires []Fire) State {
	n := State{}
	for _, j := range jobs {
		if t, ok := s[j.ID()]; ok {
			n[j.ID()] = t
		}
	}
	for _, f := range fires {
		n[f.Job.ID()] = f.Slot
	}
	return n
}

// Dispatcher starts workflow runs. Prepare does everything that starts nothing (credentials),
// so its failure can leave the slots unrecorded; Dispatch starts one run.
type Dispatcher interface {
	Prepare(ctx context.Context) error
	Dispatch(ctx context.Context, repo, file string) error
}

// Tick is one run of the timer: lock, plan, prepare, record, dispatch. Every failure goes to log;
// the caller reads log.Errors() for the exit code and the ping.
//
// The slots are recorded before anything is dispatched, so a crash or a failed dispatch
// loses that slot rather than repeating it: at most once per slot. Prepare comes before the
// record, so a GitHub or network outage before any run could start costs five minutes, not
// the slot.
func Tick(ctx context.Context, dir string, jobs []schedules.Job, now time.Time, d Dispatcher, dryRun bool, log *Log) {
	unlock, err := lock(dir)
	if err != nil {
		log.Error("%v", err)
		return
	}
	defer unlock()

	s, err := LoadState(dir)
	if err != nil {
		log.Error("%v; nothing fired, and nothing will until it is repaired or removed by hand", err)
		return
	}
	fires, warnings := Plan(jobs, s, now)
	for _, w := range warnings {
		log.Warn("%s", w)
	}
	if dryRun {
		for _, f := range fires {
			log.Info("due %s for slot %s (last fired %s)", f.Job.ID(), stamp(f.Slot), lastFired(s, f.Job))
		}
		if len(fires) == 0 {
			log.Info("nothing due")
		}
		return
	}
	if len(fires) == 0 {
		return
	}
	if err := d.Prepare(ctx); err != nil {
		log.Error("%v; nothing fired or recorded, the next tick tries again", err)
		return
	}
	if err := SaveState(dir, next(jobs, s, fires)); err != nil {
		log.Error("save state: %v; nothing fired", err)
		return
	}
	for _, f := range fires {
		if err := d.Dispatch(ctx, f.Job.Repo, f.Job.File); err != nil {
			log.Error("dispatch %s for slot %s: %v; that slot is lost", f.Job.ID(), stamp(f.Slot), err)
			continue
		}
		log.Info("fired %s for slot %s", f.Job.ID(), stamp(f.Slot))
	}
}

// lock takes an exclusive flock on dir itself. systemd already refuses to start a oneshot
// that is still running; this covers the binary run by hand beside it.
func lock(dir string) (func(), error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, fmt.Errorf("open state directory: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("lock %s: another tick holds it: %w", dir, err)
	}
	return func() { f.Close() }, nil
}

func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04Z") }

func lastFired(s State, j schedules.Job) string {
	if t, ok := s[j.ID()]; ok {
		return stamp(t)
	}
	return "never"
}

// Log writes to the journal through stdout and stderr, and keeps the errors for the ping.
// Under systemd (JOURNAL_STREAM set) lines carry the sd-daemon priority prefix, so
// `journalctl -p err` finds the errors.
type Log struct {
	Out, Err io.Writer
	Journal  bool
	errs     []string
}

func (l *Log) Info(format string, a ...any) { fmt.Fprintf(l.Out, format+"\n", a...) }

func (l *Log) Warn(format string, a ...any) { l.write(l.Err, "<4>", format, a...) }

func (l *Log) Error(format string, a ...any) {
	l.errs = append(l.errs, fmt.Sprintf(format, a...))
	l.write(l.Err, "<3>", format, a...)
}

func (l *Log) write(w io.Writer, prio, format string, a ...any) {
	if !l.Journal {
		prio = ""
	}
	fmt.Fprintf(w, prio+format+"\n", a...)
}

// Errors is every error logged so far.
func (l *Log) Errors() []string { return l.errs }

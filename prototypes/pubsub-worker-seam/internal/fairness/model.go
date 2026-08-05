// Package fairness is throwaway prototype logic for Issue 50.
//
// It answers whether a bounded Principal-first dispatch window can preserve
// starvation resistance, per-Thread order, and work conservation before the
// mechanism is added to the deployed B3 challenge lane.
package fairness

import (
	"fmt"
	"slices"
)

type Mode string

const (
	BrokerFIFO     Mode = "broker-fifo"
	PrincipalFirst Mode = "principal-first"
)

type RunState string

const (
	Queued    RunState = "queued"
	Selected  RunState = "selected"
	Succeeded RunState = "succeeded"
)

type Run struct {
	ID             string
	Principal      string
	Thread         string
	ThreadSequence int
	Parent         string
	EnqueuedTick   int
	SelectedTick   int
	CompletedTick  int
	State          RunState
}

type State struct {
	Mode            Mode
	Tick            int
	PermitLimit     int
	Runs            []Run
	PrincipalPass   map[string]int
	ThreadPass      map[string]int
	SelectionCursor int
	LastEvent       string
}

type ActionKind string

const (
	AddNoisyBatch ActionKind = "add-noisy-batch"
	AddQuietRun   ActionKind = "add-quiet-run"
	SelectWork    ActionKind = "select-work"
	CompleteWork  ActionKind = "complete-work"
	AdvanceTick   ActionKind = "advance-tick"
	ToggleMode    ActionKind = "toggle-mode"
	CrashRecover  ActionKind = "crash-recover"
)

type Action struct {
	Kind ActionKind
}

func NewState(mode Mode, permitLimit int) State {
	return State{
		Mode: mode, PermitLimit: permitLimit,
		PrincipalPass: make(map[string]int), ThreadPass: make(map[string]int),
		LastEvent: "ready",
	}
}

func Reduce(current State, action Action) State {
	next := clone(current)
	switch action.Kind {
	case AddNoisyBatch:
		addNoisyBatch(&next)
	case AddQuietRun:
		addQuietRun(&next)
	case SelectWork:
		selectWork(&next)
	case CompleteWork:
		completeWork(&next)
	case AdvanceTick:
		next.Tick++
		next.LastEvent = "advanced the logical clock"
	case ToggleMode:
		if next.Mode == BrokerFIFO {
			next.Mode = PrincipalFirst
		} else {
			next.Mode = BrokerFIFO
		}
		next.LastEvent = "changed selection mode to " + string(next.Mode)
	case CrashRecover:
		next.Tick++
		next.LastEvent = "selector restarted; durable passes and selected permits survived"
	}
	return next
}

func ActivePermits(state State) int {
	count := 0
	for _, run := range state.Runs {
		if run.State == Selected {
			count++
		}
	}
	return count
}

func OldestQueuedAgeByPrincipal(state State) map[string]int {
	ages := make(map[string]int)
	for _, run := range state.Runs {
		if run.State != Queued {
			continue
		}
		age := state.Tick - run.EnqueuedTick
		if existing, ok := ages[run.Principal]; !ok || age > existing {
			ages[run.Principal] = age
		}
	}
	return ages
}

func addNoisyBatch(state *State) {
	ordinal := countPrincipalRuns(*state, "noisy")
	rootID := fmt.Sprintf("noisy-%03d-root", ordinal)
	appendRun(state, Run{ID: rootID, Principal: "noisy", Thread: fmt.Sprintf("noisy-thread-%02d", ordinal%8)})
	appendRun(state, Run{
		ID: fmt.Sprintf("noisy-%03d-child", ordinal), Principal: "noisy",
		Thread: fmt.Sprintf("noisy-child-thread-%02d", ordinal%16), Parent: rootID,
	})
	state.LastEvent = "added two noisy-Principal obligations across separate Threads"
}

func addQuietRun(state *State) {
	ordinal := countPrincipalRuns(*state, "quiet")
	appendRun(state, Run{
		ID: fmt.Sprintf("quiet-%03d", ordinal), Principal: "quiet", Thread: "quiet-thread",
	})
	state.LastEvent = "added one quiet-Principal obligation"
}

func appendRun(state *State, run Run) {
	run.ThreadSequence = nextThreadSequence(*state, run.Thread)
	run.EnqueuedTick = state.Tick
	run.State = Queued
	state.Runs = append(state.Runs, run)
	if _, exists := state.PrincipalPass[run.Principal]; !exists {
		state.PrincipalPass[run.Principal] = minimumActivePass(*state)
	}
	if _, exists := state.ThreadPass[run.Thread]; !exists {
		state.ThreadPass[run.Thread] = 0
	}
}

func selectWork(state *State) {
	selected := 0
	for ActivePermits(*state) < state.PermitLimit {
		eligible := eligibleRunIndexes(*state)
		if len(eligible) == 0 {
			break
		}
		index := eligible[0]
		if state.Mode == PrincipalFirst {
			index = principalFirstIndex(*state, eligible)
		}
		state.Runs[index].State = Selected
		state.Runs[index].SelectedTick = state.Tick
		state.PrincipalPass[state.Runs[index].Principal]++
		state.ThreadPass[state.Runs[index].Thread]++
		state.SelectionCursor++
		selected++
	}
	state.LastEvent = fmt.Sprintf("selected %d obligation(s) into the bounded dispatch window", selected)
}

func completeWork(state *State) {
	for index := range state.Runs {
		if state.Runs[index].State == Selected {
			state.Runs[index].State = Succeeded
			state.Runs[index].CompletedTick = state.Tick
			state.Tick++
			state.LastEvent = "completed " + state.Runs[index].ID + " and released its durable permit"
			return
		}
	}
	state.LastEvent = "nothing selected to complete"
}

func eligibleRunIndexes(state State) []int {
	var indexes []int
	for index, run := range state.Runs {
		if run.State != Queued || hasOpenThreadPredecessor(state, run) {
			continue
		}
		indexes = append(indexes, index)
	}
	return indexes
}

func principalFirstIndex(state State, eligible []int) int {
	indexes := slices.Clone(eligible)
	slices.SortFunc(indexes, func(left, right int) int {
		a, b := state.Runs[left], state.Runs[right]
		if state.PrincipalPass[a.Principal] != state.PrincipalPass[b.Principal] {
			return state.PrincipalPass[a.Principal] - state.PrincipalPass[b.Principal]
		}
		if a.Principal != b.Principal {
			if a.Principal < b.Principal {
				return -1
			}
			return 1
		}
		if state.ThreadPass[a.Thread] != state.ThreadPass[b.Thread] {
			return state.ThreadPass[a.Thread] - state.ThreadPass[b.Thread]
		}
		if a.ThreadSequence != b.ThreadSequence {
			return a.ThreadSequence - b.ThreadSequence
		}
		return a.EnqueuedTick - b.EnqueuedTick
	})
	return indexes[0]
}

func hasOpenThreadPredecessor(state State, candidate Run) bool {
	for _, run := range state.Runs {
		if run.Thread == candidate.Thread && run.ThreadSequence < candidate.ThreadSequence && run.State != Succeeded {
			return true
		}
	}
	return false
}

func minimumActivePass(state State) int {
	minimum := 0
	found := false
	for principal, pass := range state.PrincipalPass {
		if !hasNonterminalPrincipalRun(state, principal) {
			continue
		}
		if !found || pass < minimum {
			minimum = pass
			found = true
		}
	}
	return minimum
}

func hasNonterminalPrincipalRun(state State, principal string) bool {
	for _, run := range state.Runs {
		if run.Principal == principal && run.State != Succeeded {
			return true
		}
	}
	return false
}

func countPrincipalRuns(state State, principal string) int {
	count := 0
	for _, run := range state.Runs {
		if run.Principal == principal {
			count++
		}
	}
	return count
}

func nextThreadSequence(state State, thread string) int {
	next := 0
	for _, run := range state.Runs {
		if run.Thread == thread && run.ThreadSequence >= next {
			next = run.ThreadSequence + 1
		}
	}
	return next
}

func clone(state State) State {
	copyState := state
	copyState.Runs = slices.Clone(state.Runs)
	copyState.PrincipalPass = make(map[string]int, len(state.PrincipalPass))
	for key, value := range state.PrincipalPass {
		copyState.PrincipalPass[key] = value
	}
	copyState.ThreadPass = make(map[string]int, len(state.ThreadPass))
	for key, value := range state.ThreadPass {
		copyState.ThreadPass[key] = value
	}
	return copyState
}

// Command b3-fairness-tui is a throwaway terminal shell for the Issue 50
// Principal-first dispatch model. The portable reducer lives in internal/fairness.
package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/fairness"
)

const (
	bold  = "\x1b[1m"
	dim   = "\x1b[2m"
	reset = "\x1b[0m"
)

func main() {
	state := fairness.NewState(fairness.PrincipalFirst, 4)
	reader := bufio.NewScanner(os.Stdin)
	for {
		render(state)
		if !reader.Scan() {
			return
		}
		command := strings.TrimSpace(reader.Text())
		if command == "q" {
			return
		}
		action, ok := actionFor(command)
		if !ok {
			state.LastEvent = "unknown command: " + command
			continue
		}
		state = fairness.Reduce(state, action)
	}
}

func actionFor(command string) (fairness.Action, bool) {
	actions := map[string]fairness.ActionKind{
		"n": fairness.AddNoisyBatch,
		"u": fairness.AddQuietRun,
		"s": fairness.SelectWork,
		"c": fairness.CompleteWork,
		"t": fairness.AdvanceTick,
		"m": fairness.ToggleMode,
		"x": fairness.CrashRecover,
	}
	kind, ok := actions[command]
	return fairness.Action{Kind: kind}, ok
}

func render(state fairness.State) {
	fmt.Print("\x1b[2J\x1b[H")
	fmt.Printf("%sIssue 50: Principal-first dispatch window%s\n", bold, reset)
	fmt.Printf("%smode%s              %s\n", bold, reset, state.Mode)
	fmt.Printf("%stick%s              %d\n", bold, reset, state.Tick)
	fmt.Printf("%spermits%s           %d/%d active\n", bold, reset, fairness.ActivePermits(state), state.PermitLimit)
	fmt.Printf("%sselection cursor%s  %d\n", bold, reset, state.SelectionCursor)
	fmt.Printf("%slast event%s        %s\n\n", bold, reset, state.LastEvent)

	fmt.Printf("%sPrincipal state%s\n", bold, reset)
	ages := fairness.OldestQueuedAgeByPrincipal(state)
	principals := make([]string, 0, len(state.PrincipalPass))
	for principal := range state.PrincipalPass {
		principals = append(principals, principal)
	}
	sort.Strings(principals)
	for _, principal := range principals {
		fmt.Printf("  %-8s pass=%-3d oldest_queued_age=%d\n", principal, state.PrincipalPass[principal], ages[principal])
	}
	if len(principals) == 0 {
		fmt.Printf("  %s(no work admitted)%s\n", dim, reset)
	}

	fmt.Printf("\n%sAgentRun obligations%s\n", bold, reset)
	fmt.Printf("  %-18s %-8s %-22s %-4s %-10s %s\n", "id", "principal", "thread", "seq", "state", "parent")
	start := 0
	if len(state.Runs) > 16 {
		start = len(state.Runs) - 16
	}
	for _, run := range state.Runs[start:] {
		fmt.Printf("  %-18s %-8s %-22s %-4d %-10s %s\n",
			run.ID, run.Principal, run.Thread, run.ThreadSequence, run.State, run.Parent)
	}
	if len(state.Runs) == 0 {
		fmt.Printf("  %s(no obligations)%s\n", dim, reset)
	}

	fmt.Printf("\n%s[n]%s noisy batch  %s[u]%s quiet run  %s[s]%s select  %s[c]%s complete\n",
		bold, reset, bold, reset, bold, reset, bold, reset)
	fmt.Printf("%s[t]%s tick  %s[m]%s mode  %s[x]%s crash/recover  %s[q]%s quit\n", bold, reset, bold, reset, bold, reset, bold, reset)
	fmt.Printf("%sTry: n, n, s, u, c, s. Then switch mode and repeat.%s\n> ", dim, reset)
}

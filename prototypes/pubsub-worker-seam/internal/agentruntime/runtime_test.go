package agentruntime

import "testing"

func TestStandardProposesCommittedModelCallBeforeSuccess(t *testing.T) {
	runtime := Standard{}
	first, err := runtime.ProposeNextStep(CurrentState{})
	if err != nil {
		t.Fatal(err)
	}
	if first.Kind != ProposeModelCall || first.NormalizedIntent == "" {
		t.Fatalf("first proposal = %#v", first)
	}
	second, err := runtime.ProposeNextStep(CurrentState{ModelCallCommitted: true, ModelCallSucceeded: true})
	if err != nil {
		t.Fatal(err)
	}
	if second.Kind != ProposeAgentRunSuccess || second.NormalizedOutcome == "" {
		t.Fatalf("second proposal = %#v", second)
	}
}

func TestStandardDoesNotExecuteUnsettledCommittedModelCall(t *testing.T) {
	_, err := (Standard{}).ProposeNextStep(CurrentState{ModelCallCommitted: true})
	if err == nil {
		t.Fatal("expected unsettled ModelCall to stop proposal")
	}
}

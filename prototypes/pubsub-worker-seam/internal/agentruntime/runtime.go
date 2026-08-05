package agentruntime

import "fmt"

type StepKind string

const (
	ProposeModelCall       StepKind = "propose_model_call"
	ProposeAgentRunSuccess StepKind = "propose_agent_run_success"
)

type CurrentState struct {
	ModelCallCommitted bool
	ModelCallSucceeded bool
}

type ProposedStep struct {
	Kind              StepKind
	NormalizedIntent  string
	NormalizedOutcome string
}

type Standard struct{}

func (Standard) ProposeNextStep(state CurrentState) (ProposedStep, error) {
	if !state.ModelCallCommitted {
		return ProposedStep{
			Kind: ProposeModelCall, NormalizedIntent: "produce_assistant_response",
		}, nil
	}
	if state.ModelCallSucceeded {
		return ProposedStep{
			Kind: ProposeAgentRunSuccess, NormalizedOutcome: "assistant_response_completed",
		}, nil
	}
	return ProposedStep{}, fmt.Errorf("committed ModelCall has no terminal outcome")
}

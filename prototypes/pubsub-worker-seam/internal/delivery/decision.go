package delivery

import "time"

type State string

const (
	Pending   State = "pending"
	Running   State = "running"
	Succeeded State = "succeeded"
	Canceled  State = "canceled"
)

type Action string

const (
	Acknowledge Action = "acknowledge"
	Claim       Action = "claim"
	Retry       Action = "retry"
)

func Decide(state State, leaseExpiresAt *time.Time, now time.Time) Action {
	switch state {
	case Pending:
		return Claim
	case Running:
		if leaseExpiresAt != nil && !leaseExpiresAt.After(now) {
			return Claim
		}
		return Retry
	default:
		return Acknowledge
	}
}

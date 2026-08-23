import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { ThinkRequestId } from "../../domain";
import {
  CommittedTurnTerminal,
  readCommittedTurnTerminal,
  withCommittedTurnTerminal,
} from "./committed-turn-terminal";

describe("committed turn terminal metadata", () => {
  it("preserves existing message metadata and reads its trusted marker", () => {
    const terminal = CommittedTurnTerminal.make({
      requestId: ThinkRequestId.make("request-1"),
      status: "completed",
    });
    const metadata = withCommittedTurnTerminal({ provider: { model: "test" } }, terminal);

    expect(metadata).toEqual({
      osfoCommittedTurn: terminal,
      provider: { model: "test" },
    });
    expect(readCommittedTurnTerminal(metadata)).toEqual(Option.some(terminal));
  });

  it("rejects malformed terminal metadata", () => {
    expect(
      readCommittedTurnTerminal({
        osfoCommittedTurn: { requestId: "request-1", status: "streaming" },
      }),
    ).toEqual(Option.none());
  });
});

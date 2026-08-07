// @vitest-environment happy-dom

import { AdmissionNotAccepted } from "@osfo/api";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadChatSubmission } from "./atoms";
import { SubmissionError } from "./submission-error";

describe("submission error", () => {
  it("renders a definite pre-acceptance rejection", () => {
    const submission: ThreadChatSubmission = AsyncResult.failure(
      Cause.fail(new AdmissionNotAccepted()),
    );

    const html = renderToStaticMarkup(<SubmissionError submission={submission} />);

    expect(html).toContain("This message was not accepted.");
    expect(html).toContain('role="alert"');
  });
});

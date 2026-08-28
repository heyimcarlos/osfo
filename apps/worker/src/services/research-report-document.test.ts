/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
/* oxlint-disable effecttsgo/global-date -- Fixed dates are immutable citation evidence. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ResearchCollector } from "./research-collector";
import { ResearchReportDocument } from "./research-report-document";
import { ResearchReport } from "./research-report";
import { ResearchSynthesis } from "./research-synthesis";

const retained: ReadonlyArray<ResearchCollector.RetainedSource> = [
  {
    content: "PRIVATE RAW BODY. The measured result improved by twelve percent.",
    source: ResearchCollector.ManifestSource.make({
      contentDigest: ResearchReport.InputDigest.make("d".repeat(64)),
      contentKey: "users/report/source.json",
      fetchedAt: new Date("2026-08-27T12:05:00.000Z"),
      sourceId: "S1",
      title: "Measured result",
      url: "https://example.com/result",
    }),
  },
];

const synthesis = ResearchSynthesis.Result.make({
  conclusion: [claim("The measured improvement supports the conclusion.")],
  sections: [{ heading: "Analysis", materialClaims: [claim("The result improved.")] }],
  summary: [claim("The source reports a measured improvement.")],
  title: "Measured improvement report",
});

const documentFailure = (reason: ResearchReportDocument.Unavailable["reason"]) =>
  new ResearchReportDocument.Unavailable({
    cause: reason,
    message: reason,
    operation: "compute",
    reason,
  });

it.effect("renders validated synthesis and generates references from retained truth", () =>
  Effect.gen(function* () {
    const source = yield* ResearchReportDocument.documentSourceFor(synthesis, retained);
    const rendered = source.pages.flatMap(({ lines }) => lines).join("\n");
    expect(rendered).toContain("The result improved. [S1]");
    expect(rendered).toContain("Evidence: “measured result improved” [S1]");
    expect(rendered).toContain("https://example.com/result");
    expect(rendered).toContain("d".repeat(64));
    expect(rendered).not.toContain("PRIVATE RAW BODY");
    expect(source.pages.map(({ title }) => title)).toEqual([
      "Measured improvement report — Executive summary",
      "Analysis",
      "Conclusion",
      "References",
    ]);
  }),
);

it.effect("chunks cited material into pages of at most thirty lines", () =>
  Effect.gen(function* () {
    const claims = Array.from({ length: 10 }, (_, index) =>
      claim(`Material claim ${index} ${"analysis ".repeat(20)}`),
    );
    const source = yield* ResearchReportDocument.documentSourceFor(
      ResearchSynthesis.Result.make({
        conclusion: [claim("Conclusion claim")],
        sections: [{ heading: "Maximum section", materialClaims: claims }],
        summary: [claim("Summary claim")],
        title: "Paginated report",
      }),
      retained,
    );

    expect(source.pages.every(({ lines }) => lines.length <= 30)).toBe(true);
    expect(source.pages.length).toBeGreaterThan(4);
  }),
);

it.effect("fails deterministically when bounded synthesis cannot fit twenty pages", () =>
  Effect.gen(function* () {
    const claims = Array.from({ length: 10 }, (_, index) => ({
      evidence: Array.from({ length: 6 }, () => ({
        quote: "measured result improved",
        sourceId: "S1",
      })),
      statement: `Material claim ${index} ${"analysis ".repeat(190)}`,
    }));
    const result = yield* ResearchReportDocument.documentSourceFor(
      ResearchSynthesis.Result.make({
        conclusion: claims.slice(0, 5),
        sections: Array.from({ length: 8 }, (_, index) => ({
          heading: `Section ${index}`,
          materialClaims: claims,
        })),
        summary: claims.slice(0, 5),
        title: "Oversized bounded report",
      }),
      retained,
    ).pipe(Effect.result);

    expect(result).toMatchObject({
      failure: { _tag: "ResearchReportDocumentUnavailable", operation: "validate" },
    });
  }),
);

it.effect("maps every closed document outcome to the exact product consequence", () =>
  Effect.sync(() => {
    expect(
      ResearchReportDocument.terminalDispositionFor(documentFailure("authorizationEnded")),
    ).toEqual({ _tag: "Canceled", safeFailureCode: "authority-ended" });
    for (const reason of ["costLimitExceeded", "intentConflict", "invalidArtifact"] as const) {
      expect(ResearchReportDocument.terminalDispositionFor(documentFailure(reason))).toEqual({
        _tag: "Failure",
        safeFailureCode: `document-${reason}`,
      });
    }
    expect(
      ResearchReportDocument.terminalDispositionFor(documentFailure("recoveryPending")),
    ).toEqual({ _tag: "RecoveryPending" });
    expect(
      ResearchReportDocument.terminalDispositionFor(documentFailure("storageUnavailable")),
    ).toBeNull();
  }),
);

function claim(statement: string): ResearchSynthesis.MaterialClaim {
  return {
    evidence: [{ quote: "measured result improved", sourceId: "S1" }],
    statement,
  };
}

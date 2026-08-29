/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned by it.effect. */
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { UserId } from "../../domain";
import { directIntegrationProviderConfig } from "../../services/integrations";
import { LocalVerificationIntegrationProvider } from "./provider";

it.effect("creates a local Integration session with Workerd's supported redirect policy", () =>
  Effect.gen(function* () {
    let redirect: RequestRedirect | undefined;
    const provider = LocalVerificationIntegrationProvider.make(
      "http://127.0.0.1:43124",
      (_url, init) => {
        redirect = init.redirect;
        return Promise.resolve(
          Response.json({ providerSessionId: "local-session" }, { status: 201 }),
        );
      },
    );

    const created = yield* provider.createSession(
      UserId.make("local-runtime-user"),
      directIntegrationProviderConfig,
    );
    expect(redirect).toBe("manual");
    expect(created).toMatchObject({ providerSessionId: "local-session" });
  }),
);

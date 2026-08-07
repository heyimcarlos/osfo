import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export type RuntimeEnvironment = "development" | "production";

export type DevelopmentBootstrapConfig =
  | { readonly enabled: false }
  | { readonly accessCodeSha256: string; readonly enabled: true };

export class InvalidDevelopmentBootstrapConfig extends Data.TaggedError(
  "InvalidDevelopmentBootstrapConfig",
)<{ readonly reason: "invalidDigest" | "productionForbidden" }> {}

export const resolveDevelopmentBootstrapConfig = (
  runtimeEnvironment: RuntimeEnvironment,
  accessCodeSha256: string | undefined,
): Effect.Effect<DevelopmentBootstrapConfig, InvalidDevelopmentBootstrapConfig> => {
  if (accessCodeSha256 === undefined) return Effect.succeed({ enabled: false });
  if (runtimeEnvironment !== "development") {
    return Effect.fail(new InvalidDevelopmentBootstrapConfig({ reason: "productionForbidden" }));
  }
  if (!/^[0-9a-f]{64}$/u.test(accessCodeSha256)) {
    return Effect.fail(new InvalidDevelopmentBootstrapConfig({ reason: "invalidDigest" }));
  }
  return Effect.succeed({ accessCodeSha256, enabled: true });
};

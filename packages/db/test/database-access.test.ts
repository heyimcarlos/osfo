import { describe, expect, it } from "@effect/vitest";
import { databaseAccessStatements } from "@osfo/db";

describe("development database access bootstrap", () => {
  it("quotes IAM roles and assigns least-privilege runtime defaults", () => {
    const statements = databaseAccessStatements("osfo_lifecycle", "postgres", [
      "osfo-dev-transport@example.iam",
      "osfo-dev-relay@example.iam",
      "osfo-dev-agentrun@example.iam",
    ]).join("\n");

    expect(statements).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA public');
    expect(statements).toContain('GRANT CONNECT ON DATABASE "osfo_lifecycle"');
    expect(statements).toContain("ALTER DEFAULT PRIVILEGES");
    expect(statements).toContain('GRANT "osfo_runtime" TO "osfo-dev-transport@example.iam"');
    expect(statements).not.toContain('GRANT "postgres" TO "postgres"');
    expect(statements).not.toContain("PASSWORD");
  });
});

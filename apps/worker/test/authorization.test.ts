import { describe, expect, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";

import { UserId } from "../src/domain";
import { AuthSessionId } from "../src/domain/auth-session";
import type { AuthorizationOperationName } from "../src/domain/authorization-operation";
import { AuthorizationContext, make } from "../src/services/authorization";
import { retainedCatalog } from "../src/domain/plan-policy";

describe("Authorization", () => {
  it("denies unknown operation input before it evaluates authority facts", () => {
    const authorization = make(retainedCatalog);

    expect(
      authorization.admit(baseContext(), { actionId: "action-unknown", kind: "unknown" }),
    ).toEqual({
      _tag: "Denied",
      reason: "unknownOperation",
      resetAt: null,
    });
  });

  it("applies launch Plan Entitlement to every authorization operation", () => {
    const authorization = make(retainedCatalog);

    for (const testCase of operationCases) {
      for (const plan of ["free", "adventurer"] as const) {
        const result = authorization.admit(
          baseContext(plan, testCase.operation),
          testCase.operation,
        );
        expect(result).toMatchObject({ _tag: testCase[plan] });
        expect(
          authorization.recheck(baseContext(plan, testCase.operation), testCase.operation),
        ).toMatchObject({ _tag: testCase[plan] === "Admitted" ? "Permitted" : "Denied" });
        const withoutApproval = {
          ...baseContext(plan, testCase.operation),
          approval: null,
        };
        const admissionWithoutApproval =
          testCase[plan] === "Denied"
            ? "Denied"
            : testCase.requiresApproval
              ? "ApprovalRequired"
              : "Admitted";
        const recheckWithoutApproval =
          testCase[plan] === "Denied" || testCase.requiresApproval ? "Denied" : "Permitted";
        expect(authorization.admit(withoutApproval, testCase.operation)).toMatchObject({
          _tag: admissionWithoutApproval,
        });
        expect(authorization.recheck(withoutApproval, testCase.operation)).toMatchObject({
          _tag: recheckWithoutApproval,
        });
      }
    }
  });

  it("evaluates launch authorization gates in fail-closed order", () => {
    const authorization = make(retainedCatalog);
    const fileRead = operation("file.read");
    const free = baseContext("free", fileRead);
    const adventurerContext = baseContext("adventurer", fileRead);
    const cases = [
      {
        context: { ...free, authority: null },
        expected: { _tag: "Denied", reason: "authenticationRequired" },
        name: "authentication",
        operation: fileRead,
      },
      {
        context: {
          ...free,
          authority: {
            _tag: "RevokedAuthSession" as const,
            authSessionId: AuthSessionId.make("auth-session-001"),
            userId: free.user.userId,
          },
        },
        expected: { _tag: "Denied", reason: "authorityRevoked" },
        name: "revocation",
        operation: fileRead,
      },
      {
        context: { ...free, user: { _tag: "SuspendedUser" as const, userId: free.user.userId } },
        expected: { _tag: "Denied", reason: "userSuspended" },
        name: "suspension",
        operation: fileRead,
      },
      {
        context: { ...free, deletionAccess: { _tag: "DeletionAccessRevoked" as const } },
        expected: { _tag: "Denied", reason: "deletionAccessRevoked" },
        name: "deletion access",
        operation: fileRead,
      },
      {
        context: { ...free, resourceOwnerUserId: "another-user" },
        expected: { _tag: "Denied", reason: "ownershipRequired" },
        name: "ownership",
        operation: fileRead,
      },
      {
        context: free,
        expected: { _tag: "Denied", reason: "missingEntitlement" },
        name: "Plan Entitlement",
        operation: {
          ...operation("document.generate"),
          artifactKind: "document",
          bytes: 1n,
          pages: 1n,
          researchSearches: 0n,
        },
      },
      {
        context: { ...adventurerContext, gmailConnection: null },
        expected: { _tag: "Denied", reason: "integrationConnectionRequired" },
        name: "Integration Connection",
        operation: operation("gmail.search"),
      },
      {
        context: {
          ...free,
          liveFacts: { ...free.liveFacts, retainedFileBytes: 100_000_000n },
        },
        expected: { _tag: "Denied", reason: "liveResourceLimitReached" },
        name: "live resource facts",
        operation: { ...operation("file.upload"), bytes: 1n },
      },
      {
        context: free,
        expected: { _tag: "Denied", reason: "operationLimitExceeded" },
        name: "per-operation limits",
        operation: { ...operation("conversation.run"), modelSteps: 7n },
      },
      {
        context: { ...free, approval: null },
        expected: { _tag: "ApprovalRequired" },
        name: "exact Approval",
        operation: operation("session.delete"),
      },
      {
        context: {
          ...free,
          allowance: {
            ...free.allowance,
            usage: [{ allowanceKind: "vendorUsdMicros" as const, quantity: 250_000n }],
          },
        },
        expected: { _tag: "Denied", reason: "allowanceExhausted" },
        name: "recorded Usage Allowance",
        operation: fileRead,
      },
    ];

    for (const testCase of cases) {
      expect(
        authorization.admit(
          Schema.decodeSync(AuthorizationContext)(testCase.context),
          testCase.operation,
        ),
      ).toMatchObject(testCase.expected);
    }
  });

  it("keeps safety, account, cancellation, revocation, deletion, and rights work available after exhaustion", () => {
    const authorization = make(retainedCatalog);
    const safeOperations = [
      operation("session.delete"),
      operation("memory.clear"),
      operation("memory.forgetKnowledge"),
      operation("file.delete"),
      { ...operation("reminder.manage"), change: "cancel" },
      { ...operation("workflow.manage"), change: "stop" },
      operation("workflow.cancel"),
      { ...operation("gmail.connection.manage"), change: "revoke" },
      operation("support.open"),
      operation("usage.inspect"),
      operation("billing.inspect"),
      operation("subscription.manage"),
      operation("authSession.revoke"),
      operation("channelBinding.revoke"),
      operation("phoneAccount.replace"),
      operation("account.delete"),
      operation("dataRights.request"),
    ];

    for (const safeOperation of safeOperations) {
      const context = baseContext("free", safeOperation);
      const exhausted = Schema.decodeSync(AuthorizationContext)({
        ...context,
        allowance: {
          _tag: "Metered",
          allowancePeriodId: "period-001",
          endsAt: date("2026-09-01T00:00:00.000Z"),
          plan: "free",
          planPolicyVersion: "launch-v1",
          startsAt: date("2026-08-01T00:00:00.000Z"),
          usage: [{ allowanceKind: "vendorUsdMicros", quantity: 250_000n }],
        },
      });

      expect(authorization.admit(exhausted, safeOperation)).toMatchObject({
        _tag: "Admitted",
        allowancePeriod: { _tag: "Unmetered" },
      });
    }
  });

  it("enforces every launch per-operation cap without making cost an Approval reason", () => {
    const authorization = make(retainedCatalog);
    const context = baseContext();
    const overLimitOperations = [
      { ...operation("conversation.run"), modelSteps: 7n },
      { ...operation("file.upload"), bytes: 10_000_001n },
      {
        ...operation("document.generate"),
        artifactKind: "document",
        bytes: 5_000_001n,
        pages: 20n,
        researchSearches: 0n,
      },
      {
        ...operation("document.generate"),
        artifactKind: "researchReport",
        bytes: 1n,
        pages: 1n,
        researchSearches: 21n,
      },
    ];

    expect(
      authorization.admit(
        { ...context, requestVendorUsdMicros: 30_001n },
        operation("support.open"),
      ),
    ).toMatchObject({ _tag: "Denied", reason: "operationLimitExceeded" });
    for (const cappedOperation of overLimitOperations) {
      const plan = cappedOperation.kind === "document.generate" ? "adventurer" : "free";
      expect(
        authorization.admit(baseContext(plan, cappedOperation), cappedOperation),
      ).toMatchObject({ _tag: "Denied", reason: "operationLimitExceeded" });
    }
  });

  it("requires an Approval bound to the exact User, operation, and Action", () => {
    const authorization = make(retainedCatalog);
    const destructive = operation("session.delete");
    const context = baseContext("free", destructive);

    const approvals = [
      null,
      { actionId: "another-action", operation: destructive.kind, userId: context.user.userId },
      {
        actionId: destructive.actionId,
        operation: "file.delete" as const,
        userId: context.user.userId,
      },
      {
        actionId: destructive.actionId,
        operation: destructive.kind,
        userId: UserId.make("another-user"),
      },
    ] satisfies ReadonlyArray<AuthorizationContext["approval"]>;
    for (const approval of approvals) {
      expect(
        authorization.admit(
          Schema.decodeSync(AuthorizationContext)({ ...context, approval }),
          destructive,
        ),
      ).toMatchObject({ _tag: "ApprovalRequired" });
    }

    expect(
      authorization.admit({ ...context, approval: null }, operation("memory.correct")),
    ).toMatchObject({ _tag: "Admitted" });
  });

  it("rechecks current protected-effect authority but not an already admitted allowance", () => {
    const authorization = make(retainedCatalog);
    const fileRead = operation("file.read");
    const context = baseContext("free", fileRead);
    const exhausted = Schema.decodeSync(AuthorizationContext)({
      ...context,
      allowance: {
        _tag: "Metered",
        allowancePeriodId: "period-001",
        endsAt: date("2026-09-01T00:00:00.000Z"),
        plan: "free",
        planPolicyVersion: "launch-v1",
        startsAt: date("2026-08-01T00:00:00.000Z"),
        usage: [{ allowanceKind: "vendorUsdMicros", quantity: 250_000n }],
      },
    });

    expect(authorization.recheck(exhausted, fileRead)).toEqual({ _tag: "Permitted" });
    const admittedOversizedUpload = {
      ...operation("file.upload"),
      bytes: 10_000_001n,
    } as const;
    expect(authorization.admit(context, admittedOversizedUpload)).toMatchObject({
      _tag: "Denied",
      reason: "operationLimitExceeded",
    });
    expect(authorization.recheck(context, admittedOversizedUpload)).toEqual({
      _tag: "Permitted",
    });
    expect(
      authorization.recheck(
        {
          ...exhausted,
          authority: {
            _tag: "RevokedAuthSession",
            authSessionId: AuthSessionId.make("auth-session-001"),
            userId: exhausted.user.userId,
          },
        },
        fileRead,
      ),
    ).toMatchObject({ _tag: "Denied", reason: "authorityRevoked" });
    expect(
      authorization.recheck(
        {
          ...exhausted,
          authority: {
            _tag: "AuthSession",
            authSessionId: AuthSessionId.make("auth-session-different"),
            expiresAt: date("2026-08-20T00:00:00.000Z"),
            userId: exhausted.user.userId,
          },
        },
        fileRead,
      ),
    ).toMatchObject({ _tag: "Denied", reason: "authorityMismatch" });
  });

  it("accepts only the exact current authority kind permitted by an operation", () => {
    const authorization = make(retainedCatalog);
    const fileRead = operation("file.read");
    const context = baseContext("free", fileRead);
    const authorityCases = [
      {
        authority: {
          _tag: "ChannelBinding" as const,
          channelBindingId: "channel-binding-001",
          userId: context.user.userId,
        },
        expected: { _tag: "Admitted" },
        operation: fileRead,
        originatingAuthority: {
          _tag: "ChannelBinding" as const,
          channelBindingId: "channel-binding-001",
        },
      },
      {
        authority: {
          _tag: "RevokedChannelBinding" as const,
          channelBindingId: "channel-binding-001",
          userId: context.user.userId,
        },
        expected: { _tag: "Denied", reason: "authorityRevoked" },
        operation: fileRead,
        originatingAuthority: {
          _tag: "ChannelBinding" as const,
          channelBindingId: "channel-binding-001",
        },
      },
      {
        authority: {
          _tag: "DurableTrigger" as const,
          triggerId: "scheduled-task-001",
          triggerType: "scheduledTask" as const,
          userId: context.user.userId,
        },
        expected: { _tag: "Admitted" },
        operation: { ...operation("reminder.deliver"), schedule: "oneTime" },
        originatingAuthority: {
          _tag: "DurableTrigger" as const,
          triggerId: "scheduled-task-001",
          triggerType: "scheduledTask" as const,
        },
      },
      {
        authority: {
          _tag: "DurableTrigger" as const,
          triggerId: "scheduled-task-001",
          triggerType: "scheduledTask" as const,
          userId: context.user.userId,
        },
        expected: { _tag: "Denied", reason: "authorityMismatch" },
        operation: fileRead,
        originatingAuthority: {
          _tag: "DurableTrigger" as const,
          triggerId: "scheduled-task-001",
          triggerType: "scheduledTask" as const,
        },
      },
      {
        authority: {
          _tag: "AuthSession" as const,
          authSessionId: "auth-session-expired",
          expiresAt: date("2026-08-15T00:00:00.000Z"),
          userId: context.user.userId,
        },
        expected: { _tag: "Denied", reason: "authenticationRequired" },
        operation: fileRead,
        originatingAuthority: {
          _tag: "AuthSession" as const,
          authSessionId: "auth-session-expired",
        },
      },
      {
        authority: {
          _tag: "AuthSession" as const,
          authSessionId: "auth-session-other-user",
          expiresAt: date("2026-08-20T00:00:00.000Z"),
          userId: "another-user",
        },
        expected: { _tag: "Denied", reason: "authorityMismatch" },
        operation: fileRead,
        originatingAuthority: {
          _tag: "AuthSession" as const,
          authSessionId: "auth-session-other-user",
        },
      },
    ];

    for (const testCase of authorityCases) {
      expect(
        authorization.admit(
          Schema.decodeSync(AuthorizationContext)({
            ...context,
            authority: testCase.authority,
            originatingAuthority: testCase.originatingAuthority,
          }),
          testCase.operation,
        ),
      ).toMatchObject(testCase.expected);
    }
  });

  it("enforces each live resource gauge owned by its feature module", () => {
    const authorization = make(retainedCatalog);
    const context = baseContext("adventurer");
    const cases = [
      {
        context: { ...context, liveFacts: { ...context.liveFacts, activeReminders: 25n } },
        operation: { ...operation("reminder.manage"), change: "oneTimeCreate" },
      },
      {
        context: { ...context, liveFacts: { ...context.liveFacts, concurrentWorkflows: 3n } },
        operation: { ...operation("workflow.manage"), change: "start" },
      },
      {
        context: {
          ...context,
          liveFacts: { ...context.liveFacts, activeGmSummonsInSession: 1n },
        },
        operation: operation("support.gmSummon"),
      },
    ];

    for (const testCase of cases) {
      expect(authorization.admit(testCase.context, testCase.operation)).toMatchObject({
        _tag: "Denied",
        reason: "liveResourceLimitReached",
      });
    }
  });

  it("keeps downgraded data manageable while paid protected effects stay stopped", () => {
    const authorization = make(retainedCatalog);
    const cases = [
      { expected: "Admitted", operation: operation("file.read") },
      { expected: "Admitted", operation: operation("file.delete") },
      {
        expected: "Denied",
        operation: { ...operation("file.upload"), bytes: 1n },
      },
      { expected: "Admitted", operation: operation("workflow.inspect") },
      { expected: "Admitted", operation: operation("workflow.cancel") },
      {
        expected: "Denied",
        operation: { ...operation("workflow.manage"), change: "start" as const },
      },
      {
        expected: "Admitted",
        operation: { ...operation("reminder.manage"), change: "cancel" as const },
      },
      {
        expected: "Denied",
        operation: { ...operation("reminder.manage"), change: "recurringCreate" as const },
      },
      {
        expected: "Admitted",
        operation: { ...operation("gmail.connection.manage"), change: "revoke" as const },
      },
      { expected: "Denied", operation: operation("gmail.search") },
    ] as const;

    for (const testCase of cases) {
      const context = baseContext("free", testCase.operation);
      expect(
        authorization.admit(
          {
            ...context,
            liveFacts: {
              ...context.liveFacts,
              activeReminders: 25n,
              concurrentWorkflows: 3n,
              retainedFileBytes: 100_000_000n,
            },
          },
          testCase.operation,
        ),
      ).toMatchObject({ _tag: testCase.expected });
    }
  });

  it("allows a recurring reminder material change at the active reminder limit", () => {
    const authorization = make(retainedCatalog);
    const operationAtLimit = {
      ...operation("reminder.manage"),
      change: "recurringMaterialChange",
    };
    const context = baseContext("adventurer", operationAtLimit);

    expect(
      authorization.admit(
        {
          ...context,
          liveFacts: { ...context.liveFacts, activeReminders: 25n },
        },
        operationAtLimit,
      ),
    ).toMatchObject({ _tag: "Admitted" });
  });

  it("uses the allowance period policy for soft-cap admission", () => {
    const authorization = make(retainedCatalog);
    const accept = operation("conversation.accept");
    const context = baseContext("adventurer", accept);

    expect(
      authorization.admit(
        Schema.decodeSync(AuthorizationContext)({
          ...context,
          allowance: {
            _tag: "Metered",
            allowancePeriodId: "period-001",
            endsAt: date("2026-09-01T00:00:00.000Z"),
            plan: "free",
            planPolicyVersion: "launch-v1",
            startsAt: date("2026-08-01T00:00:00.000Z"),
            usage: [{ allowanceKind: "acceptedMessages", quantity: 30n }],
          },
        }),
        accept,
      ),
    ).toMatchObject({ _tag: "Denied", reason: "allowanceExhausted" });
  });
});

type OperationCase = {
  readonly adventurer: "Admitted" | "Denied";
  readonly free: "Admitted" | "Denied";
  readonly operation: Readonly<Record<string, bigint | string>> & {
    readonly actionId: string;
    readonly kind: AuthorizationOperationName;
  };
  readonly requiresApproval: boolean;
};

const both = (operation: OperationCase["operation"], requiresApproval = false): OperationCase => ({
  adventurer: "Admitted",
  free: "Admitted",
  operation,
  requiresApproval,
});
const adventurer = (
  operation: OperationCase["operation"],
  requiresApproval = false,
): OperationCase => ({
  adventurer: "Admitted",
  free: "Denied",
  operation,
  requiresApproval,
});
const operation = <const Kind extends AuthorizationOperationName>(kind: Kind) => ({
  actionId: `action-${kind}`,
  kind,
});

const operationCases: ReadonlyArray<OperationCase> = [
  both(operation("conversation.accept")),
  both({ ...operation("conversation.run"), modelSteps: 1n }),
  both(operation("session.recall")),
  both(operation("session.replace")),
  both(operation("session.delete"), true),
  both(operation("memory.inspect")),
  both(operation("memory.correct")),
  both(operation("memory.clear"), true),
  both(operation("memory.forgetKnowledge"), true),
  both({ ...operation("file.upload"), bytes: 1n }),
  both(operation("file.read")),
  both(operation("file.analyze")),
  both(operation("file.delete"), true),
  adventurer({
    ...operation("document.generate"),
    artifactKind: "document",
    bytes: 1n,
    pages: 1n,
    researchSearches: 0n,
  }),
  adventurer({
    ...operation("document.generate"),
    artifactKind: "researchReport",
    bytes: 1n,
    pages: 1n,
    researchSearches: 1n,
  }),
  both({ ...operation("reminder.manage"), change: "oneTimeCreate" }),
  adventurer({ ...operation("reminder.manage"), change: "recurringCreate" }, true),
  adventurer({ ...operation("reminder.manage"), change: "recurringMaterialChange" }, true),
  both({ ...operation("reminder.manage"), change: "cancel" }),
  both({ ...operation("reminder.deliver"), schedule: "oneTime" }),
  adventurer({ ...operation("reminder.deliver"), schedule: "recurring" }),
  adventurer({ ...operation("workflow.manage"), change: "start" }, true),
  adventurer({ ...operation("workflow.manage"), change: "materialChange" }, true),
  both({ ...operation("workflow.manage"), change: "stop" }),
  both(operation("workflow.inspect")),
  both(operation("workflow.cancel")),
  adventurer({ ...operation("gmail.connection.manage"), change: "connect" }),
  both({ ...operation("gmail.connection.manage"), change: "revoke" }),
  adventurer(operation("gmail.search")),
  adventurer(operation("gmail.read")),
  adventurer(operation("gmail.draft")),
  adventurer(operation("gmail.send"), true),
  both(operation("support.open")),
  adventurer(operation("support.gmSummon"), true),
  both(operation("usage.inspect")),
  both(operation("billing.inspect")),
  both(operation("subscription.manage")),
  both(operation("authSession.revoke")),
  both(operation("channelBinding.revoke")),
  both(operation("phoneAccount.replace")),
  both(operation("account.delete"), true),
  both(operation("dataRights.request")),
];

const baseContext = (
  plan: "adventurer" | "free" = "free",
  requestedOperation: OperationCase["operation"] = operation("support.open"),
) =>
  Schema.decodeSync(AuthorizationContext)({
    allowance: {
      _tag: "Metered",
      allowancePeriodId: "period-001",
      endsAt: date("2026-09-01T00:00:00.000Z"),
      plan,
      planPolicyVersion: "launch-v1",
      startsAt: date("2026-08-01T00:00:00.000Z"),
      usage: [],
    },
    approval: {
      actionId: requestedOperation.actionId,
      operation: requestedOperation.kind,
      userId: "user-001",
    },
    authority: {
      _tag: "AuthSession",
      authSessionId: "auth-session-001",
      expiresAt: date("2026-08-20T00:00:00.000Z"),
      userId: "user-001",
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: { _tag: "Connected", userId: "user-001" },
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now: date("2026-08-16T00:00:00.000Z"),
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: "auth-session-001",
    },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: "user-001",
    subscription: { plan, planPolicyVersion: "launch-v1" },
    user: { _tag: "ActiveUser", userId: "user-001" },
  });

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

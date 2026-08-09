import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { channelBindings } from "./directory-schema.ts";
import { AccountAgent } from "./account-agent.ts";
import type { MessageAdmission, PrototypeEnv } from "./account-agent.ts";

export { AccountAgent };

const Identity = Schema.NonEmptyString.check(Schema.isMaxLength(512));
const Text = Schema.NonEmptyString.check(Schema.isMaxLength(16_384));
const BindingInput = Schema.Struct({ agentId: Identity, channelIdentity: Identity });
const MessageInput = Schema.Struct({
  channelIdentity: Identity,
  messageId: Identity,
  text: Text,
});
const CancellationInput = Schema.Struct({ submissionId: Identity });
const ReminderInput = Schema.Struct({
  delaySeconds: Schema.Int.check(Schema.isBetween({ maximum: 86_400, minimum: 1 })),
  reminderId: Identity,
  text: Text,
});

type DecodeResult<A> = { readonly _tag: "Invalid" } | { readonly _tag: "Valid"; readonly value: A };

const invalid = <A>(): DecodeResult<A> => ({ _tag: "Invalid" });

const decodeJson = <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
) =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: () => request.json(),
  }).pipe(
    Effect.map(Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })),
    Effect.map(
      Option.match({
        onNone: invalid<S["Type"]>,
        onSome: (value): DecodeResult<S["Type"]> => ({ _tag: "Valid", value }),
      }),
    ),
    Effect.catch(() => Effect.succeed(invalid<S["Type"]>())),
    Effect.runPromise,
  );

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });
const badRequest = () => Response.json({ error: "invalid_request" }, { status: 400 });
const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });

export default {
  async fetch(request: Request, env: PrototypeEnv): Promise<Response> {
    const url = new URL(request.url);
    const directory = drizzle(env.DIRECTORY);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ profile: "oz-account-agent-foundation-prototype", status: "ready" });
    }
    if (request.headers.get("authorization") !== `Bearer ${env.PROTOTYPE_TOKEN}`) {
      return unauthorized();
    }

    if (request.method === "POST" && url.pathname === "/bindings") {
      const decoded = await decodeJson(request, BindingInput);
      if (decoded._tag === "Invalid") return badRequest();
      const input = decoded.value;
      await directory
        .insert(channelBindings)
        .values({ ...input, createdAt: Date.now() })
        .onConflictDoUpdate({
          set: { agentId: input.agentId },
          target: channelBindings.channelIdentity,
        });
      return Response.json({ bound: true, ...input });
    }

    if (request.method === "POST" && url.pathname === "/messages") {
      const decoded = await decodeJson(request, MessageInput);
      if (decoded._tag === "Invalid") return badRequest();
      const input: MessageAdmission = decoded.value;
      const rows = await directory
        .select({ agentId: channelBindings.agentId })
        .from(channelBindings)
        .where(eq(channelBindings.channelIdentity, input.channelIdentity));
      const agentId = rows[0]?.agentId;
      if (!agentId) {
        return Response.json({ error: "unbound_channel_identity" }, { status: 404 });
      }
      const receipt = await env.ACCOUNT_AGENT.getByName(agentId).acceptMessage(input);
      return Response.json({ agentId, receipt });
    }

    const match = /^\/agents\/([^/]+)\/(state|cancel|schedule)$/.exec(url.pathname);
    if (!match) return notFound();
    const agentId = decodeURIComponent(match[1] ?? "");
    const action = match[2];
    const agent = env.ACCOUNT_AGENT.getByName(agentId);

    if (request.method === "GET" && action === "state") {
      return Response.json(await agent.inspectFoundation());
    }
    if (request.method === "POST" && action === "cancel") {
      const decoded = await decodeJson(request, CancellationInput);
      if (decoded._tag === "Invalid") return badRequest();
      const input = decoded.value;
      await agent.cancelTurn(input.submissionId);
      return Response.json({ cancelled: true, submissionId: input.submissionId });
    }
    if (request.method === "POST" && action === "schedule") {
      const decoded = await decodeJson(request, ReminderInput);
      if (decoded._tag === "Invalid") return badRequest();
      const input = decoded.value;
      const schedule = await agent.scheduleReminder(input);
      return Response.json({ schedule });
    }
    return notFound();
  },
} satisfies ExportedHandler<PrototypeEnv>;

# Effect v4 `use` and non-Effect host boundaries

Date: 2026-08-22

## Conclusion

The Redis example uses `use` as an application-defined adapter method. It is
not an Effect v3 operator. The service owns a raw Redis client, and its custom
`use` accepts an arbitrary client callback, catches synchronous throws, awaits
native Promises, and maps failures to `RedisError`
([source](https://github.com/bmdavis419/notion-discord-notifications/blob/3a3134b4f8b8f526250fa830c1f6670303409510/src/redis.ts#L9-L49)).
That repository pins Effect `^3.12.11`
([manifest](https://github.com/bmdavis419/notion-discord-notifications/blob/3a3134b4f8b8f526250fa830c1f6670303409510/package.json#L12-L19)).

Effect v4 now gives every `Context.Service` key its own `use` and `useSync`
helpers. `Service.use` retrieves the service and flattens an Effect returned by
the callback. `Service.useSync` retrieves the service and evaluates a
synchronous callback
([contract](https://github.com/Effect-TS/effect/blob/1144032cedda7b5eacc1ebf980d06957c7a59ddf/packages/effect/src/Context.ts#L70-L103),
[implementation](https://github.com/Effect-TS/effect/blob/1144032cedda7b5eacc1ebf980d06957c7a59ddf/packages/effect/src/Context.ts#L282-L297)).
These helpers remove the lookup boilerplate, but they do not turn an arbitrary
Promise API into a typed Effect.

For Osfo, use the v4 service-key helper only when a non-Effect host object
deserves a service identity. Wrap each Promise operation with
`Effect.tryPromise`, then return that Effect from `Service.use`. If the host
already owns the object's lifetime, provide the existing object with
`Layer.succeed` or `Effect.provideService`. A private adapter may use a generic
`use` method to confine raw SDK access and failure translation, but that escape
hatch must not become the application-facing interface.

```ts
interface CompanyHostClient {
  readonly reply: (
    message: string,
    callback: StreamCallback,
    context: MessengerContext,
  ) => Promise<void>;
}

class CompanyHost extends Context.Service<CompanyHost, CompanyHostClient>()(
  "@osfo/worker/CompanyHost",
) {}

const reply = (message: string, callback: StreamCallback, context: MessengerContext) =>
  CompanyHost.use((host) =>
    Effect.tryPromise({
      try: () => host.reply(message, callback, context),
      catch: (cause) => new CompanyHostUnavailable({ cause }),
    }),
  );

const runnable = reply(message, callback, context).pipe(
  Effect.provideService(CompanyHost, companyAgent),
);
```

That is the direct v4 spelling of the useful idea in the Redis example:
retrieve a host-owned capability through context, and make the throwing or
Promise call once at the adapter boundary. `Effect.tryPromise` catches both a
synchronous throw from its thunk and a rejected `PromiseLike`, and maps either
to the typed error channel
([official source](https://github.com/Effect-TS/effect/blob/1144032cedda7b5eacc1ebf980d06957c7a59ddf/packages/effect/src/Effect.ts#L900-L973)).
This is safer than testing `result instanceof Promise`, which misses non-native
thenables.

## What Osfo already does

Osfo is pinned to `effect@4.0.0-rc.111`
([root manifest](../../package.json#L63)). Its Company Agent already has the
right Promise-to-Effect adapter. `companyPromise` accepts a synchronous value or
`PromiseLike`, normalizes both with `Promise.resolve`, and maps failures to the
operation-specific `CompanyConversationUnavailable`
([implementation](../../apps/worker/src/agents/osfo/company-agent.ts#L367-L380)).
This is the current equivalent of the Redis service's custom `redis.use(...)`
boundary. Renaming it to `use` would make its job less clear.

The opposite bridge is also current v4 practice. The Promise-only Think
callbacks call `Effect.runPromise` after providing their invocation layer and
opening a scope
([Company Agent entry points](../../apps/worker/src/agents/osfo/company-agent.ts#L147-L169)).
Official Effect source describes `runPromise` as the compatibility boundary for
Promise-based code
([source](https://github.com/Effect-TS/effect/blob/1144032cedda7b5eacc1ebf980d06957c7a59ddf/packages/effect/src/Effect.ts#L8940-L8980)).

Keep that invocation-scoped shape when each host callback should acquire and
release its own dependencies. If one Company Agent activation must share
layer-owned state or acquired resources across many callbacks, create one
`ManagedRuntime` for that activation, call `runtime.runPromise(...)` at each
Promise entry point, and dispose it when the activation ends. `ManagedRuntime`
builds the layer once, caches its context, owns its resource scope, and requires
explicit disposal
([official contract](https://github.com/Effect-TS/effect/blob/1144032cedda7b5eacc1ebf980d06957c7a59ddf/packages/effect/src/ManagedRuntime.ts#L88-L112),
[construction and lifecycle](https://github.com/Effect-TS/effect/blob/1144032cedda7b5eacc1ebf980d06957c7a59ddf/packages/effect/src/ManagedRuntime.ts#L231-L290)).
There is no reason to make that lifetime change until a service actually needs
to survive across callbacks.

## Version-specific translation

The Redis example's `Layer.scoped(Redis, make(options))` should not be copied
into Osfo. In current v4, `Layer.effect(Service, acquisition)` runs the
acquisition in the Layer scope and removes its `Scope` requirement. It supports
an acquisition that uses `Effect.acquireRelease`
([official Layer contract](https://github.com/Effect-TS/effect/blob/1144032cedda7b5eacc1ebf980d06957c7a59ddf/packages/effect/src/Layer.ts#L976-L1021)).

The practical translation for `effect@4.0.0-rc.111` is:

```ts
const layer = Layer.effect(
  Redis,
  Effect.acquireRelease(connect, (client) => close(client)),
);
```

Use `Service.use` when the callback already returns an Effect. Use
`Service.useSync` only for synchronous work that cannot fail in the typed error
channel. For throwing or Promise host calls, use `Service.use` with
`Effect.try` or `Effect.tryPromise`. For Osfo's existing Company Agent, the
current `companyPromise` helper and Promise entry-point wiring already follow
that rule.

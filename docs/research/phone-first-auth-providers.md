# Phone-first authentication provider research

Research date: 2026-08-13

## Decision summary

Better Auth is the best fit if Osfo wants to own its authentication data in the
control-plane Postgres database. Use the Better Auth phone-number plugin with
Twilio Verify, not the raw Twilio Messaging API, unless Osfo accepts direct
ownership of OTP secrets and abuse controls.

Osfo will use Better Auth's User as its control-plane User. The Better Auth
User ID is the stable Osfo `UserId`, and Better Auth's `users` table is the
control-plane `users` table. Osfo will not add an `auth_identities` mapping
table for Better Auth.

Clerk is also a valid phone-only option. It does not require an email. It has a
smaller local schema and less security work, but Clerk owns the authentication
User, phone factors, OTP process, and sessions.

WorkOS AuthKit is not a fit for phone-first authentication. Its User identity
and recovery model use email.

TryAgent does not contain SMS authentication logic to copy. It is an
email-first Better Auth implementation.

## Provider comparison

| Question | Better Auth with Twilio | Clerk | WorkOS AuthKit |
| --- | --- | --- | --- |
| Phone-only sign-up and sign-in | Yes, through the phone-number plugin | Yes | No |
| E.164 enforcement | Osfo must add a validator | Required by Clerk | No global phone login |
| Email needed | Yes, the plugin requires a generated temporary email | No | Yes |
| OTP owner | Better Auth or Twilio Verify, based on configuration | Clerk | Not applicable to phone login |
| Session owner | Osfo, through Better Auth and Postgres | Clerk | WorkOS plus an application cookie |
| Local auth tables | `user`, `session`, `account`, `verification`, and optional `rateLimit` | Provider identity mapping only | Provider identity mapping and optional refresh-token storage |
| Cloudflare Workers | Viable, but Osfo must prove the full Worker, Drizzle, Postgres, and SMS build | Supported through Web API SDKs and JWT validation | Worker export exists, but the product does not fit |
| Lost-phone recovery | Osfo policy required | Osfo policy or another Clerk factor required | No phone-first recovery |
| Main burden | Self-hosted auth security and SMS abuse controls | Vendor dependency and external identity mapping | A separate phone auth system would still be required |

## Better Auth

### Phone-only behavior and the email limitation

The phone-number plugin can send an OTP, verify it, create a new User, and
create a session. A phone can also be the sign-in identifier. The caller must
provide a validator if Osfo wants strict E.164 parsing. Better Auth does not
enforce E.164 by default. [Better Auth phone-number plugin](https://better-auth.com/docs/plugins/phone-number)

The flow is phone-only for the person, but it is not email-free in storage.
`signUpOnVerification` requires `getTempEmail`. The core Better Auth User still
has an email and name. Osfo must generate a non-routable internal email and
must never present it as a real address. A deterministic HMAC-derived local
part under a reserved domain is safer than putting the raw phone number into
an email field. [Better Auth phone sign-up](https://better-auth.com/docs/plugins/phone-number#allow-sign-up-with-phone-number)

### Two Twilio designs

#### Better Auth plus Twilio Messaging

```text
Better Auth generates code
  -> Better Auth stores code and attempt count in Postgres
  -> sendOTP sends the provided code through Twilio Messaging
  -> Better Auth checks and consumes the code
  -> Better Auth creates User and Session
```

In this design, Twilio only transports text. Better Auth generates the code,
stores it in `verification`, applies the default five-minute expiry, allows
three verification attempts by default, and consumes a successful code. Its
phone plugin also applies a limit of ten requests per 60 seconds to
`/phone-number/*`. The current first-party source stores the code and attempt
count as the verification value. [Better Auth 1.6.28 phone routes](https://github.com/better-auth/better-auth/blob/v1.6.28/packages/better-auth/src/plugins/phone-number/routes.ts),
[phone plugin source](https://github.com/better-auth/better-auth/blob/v1.6.28/packages/better-auth/src/plugins/phone-number/index.ts)

The default rate limit is IP-based and uses memory unless configured otherwise.
It is disabled in development and does not cover direct server-side
`auth.api` calls. Osfo must configure shared database storage and add phone,
invitation, and abuse limits at the public Worker boundary.
[Better Auth rate limits](https://better-auth.com/docs/concepts/rate-limit)

Osfo must then own delivery retries, phone and IP abuse limits, toll-fraud
controls, OTP data protection, and monitoring. Twilio Messaging requires E.164
recipients but does not provide the verification ceremony.
[Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource)

#### Better Auth plus Twilio Verify

```text
Better Auth sendOTP callback
  -> Osfo starts a Twilio Verification
  -> Twilio generates, stores, expires, limits, and sends the code
  -> Better Auth verifyOTP callback checks the code with Twilio
  -> Better Auth creates User and Session
```

Better Auth documents `verifyOTP` for services such as Twilio Verify. With this
option, the Better Auth callback replaces its internal OTP check.
[Better Auth custom OTP verification](https://better-auth.com/docs/plugins/phone-number#verifyotp)

Twilio Verify requires E.164 phone numbers. It owns the real token and its
status. The default validity period is ten minutes. A token stays the same
during that period until successful verification. Twilio documents five
verification attempts for one entity in ten minutes, status-check limits, and
custom service rate limits such as IP-based limits. It also provides fraud
controls and verification events. [Twilio Verify API](https://www.twilio.com/docs/verify/api/verification),
[Verify limits and timeouts](https://www.twilio.com/docs/verify/api/rate-limits-and-timeouts),
[Verify service rate limits](https://www.twilio.com/docs/verify/api/service-rate-limits)

This integration has one awkward detail. Better Auth still creates a local
verification record before it calls `sendOTP`, even when Twilio owns the real
code. The callback can ignore the generated Better Auth code, and `verifyOTP`
can use Twilio as the only authority. On success, Better Auth removes its local
record. Osfo must test cleanup, retries, concurrent checks, and failure behavior
before release. This behavior is visible in the current first-party routes.
[Better Auth 1.6.28 phone routes](https://github.com/better-auth/better-auth/blob/v1.6.28/packages/better-auth/src/plugins/phone-number/routes.ts)

Twilio Verify is the recommended Twilio design. It leaves authentication
sessions with Better Auth while moving the most sensitive SMS OTP operations
to a service made for verification.

### Session ownership

Better Auth owns database-backed sessions. The browser receives the session
token in a signed, HTTP-only cookie. The same token is in the `session` table.
The default session lifetime is seven days, with refresh after the configured
update age. Osfo can revoke sessions because the records are in Osfo Postgres.
[Better Auth session management](https://better-auth.com/docs/concepts/session-management),
[Better Auth cookies](https://better-auth.com/docs/concepts/cookies)

This is not an OAuth refresh-token model for phone OTP. The `account` table can
hold refresh tokens for social providers, but the phone-only flow only needs
the Better Auth session cookie and its database record.

### Postgres and Drizzle impact

Better Auth requires four core models: `user`, `session`, `account`, and
`verification`. The phone plugin adds `phoneNumber` and
`phoneNumberVerified` to `user`. Database rate limiting can add `rateLimit`.
The Drizzle adapter supports Postgres and schema generation.
[Better Auth database](https://better-auth.com/docs/concepts/database),
[Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle)

Better Auth's User is the Osfo control-plane User. Configure Better Auth to use
the `users` table, and use its User ID as the stable Osfo `UserId`. Other
control-plane tables reference that same primary key, as TryAgent's product
tables reference its Better Auth User:

```text
users
  id                     Osfo UserId and Better Auth User ID
  name                   Better Auth required field
  email                  generated internal Better Auth field
  email_verified
  phone_number            current verified Phone Account projection
  phone_number_verified
  created_at
  updated_at

sessions
accounts
verifications
rate_limits              optional
```

The generated email is an internal Better Auth compatibility field. It is not
an Osfo Account, contact address, recovery method, or User-facing email. The
flattened phone columns do not make the Phone Account identical to the User.
Phone replacement, loss, and recovery remain separate product operations.

### Cloudflare Workers

Better Auth uses standard `Request` and `Response` handlers and has a Hono
integration. It supports a Cloudflare `waitUntil` handler for background work.
[Better Auth Hono integration](https://better-auth.com/docs/integrations/hono),
[Better Auth background tasks](https://better-auth.com/docs/reference/options#backgroundtasks)

For Postgres, Cloudflare recommends Hyperdrive with `node-postgres`. Drizzle is
supported. This requires `nodejs_compat` and a current compatibility date.
[Cloudflare Postgres connection](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/),
[Cloudflare Drizzle with Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/)

This makes the design viable, not proven. Osfo still needs a small build and
integration test with the exact Better Auth version, Drizzle adapter,
Hyperdrive connection lifecycle, and Twilio HTTP calls. A raw Effect HTTP
adapter to Twilio can avoid adding the Node-focused Twilio SDK to the Worker.

### Alchemy Better Auth integration

Osfo already uses Alchemy `2.0.0-beta.72`. The matching
`@alchemy.run/better-auth@2.0.0-beta.72` package is the preferred integration
path for the proof. It wraps Better Auth as an Effect service, exposes typed
endpoints, keeps the secret stable, constructs Better Auth for each Worker
execution, and connects background tasks to Worker `waitUntil`.
[Alchemy Better Auth](https://alchemy.run/better-auth/)

Its database Layers include Postgres over `CloudflareHyperdrive` and work with
Drizzle. Its deploy resource uses the origin database URL to reconcile the
Better Auth schema during deployment.
[Alchemy Better Auth database Layers](https://alchemy.run/better-auth/database-layers),
[Alchemy Better Auth source](https://github.com/alchemy-run/alchemy/tree/main/packages/better-auth)

This migration system is additive schema reconciliation. It is not the
append-only, historical migration chain that Osfo uses for product tables.
Keep Better Auth schema ownership clear and keep product migrations separate.
[Alchemy Better Auth migrations](https://alchemy.run/better-auth/migrations)

Alchemy removes much of the Worker and Effect integration work. It does not
remove Better Auth's temporary-email requirement, local verification record,
or the decision about mapping the Better Auth User to the Osfo User.

### Phone replacement and recovery

A signed-in Better Auth User can verify a new number and replace the old one.
The plugin can also remove a phone number. Both actions change the phone factor
on the Better Auth User. [Better Auth update and remove phone](https://better-auth.com/docs/plugins/phone-number#update-phone-number)

This is not enough for a signed-out User who lost the only phone. Osfo must
choose a recovery policy. Safe options include a second verified factor,
recovery codes, or a manual support process with strong evidence and immutable
audit facts. A phone number must not transfer to another Osfo User only because
the carrier reassigned it.

Better Auth provides lifecycle hooks and a verification callback, but these
are in-process callbacks, not provider webhooks. Use them to trigger an
idempotent Osfo operation. Do not assume that a callback and all product-table
writes are one Postgres transaction until an integration test proves it.
[Better Auth hooks](https://better-auth.com/docs/concepts/hooks)

## Clerk

Clerk supports a true phone-only flow. Its official setup says to disable all
email authentication settings, enable phone sign-up and sign-in, enable phone
verification, and disable passwords. It requires E.164 input. No fabricated
email is needed. [Clerk phone OTP flow](https://clerk.com/docs/guides/development/custom-flows/authentication/email-sms-otp)

Clerk owns OTP generation, verification state, expiry, attempts, the User, and
the Session. It exposes short-lived signed session JWTs and refreshes them
through its frontend system. Osfo validates the JWT and maps Clerk's `sub` to
an Osfo User ID. [Clerk session tokens](https://clerk.com/docs/guides/sessions/session-tokens),
[Clerk token refresh](https://clerk.com/docs/guides/sessions/force-token-refresh)

Clerk can deliver SMS itself. Osfo can disable delivery for each SMS template
and listen for `sms.created`; the event contains the OTP content, which Osfo
could send through Twilio Messaging. This is a webhook-based delivery path,
not a Twilio Verify integration. Clerk still owns the code.
[Clerk SMS templates](https://clerk.com/docs/guides/customizing-clerk/email-sms-templates)

Clerk webhooks can retry and replay, but Clerk states that they are asynchronous
and must not control synchronous onboarding. If Osfo uses Clerk, the browser
should call `completeRegistration` after Clerk verification. The Worker should
validate the Clerk JWT and create Osfo records in one Postgres transaction.
Use webhooks for reconciliation and phone-change events.
[Clerk webhook overview](https://clerk.com/docs/guides/development/webhooks/overview),
[Clerk database synchronization](https://clerk.com/docs/guides/development/webhooks/syncing)

The local schema can stay small:

```text
control.users
control.auth_identities
  user_id
  provider               "clerk"
  provider_subject       Clerk User ID
  revoked_at             nullable
```

Clerk supports verified phone additions and changes. It does not document a
self-service recovery path for a signed-out, phone-only User who lost that
number. Osfo still needs another factor or a manual recovery policy.
[Clerk add-phone flow](https://clerk.com/docs/guides/development/custom-flows/account-updates/add-phone)

Production phone authentication requires a paid Clerk plan. SMS countries are
controlled through an allowlist, with only the United States and Canada enabled
by default. [Clerk phone settings](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options)

## WorkOS AuthKit

WorkOS treats email as the unique identity and verifies access to that email.
Its documented methods are email/password, email Magic Auth, social login,
SSO, and MFA. Its User resource contains an email. A fabricated email would
conflict with WorkOS identity linking and recovery rules.
[WorkOS Users and Organizations](https://workos.com/docs/authkit/users-organizations),
[WorkOS identity linking](https://workos.com/docs/authkit/identity-linking),
[WorkOS User API](https://workos.com/docs/reference/authkit/user)

WorkOS offers SMS MFA, but that is an extra factor for an existing
authentication method. It is not a global phone-only AuthKit sign-up and
sign-in service. [WorkOS MFA API](https://workos.com/docs/mfa)

WorkOS owns the hosted session. A successful exchange returns a signed access
token and a rotating refresh token. The application must keep the refresh token
in a secure cookie or backend store. [WorkOS sessions](https://workos.com/docs/authkit/sessions)

Using WorkOS would leave Osfo responsible for the primary phone verification,
phone account, recovery process, and SMS ceremony. That removes the main reason
to select an auth provider. Do not select WorkOS for the current phone-first
requirement.

## TryAgent reference

TryAgent is email-first. Its Better Auth config enables email/password and an
optional Google provider. Its User-create hook checks an email access list.
It has no phone-number plugin, Twilio client, SMS endpoint, phone-auth UI, or
phone column.

Relevant local sources:

- [Better Auth configuration](../../.reference/tryagent/packages/auth/src/index.ts)
- [Postgres auth schema](../../.reference/tryagent/packages/db/src/schema/auth.ts)
- [email sign-in UI](../../.reference/tryagent/apps/web/src/components/sign-in-form.tsx)
- [email sign-up UI](../../.reference/tryagent/apps/web/src/components/sign-up-form.tsx)
- [Hono auth route](../../.reference/tryagent/apps/server/src/routes/auth.ts)

TryAgent uses a Bun Hono server and `node-postgres`. It is not a Cloudflare
Workers implementation. Osfo can reuse its package boundary, Drizzle schema
style, Hono route shape, session middleware, and database-hook pattern. It
cannot copy a phone or Twilio flow because none exists.

## Recommended next proof

Build a narrow Better Auth proof before changing the control-plane schema:

```text
Registration Invitation
  -> normalize and validate E.164 phone
  -> Better Auth send OTP
  -> Twilio Verify sends and owns OTP
  -> Better Auth verifyOTP checks Twilio
  -> Better Auth creates the Osfo User and AuthSession
  -> Osfo completeRegistration validates invitation and authenticated User
  -> one Postgres transaction creates Agent route, Free Subscription,
     first usage period, audit fact, and outbox record
```

The proof must answer these questions:

1. Can the exact packages build and run in the Osfo Worker with Hyperdrive?
2. Does Twilio Verify remain the only OTP authority when Better Auth creates its
   local verification record?
3. What happens when SMS send, verification, callback, or product registration
   fails at each boundary?
4. Can one verified OTP or Registration Invitation create more than one User or
   Session under concurrent requests?
5. How are a lost phone, a recycled number, and a legitimate phone replacement
   handled without account takeover?
6. How do the flattened current phone fields preserve Phone Account replacement
   and recovery rules?

Do not add separate `phone_accounts` or `auth_identities` tables unless the
proof establishes a concrete need that the Better Auth `users` table cannot
support.

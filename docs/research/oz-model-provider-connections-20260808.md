# Oz model provider connections

Date: 2026-08-08

## Question

Can Oz give a WhatsApp user immediate managed model access, then let that user
connect an OpenAI or Anthropic account without rebuilding TryAgent's
Hermes-dependent provider control?

## Finding

Yes for the product flow, but not by copying TryAgent's implementation.

TryAgent completed one browser/device flow: OpenAI Codex login through native
Hermes Gateway routes. Its Anthropic, Gemini, and OpenRouter connections used
API keys. The reusable asset is the interaction pattern and state model:

1. Start a connection from chat or the authenticated web surface.
2. Return a short-lived authorization URL and, when applicable, a user code.
3. Poll or receive a callback without exposing the provider secret to chat.
4. Store only safe connection metadata in product-facing state.
5. Make the verified connection primary and retain a declared managed fallback.
6. Support explicit disconnection and revocation guidance.

The Hermes-specific routes and one-gateway-per-Agent-Box credential storage are
not reusable Oz architecture.

## Official provider evidence

### OpenAI

OpenAI documents ChatGPT sign-in for its Codex clients. That flow can create an
API key and gives the Codex client a refresh token capable of creating keys and
consuming API credits. OpenAI's general API documentation still defines API
keys as the application authentication mechanism. The public material found in
this review does not document a general third-party OAuth product through which
Oz may consume a user's ordinary ChatGPT allowance.

Implication: support a user-supplied OpenAI API key at launch if needed. Treat
Codex or ChatGPT subscription login as a separate feasibility and terms
prototype, not as a launch dependency.

Sources:

- [OpenAI API authentication](https://platform.openai.com/docs/api-reference/authentication)
- [Codex CLI and Sign in with ChatGPT](https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt)
- [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540)

### Anthropic

Anthropic's production Claude API supports API keys and workload identity
federation. Its interactive Console and Claude Code clients have OAuth login
flows, but those are not documented as a general OAuth grant for an arbitrary
multi-tenant application. Anthropic currently says third-party applications
built with the Claude Agent SDK can draw from subscription usage limits, while
also saying shared production automation should use the Claude Platform for
predictable pay-as-you-go billing. That policy is actively changing and needs a
focused Agent SDK prototype and terms review.

Implication: support a user-supplied Anthropic API key as the stable path.
Evaluate Claude Agent SDK subscription authentication only if that SDK becomes
a serious Oz harness candidate.

Sources:

- [Claude API authentication](https://platform.claude.com/docs/en/manage-claude/authentication)
- [Claude Code setup and login options](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- [Claude Agent SDK with a Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude subscription and API billing separation](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console)

## Recommended Oz contract

```text
WhatsApp sender
  -> Provisional Oz Identity
  -> Managed Starter Allowance
  -> soft connection prompt
  -> verified Oz Account
  -> secure Provider Connection
  -> Model Access Policy chooses connected primary or managed fallback
```

- Budget the free experience by estimated cost, not message count.
- Attribute spend to the Principal. Do not let account claiming multiply the
  original provisional allowance.
- Show connection links and device codes in WhatsApp, but collect API secrets
  only on an authenticated, expiring web page.
- Keep provider authorization mechanisms behind one Oz-owned connection
  contract. Do not pretend the providers expose identical capabilities.
- Preserve managed access as the zero-setup first experience and an explicit
  fallback, subject to the user's plan.

## Open questions for the Wayfinder

1. Which capabilities are available before account claim, especially expensive
   research, document generation, and sandbox execution?
2. What cost unit and allowance amount produce a compelling first experience
   without inviting disposable-number abuse?
3. Can OpenAI Codex sign-in be used by Oz under an official third-party client
   contract?
4. Can the Claude Agent SDK securely use per-user subscription authorization in
   an Oz server-side execution topology?
5. Which secrets service owns encrypted provider credentials, rotation, and
   deletion?

---
name: web-search
description: Searches the public web and returns both a concise, cited answer and familiar ranked links. Use when the user asks to search, Google, look something up, find a website, check a current fact, compare options, or continue working with earlier search results.
---

# Web Search

Keep the user inside their current conversation while giving them the useful
parts of a search engine: a direct answer, ranked links, and easy follow-ups.

## Default behavior

1. Infer a focused query from the message and recent conversation.
2. Search the public web. For current, local, or changing facts, never rely on
   model memory alone.
3. Open enough promising results to verify the answer. Prefer primary sources
   for factual claims and clearly label inference or disagreement.
4. Reply with both layers unless the user asks for only one:
   - **Answer:** a short synthesis with source links beside supported claims.
   - **Results:** up to ten ranked, tappable links with title, domain, and a
     one-line reason each result is useful.
5. Preserve the numbered result set for conversational follow-ups such as
   "open 3," "summarize 2 and 5," "more like 4," or "show more results."

For a simple navigational query, lead with the likely official page and keep
the answer to one sentence. For an ambiguous query, show the strongest useful
interpretations instead of blocking on a question when the ambiguity is safe.

## Conversational controls

- "just links" or "Google it": emphasize ranked results and keep synthesis
  minimal.
- "AI answer" or a natural-language question: emphasize synthesis, then show
  the best supporting links.
- "more results": keep the same intent and continue after the prior result set.
- "search instead for ...": replace the prior query constraints.
- "recent," "today," or "latest": state the relevant event date when it
  differs from the publication date.

## WhatsApp-friendly response

Keep the first message useful without requiring a tap. Use compact text and
ordinary HTTPS links. Avoid tables, repeated URLs, long excerpts, and a separate
link-preview-heavy message for every result.

```text
Answer
The direct answer, with supporting links where the claims appear.

Results
1. Result title (example.com)
   Why this result is useful
   https://example.com/page
```

Show three to five results for routine lookups. Expand toward ten when the user
asks for options, discovery, comparison, or "ten blue links." Never add weak
results merely to reach ten.

## Grounding rules

- Never invent a result, URL, quotation, date, price, availability, or source.
- Distinguish sponsored placement from relevance if the search provider exposes
  it. Do not silently rank paid placement first.
- Cite the page that supports the claim, not a search results page.
- Say when trustworthy results are sparse, stale, paywalled, geographically
  limited, or contradictory.
- For consequential medical, legal, or financial questions, provide sourced
  orientation without presenting the answer as professional advice.
- Do not expose private conversation context in a search query unless it is
  necessary and the user clearly intended it.

## Scope

A normal lookup is one interactive skill invocation. A broad investigation that
requires many searches, delegation, or a durable report is research and may be
subject to a different capability gate, budget, and progress flow.

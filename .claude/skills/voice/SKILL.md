---
name: voice
description: >-
  The voice of h&w and the people it writes for, before drafting or editing any prose a human reads:
  replies in the conversation, mail, chat, social posts, proposals, records and documents, headlines,
  captions, slides, README and documentation prose, FAQs, surveys, summaries and notes for review.
  Never for messages between agents, agent memory, instruction artifacts, scratch files, code,
  comments, command output, data, commit messages, logs or config.
allowed-tools: Read, Glob, Grep, Bash
---

# Voice: postures over a layered stack

Drafting into an existing conversation: read it first. Greeting, sign-off, one block or a stream, and the sender's own unanswered questions come from the thread, not from the request.

1. Pick the register. Relational (email, Slack, WhatsApp, DMs, a comment or reply under a social post: a person answers): `personal-voice.md` wins conflicts. Authored (articles, LinkedIn posts, proposals, slides, docs: an audience reads): `prose-style.md` wins on sentence mechanics. A comment answers a person, so it is relational however public the thread is.
2. Name the posture. Relational prose always has one: read `postures.md` before writing a word. Authored prose has no posture and takes a scaffold overlay instead.
3. Apply the four base layers in order, then the overlays the situation calls for.
4. Conflicts: the posture beats every layer on length, openings, closings and directness. Layers beat the posture on everything else. Channel mechanics beat both where they carve out.

## The primary axis

`postures.md`: the nine measured situational registers of relational prose (quick reply, decision/pushback, delegation/ask, repair, teaching, scheduling, intro, status update, LinkedIn DM). Length, opening and closing moves, directness, verbatim phrasings.

## The four base layers, in order

Layers 1-3 are positive: write from them. Layer 4 is a filter: check the draft against it.

| Layer | File | Owns |
|-------|------|------|
| 1 Brand | `brand-voice.md` | h&w as a company: positioning terms, measures and figures, banned words, numbers, banned Unicode, client naming, sender identity |
| 2 Personal voice | `personal-voice.md` | The one shared voice of everyone who writes under their own name: greeting and sign-off, the measured numbers, hedges and particles, emoji, anti-patterns |
| 3 Prose | `prose-style.md` | Sentence mechanics (DE/EN), language choice, German orthography |
| 4 AI-tells filter | `ai-tells.md` | Structures, openers, transitions, copula dodges and the measured signature vocabulary that mark prose as LLM output. The vocabulary check is a density bar, not a word ban |

## Overlays, when the channel or situation matches

| File | When | Owns |
|------|------|------|
| `slack-channel.md` | Slack via the MCP tool | Markdown quirks and Slack-only conventions |
| `content-formula.md` | Post-length content: LinkedIn essays, blog articles, talk arcs | Six beats, the research-backed pattern |
| `negotiation.md` | Pricing pushback, advisor or partner setup, speaker fees, training scope, scope creep, asking for visibility, intros or access | Tactics and h&w-specific phrasings |
| `intro-framework.md` | 30-second self-introduction | NSFAG: Name, Same, Fame, Aim, Game |

A cold pitch, a proposal opener or speaker outreach takes its shape from `postures.md`, "Pitch and positioning".

## Reference, for deep calibration

| File | Purpose |
|------|---------|
| `signature-phrases.md` | Benedikt's measured calibration anchors, how to pull real email exemplars from his mailbox, and his spoken slogan catalogue. Use when ghostwriting from a transcript or anchoring a draft that needs more voice depth than `personal-voice.md` gives |
| `brand-vocabulary.md` | Verbatim offerings and value props, written positioning vocabulary, the competitive frame, approved performance language. Use when positioning in proposals or sales decks, or citing numbers |

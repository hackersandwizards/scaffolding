# Prose style: bilingual (DE/EN)

Sentence mechanics for any prose a human will read.

## Sentence shape

- Long-form (proposals, posts, slides, articles, client docs): main clauses 15-20 words. Hard
  ceiling 26. Past 26, split.
- Email, Slack, chat: much shorter, and the numbers are measured, not estimated. Take them from
  `personal-voice.md`, "The hard numbers", and never average upward toward the long-form range.
- One main idea per sentence. Inserts (Einschübe, parentheticals): max 6 words or 12 syllables.

## Strong verbs over nominalizations

A noun ending in `-ung`, `-heit`, `-keit`, `-ion`, `-ität`, `-ismus` (DE) or `-tion`, `-ment`,
`-ance`, `-ity` (EN) paired with a weak verb (*erfolgen, vornehmen, durchführen, perform, conduct,
make, give*) is a Streckverb. Replace it with the verb hidden inside the noun: "Eine Entscheidung
treffen" -> "entscheiden", "make a decision" -> "decide".

## Active voice as default

"Es wird eine Entscheidung getroffen" -> "Das Team entscheidet." Keep passive only when the actor is
irrelevant or the object is the point ("The contract was signed yesterday").

## Concrete over abstract

Replace a vague quantifier with the number, or cut the claim: "Wir verbessern die Performance
deutlich" -> "Wir senken die Latenz von 800 auf 200 ms". Banned modifiers without numbers:
`deutlich, signifikant, erheblich, massiv, considerable, substantial, significant, dramatic`.
The example figure falls under Measures and figures in `brand-voice.md`.

## Three or more parties: name each one

When a partner, a subcontractor, and an end client all appear in one message, `wir` / `uns` / `we`
reads as any sender-side combination. Write the company name for each party and keep `wir` only
where the recipient is inside it. Sweep the finished draft pronoun by pronoun, and use the shorthand
the counterparty already uses in the thread.

- "Daraus machen wir einen Festpreis" -> "Daraus macht h&w einen Festpreis"
- Joint, so it stays: "Den Überschuss teilen wir."

## Filler

In authored prose, delete each word and each sentence the reader loses no fact by. Epistemic
markers (`I think`, `glaub ich`, `I'm not sure`) carry stance and are not filler.

Relational-prose exception. In email, Slack, and personal messages, Abtönungspartikel (`mal`,
`einfach`, `doch`, `eh`, `schon`, `halt`) and softeners (`gern`, `vllt.`, `ggf.`) carry politeness
and warmth: "Sagt einfach Bescheid" invites, "Sagt Bescheid" instructs. Keep them at the measured
density in `personal-voice.md`.

## Spoken to written

Converting his spoken words (Fathom transcripts, talks, recordings) is tightening, not
translation. The result reads like an articulate email from him, not a think-piece.

- Keep: specific examples and numbers, self-corrections, asides, and the inline assent tag (`ne?`,
  `right?`), which becomes a short confirming clause at the end of a claim (`postures.md` posture
  5).
- Cut, the measured spoken filler load: `sozusagen` (621), `irgendwie` (537), `kind of` (504),
  `halt`, `ähm` and other hesitation fillers, and repetition without rhythm.
- Convert: spoken `ja` or `also` marks a transition. Render it as a paragraph break or a short
  connector, not as a word.
- Triple emphasis (*"sehr, sehr, sehr"*) occurs once in the whole spoken corpus. Never reproduce it
  as a voice marker.

## Written to be spoken

Copy someone reads aloud from a page (a talk, an opening, a moderation script, an intro, a podcast
read) breaks at the sentence: one sentence per line, a blank line between blocks.

- No clock times, reference codes or bracketed notes inside a spoken line. They stop the delivery,
  and a time a reader needs belongs in the surrounding note, never in the sentence.
- One thought per line, six to ten words. Subject, verb, object, and no relative clause: a "who",
  "which" or "that" clause becomes its own line. Contractions, except the ones ending in -ve.
- Where the text is a sequence of cards, each line is one card and ends where the speaker breathes.

## Language (DE vs EN)

User override always wins. A stated language outranks every other signal but one: where the record
for the recipient, their team, or their customer states a language, that value decides, unless
every message in the thread runs in another language, and then the thread decides. Where a record
governs the language and states nothing, that silence is not this section's to fill.

Without a governing record: a thread already in one language stays in it, and a mixed thread
matches what the recipient used last. A new thread to several recipients takes the language they
all share, never the language of the sender's existing thread with one of them. No prior history: DACH region, German names or a `.de`
domain mean German, an international name means English. If still uncertain, write English.

A slide deck is in English, a German client's included, unless the person names another language
for that deck.

## German orthography

Always proper Umlaute and Sonderzeichen (ä, ö, ü, ß, Ä, Ö, Ü), never ASCII fallbacks like `ae`,
`oe`, `ue`, `ss`: `grüße`, not `gruesse`.

## Foreign words, jargon, Anglizismen

Use them when they do work the local language cannot, cut them when an everyday word means the
same: "agentic engineering" stays, "implementieren" -> "umsetzen", "utilize" -> "use".

That test reads on what the reader says, not on what the dictionary offers. An English term the
reader's own industry speaks stays English though German has a word for it: `Bottleneck` over
`Engpass`, `Backlog` over `Rückstand`. `Harness`, `Agent`, `Tool Call`, `Tools`, `Guardrails` and
`Scaffolding` stay English in every German text and translation.

One exception: German prose in this field writes `AI`, not `KI`, in every compound (`AI-Adoption`,
`AI-gestützte Entwicklung`). German website copy and blog posts, the copy with SEO and GEO weight, are the exception to the
exception: they may write `KI` for `AI`, because German search uses that word. Knowledge base pages
keep `AI`.

## When the rule fights the meaning

Break any rule here before producing something stilted, false, or dead. A 27-word sentence that
flows beats a 25-word sentence that limps.

# AI tells

A detector list, not a positive rule. Run the draft against it after the four base layers, asking
of each paragraph: "would a reader looking for AI output flag this?" Rewrite anything that triggers
without the offending pattern, not around it. DE and EN both; bans apply regardless of punctuation
or surface variation.

## 1. Structural patterns

### Contrastive reframe ("not just X, it's Y")

| Banned | Use instead |
|--------|-------------|
| "It's not just X, it's Y" / "It's not X, it's Y" / "X is more than a Z, it's Y" | name Y directly |
| "We don't just X, we Y" / "rather than simply X, we Y" | "We Y" |
| "Not a trend, an epidemic" / "Not a tool, a partner" | the concrete claim without the contrast frame |
| "X isn't evolving, it's accelerating" (any pivot punctuation) | same rule, banned in all forms |
| DE: "Nicht nur X, sondern Y" / "Das ist kein X, das ist ein Y" | nenn Y direkt |

### Negative parallelism ("no X, no Y, just Z")

"No fluff, no jargon, just results" / "Not slower, not cheaper, but smarter" / DE "Kein X, kein Y,
sondern Z": drop the triplet, make one concrete claim.

### Rule of three (forced triplets)

Triplet adjectives, noun phrases or parallel clauses applied regardless of necessity: "fast,
reliable, and secure" / "build, measure, learn" / "clarity, speed, focus". Pick the one that
matters and cut the rest. If three concepts belong, vary clause length so it does not read as a
triplet.

### Aphorism stacking

Short declaratives in a row, each pretending to be wisdom: "Clarity is speed. Less is more. The
simplest version wins." One concrete observation tied to a specific situation instead.

### Announced count

"Three things I'd push on." / "Two things to note:" / "A few thoughts:" / "Here are some reasons:"
/ DE "Drei Dinge dazu:" / "Zwei Punkte:": drop the preamble and state the first point. A count the
argument depends on ("only two of the five survive") stays.

### Soft-challenge verbs

"Things I'd push on" / "One thing I'd push back on" / "I'd poke at this" / "worth pressing on" /
DE "Hier würde ich nachhaken" / "Daran würde ich rütteln": name the disagreement directly. "Two of
these contradict each other." "This is wrong because..."

### Elegant variation

Swapping synonyms for the same referent ("Yankilevsky... the non-conformist artist... their
creative output..."). Repeat the noun. Plain repetition reads as confident.

### Mannered prose

Metaphor or flourish where a direct statement fits ("sits at the heart of", "the backbone of",
"opens the door to"): write the direct statement.

### Generic temporal or landscape opener

"In today's fast-paced landscape..." / "In a world where..." / "Right now, X is changing faster
than..." / DE "In der heutigen Zeit..." / "In einer Welt, in der...": drop the frame, open on the
concrete situation.

### The four-beat paragraph

1. Opening: framing claim or landscape statement
2. Expansion: elaboration or supporting evidence
3. Contrast: reframe or tension signal (but / however / it's not just)
4. Resolution: takeaway, imperative, or call to action

A paragraph that follows this skeleton end-to-end reads as AI regardless of the words. Cut the
opening landscape claim and start at the expansion. Remove the contrast pivot; the claim stands
without it. Cut the closing imperative unless it names a specific next step.

## 2. Opener and hook patterns

Banned in all forms:

| Pattern | Banned example | Use instead |
|---------|----------------|-------------|
| Curiosity hook | "Have you ever wondered..." | name the actual question |
| Candor opener | "Let's be honest..." | be honest without announcing it |
| Reveal setup | "Here's the thing..." | state the thing |
| Rhetorical-question challenge | "What if the way we think about X is wrong?" | make the claim directly |
| Contrarian opener | "Most people believe X. They're wrong." | argue the position without the binary |
| Statistic opener | "Studies show that X percent of teams..." | open on the observation, and cite the source as `content-formula.md` states |
| Empathy opener | "If you've ever struggled with..." | open on a concrete moment |
| Direct imperative pair | "Stop doing X. Start doing Y." | argue the change instead of commanding it |
| Confession opener | "I used to think X. I was wrong." | tell the actual story, including the change |
| Urgency frame | "The window for X is closing." | name the deadline or cut the urgency |
| Paradox opener | "The more you try to X, the less Y you get." | drop the paradox framing |
| Community segmentation | "Whether you're a founder, a marketer, or a..." | address one audience at a time |

## 3. Transition and bridge fillers

| Category | Banned | Use instead |
|----------|--------|-------------|
| Summary and outlook | "at the end of the day", "in a nutshell", "ultimately", "looking ahead", "what comes next" | drop the bridge |
| Importance flag | "this matters", "why this matters", "what matters most", "just as important", "adds another layer" | state the consequence itself |
| Restatement | "in other words", "the reality is", "to be clear" | the first version was wrong, rewrite it |
| Topic-pivot | "at its core", "when it comes to" | name the topic directly |
| Contrast | "on the other hand", "that said", "at the same time" | "but" or a period |
| Hedge | "it's worth noting", "needless to say", "moving forward" | if it's worth noting, note it |
| Frame | "It should be noted that", "It is important to mention that", "One could argue that", "Furthermore", "Moreover", "In conclusion" | cut the frame, lead with the claim |
| DE | "letzten Endes", "im Grunde", "im Kern", "in der Tat", "nichtsdestotrotz", "Es ist festzustellen, dass", "Es ist wichtig zu betonen, dass", "Man kann sagen, dass", "In diesem Zusammenhang", "Warum das wichtig ist" | dieselbe Regel |

## 4. Copula and verb dodging

| Banned | Use instead |
|--------|-------------|
| "X serves as a Y" / "X stands as a Y" / "X represents a Y" / "X marks a Y" | "X is a Y" |
| "X features Y" / "X offers Y" / "X boasts Y" | "X has Y" |
| DE: "X fungiert als Y", "X stellt ein Y dar" | "X ist ein Y" |

## 5. Formatting tics

Sentence case in headings. Bold sparingly: the lead sentence of each paragraph in a run of parallel
paragraphs, or the field names of a quoted record. Never bold in place of a heading, and no
"**Term:** description" list where the items are points of the argument: write those as full
sentences.

## 6. Signature vocabulary

Measured, not guessed. `github.com/louisabraham/load-bearing` groups 461,121 GitHub pull-request
descriptions into ten clusters by vocabulary alone, and its author reads one of them as Claude. The
classes below are that cluster's own, except the last two, which come from Graphite's study of Claude
Opus 5.5 articles against pre-ChatGPT human ones (graphite.io/five-percent/research/ai-tells-opus-5-5-update).

A ratio is not a ban: what marks the text is density. Across our own published LinkedIn posts:
`nobody` 91, `carries` 84, `deliberately` 72, `nothing` 52, `honestly` 23.

The bar: at most two of these words in one piece, and never two of the same class in one
paragraph. Past that, rewrite the sentence carrying the third.

The classes: stance adverbs (`plainly`, `quietly`, `genuinely`, `deliberately`, `merely`,
`precisely`, `honestly`, `silently`); absolutes (6b); the abstraction that acts (6c); courtroom
nouns (`refusal`, `premise`, `defect`, `precedent`, `remedy`, `verdict`, `caveat`: a `defect` in a
client mail about software is a bug, a `remedy` is a fix); coined compounds (`load-bearing`,
`chokepoint`, `backstop`, `tripwire`, `lever`, `seam`) and the hyphenated `re-` verb
(`re-verified`, `re-derived`: "checked again"). DE: "entscheidend" or "trägt das Argument", never
"load-bearing". Evaluative adjectives rate without describing: `dependable` 23x the human rate,
`steady` 11x, `thoughtful` 9x, `meaningful` 8x. Superlatives: `the most powerful` 7x, `perhaps the
most` 8x.

### 6b. Absolutes

`nobody` 25x, `nowhere` 20x, `nothing` 19x, `alone` 14x, `whoever` 13x, `forever` 13x, `somebody`
11x, `neither` 10x, `whichever` 10x.

Name the party instead.

- "Nobody owns the pipeline" -> "The pipeline has no owner" or name the team that should.
- "There is nowhere else for it to be" -> cut the sentence, the point was made.

### 6c. The abstraction that acts

An abstract noun as the subject of a verb only a person performs. `carries` 21x, `carrying` 20x,
`refuses` 23x, `rests` 17x, `refused` 17x, `carried` 16x, `admits` 16x, `holds` 15x, `settles`
14x, `says` 14x, `decides` 13x, `lands` 12x, `stands` 11x, `buys` 11x, `governs` 10x, `pays` 10x.

Put the person or the system back in the subject position.

- "The rule carries the consequence" -> "Whoever breaks the rule pays for it" or name the cost.
- "The contract holds" -> "The contract still applies."

### 6f. German drafts

The corpus is English, so the words above do not transfer and the classes do. Check a German draft
class by class: Haltungs-Adverbien (`schlicht`, `still`, `bewusst`, `nachweislich`), Absolutwörter
(`niemand`, `nirgends`, `nichts`), abstrakte Subjekte mit Personen-Verben ("die Regel trägt", "der
Vertrag entscheidet"), Gerichtsvokabular (`Anspruch`, `Präzedenzfall`, `Befund`, `Mangel`). Those
German examples are translations of the measured classes and are not themselves measured; the
density bar in 6 applies to them the same way.

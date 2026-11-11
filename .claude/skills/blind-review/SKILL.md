---
name: blind-review
description: >-
  Decide how much review a result a person will see deserves, from none to a large blind panel, and
  run it blind (personas, criteria, scoring, noise, stop rules, screenshots, the Claude and Codex
  reviewer commands). Use before handing over or shipping anything a person will read or see: copy,
  mail, a page, a document, slides, a logo or other brand element, a value one surface or scale sets
  for a shared element (a brief's request included), a design variant, a report, and
  for "blind review", "review this", "panel", "score the variants", "which version is better".
---

# Blind review

Every result a person will see gets the review it deserves, and you judge how much, none included.
Ask: who is hurt and how much if this is wrong, and how hard is it to take back?

## How much

Examples, not triggers:

- **None:** a thank-you or receipt mail, an internal note.
- **Small:** one persona from the real recipient or audience, Codex, one run.
- **Medium:** 2 to 3 personas, Claude and Codex, the current state scored against the new one.
- **Large:** 4 to 6 personas, both models, two runs, noise measured, an independent counter-draft
  scored alongside.

Cadence: a review per batch.

A visible asset changed to conform to a rule gets a review like any new version: the rendered
result scored against the version it replaces. Check: the report gives both scores and the noise.

End your report with your choice in one line: "Review: small, because first contact" or "Review:
none, because receipt".

## Whenever a review runs

1. Before the first draft, or before the first round where a draft exists, fix the medium, the
   audience and the real display size. Check: every reviewer prompt names all three.
2. Take the personas from the real target audience. Fix the criteria before scoring; for visual
   work "breathing room, not cramped", "visual calm" and "ours: made for this company, could not be
   any other's" are criteria of their own. Check: the criteria list is written before any score
   exists.
3. Brief unprimed: each reviewer gets only its role, the artifacts and the same criteria, with no
   score, rationale, hypothesis, preference, rule text under test, or hint of which version is current, new or whose.
   Use neutral labels, in file paths and names too, and a shuffled order per reviewer. Score the unchanged current state
   alongside, where one exists. Quote one reviewer prompt verbatim in the report. Check: no prompt names an author or
   a version's age.
4. Show each visual at its real display size in its real context and at full size. A candidate on a
   third-party surface (a chat app, a phone, a booth wall) goes on a mock first checked against a
   real screenshot of that surface. Downscale a screenshot judged only on layout, content or
   presence to 1000 px on its long side (`sips -Z 1000 in.png --out out.png`); give one judged on
   legibility, typography or logo detail at full size or as a full-resolution crop of that detail.
   An image costs `⌈width / 28⌉ × ⌈height / 28⌉` tokens, up to 4,784 at a 2,576 px long edge.
   Check: every image is at its real display size in context, at 1000 px or at full resolution,
   and before any reviewer starts, no two images of the same view, the current state's included,
   are pixel-identical at full resolution: on a match, stop and fix the build or the shot.
   Score a design that depends on a platform's settings (a device background, a lock screen) in
   the platform's default state, each default taken from the vendor's documentation. Check: the
   report names the default state and its source.
   Where the artifact is one step on a reader's path, show the step before it and the one after (the
   link and the page it opens, the post and the profile behind it), and ask each reviewer which
   question the artifact leaves open. Check: the brief names the steps shown.
   A change to how a control is operated is judged on measured task runs (clicks, keystrokes,
   pointer travel per typical task) beside the screenshots, never on a count alone: where a variant
   adds a control that commits an answer or an action, the reviewer sees the screen at the moment
   of that click and says what they have read by then. Check: the brief carries those numbers and
   that screen.
   Build every candidate to the system's current rules for that ground and surface (the asset cut,
   the type allowed on it), except the one rule the comparison tests. Check: before scoring, each
   candidate is checked against those rules and the report names any it breaks.
5. For a shared brand element (logo, colour, lockup, frame), score one choice across every surface
   (assets, documents, slides, sites, apps) before the first surface, and once more after the last
   batch that changed a surface, beside the per-surface scores. Name the combinations you skipped.
   Check: the report lists the surfaces and the skipped combinations.
   A shared line (a claim, a headline) rolled out to a surface makes that surface's copy around it a
   candidate of its own: rewritten so the whole text fits the place, the brand's mission and vision
   and the rest of the appearance, and scored in that context against the current copy. The line
   pasted in unchanged is one candidate, never the default. Check: each surface reports both scores.
6. A person's preferred variant is a hypothesis the next round tests blind, never a score.
7. Between rounds, ask every reviewer what keeps each criterion below the maximum, group the reasons
   by element and fix one or two causes. Fix only what a real reader or user would notice.
8. Noise is the score spread between two runs of the same reviewer. A lead inside the noise is a
   tie, and a tie goes to the variant with fewer exceptions. A surface keeps an exception to the
   shared standard only where its lead stands outside the noise in both runs and with both models
   (a lead of 0.75 at noise 0.58 on a 10-point scale counted); that exception goes to the person
   as the recommended option. A second-best variant that needs no exception may beat a best one
   that does. A value a brief or a consumer's override sets for one surface or scale of a shared
   element is such an exception, scored as in step 5 before it is built. Check: the report gives the
   noise next to the lead, or says it was not measured, and a per-surface value has its
   cross-surface score.
9. Stop on a plateau and report it instead of starting another round. Once a review says ship with
   no must-fix, order no confirming review. For long prose, stop after two consecutive rounds
   without a finding in classes named before round one (contradiction, counts, a statement against
   its fetched source, language parity, a broken sentence); the rest is a list for the author.

## Reviewer commands

Run each reviewer headless and read-only, the prompt naming each artifact by absolute path. Codex
takes images with `-i <file>`, placed after the prompt: `-i` is variadic, and a prompt after it is
read as an image and Codex answers "No prompt provided via stdin". Check: every Codex output file
is non-empty. A `claude -p` started inside a repository runs its session-start hook there, which
can merge `origin/main` and reinstall: start reviewers from a directory outside the checkout under
review, or read `git reflog -3` afterwards and rebuild a before baseline whose `HEAD` moved.

```bash
claude -p --model opus --effort medium --strict-mcp-config --no-session-persistence --allowedTools=Read "<prompt>"
codex exec -m gpt-6.1-sol -c model_reasoning_effort="high" --skip-git-repo-check --ephemeral -s read-only "<prompt>" < /dev/null
```

Codex reviews; it never authors the text under review.

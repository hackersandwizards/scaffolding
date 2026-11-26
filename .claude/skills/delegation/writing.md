# Writing

## Human writing -> Neon

A text that leaves the session for a reader (a mail, a chat message, a post, a comment, a document
a person outside the session reads) is written by Neon, in every mailbox and channel. The session
writes itself: its own conversation
with the person, records, run reports, pre-reads, a reply of one or two sentences, and a text a
template fixes; a quote's prices, scope and terms come from the records.

One writer per run, on Neon high. In T3 Code it is a child thread on T3's Antigravity provider
(`delegate_task`), every later text sent with `t3_thread_send` to that thread. Elsewhere:
`agy --model gemini-4-neon-high --output-format json --print-timeout 600s -p="<brief>"`. The brief
tells it to write no file and to read the `voice` skill and the channel's skill,
and hands over every text the run already knows under `=== <id> ===`, each with sender and
signature, recipients, language, purpose, must and must-not facts, new message or reply with its
thread, for a mail subject and body; it asks for the texts only, under their ids. Every later text
and every revision goes to the same writer: outside T3, `agy --conversation <conversation_id>`
with the id the first call returned. Measured: about 30 s
for the first text and 25 s for each later one.

Check facts (names, dates, links, recipients, language, signature), content correctness, length,
and for a text published without release the standing approval's bans. Never phrasing or tone. On
a finding, hand it back to the writer with the concrete finding. Deliver the output verbatim,
without the id lines: no rewording, no dropped or added sentences, no re-casing, no polish. Any
text change goes through the writer.

Where Neon does not answer (no `agy`, not signed in, a capacity error after one
retry), the session writes the text itself after loading `voice`, and its report says so.

Public web research (companies, events, tools, vendors) goes to Neon high the same way, through
its `search_web` tool; before a result reaches a person, the session checks its version numbers and
dates against the cited source.

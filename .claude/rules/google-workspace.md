# Google Workspace

Gmail, Calendar, Drive and Chat are reached through `gws` under the Company OS skills `google-api`
and `email` (`.claude/skills/` in the Company OS repository, `hackersandwizards/os`), from any
repository.
Read their `SKILL.md` before the first call. A browser reads a mailbox only while `gws` is
unavailable, and never writes a draft: Gmail's web editor saves its own model, so a DOM edit shows
"Draft saved" and is gone after a reload.

Slack is reached the same way, through the Company OS skills `slack` and `slack-api`: a message for
a person in the h&w workspace becomes a draft in their DM or thread, never text in the reply for
the user to paste.

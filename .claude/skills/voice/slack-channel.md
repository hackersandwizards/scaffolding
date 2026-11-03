# Slack channel mechanics

Format constraints for any Slack message sent or drafted via the Slack MCP tool. Length and shape
come from the posture (`postures.md`).

## Slack markdown via the MCP tool

The MCP Slack tool accepts standard markdown, not Slack's own mrkdwn syntax, and converts it.

| Format | Correct syntax | Wrong | Failure mode |
|--------|---------------|-------|--------------|
| Bold | `**text**` (double asterisks) | `*text*` | Single asterisks render as italic |
| Italic | `*text*` (single asterisks) | | `_text_` also works |
| Bold + Italic | `_**text**_` or `**_text_**` | `*_text_*` | Wrap one inside the other |
| Strikethrough | `~~text~~` (double tilde) | | `~text~` also works |
| Underline | not available via API | `__text__` | Renders as bold |
| Code (inline) | `` `code` `` | | |
| Code block | 4-space indentation | ` ``` ` (triple backticks) | Triple backticks break the MCP tool |
| Quote | `> text` | | |
| Bullet list | `•` (Unicode bullet char) | `- item` | Hyphen renders as a literal dash |
| Numbered list | `1. item` | | |
| Link | `<url\|display text>` | `[text](url)` | Standard markdown links don't render |
| User mention | `<@USER_ID>` | `@name` | |
| Channel mention | `<#CHANNEL_ID>` | `#channel` | |
| Emoji | `:emoji_name:` | | e.g. `:wave:` |
| Headers | not supported in messages | `##`, `###` | Use `**bold**` for section labels |
| Nested lists | not supported | | Renders flat regardless of indent |

The Unicode bullet (`•`) is banned in customer-facing prose everywhere except Slack.

## Conventions

- The trainer channels (`#trainer` and every regional trainer channel) are written in English,
  whatever language the surrounding conversation used.
- `_italic_` for action items in a DM to a close peer.
- Thread reply: no greeting, no closing.
- Hard ceiling 5,000 characters (Slack API).

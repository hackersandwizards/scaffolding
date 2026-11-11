# README

A README answers three questions for someone new to the repository: what is this, how do I start,
where is the rest. Every other fact lives in the file that owns it, and the README links that file.

## Kind and budget

Read the kind off the manifest and the deploy config, never off the folder the checkout sits in.
A repository of two kinds writes for the reader who arrives most often and gives the other kind one
section with its link.

| Kind | Sign | First reader | Lines |
| --- | --- | --- | --- |
| Package | `bin` or `exports`, consumers pin a tag | a developer or agent in a consuming repository | 100 |
| App | people run or deploy it | the person who runs it | 80 |
| Content | public, outside people edit entries | a contributor editing one entry | 40 |
| Records | private company records with tooling | a colleague new to it | 80 |
| Example | shows one technique, not a dependency | someone studying or copying it | 60 |

Every kind opens with the title, one paragraph (what it is, for whom, which neighbouring repository
it is not where the two are confused, and whether it is an example or out of use), then a routes
table ("You want", "Go to"), one row per reader task, each ending on a link, with a row for a
reader who does not write code. Check: all three end within source line 25. Then, by kind:

- **Package:** install line and requirements; the smallest working example with every import a
  first setup needs; at most ten entry points, picked by counting what consumers import, and a link
  to the full list; every command with one line each, its flags left to `--help`.
- **App:** accounts, tools and secrets to have; install, configure, start and what you see when it
  works; the commands or pages of a normal day; deploy in one sentence and a link.
- **Content:** the published site; the file to edit and the preview command; `CONTRIBUTING.md`.
- **Records:** as an app, plus who gets access and where the rules live.
- **Example:** what it shows, how to run it, three to five files to look at, where the technique is
  documented.

Package, app and records end with: documentation, one line per docs file (topic as the link, what
it holds); work on it (install, check, run and build commands, the release in one sentence,
`CLAUDE.md`); owner and licence. Content ends with the content's licence and a contact. A README
under its budget is not padded, and a section with nothing to say is left out.

## Where removed text goes

- Exports, options, config keys, file formats, how-to tasks, reasons and measurements:
  `docs/<topic>.md`. A dated run: `docs/agent-work/`.
- A command's flags: its `--help`, added in the same commit where it has none.
- Rules for changing the repository, layout, release: `CLAUDE.md`, or `CONTRIBUTING.md` where
  outside people contribute.
- What a component looks like: the catalog or published site. What the app's own pages show:
  deleted.
- A setup several repositories share, such as local URLs: one repository's `docs/`, linked from
  every other README. A format another package or skill owns: that owner, linked.
- Onboarding, access lists and accounts in a public repository: os.

A docs file the README links ships wherever the README ships: list the package archive to prove
`files` or `export-ignore` does not drop it.

## Procedure

1. Read the README, `CLAUDE.md`, `CONTRIBUTING.md` and the manifest whole.
2. List every inbound pointer, searching each heading's text as well as "README": tests reading the
   README, frontmatter a script parses, code comments and error messages, generated site text,
   `CLAUDE.md`, `CONTRIBUTING.md`, and `git grep` at `origin/main` in each repository that depends on
   this one. Check: the list names file and line.
3. Mark every paragraph: stays, moves to `<file>`, duplicate of `<file>` (checked fact by fact), or
   stale (checked against the tree).
4. Move text verbatim; the commit message says what moved where and names any addition. Rewriting
   moved text is a second commit.
5. Repoint every inbound pointer inside the repository in the same commit. A heading another
   repository links stays, with one line naming the new place, until that link has changed.
6. Ledger: every old line is found verbatim in the new README, a receiving file or the named
   duplicate, table rows cell by cell, whitespace normalised. Check: with one moved paragraph
   deleted, it reports that paragraph.
7. Render: `gh api -X POST /markdown -f mode=markdown -F text=@README.md` (`mode=gfm` renders every
   source line break) swapped into `article.markdown-body` of the live repository page, at 1280 px
   and at 390 px as a touch viewport; a private repository borrows a public one's page. Check:
   today's README swapped in has the live page's height; no table is cut off at 390 px and no code
   line at 1280 px. GitHub shows about 95 characters of a code line at 1280 px and 35 at 390 px, and
   a table with code in a cell does not wrap on a phone: write it as a list, and a code line holds
   the command alone.
8. `blind-review` the new README against the old one and one shorter alternative, personas from the
   repository's real readers, each given tasks.

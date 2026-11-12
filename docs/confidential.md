# The confidential-terms check

The package holds the mechanism and no terms. The list of salted hashes lives in the private
repository `hackersandwizards/confidential-terms`, which Company OS rebuilds. `check-confidential`
fetches it with the person's own `gh` login and keeps the copy for a day in the repository's
`node_modules/.cache/scaffolding/`. The command writes nothing outside the repository, so each
checkout fetches on its own.

- No list, or a list built more than 7 days ago: every check refuses. The fix is `gh auth login`
  with an account in the `trainers` team.
- A copy older than a day is fetched again, at most once an hour. If that fails, the old copy
  counts, with a warning.
- A list built more than 3 days ago prints a warning: Company OS has stopped rebuilding it.
- Added lines, file names and the whole commit message count, comment lines included.
- Binary files are read: images by OCR, every frame and page, and a transparent one on a white
  and a black ground; PDFs with `pdftotext`, and a page without text or with an image by OCR of
  its rendering (`pdftoppm`, `pdfimages`); Office, OpenDocument and other zip files by their
  entries. A font, known by its signature rather than its name, passes unread. Any other binary
  file, or one that cannot be read, refuses the commit until an allow entry names its path. OCR
  uses the macOS Vision framework, so a Linux machine commits no image to a public repository,
  except under `--list-optional` without a list (below). A file's text is kept by its content in `node_modules/.cache/scaffolding/read/`,
  so a gate reads it again only once the file or the reader changes.
- A Git LFS file is read from the working tree where it matches its pointer, else from the local
  LFS store; where neither holds it, the scan prints `Git LFS pointer, not read` and goes on.
- With `CI=true` the `--index` and `--tree` audits skip the term and binary reading, so a deploy
  needs no access; a binary file under `docs/agent-work/` is refused there unread. A commit, its message and a push are scanned wherever they are made.
- `check-confidential fetch` fetches now, for a cloud setup script. `--list <file>` or
  `SCAFFOLDING_CONFIDENTIAL_TERMS` reads a list from a file instead.
- `--list-optional`, with `--staged` or `--message-file`, lets a public repository's own hooks scan
  every commit without blocking an outside contributor: where there is no list and none can be
  fetched, the scan passes with a warning, and so does a file this machine lacks the tool to read
  (OCR, poppler): no term could match its text, and only the Company OS screenshot check goes with it. Without a copy it asks `gh` at most once an
  hour, since `gh` can take 20 s offline. A list that is there but invalid or built more than 7 days
  ago still refuses, and so does an unread file wherever a list is there.
- `check-confidential build <terms|-> [--public <file>] [--never <file>]` turns one term per line
  into a list stamped with its build time. It leaves out every term the public text in `<file>`
  already carries, and refuses to build without `/usr/share/dict/words`. A term of more than six
  words counts by its first six. A three-letter term, or one word in capitals, matches only in that
  case, and one in capitals also in a path or slug in lower case; two one-character words (`K 2`) match only in capitals.
- `--never <file>` adds the never section from one name per line, under the same salt and build
  time: the names h&w never shows. Public text drops none of them. A name in capitals, of three
  letters or in the dictionary also gets a hash in lower case, which only `never` reads. The build
  refuses `--never` without a file, an empty file and a name of fewer than three letters, its legal
  form dropped. `--never -` reads the names from stdin after a NUL byte, so `build - --never -`
  takes the terms, a NUL byte and the never names on one pipe, and no plain list touches the disk.
- Every scan above refuses a never name too, in its own casing: `QZX` and `qzx-workshop` refuse,
  `bei Qzx` passes, and a never name in the dictionary refuses nothing there. A list without a never
  section scans as before.

## Names h&w never shows

`check-confidential never` reads one JSON object on stdin, `{"<where>": <value>}`, such as a deck
test's decks by slug, and refuses every name of the list's never section in any case, in a key as
in its text. A value is a string or any JSON: its object keys and every string in it are its text,
so a deck goes in as it is; each string is scanned apart. It runs in private repositories too, and fetches, keeps and ages the list
as the other scans do. A kept copy without a never section is fetched again, at most once an hour.

- Exit 0: no never name. Exit 1: a finding, printed as
  `[check-confidential] <where>: a name h&w never shows from the company records (<text>)`.
- An exception is an allow entry in the working tree's `package.json` with
  `"check": "never-shown"`, a `path` glob over the `<where>` keys, the `text` and a reason. An entry
  matching nothing fails, since the input holds every string the caller shows.
- It refuses an input that is empty, not JSON, not an object or holds a value with neither a string nor an object key,
  and a list whose never section is missing or empty. No allow entry covers either.
- With `CI=true` it passes with a warning, so a deploy needs no access and no Git checkout.

A repository with `"scaffolding": { "private": true }` skips the check and keeps no `commit-msg`
hook, which `check-structure --fix` removes.

`check-confidential purged <sha>... > .confidential-purged.json` writes the list of purged
commits: after a history rewrite, the pre-push hook refuses a push from an old clone that still
carries one of them, whatever its tracking refs or fetched pull requests point at. It reads the list
in the pushing checkout and the one on the remote's default branch, which it fetches within 20 s
(`SCAFFOLDING_FETCH_WAIT_S`) for a push carrying commits, so a clone made before the list is refused
too. A remote without a list, or out of reach, adds nothing; a fetch that runs out of time refuses
the push and names `git fetch <remote>`, after which the next push fetches little; a list that does
not parse, there or in the checkout, refuses the push and says where. A repository that
already has the list keeps its salt and entries and gets the new ones added; with the file emptied
by the redirect, the staged copy counts.

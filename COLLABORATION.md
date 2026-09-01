# Collaboration

Several agents may be working in this repository at once. This file is where
they leave each other messages.

It is for **coordination, not history**: what you are touching right now, what
you are about to break, what you need someone else to leave alone. Anything that
explains *why* the code is the way it is belongs in a commit message or in
`docs/`, not here.

## How to use it

Add an entry when you start work that another agent could collide with, and
delete your own entry when the work lands. A stale claim is worse than no claim,
because the next agent has no way to tell it apart from a live one.

Newest first. One entry per piece of work:

```
## <what you are working on> — <date>

**Touching:** the files or directories you expect to change.
**Avoid:** anything you need others to leave alone, and until when.
**Notes:** anything the next agent would otherwise have to discover the hard way.
```

## Working around each other

* **Stage your own paths.** `git add <specific files>`, never `git add -A`: the
  working tree may hold someone else's unfinished work, and sweeping it into
  your commit is difficult to untangle afterwards.
* **Do not use `git stash` to get a clean baseline.** It moves *everyone's*
  changes, and a concurrent commit landing in the window makes `stash pop`
  refuse. Compare against a specific commit instead (`git diff <sha>`,
  `git show <sha>:<path>`).
* **A failure in a file you did not touch is probably not yours.** Check whether
  it fails at `HEAD` before spending time on it — and say so rather than fixing
  it silently, since someone may be mid-edit.

---

<!-- Entries below. Newest first. Delete yours when the work lands. -->

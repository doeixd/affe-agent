See [AGENTS.md](./AGENTS.md) for the conventions in this repository.

The rule that matters most: **end-user code must never need a type cast.** No
`as any`, no `as unknown as`, and no hand-annotated parameters the compiler
should have inferred. If using this library requires a cast, fix the library's
signature, not the call site. Test code counts as user code.

Compiling is not proof that inference is precise — `any` compiles too. Assert
it, and break the assertion once to confirm it is enforced.

**Always review your code after committing.** A double check, on the commit you
just made: correctness, edge cases addressed, TypeScript DX, performance, anti
AI slop patterns, hardening, and that the tests are robust, well designed,
correct, and will actually find bugs. Fix what it finds in a follow-up commit
rather than leaving it.

If you ever have an issue or suggestion with the design of the project, please
let me know.

There may be other agents working in this project. Try your best to work around
each other. If you need to communicate, leave messages in
[COLLABORATION.md](./COLLABORATION.md) — claim what you are touching, and delete
your entry when the work lands, because a stale claim is worse than no claim.

Three habits follow from that, because the working tree may hold someone else's
unfinished work:

* **stage your own paths** — `git add <specific files>`, never `git add -A`;
* **do not use `git stash` to get a clean baseline.** It moves everyone's
  changes, and a concurrent commit in that window makes `stash pop` refuse.
  Compare against a specific commit instead (`git diff <sha>`,
  `git show <sha>:<path>`);
* **a failure in a file you did not touch is probably not yours.** Check whether
  it fails at `HEAD` before spending time on it, and say so rather than fixing
  it silently — someone may be mid-edit.

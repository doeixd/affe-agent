See [AGENTS.md](./AGENTS.md) for the conventions in this repository.

The rule that matters most: **end-user code must never need a type cast.** No
`as any`, no `as unknown as`, and no hand-annotated parameters the compiler
should have inferred. If using this library requires a cast, fix the library's
signature, not the call site. Test code counts as user code.

Compiling is not proof that inference is precise — `any` compiles too. Assert
it, and break the assertion once to confirm it is enforced.

**Always review your code after committing.** A double check, on the commit you
just made: correctness, edge cases addressed, TypeScript DX, performance,
hardening. Fix what it finds in a follow-up commit rather than leaving it.

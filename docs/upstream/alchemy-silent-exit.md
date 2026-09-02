# Alchemy `deploy` exits 1 with no output (2.0.0-beta.75, Node 22, non-TTY)

Observed 2026-09-02 in `examples/deploy-cloudflare/`, from a shell without a
TTY (an agent's, but `CI=1` selects the same non-interactive path).

`npx alchemy deploy --yes` exits 1 and prints nothing but the version
notice. It does the same with `--log-level all`, `--dry-run`, `--stage dev`,
`USER` set, telemetry disabled, a valid `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in `.env` (verified active against
`/user/tokens/verify`), and when `bin/alchemy.js` is run directly to bypass
the launcher's stderr filter. `.alchemy/log/out` stays empty. The stack file
imports cleanly under plain `node` and exports a default `Effect`.
`--trace-exit` shows the exit coming from `NodeRuntime.runMain`'s teardown,
i.e. the main effect ends with a failure or a non-zero `process.exitCode`
that nothing renders; wrapping `main` from `alchemy/Cli` in
`Effect.tapCause` prints nothing either, so the cause never reaches the
outermost effect.

Not chased further: `wrangler deploy` with the mirrored `wrangler.jsonc`
deploys the same Worker, which is what the example documents. Re-test on
the next beta; if it reproduces, file it upstream with the above.

# affe-agent CLI

A conventional command-line client for an `AgentHttp` server. It speaks only
the transport-neutral `AgentClient` surface, so the mounted agent may run
locally or durably without changing this application.

```sh
npm run dev -- create --id demo
npm run dev -- prompt demo "inspect the workspace"
npm run dev -- status demo
npm run dev -- history demo
npm run dev -- interrupt demo
npm run dev -- respond demo approval-1 allow
```

`dev` compiles the application and the library modules it imports into the
app-local ignored `dist/` directory, then runs it on Node.

The server defaults to `http://127.0.0.1:3000`. Override it with `--url` or
`EFFECT_AGENT_URL`. Authentication comes from `--token` or
`EFFECT_AGENT_TOKEN`; it is parsed as `Redacted` and revealed only while the
HTTP authorization header is constructed. Add `--json` for stable
machine-readable output.

The command tree uses `effect/unstable/cli`, and all output goes through
Effect's `Terminal` service. `src/command.ts` accepts an injectable client
acquisition so tests and alternate transports do not need a live HTTP server.

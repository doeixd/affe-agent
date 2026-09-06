/**
 * The opt-in live smoke for a real-model Cloudflare deployment
 * (`examples/deploy-cloudflare/README.md`, "Quickstart with a real model").
 *
 *   WORKER_URL=https://affe-agent-real.<account>.workers.dev npm run smoke:cloudflare
 *
 * Not in `check`: it needs a deployment and a provider key, and it spends
 * real tokens. What `test/WorkerRealModel.test.ts` proves on workerd with
 * the provider substituted, this proves against the provider: a session
 * opens, a prompt completes with a non-empty answer from the model, and
 * the history read back holds the exchange. Prints the sanitized result
 * (no key, no account) so it can be pasted into the ledger.
 */
const url = process.env.WORKER_URL
if (url === undefined || url.length === 0) {
  console.error("smoke-cloudflare: set WORKER_URL to the deployed Worker's URL")
  process.exit(2)
}
const base = url.replace(/\/$/, "")
const sessionId = `smoke-${Date.now()}`
const headers = { "content-type": "application/json", authorization: "Bearer smoke" }

const call = async (pathname, init) => {
  const response = await fetch(`${base}${pathname}`, init)
  const body = await response.text()
  if (!response.ok) {
    console.error(`smoke-cloudflare: ${init?.method ?? "GET"} ${pathname} -> ${response.status}: ${body.slice(0, 300)}`)
    process.exit(1)
  }
  return JSON.parse(body)
}

const started = Date.now()
await call("/sessions", { method: "POST", headers, body: JSON.stringify({ requestId: "create-1", sessionId }) })
const answered = await call(`/sessions/${sessionId}/prompt`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    requestId: "prompt-1",
    input: { content: [{ options: {}, role: "user", content: "Reply with exactly the word: ready" }] }
  })
})
const text = String(answered.result?.text ?? "")
if (answered.result?.status !== "completed" || text.trim().length === 0) {
  console.error(`smoke-cloudflare: the prompt did not complete with an answer: ${JSON.stringify(answered).slice(0, 300)}`)
  process.exit(1)
}
const history = await call(`/sessions/${sessionId}/history`, { headers: { authorization: "Bearer smoke" } })
const rendered = JSON.stringify(history)
if (!rendered.includes("ready") || !rendered.includes(text.slice(0, 20))) {
  console.error("smoke-cloudflare: the history read back does not hold the exchange")
  process.exit(1)
}
console.log(JSON.stringify({
  smoke: "cloudflare-real-model",
  worker: new URL(base).hostname.replace(/\.[^.]+\.workers\.dev$/, ".<account>.workers.dev"),
  sessionId,
  status: answered.result.status,
  turns: answered.result.turns,
  answer: text.slice(0, 80),
  elapsedMillis: Date.now() - started
}, null, 2))

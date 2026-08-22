import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream, stream } from "@durable-streams/client"
const server = new DurableStreamTestServer({ port: 0 })
const base = await server.start()
const url = `${base}/streams/x`
const s = new DurableStream({ url, contentType: "application/json" })
await DurableStream.create({ url, contentType: "application/json" })
for (const n of [1,2,3]) await s.append(JSON.stringify({ n }))
// catch-up via subscribeJson
const r = await stream({ url, live: false })
const batches = []
await new Promise((res) => { r.subscribeJson((b) => { batches.push([b.items.map(x=>x.n), b.offset, b.upToDate]) }); r.closed.then(res) })
console.log("catch-up batches", JSON.stringify(batches), "startOffset", r.startOffset)
// live from start via subscribeJson, then appends
const l = await stream({ url, live: true })
const lb = []
l.subscribeJson((b) => lb.push([b.items.map(x=>x.n), b.offset]))
await new Promise(r => setTimeout(r, 150))
await s.append(JSON.stringify({ n: 4 }))
await s.append(JSON.stringify({ n: 5 }))
await new Promise(r => setTimeout(r, 300))
console.log("live batches", JSON.stringify(lb))
await server.stop()

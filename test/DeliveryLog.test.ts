import { SqliteClient } from "@effect/sql-sqlite-node"
import { Duration, Effect, Layer } from "effect"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import { contract, crossProcessLive } from "./DeliveryLogContract.js"

/**
 * The delivery log is what a client observes, and the two things it must get
 * right are the two numbers it keeps apart: the key (identity, for replay)
 * and the sequence (the session-wide offset, for reconnection). Both
 * implementations run the same contract.
 */

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-delivery-")),
      "log.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
    })
)

const sqlLog = Effect.gen(function* () {
  const file = yield* tempDatabase
  const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
  return yield* DeliveryLog.sqlLogWithTable().pipe(Effect.provide(sql))
})

contract("memory", DeliveryLog.memoryLog)
contract("sqlite", sqlLog)

// Two SQL logs over one database file, as two processes would be. The poll
// interval is shortened so a cross-process append surfaces quickly.
crossProcessLive(
  "sqlite",
  Effect.gen(function* () {
    const file = yield* tempDatabase
    const one = yield* DeliveryLog.sqlLogWithTable({ pollInterval: Duration.millis(30) }).pipe(
      Effect.provide(yield* Layer.build(SqliteClient.layer({ filename: file })))
    )
    const two = yield* DeliveryLog.sqlLogWithTable({ pollInterval: Duration.millis(30) }).pipe(
      Effect.provide(yield* Layer.build(SqliteClient.layer({ filename: file })))
    )
    return [one, two] as const
  }),
  { settle: "150 millis" }
)

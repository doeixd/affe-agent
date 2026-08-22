import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import { contract } from "./DeliveryLogContract.js"

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

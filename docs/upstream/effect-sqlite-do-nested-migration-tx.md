# Draft upstream issue — effect: SqlMessageStorage's sqlite migration nests a transaction the Durable Object driver refuses

*Draft for the Effect repository; not yet filed. Written 2026-08-30 against
`effect@4.0.0-rc.112`.*

## Summary

Building `SingleRunner.layer({ runnerStorage: "sql" })` over
`@effect/sql-sqlite-do` fails with:

```
MigrationError: Migration "1_create_tables" failed
  (cause: SqlError: Nested transactions are not supported by Cloudflare
   Durable Object SQLite storage)
```

Two pieces interact:

1. `Migrator` wraps the whole migration run in one transaction
   (`sql.withTransaction(run)` — `unstable/sql/Migrator`).
2. `SqlMessageStorage`'s `0001_create_tables` migration, in its sqlite
   `onDialectOrElse` fallback, pipes its index creation through
   `sql.withTransaction` *again*:

   ```ts
   all([sql`CREATE INDEX IF NOT EXISTS …`, sql`CREATE INDEX IF NOT EXISTS …`])
     .pipe(sql.withTransaction)
   ```

On drivers whose `withTransaction` tolerates or flattens nesting this is
invisible. `@effect/sql-sqlite-do` explicitly refuses nesting (correctly —
DO storage transactions cannot nest), so the engine cannot be constructed on
the one driver made for the platform.

## Suggested fix

Either drop the inner `sql.withTransaction` in the migration body (the
migrator already provides the transaction), or teach the DO driver to treat
a nested `withTransaction` as joining the outer transaction (savepoints are
unavailable, but join-semantics match what the flattened statement order
already is).

## Workaround used downstream

A re-entrant proxy over the `SqlClient` whose `withTransaction` joins the
transaction it is already inside, tracked per fibre via a context service —
mirroring the driver's own guard:

```ts
class InsideTransaction extends Context.Service<InsideTransaction, true>()("app/InsideTx") {}
const reentrant = (sql: SqlClient.SqlClient): SqlClient.SqlClient =>
  new Proxy(sql, {
    get(target, property, receiver) {
      if (property === "withTransaction") {
        return <R, E, A>(self: Effect.Effect<A, E, R>) =>
          Effect.withFiber<A, E | SqlError, R>((fiber) =>
            Option.isSome(Context.getOption(fiber.context, InsideTransaction))
              ? self
              : Effect.provideService(target.withTransaction(self), InsideTransaction, true))
      }
      return Reflect.get(target, property, receiver)
    }
  })
```

## Environment

`effect@4.0.0-rc.112`, `@effect/sql-sqlite-do@4.0.0-rc.112`, miniflare
5.20260828.0-alpha, DO with `useSQLite: true`.

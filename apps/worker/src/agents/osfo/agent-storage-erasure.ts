import { Effect, Schema } from "effect";

export class AgentStorageErasureUnavailable extends Schema.TaggedError<AgentStorageErasureUnavailable>()(
  "AgentStorageErasureUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Facets cannot use deleteAll in the installed runtime; erase their SQLite and KV atomically. */
export const erase = Effect.fn("AgentStorageErasure.erase")((storage: DurableObjectStorage) =>
  Effect.try({
    try: () =>
      storage.transactionSync(() => {
        // workerd owns _cf_KV; erase its entries only through the synchronous KV API.
        const tables = () =>
          storage.sql
            .exec<{ name: string; sql: string | null }>(
              "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV'",
            )
            .toArray();
        const drop = (name: string) => {
          // Names come from SQLite's schema, and quoting preserves any embedded quote.
          try {
            storage.sql.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
          } catch (cause) {
            throw new Error(`Agent storage erasure could not drop table ${name}`, { cause });
          }
        };
        storage.sql.exec("PRAGMA defer_foreign_keys = ON");
        for (const table of tables()) {
          if (table.sql?.toUpperCase().startsWith("CREATE VIRTUAL TABLE")) drop(table.name);
        }
        // Dropping virtual tables removes their shadow tables. Refresh the schema
        // before dropping ordinary tables, including all SDK and product records.
        let remaining = tables().map((table) => {
          try {
            return {
              name: table.name,
              parents: storage.sql
                .exec<{ table: string }>(
                  `PRAGMA foreign_key_list("${table.name.replaceAll('"', '""')}")`,
                )
                .toArray()
                .map((foreignKey) => foreignKey.table),
            };
          } catch (cause) {
            throw new Error(`Agent storage erasure could not inspect table ${table.name}`, {
              cause,
            });
          }
        });
        while (remaining.length > 0) {
          const leaf = remaining.find((candidate) =>
            remaining.every(
              (other) => other.name === candidate.name || !other.parents.includes(candidate.name),
            ),
          );
          if (leaf === undefined)
            throw new Error("Agent storage erasure cannot resolve cyclic table ownership");
          drop(leaf.name);
          remaining = remaining.filter((table) => table.name !== leaf.name);
        }
        for (const [key] of storage.kv.list()) storage.kv.delete(key);
        if (tables().length !== 0 || Array.from(storage.kv.list()).length !== 0) {
          throw new Error("Agent storage erasure could not be verified");
        }
        return { storageErasureVerified: true as const };
      }),
    catch: (cause) =>
      new AgentStorageErasureUnavailable({
        cause,
        message: "Agent storage erasure failed",
      }),
  }),
);

export * as AgentStorageErasure from "./agent-storage-erasure";

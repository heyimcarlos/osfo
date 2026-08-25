/* oxlint-disable effecttsgo/node-builtin-import -- This verification CLI reads run-owned local Wrangler storage. */
import { readdirSync } from "node:fs";
import { Database } from "bun:sqlite";

const [storageRoot, agentId] = process.argv.slice(2);
if (storageRoot === undefined || agentId === undefined) {
  throw new Error("Usage: inspect-agent-storage.mjs <wrangler-storage-root> <agent-id>");
}

const sqlitePaths = findSqliteFiles(storageRoot);
let initializationCount = 0;
let registryCount = 0;

for (const path of sqlitePaths) {
  const database = new Database(path, { readonly: true });
  try {
    if (hasTable(database, "osfo_agent_initialization")) {
      const row = database
        .query("select 1 as present from osfo_agent_initialization where agent_id = ? limit 1")
        .get(agentId);
      if (row !== null) initializationCount += 1;
    }
    if (hasTable(database, "cf_agents_sub_agents")) {
      const row = database
        .query(
          "select 1 as present from cf_agents_sub_agents where class = 'OsfoAgent' and name = ? limit 1",
        )
        .get(agentId);
      if (row !== null) registryCount += 1;
    }
  } finally {
    database.close();
  }
}

process.stdout.write(`${JSON.stringify({ agentId, initializationCount, registryCount })}\n`);

function findSqliteFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return findSqliteFiles(path);
    return entry.isFile() && entry.name.endsWith(".sqlite") ? [path] : [];
  });
}

function hasTable(database, name) {
  return (
    database
      .query("select 1 as present from sqlite_master where type = 'table' and name = ? limit 1")
      .get(name) !== null
  );
}

/**
 * list-tables.js
 *
 * Diagnostic script: connects to whatever database TURSO_DATABASE_URL /
 * TURSO_AUTH_TOKEN point to, and lists every table in it. Used to confirm
 * which database the pipeline is actually talking to, and what the
 * transcripts table (if present) is really called.
 *
 * Usage:
 *   node list-tables.js
 */

const { createClient } = require("@libsql/client");

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  console.log(`Connecting to: ${process.env.TURSO_DATABASE_URL}\n`);

  const result = await turso.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
  );

  if (result.rows.length === 0) {
    console.log("No tables found in this database. It may be empty, or");
    console.log("TURSO_DATABASE_URL may be pointing at the wrong database.");
    return;
  }

  console.log(`Found ${result.rows.length} table(s):`);
  for (const row of result.rows) {
    console.log(`  - ${row.name}`);
  }

  // If something table-like exists, show its columns too, to help spot a
  // transcripts table under a different name.
  console.log("\nColumn details:");
  for (const row of result.rows) {
    const cols = await turso.execute(`PRAGMA table_info(${row.name});`);
    const colNames = cols.rows.map((c) => c.name).join(", ");
    console.log(`  ${row.name}: ${colNames}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

/**
 * mark-rewrite.js
 *
 * Flags existing commentary rows so the next --submit run regenerates
 * them, instead of skipping them as already done. Use this after changing
 * the prompt (voice, length, formatting rules, etc.) and wanting to
 * regenerate chapters that were created under the old prompt.
 *
 * Usage:
 *   node mark-rewrite.js --book "John"     # flag one book
 *   node mark-rewrite.js --all             # flag everything generated so far
 */

const { createClient } = require("@libsql/client");

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  const args = process.argv.slice(2);
  const bookIdx = args.indexOf("--book");
  const book = bookIdx !== -1 ? args[bookIdx + 1] : null;
  const all = args.includes("--all");

  if (!book && !all) {
    console.error('Usage: node mark-rewrite.js --book "John"  OR  node mark-rewrite.js --all');
    process.exit(1);
  }

  const result = book
    ? await turso.execute({
        sql: "UPDATE chapter_commentary SET needs_rewrite = 1 WHERE book = ?",
        args: [book],
      })
    : await turso.execute("UPDATE chapter_commentary SET needs_rewrite = 1");

  console.log(`Flagged ${result.rowsAffected} chapter(s) for rewrite.`);
  console.log("Run --submit again (for the same book, or the full run) to regenerate them.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

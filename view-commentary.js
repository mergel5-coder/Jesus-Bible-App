/**
 * view-commentary.js
 *
 * Diagnostic script: prints the generated commentary for a given book (or
 * all books) so you can review it without needing direct database access.
 *
 * Usage:
 *   node view-commentary.js --book "John"
 *   node view-commentary.js --book "John" --chapter 3
 *   node view-commentary.js                    # shows a summary count only
 */

const { createClient } = require("@libsql/client");

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  const args = process.argv.slice(2);
  const bookIdx = args.indexOf("--book");
  const chapterIdx = args.indexOf("--chapter");
  const book = bookIdx !== -1 ? args[bookIdx + 1] : null;
  const chapter = chapterIdx !== -1 ? parseInt(args[chapterIdx + 1], 10) : null;

  if (!book) {
    const result = await turso.execute(
      "SELECT book, COUNT(*) as count FROM chapter_commentary GROUP BY book ORDER BY book;"
    );
    console.log("Commentary generated so far, by book:\n");
    for (const row of result.rows) {
      console.log(`  ${row.book}: ${row.count} chapter(s)`);
    }
    console.log("\nRun again with --book \"BookName\" to see the actual text.");
    return;
  }

  const sql = chapter
    ? "SELECT book, chapter, commentary FROM chapter_commentary WHERE book = ? AND chapter = ? ORDER BY chapter"
    : "SELECT book, chapter, commentary FROM chapter_commentary WHERE book = ? ORDER BY chapter";
  const args_ = chapter ? [book, chapter] : [book];

  const result = await turso.execute({ sql, args: args_ });

  if (result.rows.length === 0) {
    console.log(`No commentary found for ${book}${chapter ? " " + chapter : ""}.`);
    return;
  }

  for (const row of result.rows) {
    console.log(`\n========== ${row.book} ${row.chapter} ==========\n`);
    console.log(row.commentary);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

/**
 * export-bundle.js
 *
 * Combines the fetched BSB text (data/bsb.json) with the generated
 * commentary (Turso's chapter_commentary table) into a single JSON bundle
 * the app ships with for fully offline reading.
 *
 * Output shape:
 *   {
 *     "John": {
 *       "3": {
 *         "verses": ["For God so loved...", "For God did not send...", ...],
 *         "commentary": "John 3 is one of those chapters..."
 *       },
 *       "21": { ... }
 *     },
 *     "Genesis": { "1": { ... }, ... }
 *   }
 *
 * Only books/chapters that already have generated commentary are included
 * -- so running this now (while the full batch is still processing) safely
 * produces a partial bundle with just what's ready (e.g. John, Genesis,
 * Revelation), and running it again later produces the complete bundle.
 * The app's data layer treats a missing chapter as "not yet available"
 * rather than crashing, so a partial bundle is safe to ship during testing.
 *
 * Usage:
 *   node export-bundle.js
 *
 * Requires env vars:
 *   TURSO_DATABASE_URL
 *   TURSO_AUTH_TOKEN
 *
 * Requires data/bsb.json to already exist (run fetch-bsb.js first).
 */

const { createClient } = require("@libsql/client");
const fs = require("fs");
const path = require("path");

const BSB_PATH = path.join(__dirname, "data", "bsb.json");
const OUTPUT_PATH = path.join(__dirname, "data", "bible-content-bundle.json");

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  if (!fs.existsSync(BSB_PATH)) {
    console.error(`BSB text not found at ${BSB_PATH}. Run fetch-bsb.js first.`);
    process.exit(1);
  }

  const bsb = JSON.parse(fs.readFileSync(BSB_PATH, "utf-8"));

  console.log("Fetching all generated commentary from Turso...");
  const result = await turso.execute(
    "SELECT book, chapter, commentary FROM chapter_commentary WHERE needs_rewrite = 0"
  );

  console.log(`Found ${result.rows.length} generated chapters.`);

  const bundle = {};
  let includedChapters = 0;
  let missingVerseText = 0;

  for (const row of result.rows) {
    const { book, chapter, commentary } = row;
    const chapterIdx = chapter - 1;

    if (!bsb[book] || !bsb[book][chapterIdx]) {
      missingVerseText++;
      console.warn(`  Skipping ${book} ${chapter}: no BSB verse text found for it.`);
      continue;
    }

    if (!bundle[book]) bundle[book] = {};
    bundle[book][chapter] = {
      verses: bsb[book][chapterIdx],
      commentary,
    };
    includedChapters++;
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(bundle));

  const sizeKB = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(0);
  const bookCount = Object.keys(bundle).length;

  console.log(`\nDone. Bundle written to ${OUTPUT_PATH}`);
  console.log(`Books included: ${bookCount}`);
  console.log(`Chapters included: ${includedChapters}`);
  console.log(`Bundle size: ${sizeKB} KB`);
  if (missingVerseText > 0) {
    console.log(`Note: ${missingVerseText} chapter(s) had commentary but no matching BSB text -- check data/bsb.json is fully populated.`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

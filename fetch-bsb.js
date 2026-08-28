/**
 * fetch-bsb.js
 *
 * Downloads the full Berean Standard Bible (BSB) text, chapter by chapter,
 * and assembles it into the JSON shape required by generate-commentary.js:
 *
 *   { "Genesis": [ ["v1","v2",...], ["v1","v2",...], ... ], "Exodus": [...] }
 *
 * The BSB was released into the public domain by the Berean Bible team
 * specifically so it can be used freely in apps like this one — see
 * https://berean.bible/ and https://faithtools.substack.com/p/persistence-and-berean-study-bible
 *
 * This script uses bible-api.com, a free, unlimited, no-key-required API
 * that serves the BSB (translation code "bsb") alongside other public
 * domain translations.
 *
 * IMPORTANT: run `node fetch-bsb.js --test` first to confirm the API and
 * translation code still respond as expected before running a full fetch —
 * free third-party APIs occasionally change endpoints or formats.
 *
 * Usage:
 *   node fetch-bsb.js --test           # fetch just John 3, print it, verify BSB wording
 *   node fetch-bsb.js                  # fetch the entire Bible (all 1,189 chapters)
 *   node fetch-bsb.js --book "John"    # fetch just one book
 */

const fs = require("fs");
const path = require("path");

const API_BASE = "https://bible-api.com";
const TRANSLATION = "bsb";
const OUTPUT_PATH = path.join(__dirname, "data", "bsb.json");
const REQUEST_DELAY_MS = 250; // be polite to a free public API
const RETRY_LIMIT = 3;

// Book name -> chapter count. Used to know how many chapters to request per book.
const BOOKS = {
  Genesis: 50, Exodus: 40, Leviticus: 27, Numbers: 36, Deuteronomy: 34,
  Joshua: 24, Judges: 21, Ruth: 4, "1 Samuel": 31, "2 Samuel": 24,
  "1 Kings": 22, "2 Kings": 25, "1 Chronicles": 29, "2 Chronicles": 36,
  Ezra: 10, Nehemiah: 13, Esther: 10, Job: 42, Psalms: 150, Proverbs: 31,
  Ecclesiastes: 12, "Song of Solomon": 8, Isaiah: 66, Jeremiah: 52,
  Lamentations: 5, Ezekiel: 48, Daniel: 12, Hosea: 14, Joel: 3, Amos: 9,
  Obadiah: 1, Jonah: 4, Micah: 7, Nahum: 3, Habakkuk: 3, Zephaniah: 3,
  Haggai: 2, Zechariah: 14, Malachi: 4,
  Matthew: 28, Mark: 16, Luke: 24, John: 21, Acts: 28, Romans: 16,
  "1 Corinthians": 16, "2 Corinthians": 13, Galatians: 6, Ephesians: 6,
  Philippians: 4, Colossians: 4, "1 Thessalonians": 5, "2 Thessalonians": 3,
  "1 Timothy": 6, "2 Timothy": 4, Titus: 3, Philemon: 1, Hebrews: 13,
  James: 5, "1 Peter": 5, "2 Peter": 3, "1 John": 5, "2 John": 1,
  "3 John": 1, Jude: 1, Revelation: 22,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchChapter(book, chapter) {
  const url = `${API_BASE}/${encodeURIComponent(book)}+${chapter}?translation=${TRANSLATION}`;

  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (!data.verses || !Array.isArray(data.verses)) {
        throw new Error("Unexpected response shape — no verses array");
      }

      return data.verses.map((v) => v.text.trim());
    } catch (err) {
      console.error(`  Attempt ${attempt} failed for ${book} ${chapter}: ${err.message}`);
      if (attempt === RETRY_LIMIT) throw err;
      await sleep(1000 * attempt);
    }
  }
}

async function runTest() {
  console.log("Fetching John 3 as a smoke test...\n");
  const verses = await fetchChapter("John", 3);
  console.log(verses.slice(15, 17).join(" ")); // verses 16-17
  console.log("\nIf this reads 'For God so loved the world that He gave His");
  console.log("one and only Son...' (BSB wording), the API and translation");
  console.log("code are working correctly. If it looks like a different");
  console.log("translation (e.g. 'only begotten Son' = KJV), stop and check");
  console.log("the translation parameter before running a full fetch.");
}

async function runFull(bookFilter) {
  const output = fs.existsSync(OUTPUT_PATH)
    ? JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf-8"))
    : {};

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  const books = bookFilter
    ? Object.entries(BOOKS).filter(([name]) => name.toLowerCase() === bookFilter.toLowerCase())
    : Object.entries(BOOKS);

  if (books.length === 0) {
    console.error(`Book "${bookFilter}" not recognized.`);
    process.exit(1);
  }

  let totalChapters = books.reduce((sum, [, count]) => sum + count, 0);
  let done = 0;

  for (const [book, chapterCount] of books) {
    output[book] = output[book] || [];

    for (let ch = 1; ch <= chapterCount; ch++) {
      if (output[book][ch - 1]) {
        done++;
        continue; // already fetched — resumable
      }

      const verses = await fetchChapter(book, ch);
      output[book][ch - 1] = verses;
      done++;
      console.log(`✓ ${book} ${ch} (${done}/${totalChapters})`);

      // Save progress every chapter so an interruption doesn't lose work
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output));

      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log(`\nDone. Saved to ${OUTPUT_PATH}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--test")) {
    return runTest();
  }

  const bookIdx = args.indexOf("--book");
  const bookFilter = bookIdx !== -1 ? args[bookIdx + 1] : null;

  await runFull(bookFilter);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

/**
 * fetch-bsb.js
 *
 * Downloads the full Berean Standard Bible (BSB) text, chapter by chapter,
 * and assembles it into the JSON shape required by generate-commentary.js:
 *
 *   { "Genesis": [ ["v1","v2",...], ["v1","v2",...], ... ], "Exodus": [...] }
 *
 * Uses the free Bible API at https://bible.helloao.org — built by the same
 * team (helloao.org) that worked with the Berean Bible team to release the
 * BSB into the public domain. See:
 *   https://faithtools.substack.com/p/persistence-and-berean-study-bible
 *
 * IMPORTANT: run `node fetch-bsb.js --test` first. It prints the raw API
 * response in full. If the wording or shape doesn't look right, paste the
 * output back for a quick fix -- no need to guess blindly through multiple
 * failed full runs.
 *
 * Usage:
 *   node fetch-bsb.js --test           # fetch John 3, print raw + parsed result
 *   node fetch-bsb.js                  # fetch the entire Bible (all 1,189 chapters)
 *   node fetch-bsb.js --book "John"    # fetch just one book
 */

const fs = require("fs");
const path = require("path");

const API_BASE = "https://bible.helloao.org/api";
const TRANSLATION_ID = "BSB";
const OUTPUT_PATH = path.join(__dirname, "data", "bsb.json");
const REQUEST_DELAY_MS = 150;
const RETRY_LIMIT = 3;

// USFM-style 3-letter book codes used by this API, mapped to the display
// names used throughout the rest of the pipeline, with chapter counts.
const BOOKS = [
  ["GEN", "Genesis", 50], ["EXO", "Exodus", 40], ["LEV", "Leviticus", 27],
  ["NUM", "Numbers", 36], ["DEU", "Deuteronomy", 34], ["JOS", "Joshua", 24],
  ["JDG", "Judges", 21], ["RUT", "Ruth", 4], ["1SA", "1 Samuel", 31],
  ["2SA", "2 Samuel", 24], ["1KI", "1 Kings", 22], ["2KI", "2 Kings", 25],
  ["1CH", "1 Chronicles", 29], ["2CH", "2 Chronicles", 36], ["EZR", "Ezra", 10],
  ["NEH", "Nehemiah", 13], ["EST", "Esther", 10], ["JOB", "Job", 42],
  ["PSA", "Psalms", 150], ["PRO", "Proverbs", 31], ["ECC", "Ecclesiastes", 12],
  ["SNG", "Song of Solomon", 8], ["ISA", "Isaiah", 66], ["JER", "Jeremiah", 52],
  ["LAM", "Lamentations", 5], ["EZK", "Ezekiel", 48], ["DAN", "Daniel", 12],
  ["HOS", "Hosea", 14], ["JOL", "Joel", 3], ["AMO", "Amos", 9],
  ["OBA", "Obadiah", 1], ["JON", "Jonah", 4], ["MIC", "Micah", 7],
  ["NAM", "Nahum", 3], ["HAB", "Habakkuk", 3], ["ZEP", "Zephaniah", 3],
  ["HAG", "Haggai", 2], ["ZEC", "Zechariah", 14], ["MAL", "Malachi", 4],
  ["MAT", "Matthew", 28], ["MRK", "Mark", 16], ["LUK", "Luke", 24],
  ["JHN", "John", 21], ["ACT", "Acts", 28], ["ROM", "Romans", 16],
  ["1CO", "1 Corinthians", 16], ["2CO", "2 Corinthians", 13], ["GAL", "Galatians", 6],
  ["EPH", "Ephesians", 6], ["PHP", "Philippians", 4], ["COL", "Colossians", 4],
  ["1TH", "1 Thessalonians", 5], ["2TH", "2 Thessalonians", 3], ["1TI", "1 Timothy", 6],
  ["2TI", "2 Timothy", 4], ["TIT", "Titus", 3], ["PHM", "Philemon", 1],
  ["HEB", "Hebrews", 13], ["JAS", "James", 5], ["1PE", "1 Peter", 5],
  ["2PE", "2 Peter", 3], ["1JN", "1 John", 5], ["2JN", "2 John", 1],
  ["3JN", "3 John", 1], ["JUD", "Jude", 1], ["REV", "Revelation", 22],
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts an array of verse strings from whatever shape the API returns.
 * Written defensively since we're relying on documentation recall rather
 * than a live-verified schema -- logs the raw shape if it doesn't match
 * any known pattern, so a fix can be made from real data.
 */
function extractVerses(json) {
  // Known shape: { chapter: { content: [ { type: "verse", number, content: [...] }, ... ] } }
  if (json.chapter && Array.isArray(json.chapter.content)) {
    const verseItems = json.chapter.content.filter((item) => item.type === "verse");
    if (verseItems.length > 0) {
      return verseItems.map((v) => {
        if (!Array.isArray(v.content)) return String(v.content).trim();
        // Verse content arrays mix plain strings with footnote reference
        // objects like {"noteId":13} -- keep only the actual text pieces.
        return v.content
          .filter((piece) => typeof piece === "string")
          .join("")
          .replace(/\s+/g, " ")
          .trim();
      });
    }
  }

  // Fallback shape: { verses: [ { text: "..." }, ... ] }
  if (Array.isArray(json.verses)) {
    return json.verses.map((v) => (v.text || v.content || "").toString().trim());
  }

  return null; // unrecognized shape -- caller handles this
}

async function fetchChapter(bookCode, chapter, { verbose = false } = {}) {
  const url = `${API_BASE}/${TRANSLATION_ID}/${bookCode}/${chapter}.json`;

  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const res = await fetch(url);
      const bodyText = await res.text();

      if (verbose) {
        console.log(`\nURL: ${url}`);
        console.log(`Status: ${res.status}`);
        console.log(`Raw response (first 2000 chars):\n${bodyText.slice(0, 2000)}`);
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = JSON.parse(bodyText);
      const verses = extractVerses(json);

      if (!verses) {
        throw new Error(
          "Response parsed as JSON but didn't match any known shape. " +
          "See the raw response above (run with --test to see it) and " +
          "report back so extractVerses() can be fixed."
        );
      }

      return verses;
    } catch (err) {
      console.error(`  Attempt ${attempt} failed for ${bookCode} ${chapter}: ${err.message}`);
      if (attempt === RETRY_LIMIT) throw err;
      await sleep(1000 * attempt);
    }
  }
}

async function runTest() {
  console.log("Fetching John 3 as a smoke test (verbose mode -- showing raw response)...");
  const verses = await fetchChapter("JHN", 3, { verbose: true });

  console.log("\n--- Parsed result ---");
  console.log(`Got ${verses.length} verses.`);
  console.log("Verses 16-17:");
  console.log(verses.slice(15, 17).join(" "));

  console.log("\nIf that reads something like 'For God so loved the world");
  console.log("that He gave His one and only Son...' (BSB wording), everything");
  console.log("is working -- run the full fetch next. If the verse count looks");
  console.log("wrong (John 3 has 36 verses) or the wording looks like a");
  console.log("different translation, paste this output back for a fix.");
}

async function runFull(bookFilter) {
  const output = fs.existsSync(OUTPUT_PATH)
    ? JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf-8"))
    : {};

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  const books = bookFilter
    ? BOOKS.filter(([, name]) => name.toLowerCase() === bookFilter.toLowerCase())
    : BOOKS;

  if (books.length === 0) {
    console.error(`Book "${bookFilter}" not recognized.`);
    process.exit(1);
  }

  const totalChapters = books.reduce((sum, [, , count]) => sum + count, 0);
  let done = 0;

  for (const [code, name, chapterCount] of books) {
    output[name] = output[name] || [];

    for (let ch = 1; ch <= chapterCount; ch++) {
      if (output[name][ch - 1]) {
        done++;
        continue; // already fetched -- resumable
      }

      const verses = await fetchChapter(code, ch);
      output[name][ch - 1] = verses;
      done++;
      console.log(`\u2713 ${name} ${ch} (${done}/${totalChapters})`);

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

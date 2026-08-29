/**
 * generate-commentary.js
 *
 * Batch-generates "How this chapter points to Jesus" commentary for every
 * chapter of the Bible, using the BSB text and Josh's Church Lessons
 * transcripts as grounding context. Writes results to a Turso table.
 *
 * Usage:
 *   node generate-commentary.js                # generate all missing chapters
 *   node generate-commentary.js --book "John"   # only one book
 *   node generate-commentary.js --retry-flagged # re-run rows marked needs_rewrite
 *
 * Requires env vars:
 *   ANTHROPIC_API_KEY
 *   TURSO_DATABASE_URL
 *   TURSO_AUTH_TOKEN
 */

const { createClient } = require("@libsql/client");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

// ---------- Config ----------

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1000;
const CONCURRENCY = 3; // parallel requests — keep modest to avoid rate limits
const RETRY_LIMIT = 3;
const RETRY_BASE_DELAY_MS = 2000;

// Path to a local BSB JSON dump: { "Genesis": [["In the beginning...", ...], [...]], ... }
// Each book maps to an array of chapters, each chapter an array of verse strings.
const BSB_PATH = path.join(__dirname, "data", "bsb.json");

// ---------- Clients ----------

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ---------- Prompt template ----------

const SYSTEM_PROMPT = `You are writing a devotional reflection for a Bible reading app.
Your task: explain how a specific Bible chapter connects to Jesus Christ
— his person, his work, or the redemption he accomplished.

Theological framework (apply consistently, without stating it explicitly
as doctrine — let it shape the reflection naturally):
- Jesus has accomplished everything necessary for redemption; his work
  is finished, not still unfolding
- He reigns now, actively and fully — not merely a future hope
- Death has been defeated through him
- Christians enter directly into God's presence at death

Voice and style:
- Warm, clear, pastoral — not academic or dense
- Third person only. Never use first-person language like "I" or "me"
  (e.g. never "what strikes me" or "I find") — write as a steady,
  consistent narrator throughout, not a personal reflection
- Write for someone reading the Bible on their own, not a scholar
- Avoid jargon; explain any theological term you use
- 3 paragraphs, roughly 200-260 words total
- Do not simply summarize the chapter — connect it specifically to Jesus
- If the chapter has no obvious direct connection (e.g. a genealogy, a
  law code, a historical detail), find the thread through pattern,
  promise, contrast, or foreshadowing rather than forcing something
  artificial
- Weave in 2-4 relevant cross-references (book, chapter, verse) where
  they genuinely illuminate the connection — never force one in just
  to hit a quota. Write them inline in natural sentence flow rather
  than as a bare citation list at the end
- Actively look for Old Testament connections specifically: fulfilled
  prophecy, foreshadowing (a person, event, sacrifice, or object that
  prefigures Christ), promises being kept, or a pattern the New
  Testament text is deliberately echoing. When the chapter is itself
  in the Old Testament, this is often the heart of the whole
  reflection; when it's in the New Testament, look for what it's
  quoting, alluding to, or fulfilling from the Old. Prioritize a
  genuine Old Testament connection over a New Testament one when both
  are available and equally strong
- Plain text only. Do not use markdown formatting of any kind —
  no asterisks for italics or bold, no underscores, no headers. Quote
  Scripture using plain quotation marks only (e.g. "Look, the Lamb of
  God"), never wrapped in asterisks

Output only the reflection text. No heading, no chapter summary preamble.`;

function buildUserPrompt({ book, chapter, chapterText, transcriptExcerpts }) {
  return `Grounding material (from Josh's Church Lessons teaching — prioritize
consistency with these when the topic overlaps):
${transcriptExcerpts || "(no closely matching transcript found — rely on the theological framework above)"}

CHAPTER TEXT:
${book} ${chapter}
${chapterText}

Write the reflection now.`;
}

// ---------- Retrieval (reuses Church Lessons AI's keyword approach) ----------

async function retrieveRelevantTranscripts(book, chapter, chapterText) {
  // Simple keyword extraction: pull distinctive words from the chapter text,
  // match against a transcripts table already populated by Church Lessons AI.
  const keywords = extractKeywords(chapterText);
  if (keywords.length === 0) return "";

  const placeholders = keywords.map(() => "?").join(" OR transcript LIKE ");
  const likeParams = keywords.map((k) => `%${k}%`);

  const result = await turso.execute({
    sql: `SELECT title, transcript FROM lessons
          WHERE transcript LIKE ${placeholders}
          LIMIT 5`,
    args: likeParams,
  });

  if (result.rows.length === 0) return "";

  return result.rows
    .map((row) => `[${row.title}]\n${truncate(row.transcript, 600)}`)
    .join("\n\n");
}

function extractKeywords(text) {
  const stopwords = new Set([
    "the", "and", "for", "that", "with", "his", "her", "unto", "shall",
    "have", "them", "from", "was", "are", "not", "you", "your", "this",
  ]);
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !stopwords.has(w));

  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w);
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
}

// ---------- Generation ----------

async function generateCommentary({ book, chapter, chapterText, transcriptExcerpts }) {
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildUserPrompt({ book, chapter, chapterText, transcriptExcerpts }),
          },
        ],
      });

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      if (!text) throw new Error("Empty response from model");
      return text;
    } catch (err) {
      console.error(`  Attempt ${attempt} failed for ${book} ${chapter}: ${err.message}`);
      if (attempt === RETRY_LIMIT) throw err;
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- DB setup ----------

async function ensureTable() {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS chapter_commentary (
      book TEXT NOT NULL,
      chapter INTEGER NOT NULL,
      commentary TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      reviewed INTEGER DEFAULT 0,
      needs_rewrite INTEGER DEFAULT 0,
      PRIMARY KEY (book, chapter)
    )
  `);
}

async function alreadyGenerated(book, chapter) {
  const result = await turso.execute({
    sql: `SELECT 1 FROM chapter_commentary WHERE book = ? AND chapter = ? AND needs_rewrite = 0`,
    args: [book, chapter],
  });
  return result.rows.length > 0;
}

async function saveCommentary(book, chapter, commentary) {
  await turso.execute({
    sql: `INSERT INTO chapter_commentary (book, chapter, commentary, generated_at, reviewed, needs_rewrite)
          VALUES (?, ?, ?, ?, 0, 0)
          ON CONFLICT(book, chapter) DO UPDATE SET
            commentary = excluded.commentary,
            generated_at = excluded.generated_at,
            needs_rewrite = 0`,
    args: [book, chapter, commentary, new Date().toISOString()],
  });
}

// ---------- Main ----------

async function main() {
  const args = process.argv.slice(2);
  const bookFilter = getArgValue(args, "--book");
  const retryFlagged = args.includes("--retry-flagged");

  if (!fs.existsSync(BSB_PATH)) {
    console.error(`BSB text not found at ${BSB_PATH}.`);
    console.error("Download it first (e.g. from bible-api.com or a BSB JSON dump)");
    console.error('and save it in the shape: { "Genesis": [["v1","v2",...], [...]], ... }');
    process.exit(1);
  }

  const bsb = JSON.parse(fs.readFileSync(BSB_PATH, "utf-8"));
  await ensureTable();

  const jobs = [];
  for (const [book, chapters] of Object.entries(bsb)) {
    if (bookFilter && book.toLowerCase() !== bookFilter.toLowerCase()) continue;
    chapters.forEach((verses, idx) => {
      jobs.push({ book, chapter: idx + 1, verses });
    });
  }

  console.log(`Queued ${jobs.length} chapters${bookFilter ? ` (book: ${bookFilter})` : ""}.`);

  let completed = 0;
  let skipped = 0;
  let failed = 0;

  // Simple concurrency pool
  const queue = [...jobs];
  const workers = Array.from({ length: CONCURRENCY }, () => worker());

  async function worker() {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      const { book, chapter, verses } = job;

      if (!retryFlagged && (await alreadyGenerated(book, chapter))) {
        skipped++;
        continue;
      }

      const chapterText = verses.join(" ");

      try {
        const transcriptExcerpts = await retrieveRelevantTranscripts(book, chapter, chapterText);
        const commentary = await generateCommentary({
          book,
          chapter,
          chapterText,
          transcriptExcerpts,
        });
        await saveCommentary(book, chapter, commentary);
        completed++;
        console.log(`✓ ${book} ${chapter} (${completed} done, ${queue.length} left)`);
      } catch (err) {
        failed++;
        console.error(`✗ ${book} ${chapter} failed permanently: ${err.message}`);
      }
    }
  }

  await Promise.all(workers);

  console.log("\n---");
  console.log(`Done. Generated: ${completed}, Skipped (already done): ${skipped}, Failed: ${failed}`);
  if (failed > 0) {
    console.log("Re-run the same command to retry failed chapters (they were not saved).");
  }
}

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

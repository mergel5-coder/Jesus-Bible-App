/**
 * generate-commentary-batch.js
 *
 * Cost-optimized version of generate-commentary.js using:
 *   1. The Anthropic Batches API (50% off input + output tokens)
 *   2. Prompt caching on the system prompt (further reduces repeated cost)
 *
 * Trade-off: batches are asynchronous. Submitting all 1,189 chapters takes
 * seconds, but Anthropic processes the batch over the next few hours (often
 * much faster, but not guaranteed instant). This script submits the batch,
 * then you run it again later with --check to poll status and save results
 * once done.
 *
 * Usage:
 *   node generate-commentary-batch.js --submit           # submit all missing chapters
 *   node generate-commentary-batch.js --submit --book "John"
 *   node generate-commentary-batch.js --check <batch_id>  # check status / retrieve results
 *
 * Requires the same env vars as generate-commentary.js:
 *   ANTHROPIC_API_KEY, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
 */

const { createClient } = require("@libsql/client");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1000;
const BSB_PATH = path.join(__dirname, "data", "bsb.json");
const BATCH_ID_FILE = path.join(__dirname, "data", "last-batch-id.txt");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Same system prompt as generate-commentary.js — kept identical so caching
// and retrieval logic stay consistent between both scripts.
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
- Write for someone reading the Bible on their own, not a scholar
- Avoid jargon; explain any theological term you use
- 3 paragraphs, roughly 180-220 words total
- Do not simply summarize the chapter — connect it specifically to Jesus
- If the chapter has no obvious direct connection (e.g. a genealogy, a
  law code, a historical detail), find the thread through pattern,
  promise, contrast, or foreshadowing rather than forcing something
  artificial
- Weave in 1-3 relevant cross-references (book, chapter, verse) where
  they genuinely illuminate the connection — never force one in just
  to hit a quota. Write them inline in natural sentence flow rather
  than as a bare citation list at the end

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

// ---------- Retrieval (same approach as the live-request script) ----------

async function retrieveRelevantTranscripts(chapterText) {
  const keywords = extractKeywords(chapterText);
  if (keywords.length === 0) return "";

  const placeholders = keywords.map(() => "?").join(" OR content LIKE ");
  const likeParams = keywords.map((k) => `%${k}%`);

  const result = await turso.execute({
    sql: `SELECT title, content FROM transcripts WHERE content LIKE ${placeholders} LIMIT 5`,
    args: likeParams,
  });

  if (result.rows.length === 0) return "";
  return result.rows
    .map((row) => `[${row.title}]\n${truncate(row.content, 600)}`)
    .join("\n\n");
}

function extractKeywords(text) {
  const stopwords = new Set([
    "the", "and", "for", "that", "with", "his", "her", "unto", "shall",
    "have", "them", "from", "was", "are", "not", "you", "your", "this",
  ]);
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/)
    .filter((w) => w.length > 4 && !stopwords.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
}

// ---------- DB ----------

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
            commentary = excluded.commentary, generated_at = excluded.generated_at, needs_rewrite = 0`,
    args: [book, chapter, commentary, new Date().toISOString()],
  });
}

// ---------- Submit ----------

async function submitBatch(bookFilter) {
  if (!fs.existsSync(BSB_PATH)) {
    console.error(`BSB text not found at ${BSB_PATH}. Run fetch-bsb.js first.`);
    process.exit(1);
  }

  const bsb = JSON.parse(fs.readFileSync(BSB_PATH, "utf-8"));
  await ensureTable();

  const requests = [];
  for (const [book, chapters] of Object.entries(bsb)) {
    if (bookFilter && book.toLowerCase() !== bookFilter.toLowerCase()) continue;

    for (let idx = 0; idx < chapters.length; idx++) {
      const chapter = idx + 1;
      if (await alreadyGenerated(book, chapter)) continue;

      const chapterText = chapters[idx].join(" ");
      const transcriptExcerpts = await retrieveRelevantTranscripts(chapterText);

      requests.push({
        custom_id: `${book}__${chapter}`,
        params: {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: [
            {
              type: "text",
              text: SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" }, // prompt caching — repeated across all requests
            },
          ],
          messages: [
            {
              role: "user",
              content: buildUserPrompt({ book, chapter, chapterText, transcriptExcerpts }),
            },
          ],
        },
      });
    }
  }

  if (requests.length === 0) {
    console.log("Nothing to submit — all chapters already generated.");
    return;
  }

  console.log(`Submitting a batch of ${requests.length} chapters...`);

  const batch = await anthropic.messages.batches.create({ requests });

  fs.writeFileSync(BATCH_ID_FILE, batch.id);
  console.log(`\nBatch submitted. ID: ${batch.id}`);
  console.log(`Saved to ${BATCH_ID_FILE} for convenience.`);
  console.log(`\nProcessing typically takes anywhere from minutes to a few hours.`);
  console.log(`Check status any time with:`);
  console.log(`  node generate-commentary-batch.js --check ${batch.id}`);
}

// ---------- Check / retrieve ----------

async function checkBatch(batchId) {
  const id = batchId || (fs.existsSync(BATCH_ID_FILE) ? fs.readFileSync(BATCH_ID_FILE, "utf-8").trim() : null);

  if (!id) {
    console.error("No batch ID provided and none saved from a previous --submit run.");
    process.exit(1);
  }

  const batch = await anthropic.messages.batches.retrieve(id);
  console.log(`Batch ${id} status: ${batch.processing_status}`);

  if (batch.processing_status !== "ended") {
    console.log("Not finished yet — check back later with the same command.");
    return;
  }

  console.log("Batch complete. Retrieving and saving results...\n");

  let saved = 0;
  let errored = 0;

  for await (const result of await anthropic.messages.batches.results(id)) {
    const [book, chapterStr] = result.custom_id.split("__");
    const chapter = parseInt(chapterStr, 10);

    if (result.result.type === "succeeded") {
      const text = result.result.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      await saveCommentary(book, chapter, text);
      saved++;
    } else {
      console.error(`✗ ${book} ${chapter}: ${result.result.type}`);
      errored++;
    }
  }

  console.log(`\nDone. Saved: ${saved}, Errored: ${errored}`);
  if (errored > 0) {
    console.log("Re-run --submit to retry errored chapters (they weren't saved).");
  }
}

// ---------- Main ----------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--submit")) {
    const bookIdx = args.indexOf("--book");
    const bookFilter = bookIdx !== -1 ? args[bookIdx + 1] : null;
    return submitBatch(bookFilter);
  }

  if (args.includes("--check")) {
    const idx = args.indexOf("--check");
    const batchId = args[idx + 1] && !args[idx + 1].startsWith("--") ? args[idx + 1] : null;
    return checkBatch(batchId);
  }

  console.log("Usage:");
  console.log("  node generate-commentary-batch.js --submit [--book \"John\"]");
  console.log("  node generate-commentary-batch.js --check [batch_id]");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

# Bible app commentary pipeline

Batch-generates "How this chapter points to Jesus" commentary for all 1,189
Bible chapters, grounded in your Church Lessons transcripts, and stores the
results in Turso for the app to read at runtime (no live API calls needed
in the app itself).

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Set environment variables:
   ```
   export ANTHROPIC_API_KEY=sk-...
   export TURSO_DATABASE_URL=libsql://your-db.turso.io
   export TURSO_AUTH_TOKEN=your-token
   ```

3. Fetch the BSB text automatically with `fetch-bsb.js`, which pulls from
   bible-api.com (a free, unlimited, no-key API that serves the BSB — the
   Berean Bible team released it into the public domain specifically for
   this kind of use).

   First, run the smoke test to confirm the API and translation code are
   still working before committing to a full fetch:
   ```
   node fetch-bsb.js --test
   ```
   This fetches John 3:16-17 and prints it. Confirm it reads "For God so
   loved the world that He gave His one and only Son..." (BSB wording) —
   if it looks like a different translation (e.g. "only begotten Son" is
   KJV), stop and check the `translation=bsb` parameter before proceeding.

   Once confirmed, fetch everything:
   ```
   node fetch-bsb.js
   ```
   This takes a while (1,189 chapters, with a small delay between requests
   to be polite to the free API) and saves progress after every chapter,
   so it's safe to stop and resume — just re-run the same command. Test on
   a single book first if you want:
   ```
   node fetch-bsb.js --book "John"
   ```
   Output is saved to `data/bsb.json`, shaped like:
   ```json
   {
     "Genesis": [
       ["In the beginning God created...", "And the earth was without form..."],
       ["Thus the heavens and the earth were finished...", "..."]
     ],
     "Exodus": [ ... ]
   }
   ```

4. Make sure your existing `transcripts` table (from Church Lessons AI) is
   reachable in the same Turso database — the script queries it directly
   for grounding context. If it lives in a different database, point
   `TURSO_DATABASE_URL` there or add a second client for it.

## Running

Generate everything (skips chapters already done):
```
node generate-commentary.js
```

Generate just one book (useful for testing):
```
node generate-commentary.js --book "John"
```

Re-run chapters you flagged for rewrite:
```
node generate-commentary.js --retry-flagged
```

## Reviewing output

Query flagged/unreviewed chapters directly in Turso:
```sql
SELECT book, chapter, commentary FROM chapter_commentary WHERE reviewed = 0;
```

To flag a chapter for regeneration after reading it:
```sql
UPDATE chapter_commentary SET needs_rewrite = 1 WHERE book = 'Leviticus' AND chapter = 11;
```

Then re-run with `--retry-flagged`.

## Cost-effective option: generate-commentary-batch.js

`generate-commentary.js` calls the API live, one chapter at a time. For a
one-time bulk job like this, `generate-commentary-batch.js` is cheaper and
does the exact same thing, using two Anthropic cost-saving features:

- **Batch API** — 50% off both input and output tokens. Trade-off:
  asynchronous — you submit, then check back later (typically minutes to a
  few hours) rather than getting results immediately.
- **Prompt caching** — the system prompt (theological framework + style
  rules) is identical across all 1,189 requests, so caching it cuts
  further into the repeated cost.

Usage:
```
node generate-commentary-batch.js --submit              # submit all missing chapters
node generate-commentary-batch.js --submit --book "John"  # test on one book first
node generate-commentary-batch.js --check                # check status / save results once ready
```

The batch ID is saved locally after submitting, so `--check` with no
argument automatically checks your most recent batch. Run `--check` again
later if it's not done yet — it's safe to run repeatedly.

Recommended: test with `--submit --book "John"` first, review those 21
commentaries in Turso, then submit the full run once you're happy with
the output.

## Running this entirely in the cloud (no local machine needed)

If you'd rather not run any of this on your own computer, `.github/workflows/generate-commentary.yml`
lets you do the whole thing from GitHub's website, using GitHub Actions
(free for this kind of usage) to actually run the scripts.

**One-time setup:**

1. Create a GitHub repository (or use an existing one) and upload this
   entire `bible-app-pipeline` folder to it — you can drag-and-drop files
   directly on github.com if you don't want to use git from a terminal.

2. In the repo, go to **Settings → Secrets and variables → Actions** and
   add three repository secrets:
   - `ANTHROPIC_API_KEY`
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`

   These are encrypted by GitHub and never appear in logs or to anyone
   without repo admin access.

**Running each step:**

Go to the **Actions** tab → **Generate chapter commentary** (in the left
sidebar) → **Run workflow** button. A dropdown lets you pick which step
to run:

1. `fetch-bsb-test` — confirms the Bible API responds correctly (check
   the run's log output)
2. `fetch-bsb-full` — fetches all 1,189 chapters (takes a while; the
   workflow is allowed up to 2 hours)
3. `generate-batch-submit-john` — submits a test batch for John only
4. `generate-batch-check` — checks status and saves results once ready
   (run this again later if it says "not finished yet")
5. `generate-batch-submit-all` — once John looks good, submit everything

Each run shows live logs in the Actions tab so you can watch progress
and see any errors, exactly like a terminal — just in the browser.

**Note on the Bible text cache:** the workflow caches `data/bsb.json`
between runs so you don't have to re-fetch it every time. If the cache
ever seems stale or missing, just re-run `fetch-bsb-full`.


- Concurrency is set to 3 parallel requests — safe default, raise cautiously
  if you're not hitting rate limits.
- Failed chapters are not saved, so simply re-running the same command will
  retry only what's missing.
- Retrieval reuses the same keyword-matching approach as Church Lessons AI.
  If you upgrade that assistant to smarter retrieval later, swap the
  `retrieveRelevantTranscripts` function here to match.

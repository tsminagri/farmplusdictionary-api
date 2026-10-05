/**
 * Bulk-translate every term's English `description` to Myanmar and write the
 * result into a new `descriptionMyanmar` field on the same doc. Safe to
 * re-run: skips terms that already have a non-empty descriptionMyanmar.
 *
 *   npx tsx scripts/bulk-translate-descriptions.ts
 *
 * Reads Gemini key from .gemini-api-key (gitignored) or GEMINI_API_KEY env.
 * Reads Firebase Admin creds from service-account.json.
 *
 * Rate-limiting: fires up to CONCURRENCY translations at once; a small pause
 * between waves keeps us under Gemini's paid-tier RPM even during bursts.
 * The whole run for ~4,000 descriptions typically finishes in 5–10 minutes.
 *
 * Cost: paid Gemini Flash is ~$0.10 / 1M output tokens. A typical description
 * is ~50-150 output tokens, so 4,000 translations ≈ $0.05 total.
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { GoogleGenAI } from '@google/genai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// --- Config ---------------------------------------------------------------
// Paid-tier gemini-3.5-flash supports ~1,000 RPM. We run with modest
// concurrency and almost no pacing — the retry/backoff logic handles the
// rare transient 429/503. Should finish ~6k translations in minutes.
const CONCURRENCY = 10;             // parallel in-flight requests
const PACE_MS = 100;                // tiny jitter between batch starts
const MAX_DESCRIPTION_LEN = 2000;   // matches the Cloud Function's cap
const MODEL = 'gemini-3.5-flash';
const LOG_FILE = resolve(root, 'bulk-translate.log');

// --- Credentials ----------------------------------------------------------
const geminiKey =
  process.env.GEMINI_API_KEY?.trim() ||
  (existsSync(resolve(root, '.gemini-api-key'))
    ? readFileSync(resolve(root, '.gemini-api-key'), 'utf8').trim()
    : '');
if (!geminiKey) {
  console.error('No Gemini key found. Set GEMINI_API_KEY or create .gemini-api-key.');
  process.exit(1);
}

const sa = JSON.parse(readFileSync(resolve(root, 'service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const ai = new GoogleGenAI({ apiKey: geminiKey });

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* logging is best-effort */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Extract the "retry in N seconds" hint the Gemini API includes on 429 errors
 * so we can wait exactly as long as required (plus a small buffer) instead
 * of guessing.
 */
function retryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/retry in (\d+(?:\.\d+)?)s/i) || msg.match(/"retryDelay":\s*"(\d+)s"/);
  if (!m) return null;
  return Math.ceil(parseFloat(m[1]) * 1000);
}

async function translate(text: string, attempt = 1): Promise<string> {
  const prompt = [
    'You are translating an agricultural dictionary entry from English to Myanmar (Burmese).',
    'Return ONLY the Myanmar translation of the text below.',
    'Do NOT include quotes, explanations, romanisation, or the original English.',
    'Preserve technical accuracy for farming, crops, livestock, fertilizers, pests and equipment.',
    '',
    'English:',
    text,
  ].join('\n');
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
    });
    const out = (response.text || '').trim();
    if (!out) throw new Error('empty response');
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const is429 = /429|RESOURCE_EXHAUSTED|quota/i.test(msg);
    const is503 = /503|UNAVAILABLE|high demand/i.test(msg);
    if ((is429 || is503) && attempt <= 6) {
      const hint = retryDelayMs(e);
      const wait = hint != null ? hint + 2000 : Math.min(60000, 5000 * attempt);
      log(`  rate-limited, waiting ${Math.round(wait / 1000)}s (attempt ${attempt})`);
      await sleep(wait);
      return translate(text, attempt + 1);
    }
    throw e;
  }
}

interface Row {
  id: string;
  english: string;
  description: string;
}

async function main(): Promise<void> {
  log(`Fetching /terms…`);
  const snap = await db.collection('terms').get();
  const targets: Row[] = [];
  let alreadyDone = 0;
  let noDescription = 0;
  let tooLong = 0;
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>;
    const description = (d.description as string | undefined) || '';
    const existing = (d.descriptionMyanmar as string | undefined) || '';
    if (!description.trim()) {
      noDescription++;
      continue;
    }
    if (existing.trim()) {
      alreadyDone++;
      continue;
    }
    if (description.length > MAX_DESCRIPTION_LEN) {
      tooLong++;
      continue;
    }
    targets.push({ id: doc.id, english: (d.english as string) || doc.id, description });
  }
  log(`Total docs: ${snap.size}`);
  log(`  ${targets.length} to translate`);
  log(`  ${alreadyDone} already have descriptionMyanmar (skipped)`);
  log(`  ${noDescription} have no English description (skipped)`);
  log(`  ${tooLong} descriptions exceed ${MAX_DESCRIPTION_LEN} chars (skipped — translate manually)`);

  if (targets.length === 0) {
    log('Nothing to do. Done.');
    return;
  }

  let ok = 0;
  let failed = 0;
  const failures: Array<{ id: string; error: string }> = [];

  // Sequential loop paced at PACE_MS between calls. Free-tier caps at 5 RPM;
  // 13s pace ≈ 4.6 RPM, comfortably under the limit. The translate() helper
  // handles rare 429/503 with its own backoff so a burst of noise from Google
  // doesn't lose the current doc.
  // Process in waves of CONCURRENCY. Each wave fires in parallel, we await
  // all of them, then start the next wave after a tiny pace delay. The
  // translate() helper handles rare 429/503 with its own backoff.
  const startedAt = Date.now();
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const wave = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      wave.map(async (row) => {
        const translated = await translate(row.description);
        await db.collection('terms').doc(row.id).update({
          descriptionMyanmar: translated,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return row.id;
      }),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        ok++;
      } else {
        failed++;
        const errStr = r.reason instanceof Error ? r.reason.message : String(r.reason);
        failures.push({ id: wave[j].id, error: errStr.slice(0, 200) });
      }
    }
    const done = Math.min(i + CONCURRENCY, targets.length);
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = done / Math.max(elapsed, 0.1);
    const remaining = (targets.length - done) / Math.max(rate, 0.1);
    const eta = new Date(Date.now() + remaining * 1000).toISOString().slice(11, 19);
    const pct = Math.round((done / targets.length) * 100);
    log(`Progress: ${done}/${targets.length} (${pct}%) — ok=${ok} failed=${failed} — rate=${rate.toFixed(1)}/s — ETA ~${eta} UTC`);
    if (i + CONCURRENCY < targets.length) await sleep(PACE_MS);
  }

  log(`\nDone. ${ok} translated, ${failed} failed.`);
  if (failures.length > 0) {
    log('First 20 failures:');
    for (const f of failures.slice(0, 20)) log(`  ${f.id}: ${f.error}`);
    log(`Full failure list saved to bulk-translate.log`);
  }
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((e) => {
  log('Fatal: ' + (e instanceof Error ? e.stack || e.message : String(e)));
  process.exit(1);
});

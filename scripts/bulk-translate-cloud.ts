/**
 * Bulk-translate every term's English `description` to Myanmar using the
 * Google Cloud Translation API v2 (standard model). Result goes into the
 * `descriptionMyanmar` field. Safe to re-run — skips terms that already
 * have a non-empty descriptionMyanmar.
 *
 *   npm run bulk-translate-cloud
 *
 * Uses service-account.json (same credentials as the other api scripts).
 * The service account must have the `roles/cloudtranslate.user` role on the
 * farmplus-dictionary project — see README for one-click grant.
 *
 * Cost: $20 per 1M characters BEYOND the free 500K/month tier. A full run
 * for ~5,500 descriptions (~830K chars) costs around $6.60.
 *
 * Pace: Translation API supports hundreds of RPS; we chunk by 50 strings
 * per request (API lets you send arrays) and run 5 chunks in parallel —
 * finishes 5,500 translations in a few minutes.
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { v2 } from '@google-cloud/translate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const CHUNK_SIZE = 50;         // strings per Translation API call (API limit ~128)
const PARALLEL_CHUNKS = 5;     // concurrent API calls (plenty under rate limits)
const SOURCE = 'en';
const TARGET = 'my';           // Myanmar / Burmese
const LOG_FILE = resolve(root, 'bulk-translate.log');

const sa = JSON.parse(readFileSync(resolve(root, 'service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const translate = new v2.Translate({
  projectId: sa.project_id,
  credentials: {
    client_email: sa.client_email,
    private_key: sa.private_key,
  },
});

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch { /* best-effort */ }
}

interface Row {
  id: string;
  english: string;
  description: string;
}

async function translateChunk(texts: string[]): Promise<string[]> {
  // API accepts an array of strings; returns a parallel array of translations.
  const [translations] = await translate.translate(texts, {
    from: SOURCE,
    to: TARGET,
    format: 'text',
  });
  return Array.isArray(translations) ? translations : [translations];
}

async function main(): Promise<void> {
  log('Fetching /terms…');
  const snap = await db.collection('terms').get();
  const targets: Row[] = [];
  let alreadyDone = 0;
  let noDescription = 0;
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>;
    const description = ((d.description as string | undefined) || '').trim();
    const existing = ((d.descriptionMyanmar as string | undefined) || '').trim();
    if (!description) { noDescription++; continue; }
    if (existing) { alreadyDone++; continue; }
    targets.push({ id: doc.id, english: (d.english as string) || doc.id, description });
  }
  log(`Total docs: ${snap.size}`);
  log(`  ${targets.length} to translate`);
  log(`  ${alreadyDone} already have descriptionMyanmar (skipped)`);
  log(`  ${noDescription} have no English description (skipped)`);

  if (targets.length === 0) {
    log('Nothing to do. Done.');
    return;
  }

  // Estimate cost
  const totalChars = targets.reduce((s, r) => s + r.description.length, 0);
  const freeChars = 500_000;
  const paidChars = Math.max(0, totalChars - freeChars);
  const estimatedCost = (paidChars / 1_000_000) * 20;
  log(`Characters: ${totalChars.toLocaleString()} (~$${estimatedCost.toFixed(2)} after free 500K tier)`);

  // Chunk the targets
  const chunks: Row[][] = [];
  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    chunks.push(targets.slice(i, i + CHUNK_SIZE));
  }
  log(`${chunks.length} chunks of up to ${CHUNK_SIZE} strings each\n`);

  let ok = 0;
  let failed = 0;
  const startedAt = Date.now();

  // Run PARALLEL_CHUNKS chunks concurrently
  for (let i = 0; i < chunks.length; i += PARALLEL_CHUNKS) {
    const wave = chunks.slice(i, i + PARALLEL_CHUNKS);
    const results = await Promise.allSettled(
      wave.map(async (chunk) => {
        const translations = await translateChunk(chunk.map((r) => r.description));
        // Write back in a Firestore batch
        const batch = db.batch();
        for (let j = 0; j < chunk.length; j++) {
          const translated = (translations[j] || '').trim();
          if (!translated) continue;
          batch.update(db.collection('terms').doc(chunk[j].id), {
            descriptionMyanmar: translated,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        await batch.commit();
        return chunk.length;
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') ok += r.value;
      else {
        failed += CHUNK_SIZE;
        log(`  chunk failed: ${String(r.reason).slice(0, 200)}`);
      }
    }
    const done = Math.min(i + PARALLEL_CHUNKS, chunks.length);
    const translationsDone = ok + failed;
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = translationsDone / Math.max(elapsed, 0.1);
    const remaining = (targets.length - translationsDone) / Math.max(rate, 0.1);
    log(`Chunks ${done}/${chunks.length} — ok=${ok} failed=${failed} — rate=${rate.toFixed(1)}/s — ETA ${Math.ceil(remaining)}s`);
  }

  log(`\n✓ Done. ${ok} translated, ${failed} failed. Total chars: ${totalChars.toLocaleString()}`);
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((e) => {
  log('Fatal: ' + (e instanceof Error ? e.stack || e.message : String(e)));
  process.exit(1);
});

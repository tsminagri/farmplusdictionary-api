/**
 * One-off: backfill `englishLower` on every /terms doc so the admin search
 * can do case-insensitive prefix queries via Firestore. Without this, terms
 * stored as "urea" (lowercase) are missed by a query that title-cases the
 * user's input, and terms stored as "Acreage" (titlecase) are missed by a
 * lowercased query — there's no consistent casing across the data.
 *
 * Cost on Blaze: ~6,700 reads + ~6,700 writes ≈ $0.02 total.
 * Safe to re-run: skips docs whose englishLower already matches.
 *
 *   npx tsx scripts/backfill-english-lower.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const sa = JSON.parse(readFileSync(resolve(root, 'service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

async function main() {
  console.log('Scanning /terms…');
  const snap = await db.collection('terms').get();
  console.log(`  ${snap.size} docs.`);

  // Firestore batched writes max 500 ops per batch.
  const BATCH_LIMIT = 400;
  let batch = db.batch();
  let pending = 0;
  let updated = 0;
  let alreadyOK = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const english = typeof data.english === 'string' ? data.english : '';
    if (!english) {
      skipped++;
      continue;
    }
    const wanted = english.toLowerCase();
    if (data.englishLower === wanted) {
      alreadyOK++;
      continue;
    }
    batch.update(doc.ref, { englishLower: wanted });
    pending++;
    updated++;
    if (pending >= BATCH_LIMIT) {
      await batch.commit();
      console.log(`  committed ${pending} writes`);
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) {
    await batch.commit();
    console.log(`  committed ${pending} writes (final)`);
  }

  console.log(`\nDone. ${updated} updated, ${alreadyOK} already had englishLower, ${skipped} skipped (no english).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

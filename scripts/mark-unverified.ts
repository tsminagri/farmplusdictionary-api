/**
 * One-off migration: ensure every existing term has `verified: false`.
 *
 * Bulk-imported terms came in without a verification field, so set it now.
 * Idempotent — running again just rewrites the same value.
 *
 * Reads `service-account.json` from the project root (same one seed uses).
 *
 *   npm run mark-unverified
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
  const snap = await db.collection('terms').get();
  let touched = 0;
  let alreadyVerified = 0;
  let batch = db.batch();
  let inBatch = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    if (data.verified === true) {
      alreadyVerified++;
      continue;
    }
    if (data.verified === false) {
      // already false — skip to save writes
      continue;
    }
    batch.update(docSnap.ref, { verified: false });
    touched++;
    inBatch++;
    if (inBatch === 400) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) await batch.commit();

  console.log(
    `\n✓ ${touched} terms marked unverified · ${alreadyVerified} were already verified · ${snap.size} total in collection.\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

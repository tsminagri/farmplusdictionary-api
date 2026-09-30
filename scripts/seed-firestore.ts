/**
 * One-time seed: load src/data/initialTerms.json into the Firestore `terms` collection.
 *
 * Uses the Firebase Admin SDK (service account), which bypasses security rules,
 * so it works regardless of whether firestore.rules has been deployed.
 *
 * Setup:
 *   1. Firebase Console -> Project settings -> Service accounts -> "Generate new private key"
 *   2. Save the downloaded JSON as ./service-account.json (gitignored)
 *   3. Run: npm run seed
 *
 * Idempotent: uses a deterministic doc id per term (slug of the English word),
 * so re-running updates existing docs instead of creating duplicates.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const VALID_CATEGORIES = [
  'Fertilizers', 'Pests', 'Crops', 'Livestock', 'Aquaculture', 'Equipment', 'Techniques',
  'General', 'Finance', 'Diseases', 'Weeds',
];

interface RawTerm {
  english: string;
  myanmar: string;
  category: string;
  description?: string;
  regionalVariations?: Record<string, string>;
}

function slugify(s: string): string {
  const slug = s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Doc id must match firestore.rules isValidId: ^[a-zA-Z0-9_\-]+$, size <= 128
  return slug.slice(0, 128) || 'term';
}

async function main() {
  const saPath = resolve(root, 'service-account.json');
  let serviceAccount: any;
  try {
    serviceAccount = JSON.parse(readFileSync(saPath, 'utf8'));
  } catch {
    console.error(
      `\n✗ Could not read ${saPath}\n` +
        `  Download it from: Firebase Console -> Project settings -> Service accounts -> Generate new private key\n` +
        `  Save it as service-account.json in the project root, then re-run.\n`,
    );
    process.exit(1);
  }

  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();

  const terms: RawTerm[] = JSON.parse(
    readFileSync(resolve(root, 'src/data/initialTerms.json'), 'utf8'),
  );

  // Dedupe by slug so deterministic ids don't collide silently.
  const seen = new Set<string>();
  let written = 0;
  let skipped = 0;
  let batch = db.batch();
  let inBatch = 0;

  for (const t of terms) {
    if (!t.english || !t.myanmar || !VALID_CATEGORIES.includes(t.category)) {
      console.warn(`  skip (invalid): ${JSON.stringify(t).slice(0, 80)}`);
      skipped++;
      continue;
    }
    let id = slugify(t.english);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);

    const data: Record<string, unknown> = {
      english: t.english,
      myanmar: t.myanmar,
      category: t.category,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (t.description) data.description = t.description;
    if (t.regionalVariations && Object.keys(t.regionalVariations).length > 0) {
      data.regionalVariations = t.regionalVariations;
    }

    batch.set(db.collection('terms').doc(id), data, { merge: true });
    written++;
    inBatch++;

    if (inBatch === 400) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) await batch.commit();

  console.log(`\n✓ Seeded ${written} terms into "terms" collection (${skipped} skipped).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

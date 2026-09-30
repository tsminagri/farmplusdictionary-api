/**
 * Export the live Firestore `terms` collection into
 * `../farmplus-app/src/data/initialTerms.json`, which the public site bundles.
 *
 * Run this whenever the review team has finished a batch of verifications or
 * the admin has edited/added terms — then rebuild & redeploy the site.
 *
 * Uses `service-account.json` (Admin SDK), so it bypasses client quotas.
 *
 * The output path can be overridden with EXPORT_OUT for CI use where the
 * two repos aren't cloned as siblings.
 *
 *   npm run export-terms
 *   EXPORT_OUT=/some/path/initialTerms.json npm run export-terms
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const OUT = process.env.EXPORT_OUT
  ? resolve(process.env.EXPORT_OUT)
  : resolve(root, '../farmplus-app/src/data/initialTerms.json');
// Ensure the target directory exists — helps first-run + CI paths.
try { mkdirSync(dirname(OUT), { recursive: true }); } catch { /* already exists */ }

const sa = JSON.parse(readFileSync(resolve(root, 'service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

async function main() {
  console.log('Fetching terms from Firestore…');
  const snap = await db.collection('terms').orderBy('english').get();

  const terms = snap.docs.map((d) => {
    const data = d.data();
    // Drop Firestore Timestamp objects — JSON can't serialise them cleanly
    // and the public site doesn't need them. Verified flag + verifiedByName
    // are preserved so the public card can show the green chip.
    const { updatedAt, verifiedAt, ...rest } = data;
    return { id: d.id, ...rest };
  });

  // Atomic write so a crash mid-write doesn't corrupt the bundled file.
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, JSON.stringify(terms, null, 2));
  renameSync(tmp, OUT);

  const verified = terms.filter((t: any) => t.verified === true).length;
  console.log(`\n✓ Wrote ${terms.length} terms to ${OUT}`);
  console.log(`  Verified: ${verified} · Unverified: ${terms.length - verified}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});

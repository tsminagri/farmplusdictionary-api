/**
 * Export all terms that have an English description but no Myanmar
 * description, into a CSV ready for the Google Sheets GOOGLETRANSLATE
 * workflow.
 *
 *   npm run export-untranslated
 *
 * Writes to `untranslated.csv` in the api repo root. CSV columns:
 *   id, english, description
 *
 * Open the CSV in Google Sheets, add a column `descriptionMyanmar` with
 *   =GOOGLETRANSLATE(C2, "en", "my")
 * fill down, download as CSV, then run `npm run import-translations`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const OUT = resolve(root, 'untranslated.csv');

const sa = JSON.parse(readFileSync(resolve(root, 'service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

/** Escape a single CSV field. Wraps in quotes, doubles internal quotes. */
function csv(v: string): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  console.log('Fetching terms from Firestore…');
  const snap = await db.collection('terms').get();
  const rows: string[] = ['id,english,description'];
  let skippedDone = 0;
  let skippedEmpty = 0;
  for (const d of snap.docs) {
    const x = d.data();
    const english = (x.english as string) || d.id;
    const description = ((x.description as string) || '').trim();
    const existing = ((x.descriptionMyanmar as string) || '').trim();
    if (!description) {
      skippedEmpty++;
      continue;
    }
    if (existing) {
      skippedDone++;
      continue;
    }
    rows.push([csv(d.id), csv(english), csv(description)].join(','));
  }
  writeFileSync(OUT, rows.join('\n') + '\n', 'utf8');
  console.log(`✓ Wrote ${rows.length - 1} rows to ${OUT}`);
  console.log(`  ${skippedDone} already have descriptionMyanmar (skipped)`);
  console.log(`  ${skippedEmpty} have no English description (skipped)`);
  console.log(`\nNext steps:`);
  console.log(`  1. Open ${OUT} in Google Sheets`);
  console.log(`  2. In D1 type: descriptionMyanmar`);
  console.log(`  3. In D2 type: =GOOGLETRANSLATE(C2, "en", "my")`);
  console.log(`  4. Hover bottom-right of D2 and double-click to fill down`);
  console.log(`  5. Wait for translations to populate (may take a few minutes)`);
  console.log(`  6. File → Download → Comma-separated values`);
  console.log(`  7. Rename download to translated.csv in this folder`);
  console.log(`  8. Run: npm run import-translations`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

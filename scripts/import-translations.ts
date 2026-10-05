/**
 * Import Myanmar descriptions from a CSV back into Firestore.
 *
 *   npm run import-translations
 *
 * Expects `translated.csv` in the api repo root with (at minimum) columns:
 *   id, descriptionMyanmar
 *
 * Other columns are ignored — safe to pass the full Google-Sheets download.
 *
 * Safety:
 *   - Skips rows where descriptionMyanmar is empty (keeps existing value)
 *   - Skips rows where descriptionMyanmar === english (translation failed and
 *     Sheets returned the input unchanged)
 *   - Skips rows where the id doesn't exist in Firestore
 *   - Chunks writes in batches of 400 (Firestore limit is 500)
 *   - Logs progress + per-row failures
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const IN = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'translated.csv');

if (!existsSync(IN)) {
  console.error(`Not found: ${IN}`);
  console.error('Download your translated Google Sheet as CSV and save it as translated.csv here, or pass a path:');
  console.error('  npx tsx scripts/import-translations.ts /path/to/your.csv');
  process.exit(1);
}

const sa = JSON.parse(readFileSync(resolve(root, 'service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

/** Minimal CSV parser that handles quoted fields with commas, newlines, and
 *  doubled quotes. Returns rows as arrays of strings. */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ''));
}

async function main() {
  console.log(`Reading ${IN}…`);
  const text = readFileSync(IN, 'utf8');
  const rows = parseCSV(text);
  if (rows.length < 2) {
    console.error('CSV has no data rows.');
    process.exit(1);
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idCol = header.indexOf('id');
  const mmCol = header.indexOf('descriptionmyanmar');
  const enCol = header.indexOf('english');
  if (idCol < 0 || mmCol < 0) {
    console.error(`CSV must have columns "id" and "descriptionMyanmar". Found: ${header.join(', ')}`);
    process.exit(1);
  }
  console.log(`  columns: id=${idCol}, descriptionMyanmar=${mmCol}${enCol >= 0 ? ', english=' + enCol : ''}`);
  console.log(`  rows: ${rows.length - 1}`);

  // Build a plan: fetch all referenced term docs first so we can skip
  // missing ids and detect same-as-english translations.
  const payloads: Array<{ id: string; descriptionMyanmar: string }> = [];
  let skippedEmpty = 0;
  let skippedSameAsEnglish = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = (r[idCol] || '').trim();
    const mm = (r[mmCol] || '').trim();
    const en = enCol >= 0 ? (r[enCol] || '').trim() : '';
    if (!id) continue;
    if (!mm) { skippedEmpty++; continue; }
    if (en && mm === en) { skippedSameAsEnglish++; continue; }
    payloads.push({ id, descriptionMyanmar: mm });
  }
  console.log(`  ${payloads.length} rows to import`);
  console.log(`  ${skippedEmpty} skipped (empty descriptionMyanmar)`);
  console.log(`  ${skippedSameAsEnglish} skipped (translation same as English — probably failed in Sheets)`);

  if (payloads.length === 0) {
    console.log('Nothing to import.');
    process.exit(0);
  }

  // Batched writes
  const BATCH = 400;
  let written = 0;
  let missing = 0;
  for (let i = 0; i < payloads.length; i += BATCH) {
    const chunk = payloads.slice(i, i + BATCH);
    // Verify each id exists before writing (missing writes would create
    // phantom docs with just descriptionMyanmar — bad)
    const refs = chunk.map((p) => db.collection('terms').doc(p.id));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    for (let j = 0; j < chunk.length; j++) {
      if (!snaps[j].exists) {
        missing++;
        continue;
      }
      batch.update(refs[j], {
        descriptionMyanmar: chunk[j].descriptionMyanmar,
        updatedAt: FieldValue.serverTimestamp(),
      });
      written++;
    }
    await batch.commit();
    const done = Math.min(i + BATCH, payloads.length);
    console.log(`Progress: ${done}/${payloads.length} (${Math.round(done / payloads.length * 100)}%)`);
  }
  console.log(`\n✓ Done. ${written} translations imported.`);
  if (missing > 0) console.log(`  ${missing} rows had ids not found in Firestore (skipped).`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

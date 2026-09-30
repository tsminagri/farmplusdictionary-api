/**
 * One-off diagnostic: check whether the "Acre" term doc exists in Firestore
 * and what its current shape is. Used to debug why the admin UI couldn't
 * find it after an edit.
 *
 *   npx tsx scripts/check-acre.ts
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

const ids = ['acre', 'Acre', 'ACRE'];
for (const id of ids) {
  const snap = await db.collection('terms').doc(id).get();
  console.log(`/terms/${id}: ${snap.exists ? 'EXISTS' : 'missing'}`);
  if (snap.exists) {
    const d = snap.data() as Record<string, unknown>;
    console.log(`   english="${d.english}" verified=${d.verified ?? false}`);
    console.log(`   description="${(d.description as string)?.slice(0, 80) || '(none)'}"`);
  }
}

console.log('\nQuerying for english starting with "Acre":');
const titleCase = await db
  .collection('terms')
  .where('english', '>=', 'Acre')
  .where('english', '<=', 'Acre')
  .get();
console.log(`Found ${titleCase.size}:`);
titleCase.docs.forEach((d) =>
  console.log(`  id=${d.id}  english="${d.data().english}"  verified=${d.data().verified ?? false}`),
);

console.log('\nQuerying for english starting with lowercase "acre":');
const lower = await db
  .collection('terms')
  .where('english', '>=', 'acre')
  .where('english', '<=', 'acre')
  .get();
console.log(`Found ${lower.size}:`);
lower.docs.forEach((d) =>
  console.log(`  id=${d.id}  english="${d.data().english}"  verified=${d.data().verified ?? false}`),
);

process.exit(0);

/**
 * One-off backfill: import every Firebase Auth user into /users/{uid} so the
 * admin's Users tab includes people who signed in before recordUserSession()
 * existed.
 *
 * Idempotent — re-running just refreshes email/displayName/photoURL and
 * preserves createdAt (which is set to the auth user's metadata.creationTime
 * the first time we see them).
 *
 * Uses Admin SDK (service-account.json). No Firestore client quotas apply.
 *
 *   npm run sync-users
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const sa = JSON.parse(readFileSync(resolve(root, 'service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const adminAuth = getAuth();

async function main() {
  let total = 0;
  let touched = 0;
  let pageToken: string | undefined;

  do {
    const page = await adminAuth.listUsers(1000, pageToken);
    pageToken = page.pageToken;

    let batch = db.batch();
    let inBatch = 0;
    for (const u of page.users as UserRecord[]) {
      total++;
      if (!u.email) continue; // skip phone-only users etc.
      const ref = db.collection('users').doc(u.uid);
      const existing = await ref.get();
      const data: Record<string, unknown> = {
        email: u.email,
        displayName: u.displayName || '',
        photoURL: u.photoURL || '',
        lastSeenAt: u.metadata.lastSignInTime
          ? Timestamp.fromDate(new Date(u.metadata.lastSignInTime))
          : Timestamp.now(),
      };
      if (!existing.exists) {
        data.createdAt = u.metadata.creationTime
          ? Timestamp.fromDate(new Date(u.metadata.creationTime))
          : Timestamp.now();
      }
      batch.set(ref, data, { merge: true });
      touched++;
      inBatch++;
      if (inBatch === 400) {
        await batch.commit();
        batch = db.batch();
        inBatch = 0;
      }
    }
    if (inBatch > 0) await batch.commit();
    console.log(`  · processed page (${page.users.length} users)`);
  } while (pageToken);

  console.log(`\n✓ Synced ${touched} users into /users (scanned ${total} from Firebase Auth).\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});

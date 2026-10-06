/**
 * Anti-spam for /submissions and /feedback.
 *
 * The rules already require a verified Google sign-in, but nothing limits how many
 * documents one account (or a swarm of throwaway accounts) can create. This trigger runs on
 * every new submission/feedback doc and:
 *   1. counts what that user created in the last hour (both collections together);
 *   2. deletes the new doc when the user is over the soft limit;
 *   3. sets users/{uid}.blocked = true when the user is over the hard limit, after which the
 *      Firestore rules refuse any further submissions/feedback from that account.
 *
 * No client change is needed. Admins/reviewers are exempt. To unblock a user, an admin sets
 * users/{uid}.blocked to false (the rules allow admins to change it).
 */
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';

// This module is imported before index.ts runs initializeApp(), so make sure an app exists first.
if (getApps().length === 0) initializeApp();
const db = getFirestore();

const WINDOW_MS = 60 * 60 * 1000;
const SOFT_LIMIT_PER_HOUR = 20; // the 21st doc in an hour is deleted
const HARD_LIMIT_PER_HOUR = 60; // beyond this the account is blocked
const MAX_PENDING = 150; // total unreviewed docs per user

const COLLECTIONS = ['submissions', 'feedback'] as const;

async function countRecent(uid: string, sinceMs: number): Promise<number> {
  const since = Timestamp.fromMillis(sinceMs);
  let total = 0;
  for (const name of COLLECTIONS) {
    const snap = await db
      .collection(name)
      .where('submittedBy', '==', uid)
      .where('createdAt', '>=', since)
      .count()
      .get();
    total += snap.data().count;
  }
  return total;
}

async function countPending(uid: string): Promise<number> {
  let total = 0;
  for (const name of COLLECTIONS) {
    const snap = await db
      .collection(name)
      .where('submittedBy', '==', uid)
      .where('status', '==', 'pending')
      .count()
      .get();
    total += snap.data().count;
  }
  return total;
}

async function isExempt(uid: string): Promise<boolean> {
  const user = await db.collection('users').doc(uid).get();
  const role = user.exists ? (user.data()?.role as string | undefined) : undefined;
  return role === 'admin' || role === 'reviewer';
}

async function throttle(collection: string, docId: string, uid: string | undefined) {
  if (!uid) return;
  if (await isExempt(uid)) return;

  const recent = await countRecent(uid, Date.now() - WINDOW_MS);
  const pending = await countPending(uid);

  const overHard = recent > HARD_LIMIT_PER_HOUR;
  const overSoft = recent > SOFT_LIMIT_PER_HOUR || pending > MAX_PENDING;
  if (!overSoft && !overHard) return;

  await db.collection(collection).doc(docId).delete();
  console.warn(`Throttled ${collection}/${docId} for ${uid}: ${recent}/h, ${pending} pending`);

  if (overHard) {
    await db
      .collection('users')
      .doc(uid)
      .set(
        {
          blocked: true,
          blockedAt: FieldValue.serverTimestamp(),
          blockedReason: `Auto-blocked: ${recent} submissions in one hour`,
        },
        { merge: true },
      );
    console.warn(`Blocked ${uid}`);
  }
}

// Same region as the Firestore database (asia-southeast1) to keep trigger latency and cross-region cost down.
const OPTIONS = { region: 'asia-southeast1' } as const;

export const throttleSubmissions = onDocumentCreated(
  { ...OPTIONS, document: 'submissions/{id}' },
  (event) => throttle('submissions', event.params.id, event.data?.data()?.submittedBy),
);

export const throttleFeedback = onDocumentCreated(
  { ...OPTIONS, document: 'feedback/{id}' },
  (event) => throttle('feedback', event.params.id, event.data?.data()?.submittedBy),
);

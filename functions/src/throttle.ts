/**
 * Anti-spam for /submissions and /feedback.
 *
 * The rules already require a verified Google sign-in, but nothing limits how many
 * documents one account (or a swarm of throwaway accounts) can create. This trigger runs on
 * every new submission/feedback doc and:
 *   1. counts what that user created in the last hour (both collections together);
 *   2. when the user reaches the hourly limit, sets users/{uid}.rateLimitedUntil to the moment
 *      their oldest submission in the window turns one hour old; until then the Firestore rules
 *      refuse new submissions/feedback, and the apps show that time to the user;
 *   3. deletes the new doc when the user is already over the limit (covers the short race before
 *      step 2 takes effect);
 *   4. sets users/{uid}.blocked = true when the user is over the hard limit, after which the
 *      rules refuse any further submissions/feedback from that account.
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
const SOFT_LIMIT_PER_HOUR = 20; // 20 are allowed per hour; the apps are told to wait after the 20th
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

/** Oldest submission/feedback of the user inside the window, in ms (null when none). */
async function oldestInWindow(uid: string, sinceMs: number): Promise<number | null> {
  const since = Timestamp.fromMillis(sinceMs);
  let oldest: number | null = null;
  for (const name of COLLECTIONS) {
    const snap = await db
      .collection(name)
      .where('submittedBy', '==', uid)
      .where('createdAt', '>=', since)
      .orderBy('createdAt', 'asc')
      .limit(1)
      .get();
    const t = snap.docs[0]?.data().createdAt as Timestamp | undefined;
    if (t && (oldest === null || t.toMillis() < oldest)) oldest = t.toMillis();
  }
  return oldest;
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

export async function throttle(collection: string, docId: string, uid: string | undefined) {
  if (!uid) return;
  if (await isExempt(uid)) return;

  const recent = await countRecent(uid, Date.now() - WINDOW_MS);
  const pending = await countPending(uid);

  const overHard = recent > HARD_LIMIT_PER_HOUR;
  const overSoft = recent > SOFT_LIMIT_PER_HOUR || pending > MAX_PENDING;

  // Reached the cap: tell the apps (and make the rules refuse) until the oldest item ages out.
  if (recent >= SOFT_LIMIT_PER_HOUR || pending >= MAX_PENDING) {
    const oldest = (await oldestInWindow(uid, Date.now() - WINDOW_MS)) ?? Date.now();
    const until = Timestamp.fromMillis(Math.max(oldest + WINDOW_MS, Date.now() + 60_000));
    await db.collection('users').doc(uid).set({ rateLimitedUntil: until }, { merge: true });
  }

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

/**
 * Farm+ Dictionary — Cloud Functions
 *
 * publishSnapshot: callable function admins click from the Dashboard. It
 * triggers the `publish-snapshot.yml` GitHub Actions workflow on demand
 * via the GitHub REST API, so the public site picks up new
 * verifies/edits/feedback/submissions within ~90 seconds instead of
 * waiting up to 30 min for the next scheduled run.
 *
 * Security model:
 *   - Caller must be authenticated.
 *   - Caller's email must match the hardcoded SYSTEM_ADMIN_EMAIL OR they
 *     must have `role: "admin"` in /users/{uid}. Reviewers cannot publish.
 *   - The GitHub PAT is loaded from a Functions secret (never embedded in
 *     code, never sent to the client).
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenAI } from '@google/genai';

initializeApp();
const db = getFirestore();

// Owner email — kept in sync with src/lib/firebase.ts SYSTEM_ADMIN_EMAIL.
const SYSTEM_ADMIN_EMAIL = 'tsmin@greenovator.co';

// GitHub coordinates for the auto-publish workflow. Lives in farmplus-app
// after the 3-repo split. If the repo is ever moved/renamed, update here too.
const GITHUB_OWNER = 'tsminagri';
const GITHUB_REPO = 'farmplus-app';
const GITHUB_WORKFLOW_FILE = 'publish-snapshot.yml';
const GITHUB_REF = 'main';

// Define the GitHub PAT as a secret. Set it via:
//   firebase functions:secrets:set GITHUB_PUBLISH_TOKEN
// or in the Firebase console under Functions > Secrets.
const GITHUB_PUBLISH_TOKEN = defineSecret('GITHUB_PUBLISH_TOKEN');

// Gemini API key for the translateToMyanmar function. Obtain from
// https://aistudio.google.com/apikey and set via:
//   firebase functions:secrets:set GEMINI_API_KEY
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

// Shared reviewer/admin gate used by translateToMyanmar. Reviewers can also
// invoke translation since the primary use case (curating term descriptions)
// includes non-admin editorial work.
async function requireReviewerOrAdmin(
  request: { auth?: { uid: string; token: Record<string, unknown> } },
): Promise<void> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }
  const email = (request.auth.token.email as string | undefined) || '';
  const emailVerified = request.auth.token.email_verified === true;
  if (!emailVerified) {
    throw new HttpsError('permission-denied', 'Your email must be verified.');
  }
  if (email === SYSTEM_ADMIN_EMAIL) return; // fast path
  const LEGACY_REVIEWERS = new Set([
    'tsmin@greenovator.co',
    'tsmin@greenwaymyanmar.org',
    'tsminagri@gmail.com',
  ]);
  try {
    const userSnap = await db.collection('users').doc(request.auth.uid).get();
    const role = userSnap.exists ? (userSnap.data()?.role as string | undefined) : undefined;
    if (role === 'admin' || role === 'reviewer') return;
    // Explicit 'contributor' overrides the legacy list (matches client rules).
    if (role !== 'contributor' && LEGACY_REVIEWERS.has(email)) return;
  } catch (e) {
    console.error('Role lookup failed', e);
    throw new HttpsError('internal', 'Could not verify role.');
  }
  throw new HttpsError('permission-denied', 'Reviewer or admin access required.');
}

export const publishSnapshot = onCall(
  {
    region: 'us-central1',
    secrets: [GITHUB_PUBLISH_TOKEN],
    // Callable functions perform their own Firebase Auth check via the token
    // in the request body (see `request.auth` below). Cloud Run still needs
    // to accept the inbound HTTP request first, otherwise unauthenticated
    // browsers get a 401 BEFORE the function body runs. Make the underlying
    // Cloud Run service publicly invokable; security is enforced in code.
    invoker: 'public',
  },
  async (request) => {
    // (1) Must be signed in.
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'You must be signed in.');
    }
    const uid = request.auth.uid;
    const email = request.auth.token.email || '';
    const emailVerified = request.auth.token.email_verified === true;
    if (!emailVerified) {
      throw new HttpsError('permission-denied', 'Your email must be verified.');
    }

    // (2) System admin (by email) always wins. Otherwise look up /users/{uid}.role.
    const isSystemAdmin = email === SYSTEM_ADMIN_EMAIL;
    let isAdmin = isSystemAdmin;
    if (!isAdmin) {
      try {
        const userSnap = await db.collection('users').doc(uid).get();
        const role = userSnap.exists ? (userSnap.data()?.role as string | undefined) : undefined;
        isAdmin = role === 'admin';
      } catch (e) {
        console.error('Role lookup failed', e);
        throw new HttpsError('internal', 'Could not verify role.');
      }
    }
    if (!isAdmin) {
      throw new HttpsError('permission-denied', 'Only admins can publish the snapshot.');
    }

    // (3) Trigger the workflow_dispatch event.
    const token = GITHUB_PUBLISH_TOKEN.value();
    if (!token) {
      throw new HttpsError(
        'failed-precondition',
        'GITHUB_PUBLISH_TOKEN secret is not configured. Owner needs to set it.',
      );
    }

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_FILE}/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        // GitHub requires a User-Agent for API calls.
        'User-Agent': 'farmplus-dictionary-publish-button',
      },
      body: JSON.stringify({ ref: GITHUB_REF }),
    });

    if (res.status === 204) {
      // GitHub returns 204 No Content on success.
      return {
        ok: true,
        message: 'Publish workflow triggered. Site should be live in ~90 seconds.',
        runsUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_FILE}`,
      };
    }

    // Non-204: surface the GitHub error.
    let detail = `GitHub returned ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) detail += `: ${body.message}`;
    } catch {
      /* ignore body-parse errors */
    }
    console.error('GitHub dispatch failed', detail);
    throw new HttpsError('internal', detail);
  },
);

/**
 * Translate English text to Myanmar (Burmese) using Gemini.
 *
 * Optimised for the Farm+ Dictionary use case: short agricultural term
 * descriptions. The prompt frames the task as an agricultural-domain
 * translation and asks Gemini to return the Myanmar text alone (no quotes,
 * no explanations), which lets the frontend drop it straight into the
 * description textarea.
 *
 * Rate-limiting: the free Gemini tier already caps requests per day; we
 * additionally enforce a max input length so a single call can't waste too
 * many tokens.
 */
export const translateToMyanmar = onCall(
  {
    region: 'us-central1',
    secrets: [GEMINI_API_KEY],
    invoker: 'public',
    timeoutSeconds: 60,
  },
  async (request) => {
    await requireReviewerOrAdmin(request);

    const rawText = (request.data as { text?: unknown })?.text;
    if (typeof rawText !== 'string') {
      throw new HttpsError('invalid-argument', '`text` must be a string.');
    }
    const text = rawText.trim();
    if (!text) {
      throw new HttpsError('invalid-argument', 'Nothing to translate.');
    }
    if (text.length > 2000) {
      throw new HttpsError(
        'invalid-argument',
        'Text is too long (>2000 chars). Split into shorter chunks.',
      );
    }

    const apiKey = GEMINI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError(
        'failed-precondition',
        'GEMINI_API_KEY secret is not configured. Owner needs to set it.',
      );
    }

    const ai = new GoogleGenAI({ apiKey });
    const prompt = [
      'You are translating an agricultural dictionary entry from English to Myanmar (Burmese).',
      'Return ONLY the Myanmar translation of the text below.',
      'Do NOT include quotes, explanations, romanisation, or the original English.',
      'Preserve technical accuracy for farming, crops, livestock, fertilizers, pests and equipment.',
      '',
      'English:',
      text,
    ].join('\n');

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: prompt,
      });
      const translated = (response.text || '').trim();
      if (!translated) {
        throw new HttpsError('internal', 'Gemini returned an empty translation.');
      }
      return { translated };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Gemini translate failed:', msg);
      // Surface the actual Gemini error so admins can debug (e.g. bad API key).
      throw new HttpsError('internal', `Translation failed: ${msg}`);
    }
  },
);

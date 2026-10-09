/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface RegionalVariations {
  mon?: string;
  shan?: string;
  karen?: string;
}

export type Category = 'Fertilizers' | 'Pests' | 'Crops' | 'Livestock' | 'Aquaculture' | 'Equipment' | 'Techniques' | 'General' | 'Finance' | 'Diseases' | 'Weeds';

export interface Term {
  id: string;
  english: string;
  myanmar: string;
  regionalVariations?: RegionalVariations;
  description?: string;
  /**
   * Myanmar-language translation of `description`. Populated in bulk by the
   * one-off Gemini script (scripts/bulk-translate-descriptions.ts) and by the
   * admin-triggered Translate button in the term edit modal. The public site
   * shows this in place of `description` when present.
   */
  descriptionMyanmar?: string;
  category: Category;
  updatedAt: any; // Firestore Timestamp
  // Verification (set by reviewers/admin). Bulk-imported terms start unverified.
  verified?: boolean;
  verifiedBy?: string;       // uid of reviewer
  verifiedByEmail?: string;  // email of reviewer (for admin display)
  verifiedByName?: string;   // display name of reviewer (for admin display)
  verifiedAt?: any;          // Firestore Timestamp
}

export interface Submission {
  id: string;
  term: string;
  translation: string;
  /** Legacy free-text region field. Newer submissions use `regionalVariations`. */
  region?: string;
  /**
   * Map of normalized region key → local-language translation. Populated by
   * the multi-row regional variations input on Submit Term. Duplicates against
   * the existing term's regionalVariations are filtered out client-side before
   * submission.
   */
  regionalVariations?: Record<string, string>;
  /** English note/definition suggested with the term; becomes `description` when approved. */
  notes?: string;
  /** Myanmar note/definition suggested with the term; becomes `descriptionMyanmar` when approved. */
  notesMyanmar?: string;
  submittedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: any; // Firestore Timestamp
}

/**
 * A snapshot of a signed-in Firebase Auth user, mirrored into Firestore so the
 * admin can list/search contributors. Written on every sign-in by
 * recordUserSession(); the Admin SDK backfill script can prime historical
 * sign-ins via the same shape.
 */
export interface AppUser {
  id: string;          // Firebase Auth uid
  email: string;
  displayName?: string;
  photoURL?: string;
  createdAt: any;      // Firestore Timestamp — when we first saw them
  lastSeenAt: any;     // Firestore Timestamp — most recent sign-in
  /**
   * Role assigned by an admin. Absent for contributors. The hardcoded System
   * Admin (SYSTEM_ADMIN_EMAIL) ignores this field entirely — its powers come
   * from the email match, not the DB.
   */
  role?: 'admin' | 'reviewer' | 'contributor';
}

/**
 * Append-only audit entry stored under /terms/{termId}/history/{eventId}.
 * One row per write that touches a term — admin edit, verify/unverify, feedback
 * application, submission approval, etc. — capturing who did it, when, why,
 * and what changed at the field level. Rules forbid updates and deletes so
 * the chain stays trustworthy.
 */
export type TermHistorySource =
  | 'create'
  | 'edit'
  | 'verify'
  | 'unverify'
  | 'feedback_apply'
  | 'submission_approve'
  | 'submission_overwrite'
  | 'submission_regional';

export interface TermHistoryFieldChange {
  field: string;            // e.g. 'myanmar', 'category', 'regionalVariations.mon'
  before?: string | null;
  after?: string | null;
}

export interface TermHistoryEntry {
  id: string;
  at: any;                  // Firestore Timestamp
  by: string;               // uid of the actor
  byEmail: string;          // email snapshot (for display when user doc is gone)
  byName: string;           // display name snapshot
  source: TermHistorySource;
  changes?: TermHistoryFieldChange[];
  /** Set when `source` ties back to one of these docs, for traceability. */
  feedbackId?: string;
  submissionId?: string;
  note?: string;
}

export type FeedbackType = 'correction' | 'local_term' | 'other';

export interface Feedback {
  id: string;
  termId: string;
  termEnglish: string;
  type: FeedbackType;
  message: string;
  suggestedTranslation?: string; // for 'correction'
  localTerm?: string;            // for 'local_term'
  region?: string;               // for 'local_term'
  submittedBy: string;
  status: 'pending' | 'resolved';
  createdAt: any; // Firestore Timestamp
}

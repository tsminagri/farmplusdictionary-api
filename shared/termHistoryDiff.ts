/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portable term-diff logic. Pure TS with no browser / Node / Firebase
 * imports, so both the web app and a future React Native app can compute
 * an audit-log payload the same way.
 *
 * The Firestore-writing half (logTermChange) lives in src/lib/termHistory.ts
 * and stays web-specific; the mobile app will implement its own wrapper
 * using @react-native-firebase/firestore.
 */
import type { Term, TermHistoryFieldChange } from './types';

/**
 * Diff two term shapes and return an array of field-level changes.
 * Covers simple string fields + regional variations (per-key). Verification
 * fields are handled separately by the verify/unverify entries because the
 * source already conveys the intent.
 */
export function diffTermFields(
  before: Partial<Term> | undefined,
  after: Partial<Term>,
): TermHistoryFieldChange[] {
  const changes: TermHistoryFieldChange[] = [];
  const simple: Array<keyof Term> = ['english', 'myanmar', 'category', 'description'];
  for (const f of simple) {
    const b = (before?.[f] as string | undefined) ?? '';
    const a = (after[f] as string | undefined) ?? '';
    if (b !== a) {
      changes.push({ field: String(f), before: b || null, after: a || null });
    }
  }
  const bRV = (before?.regionalVariations as Record<string, string> | undefined) || {};
  const aRV = (after.regionalVariations as Record<string, string> | undefined) || {};
  const keys = new Set([...Object.keys(bRV), ...Object.keys(aRV)]);
  for (const k of keys) {
    if ((bRV[k] || '') !== (aRV[k] || '')) {
      changes.push({
        field: `regionalVariations.${k}`,
        before: bRV[k] || null,
        after: aRV[k] || null,
      });
    }
  }
  return changes;
}

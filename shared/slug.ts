/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Produce a Firestore doc id matching firestore.rules isValidId:
 * ^[a-zA-Z0-9_\-]+$ and size <= 128.
 */
export function slugify(s: string): string {
  const slug = s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  return slug || 'term';
}

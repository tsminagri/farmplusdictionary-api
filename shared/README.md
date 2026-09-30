# src/shared — portable business logic

Everything in this folder MUST be safe to import from any environment
that runs TypeScript — the current Vite/React web app today, and the
planned Expo React Native app tomorrow. Two rules:

1. **No imports from `react`, `react-dom`, `motion/react`, `lucide-react`,
   `firebase/*`, `window.*`, or anything else that assumes a browser or
   the web Firebase SDK.**
2. **Prefer pure functions over classes / stateful modules.** Anything
   with state (caches, listeners) belongs elsewhere.

## What's here

| File | Portable because |
|---|---|
| `types.ts` | Interfaces only, no runtime code |
| `slug.ts` | Pure string transform, uses only `String.prototype.normalize` |
| `categories.ts` | Static array of strings |
| `termHistoryDiff.ts` | Pure diff over plain objects |

## Move to a real `packages/shared/` later

When you're ready to start the mobile app, this folder is the
lift-and-shift candidate:

1. Create `packages/shared/` and `packages/web/` (rename `src/` to
   `packages/web/src/`).
2. Move this folder into `packages/shared/src/`.
3. Add `@shared/*` path in the root tsconfig `paths`.
4. Both packages import `from '@shared/types'`.

The physical separation is trivial; the discipline that keeps this
folder portable is the hard part. Keep it clean now, save yourself a
week of untangling later.

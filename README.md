# farmplusdictionary-api

Backend for **Farm+ Dictionary** — Firestore rules, indexes, Cloud
Functions, operational scripts, and the shared TypeScript types + pure
logic that `farmplusdictionary-app` and `farmplusdictionary-mobile` consume.

Firebase project: `farmplus-dictionary` (Blaze).

## Contents

```
farmplusdictionary-api/
├── shared/              # exported for other projects (via git URL install)
│   ├── types.ts           # Term, Submission, Feedback, AppUser, roles, history
│   ├── slug.ts            # slugify(english) → doc id
│   ├── categories.ts      # 11 category names
│   ├── termHistoryDiff.ts # portable diff helper
│   └── README.md
├── functions/           # Cloud Functions (Node 20, Firebase Functions v2)
├── scripts/             # Admin SDK scripts (seed, export, backfill, translate)
├── firestore.rules
├── firestore.indexes.json
├── firebase.json        # functions + firestore config (no hosting — that's app)
├── .firebaserc          # default project → farmplus-dictionary
└── firebase-applet-config.json  # public web SDK config (safe to commit)
```

## Setup

```bash
npm install                    # root deps for scripts
npm --prefix functions install # function deps
```

## Common commands

```bash
# Firestore
npm run deploy:rules
npm run deploy:indexes
npm run deploy:firestore       # both

# Cloud Functions
npm run deploy:functions

# Operational scripts (all use tsx, need service-account.json locally)
npm run export-terms           # dump /terms → JSON (for farmplusdictionary-app snapshot)
npm run bulk-translate         # Gemini translate all descriptions to Myanmar
npm run backfill-english-lower # ensures every term has englishLower field
npm run sync-users             # backfill Firebase Auth users into /users

# Secrets
npx firebase functions:secrets:set GEMINI_API_KEY
npx firebase functions:secrets:set GITHUB_PUBLISH_TOKEN
```

## Local files that must NEVER be committed

- `service-account.json` — Admin SDK credentials
- `.gemini-api-key` — Gemini API key
- `functions/lib/` — build output

All are gitignored.

## `shared/` — consumed by other projects

`farmplusdictionary-app` and `farmplusdictionary-mobile` install this repo via git URL:

```json
{
  "dependencies": {
    "farmplusdictionary-api": "github:tsminagri/farmplusdictionary-api"
  }
}
```

Then import:

```ts
import type { Term } from 'farmplusdictionary-api/shared/types';
import { slugify } from 'farmplusdictionary-api/shared/slug';
```

After any change to `shared/*`, push this repo and run
`npm update farmplusdictionary-api` in the consumer project.

## Rules for `shared/`

- No imports from `firebase/*`, `firebase-admin`, `react`, `react-native`,
  `motion/*`, `lucide-*`, `window.*`, `document.*`, Node's `fs`, or any
  DOM API.
- Pure functions preferred over stateful modules.

## See also

- `../farmplusdictionary-app/` — the web app
- `../farmplusdictionary-mobile/` — future mobile app
- Root `SPEC.md` in `farmplusdictionary-app` — full project specification

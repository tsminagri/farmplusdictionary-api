/**
 * Grant `allUsers` the Cloud Run Invoker role on the publishSnapshot service.
 * Without this, the browser can't reach the callable function — Cloud Run
 * rejects the request before Firebase Auth (which runs INSIDE the function
 * body) gets a chance to read the user's ID token from the request payload.
 *
 *   npx tsx scripts/grant-public-invoker.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JWT } from 'google-auth-library';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const sa = JSON.parse(readFileSync(resolve(root, 'service-account.json'), 'utf8'));

const PROJECT_ID = 'farmplus-dictionary';
const REGION = 'us-central1';
const SERVICE = 'publishsnapshot';

const client = new JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const url = `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE}:setIamPolicy`;

async function main() {
  await client.authorize();

  // Read the current IAM policy, append allUsers as Cloud Run Invoker, then write it back.
  const getUrl = `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE}:getIamPolicy`;
  const getRes = await client.request<{ bindings?: Array<{ role: string; members: string[] }>; etag?: string }>({
    url: getUrl,
    method: 'GET',
  });
  const policy = getRes.data || {};
  const bindings = policy.bindings || [];
  const existing = bindings.find((b) => b.role === 'roles/run.invoker');
  if (existing) {
    if (!existing.members.includes('allUsers')) existing.members.push('allUsers');
  } else {
    bindings.push({ role: 'roles/run.invoker', members: ['allUsers'] });
  }

  const setRes = await client.request({
    url,
    method: 'POST',
    data: { policy: { bindings, etag: policy.etag } },
  });
  console.log('Policy updated. Current bindings:');
  console.log(JSON.stringify(setRes.data, null, 2));
}

main().catch((e) => {
  console.error('Failed:', e?.response?.data || e);
  process.exit(1);
});

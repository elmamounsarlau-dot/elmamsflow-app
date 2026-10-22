// Prints the environment for running the app against the local stack (test-only keys signed with the local secret).
import { createHmac } from 'node:crypto';
const SECRET = process.env.LOCAL_JWT_SECRET ?? 'local-only-jwt-secret-0123456789-abcdef';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (c) => { const h = b64({ alg: 'HS256', typ: 'JWT' }); const b = b64(c); return `${h}.${b}.${createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`; };
const exp = Math.floor(Date.now() / 1000) + 365 * 86400;
console.log(`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=${sign({ role: 'anon', iss: 'local', exp })}
SUPABASE_SERVICE_ROLE_KEY=${sign({ role: 'service_role', iss: 'local', exp })}
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000
INTEGRATIONS_KEY=local-test-integrations-key
CRON_SECRET=local-cron-secret-for-tests-only-0123456789`);

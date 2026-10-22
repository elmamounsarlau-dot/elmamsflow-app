// Local stand-in for Supabase's API gateway, for UI and end-to-end testing only (never production).
//   /rest/v1/*  → PostgREST (Row Level Security applies exactly as in Supabase)
//   /auth/v1/*  → the few auth endpoints the app calls, answered from signed test tokens
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { sign, session, userJson, verify } from './gateway-sign.mjs';

const REST = process.env.LOCAL_REST_URL ?? 'http://127.0.0.1:3001';
const PORT = Number(process.env.LOCAL_GATEWAY_PORT ?? 54321);
const users = JSON.parse(readFileSync(new URL('./users.json', import.meta.url), 'utf8'));
void sign;
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/rest/v1')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
    const r = await fetch(REST + url.pathname.slice('/rest/v1'.length) + url.search, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const out = Buffer.from(await r.arrayBuffer());
    const h = {}; r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) h[k] = v; });
    res.writeHead(r.status, h); res.end(out); return;
  }
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (url.pathname === '/auth/v1/user') {
    const c = verify(bearer); const u = c && users.find((x) => x.id === c.sub);
    return u ? send(res, 200, userJson(u)) : send(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
  }
  const adm = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/);
  if (adm) { const u = users.find((x) => x.id === adm[1]); return u ? send(res, 200, userJson(u)) : send(res, 404, { msg: 'not found' }); }
  if (url.pathname === '/auth/v1/token') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const u = users.find((x) => x.id === body.refresh_token);
    return u ? send(res, 200, session(u)) : send(res, 400, { error: 'invalid_grant' });
  }
  if (url.pathname === '/auth/v1/logout') { res.writeHead(204); return res.end(); }
  send(res, 404, { msg: `not available locally: ${url.pathname}` });
}).listen(PORT, '127.0.0.1', () => console.log(`local gateway on :${PORT}`));

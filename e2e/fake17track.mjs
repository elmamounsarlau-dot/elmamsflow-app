// A stand-in for the 17TRACK API, for local end-to-end tests only. Listens on 127.0.0.1.
import { createServer } from 'node:http';
const port = Number(process.env.FAKE17_PORT ?? 3017);
const key = process.env.TRACK17_API_KEY;
export const registered = new Set();
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const send = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 0, data })); };
  if (req.headers['17token'] !== key) { res.writeHead(401); return res.end('{"code":-1}'); }
  const list = body ? JSON.parse(body) : [];
  if (req.url.endsWith('/register')) {
    const accepted = [], rejected = [];
    for (const x of list) {
      if (String(x.number).startsWith('BAD')) rejected.push({ number: x.number, error: { code: -18010012, message: 'The format of the tracking number is invalid.' } });
      else { registered.add(x.number); accepted.push({ number: x.number, carrier: 190008, tag: x.tag }); }
    }
    return send({ accepted, rejected });
  }
  if (req.url.endsWith('/gettrackinfo')) {
    return send({ accepted: list.map((x) => ({ number: x.number, carrier: 190008, track_info: {
      latest_status: { status: 'OutForDelivery', sub_status: 'OutForDelivery_Other' },
      latest_event: { time_utc: '2026-10-22T07:30:00Z', description: 'Out for delivery', location: 'Lyon, FR' },
      tracking: { providers: [{ events: [
        { time_utc: '2026-10-22T07:30:00Z', description: 'Out for delivery', location: 'Lyon, FR' },
        { time_utc: '2026-10-19T12:00:00Z', description: 'Arrived at destination country', location: 'Paris, FR' },
        { time_utc: '2026-10-15T02:00:00Z', description: 'Departed from origin facility', location: 'Ningbo, CN' },
      ] }] } } })), rejected: [] });
  }
  if (req.url.endsWith('/getquota')) return send({ quota_total: 100, quota_used: registered.size, quota_remain: 100 - registered.size });
  res.writeHead(404); res.end('{}');
}).listen(port, '127.0.0.1', () => console.log(`fake 17TRACK on :${port}`));

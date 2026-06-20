import http from 'http';
import { config } from './load-env';
config();

// Dynamic imports ensure env vars are set before any module initializes
const { default: webhookHandler } = await import('../api/webhook');
const { default: syncHandler } = await import('../api/sync-customers');

const PORT = 3000;

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString();

    const vReq: any = Object.assign(req, {
      query: Object.fromEntries(url.searchParams),
      body: body ? (() => { try { return JSON.parse(body); } catch { return body; } })() : {},
      cookies: {},
    });

    let statusCode = 200;
    const headers: Record<string, string> = {};
    const vRes: any = {
      status(code: number) { statusCode = code; return vRes; },
      setHeader(k: string, v: string) { headers[k] = v; return vRes; },
      json(data: any) { headers['Content-Type'] = 'application/json'; res.writeHead(statusCode, headers); res.end(JSON.stringify(data)); },
      send(data: any) { res.writeHead(statusCode, headers); res.end(String(data)); },
      end() { res.writeHead(statusCode, headers); res.end(); },
    };

    const path = url.pathname;
    try {
      if (path === '/api/webhook') return await webhookHandler(vReq, vRes);
      if (path === '/api/sync-customers') return await syncHandler(vReq, vRes);
      res.writeHead(404); res.end('Not found');
    } catch (err: any) {
      console.error(err);
      res.writeHead(500); res.end(err.message);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}`);
  console.log('Routes: /api/webhook  /api/sync-customers');
});

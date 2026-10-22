/**
 * Tiny local bridge. The Figma plugin pulls the latest O2F document from
 * http://localhost:4747/latest so you never paste JSON by hand. `capture --push`
 * posts into it, and a watched file is re-read on every request.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';

export interface ServeOptions {
  port?: number;
  file?: string;
  log?: (msg: string) => void;
}

export interface BridgeState {
  latest: string | null;
  latestAt: Date | null;
  source: string | null;
}

export function startBridge(opts: ServeOptions = {}): Promise<{ port: number; close: () => Promise<void>; state: BridgeState }> {
  const port = opts.port ?? 4747;
  const log = opts.log ?? (() => {});
  const state: BridgeState = { latest: null, latestAt: null, source: null };

  const cors = (res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    cors(res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    if (req.method === 'GET' && url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, hasDocument: !!(state.latest || opts.file), latestAt: state.latestAt, source: state.source }));
    }

    if (req.method === 'GET' && url.pathname === '/latest') {
      if (opts.file) {
        try {
          const s = await stat(opts.file);
          if (!state.latestAt || s.mtime > state.latestAt) {
            state.latest = await readFile(opts.file, 'utf8');
            state.latestAt = s.mtime;
            state.source = opts.file;
          }
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `cannot read ${opts.file}: ${(err as Error).message}` }));
        }
      }
      if (!state.latest) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'no document yet; run `open2figma capture <url> --push`' }));
      }
      res.setHeader('Content-Type', 'application/json');
      log(`served ${state.source ?? 'pushed document'} to ${req.headers.origin ?? 'client'}`);
      return res.end(state.latest);
    }

    if (req.method === 'POST' && url.pathname === '/push') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'body is not JSON' }));
      }
      state.latest = body;
      state.latestAt = new Date();
      state.source = url.searchParams.get('source') ?? 'push';
      log(`received ${(body.length / 1024).toFixed(0)} KB from ${state.source}`);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true }));
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        state,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export async function pushDocument(bridgeUrl: string, json: string, source?: string): Promise<void> {
  const u = new URL('/push', bridgeUrl);
  if (source) u.searchParams.set('source', source);
  const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
  if (!res.ok) throw new Error(`bridge rejected push: HTTP ${res.status}`);
}

// The forge's HTTP surface: one server routing the four surfaces the suite
// drives — git smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3,
// GraphQL at /api/graphql and MCP at /mcp — all over one shared store.
//
// app.ts is deliberately separate from main.ts: this is the server, the file
// you grow; main.ts is the entry <-> env lifecycle and should stay as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, readBody } from './gitHttp.ts';
import { routeRest, type RestReply } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** /{owner}/{repo}.git plus the endpoint suffix, compiled once. */
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

function sendJson(store: Store, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        res.writeHead(200, { 'content-type': JSON_TYPE });
        res.end('{"ok":true}');
        return;
      }

      const authorized = token !== '' && (req.headers.authorization ?? '') === `Bearer ${token}`;

      // ---------------------------------------------------------- git smart HTTP
      const gitMatch = GIT_PATH.exec(path);
      if (gitMatch) {
        const [, ownerRaw, repoRaw, restRaw] = gitMatch;
        const owner = decode(ownerRaw);
        const repoName = decode(repoRaw);
        const rest = restRaw ?? '';
        if (!authorized) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('authentication required\n');
          return;
        }
        if (method === 'GET' && rest === '/info/refs') {
          handleInfoRefs(store, req, res, owner, repoName, url.searchParams.get('service') ?? '');
          return;
        }
        if (method === 'POST' && rest === '/git-upload-pack') {
          await handleUploadPack(store, req, res, owner, repoName);
          return;
        }
        if (method === 'POST' && rest === '/git-receive-pack') {
          await handleReceivePack(store, req, res, owner, repoName);
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found\n');
        return;
      }

      // ---------------------------------------------------------- GraphQL
      if (path === '/api/graphql') {
        if (!authorized) {
          sendJson(store, res, 401, { message: 'Bad credentials' });
          return;
        }
        if (method !== 'POST') {
          sendJson(store, res, 404, { message: 'Not Found' });
          return;
        }
        const text = (await readBody(req)).toString('utf8');
        const reply = handleGraphql(store, text);
        sendJson(store, res, reply.status, reply.body);
        return;
      }

      // ---------------------------------------------------------- MCP
      if (path === '/mcp') {
        if (!authorized) {
          // The MCP checks require a 401 for a call with no Authorization.
          res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': store.nextRequestId() });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
          return;
        }
        if (method !== 'POST') {
          sendJson(store, res, 404, { message: 'Not Found' });
          return;
        }
        const text = (await readBody(req)).toString('utf8');
        const reply = handleMcp(store, text, req.headers['mcp-session-id']?.toString());
        const headers: Record<string, string> = {};
        if (reply.sessionId) headers['mcp-session-id'] = reply.sessionId;
        if (reply.status === 202) {
          res.writeHead(202, headers);
          res.end();
          return;
        }
        res.writeHead(reply.status, { 'content-type': JSON_TYPE, ...headers });
        res.end(JSON.stringify(reply.body));
        return;
      }

      // ---------------------------------------------------------- REST v3
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authorized) {
          sendJson(store, res, 401, { message: 'Bad credentials' });
          return;
        }
        const segments = path
          .slice('/api/v3'.length)
          .split('/')
          .filter((segment) => segment !== '')
          .map(decode);
        let bodyText = '';
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          bodyText = (await readBody(req)).toString('utf8');
        }
        const reply: RestReply = routeRest({
          store,
          method,
          segments,
          query: url.searchParams,
          bodyText,
          host: req.headers.host ?? 'localhost',
        });
        if (reply.status === 204) {
          res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
          res.end();
          return;
        }
        sendJson(store, res, reply.status, reply.body, reply.headers);
        return;
      }

      sendJson(store, res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        try {
          sendJson(store, res, 500, { message: `internal error: ${err instanceof Error ? err.message : String(err)}` });
        } catch {
          /* socket already gone */
        }
      } else {
        res.destroy();
      }
    });
  });
}

// The MCP endpoint: JSON-RPC 2.0 over Streamable HTTP. It speaks the
// 2026-07-28 revision (server/discover, no handshake) and the handshake era
// (initialize + notifications/initialized) for older clients. The six tools
// act on the same store as REST, so an object created here reads back over
// /api/v3 unchanged.

import type { Store } from './store.ts';
import { doMerge, issueJson, pullJson, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): unknown {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.properties,
        required: tool.required,
      },
    })),
  };
}

export interface McpReply {
  status: number;
  body?: unknown;
  sessionId?: string;
}

function result(id: unknown, value: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result: value } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const out: Record<string, unknown> = { content: [{ type: 'text', text }], isError };
  if (!isError && typeof payload === 'object' && payload !== null) out.structuredContent = payload;
  return out;
}

function str(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const canonical = TOOLS.find((tool) => tool.name === name.toLowerCase() || name.toLowerCase().endsWith(tool.name));
  if (!canonical) return toolResult(`unknown tool ${name}`, true);
  for (const required of canonical.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolResult(`missing required argument ${required}`, true);
    }
  }
  const owner = str(args, 'owner') ?? store.viewerLogin ?? 'viewer';
  const repoName = str(args, 'repo');
  switch (canonical.name) {
    case 'create_repo': {
      const repoNameNew = str(args, 'name')!;
      if (store.repos.has(repoNameNew)) return toolResult(`repository ${repoNameNew} already exists`, true);
      const repo = store.createRepo(repoNameNew, args.private !== false, str(args, 'description') ?? null);
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = store.repoFor(owner, repoName ?? '');
      if (!repo) return toolResult(`repository ${owner}/${repoName} not found`, true);
      store.adoptViewer(owner);
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = store.repoFor(owner, repoName ?? '');
      if (!repo) return toolResult(`repository ${owner}/${repoName} not found`, true);
      store.adoptViewer(owner);
      const now = store.clock.nowIso();
      const issue = {
        id: repo.nextIssueId,
        number: repo.nextIssueNumber,
        title: str(args, 'title')!,
        body: str(args, 'body') ?? null,
        state: 'open' as const,
        labels: [] as string[],
        createdAt: now,
        updatedAt: now,
        comments: [],
        isPull: false,
      };
      repo.nextIssueId += 1;
      repo.nextIssueNumber += 1;
      repo.issues.set(issue.number, issue);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const repo = store.repoFor(owner, repoName ?? '');
      if (!repo) return toolResult(`repository ${owner}/${repoName} not found`, true);
      store.adoptViewer(owner);
      const state = str(args, 'state') ?? 'open';
      let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => a.number - b.number);
      return toolResult(list.map((issue) => issueJson(store, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = store.repoFor(owner, repoName ?? '');
      if (!repo) return toolResult(`repository ${owner}/${repoName} not found`, true);
      store.adoptViewer(owner);
      const head = str(args, 'head')!;
      const base = str(args, 'base')!;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolResult('head or base branch does not exist', true);
      const now = store.clock.nowIso();
      const pull = {
        id: repo.nextIssueId,
        number: repo.nextIssueNumber,
        title: str(args, 'title')!,
        body: str(args, 'body') ?? null,
        state: 'open' as const,
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: now,
        updatedAt: now,
      };
      repo.nextIssueId += 1;
      repo.nextIssueNumber += 1;
      repo.pulls.set(pull.number, pull);
      return toolResult(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.repoFor(owner, repoName ?? '');
      if (!repo) return toolResult(`repository ${owner}/${repoName} not found`, true);
      store.adoptViewer(owner);
      const number = Number(args.pull_number ?? args.pullNumber ?? args.number);
      const pull = repo.pulls.get(number);
      if (!pull) return toolResult(`pull request ${number} not found`, true);
      const sha = doMerge(store, repo, pull, 'squash');
      if (sha === null) return toolResult('pull request is not mergeable', true);
      return toolResult(pullJson(store, repo, pull));
    }
    default:
      return toolResult(`unimplemented tool ${name}`, true);
  }
}

/** Handle one POST /mcp body. */
export function handleMcp(store: Store, text: string, sessionHeader?: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const replies: unknown[] = [];
  let sessionId = sessionHeader;
  for (const entry of requests) {
    const request = entry as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    const isNotification = request.id === undefined || request.id === null;
    switch (request.method) {
      case 'server/discover':
        replies.push({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: '2026-07-28',
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        });
        break;
      case 'initialize': {
        const requested = String((request.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '');
        const chosen = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
        sessionId = sessionId ?? 'forge-session-1';
        replies.push({
          jsonrpc: '2.0',
          id: request.id,
          result: { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
        });
        break;
      }
      case 'ping':
        if (!isNotification) replies.push({ jsonrpc: '2.0', id: request.id, result: {} });
        break;
      case 'tools/list':
        replies.push({ jsonrpc: '2.0', id: request.id, result: toolsList() });
        break;
      case 'tools/call': {
        const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const toolName = String(params.name ?? '');
        const known = TOOLS.some((tool) => tool.name === toolName.toLowerCase() || toolName.toLowerCase().endsWith(tool.name));
        if (!known) {
          replies.push({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `unknown tool ${toolName}` } });
        } else {
          replies.push({ jsonrpc: '2.0', id: request.id, result: callTool(store, toolName, params.arguments ?? {}) });
        }
        break;
      }
      default:
        if (typeof request.method === 'string' && request.method.startsWith('notifications/')) {
          // Notifications never get a response.
        } else if (!isNotification) {
          replies.push({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `method not found ${String(request.method)}` } });
        }
    }
  }
  if (replies.length === 0) return { status: 202, sessionId };
  return { status: 200, body: Array.isArray(parsed) ? replies : replies[0], sessionId };
}

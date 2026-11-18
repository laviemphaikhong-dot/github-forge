// The REST v3 surface: repositories, contents, branches, commits, labels,
// issues, comments and pull requests, in GitHub's shapes, backed by the same
// store the git endpoints use (a file committed through PUT /contents is a
// real git commit; a branch pushed over git is listed here).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { invalidateRepo, type Issue, type Pull, type Repo, type Store } from './store.ts';
import {
  buildCommitData,
  buildTreeFromMap,
  flattenTree,
  parseCommit,
  parseTree,
  storeObject,
} from './git.ts';

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestReply => ({ status, body, headers });
export const notFound = (): RestReply => ok(404, { message: 'Not Found' });
const unprocessable = (message: string): RestReply => ok(422, { message });

// ---------------------------------------------------------------- shapes

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.viewerLogin ?? 'viewer';
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: store.viewerId, type: 'User', site_admin: false },
    private: repo.isPrivate,
    html_url: `https://forge.invalid/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    clone_url: `https://forge.invalid/${owner}/${repo.name}.git`,
    size: 1,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open' && !i.isPull).length,
    archived: false,
    disabled: false,
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (!label) return null;
  return { id: name.length * 7919 + repo.id, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = store.viewerLogin ?? 'viewer';
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name) ?? { name }),
    user: { login: owner, id: store.viewerId, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://forge.invalid/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = store.viewerLogin ?? 'viewer';
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${owner}:${pull.headRef}`,
      repo: repoJson(store, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${owner}:${pull.baseRef}`,
      repo: repoJson(store, repo),
    },
    user: { login: owner, id: store.viewerId, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://forge.invalid/${owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const authorLine = /^author (.*)$/m.exec(obj.data.toString('utf8'))?.[1] ?? '';
  const committerLine = /^committer (.*)$/m.exec(obj.data.toString('utf8'))?.[1] ?? '';
  const person = (line: string): Record<string, unknown> => {
    const m = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (!m) return { name: line, email: '', date: new Date(0).toISOString() };
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString().replace('.000Z', 'Z') };
  };
  return {
    sha,
    node_id: Buffer.from(`Commit${sha}`).toString('base64'),
    commit: {
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      author: person(authorLine),
      committer: person(committerLine),
      comment_count: 0,
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------- helpers

function parseJsonBody(text: string): { value: Record<string, unknown> } | { error: RestReply } {
  if (text.trim() === '') return { value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { value: {} };
    return { value: value as Record<string, unknown> };
  } catch {
    return { error: ok(400, { message: 'Problems parsing JSON' }) };
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Resolve a ref name or sha to a commit sha. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.get(ref)?.type === 'commit') return ref;
  const byRef = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (byRef) return byRef;
  return undefined;
}

/** Commit a new tree onto a branch (or create the branch), REST-style. */
function commitOnto(store: Store, repo: Repo, branch: string, files: Map<string, { sha: string; mode: string }>, message: string): string {
  const tree = buildTreeFromMap(repo, files);
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const stamp = store.clock.nowGit();
  const identity = `Forge <forge@forge.invalid> ${stamp}`;
  const data = buildCommitData({
    tree,
    parents: parent ? [parent] : [],
    author: identity,
    committer: identity,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const sha = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, sha);
  invalidateRepo(repo);
  repo.updatedAt = store.clock.nowIso();
  return sha;
}

function filesAt(repo: Repo, commitSha: string): Map<string, { sha: string; mode: string }> {
  const commit = parseCommit(repo.objects.get(commitSha)!.data);
  return flattenTree(repo, commit.tree);
}

// ---------------------------------------------------------------- routing

export interface RestContext {
  store: Store;
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  bodyText: string;
  host: string;
}

export function routeRest(ctx: RestContext): RestReply {
  const { store, method, segments, query } = ctx;
  const s = segments;

  if (s.length === 0) {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (s.length === 1 && s[0] === 'meta') {
    return ok(200, { verifiable_password_authentication: false, installed_version: '3.19.0.forge' });
  }
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') return listUserRepos(ctx);
    if (method === 'POST') return createRepo(ctx);
    return notFound();
  }
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1];
    const repoName = s[2];
    const repo = store.repoFor(owner, repoName);
    if (repo) store.adoptViewer(owner);
    if (!repo) return notFound();
    const rest = s.slice(3);
    return routeRepo(ctx, repo, rest);
  }
  return notFound();
}

function listUserRepos(ctx: RestContext): RestReply {
  const { store, query } = ctx;
  const all = [...store.repos.values()];
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const params = new URLSearchParams(query);
    params.set('page', String(page + 1));
    params.set('per_page', String(perPage));
    headers.link = `<http://${ctx.host}/api/v3/user/repos?${params.toString()}>; rel="next"`;
  }
  return ok(200, slice.map((repo) => repoJson(store, repo)), headers);
}

function createRepo(ctx: RestContext): RestReply {
  const parsed = parseJsonBody(ctx.bodyText);
  if ('error' in parsed) return parsed.error;
  const name = str(parsed.value.name);
  if (!name) return unprocessable('name is required');
  if (ctx.store.repos.has(name)) {
    return ok(422, {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
  }
  const isPrivate = parsed.value.private !== false;
  const description = str(parsed.value.description) ?? null;
  const repo = ctx.store.createRepo(name, isPrivate, description);
  if (str(parsed.value.default_branch)) repo.defaultBranch = str(parsed.value.default_branch)!;
  return ok(201, repoJson(ctx.store, repo));
}

function routeRepo(ctx: RestContext, repo: Repo, rest: string[]): RestReply {
  const { store, method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(store, repo));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx.bodyText);
      if ('error' in parsed) return parsed.error;
      if (str(parsed.value.description) !== undefined) repo.description = str(parsed.value.description) ?? null;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      if (str(parsed.value.name) && str(parsed.value.name) !== repo.name) {
        store.repos.delete(repo.name);
        repo.name = str(parsed.value.name)!;
        store.repos.set(repo.name, repo);
      }
      if (str(parsed.value.default_branch)) repo.defaultBranch = str(parsed.value.default_branch)!;
      repo.updatedAt = store.clock.nowIso();
      return ok(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      return { status: 204 };
    }
    return notFound();
  }
  const [head, ...tail] = rest;
  switch (head) {
    case 'contents':
      return routeContents(ctx, repo, tail.join('/'));
    case 'branches':
      return routeBranches(ctx, repo, tail);
    case 'commits':
      return routeCommits(ctx, repo, tail);
    case 'git':
      return routeGitRefs(ctx, repo, tail);
    case 'labels':
      return routeLabels(ctx, repo, tail);
    case 'issues':
      return routeIssues(ctx, repo, tail);
    case 'pulls':
      return routePulls(ctx, repo, tail);
    default:
      return notFound();
  }
}

// ---------------------------------------------------------------- contents

function routeContents(ctx: RestContext, repo: Repo, path: string): RestReply {
  const { store, method, query } = ctx;
  if (method === 'PUT') {
    const parsed = parseJsonBody(ctx.bodyText);
    if ('error' in parsed) return parsed.error;
    const message = str(parsed.value.message) ?? 'Update file';
    const contentB64 = str(parsed.value.content);
    if (contentB64 === undefined) return unprocessable('content is required');
    const branch = str(parsed.value.branch) ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const files = tip ? filesAt(repo, tip) : new Map<string, { sha: string; mode: string }>();
    const existing = files.get(path);
    const givenSha = str(parsed.value.sha);
    if (existing && givenSha !== undefined && givenSha !== existing.sha) {
      return ok(409, { message: 'sha does not match' });
    }
    if (!existing && givenSha !== undefined) {
      return ok(409, { message: 'sha does not match' });
    }
    const data = Buffer.from(contentB64, 'base64');
    const blobSha = storeObject(repo, 'blob', data);
    files.set(path, { sha: blobSha, mode: '100644' });
    const commitSha = commitOnto(store, repo, branch, files, message);
    const status = existing ? 200 : 201;
    return ok(status, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobSha,
        size: data.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commitSha },
    });
  }
  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref) ?? repo.defaultTip();
    if (!tip) return notFound();
    const files = filesAt(repo, tip);
    const file = files.get(path);
    if (file) {
      const blob = repo.objects.get(file.sha);
      if (!blob) return notFound();
      return ok(200, {
        name: path.split('/').pop(),
        path,
        sha: file.sha,
        size: blob.data.length,
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
      });
    }
    // A directory: list the entries directly under it.
    const prefix = path === '' ? '' : `${path.replace(/\/$/, '')}/`;
    const entries = new Map<string, { sha: string; type: string; size: number }>();
    for (const [filePath, value] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const [first, ...more] = rest.split('/');
      if (more.length === 0) {
        const blob = repo.objects.get(value.sha);
        entries.set(first, { sha: value.sha, type: 'file', size: blob ? blob.data.length : 0 });
      } else if (!entries.has(first)) {
        entries.set(first, { sha: value.sha, type: 'dir', size: 0 });
      }
    }
    if (entries.size === 0 && path !== '') return notFound();
    return ok(
      200,
      [...entries.entries()].map(([name, value]) => ({
        name,
        path: `${prefix}${name}`,
        sha: value.sha,
        size: value.size,
        type: value.type,
      })),
    );
  }
  if (method === 'DELETE') {
    const parsed = parseJsonBody(ctx.bodyText);
    if ('error' in parsed) return parsed.error;
    const message = str(parsed.value.message) ?? 'Delete file';
    const branch = str(parsed.value.branch) ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return notFound();
    const files = filesAt(repo, tip);
    if (!files.has(path)) return notFound();
    files.delete(path);
    const commitSha = commitOnto(store, repo, branch, files, message);
    return ok(200, { content: null, commit: { sha: commitSha } });
  }
  return notFound();
}

// ---------------------------------------------------------------- branches/commits/refs

function routeBranches(ctx: RestContext, repo: Repo, tail: string[]): RestReply {
  if (ctx.method !== 'GET') return notFound();
  if (tail.length === 0) {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(ref)! },
        protected: false,
      }));
    return ok(200, branches);
  }
  const name = tail.join('/');
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (!sha) return notFound();
  return ok(200, { name, commit: { sha }, protected: false });
}

function routeCommits(ctx: RestContext, repo: Repo, tail: string[]): RestReply {
  if (ctx.method !== 'GET') return notFound();
  if (tail.length === 1) {
    const commit = commitJson(repo, tail[0]);
    return commit ? ok(200, commit) : notFound();
  }
  const ref = ctx.query.get('sha') ?? repo.defaultBranch;
  let tip = resolveRef(repo, ref);
  if (!tip) return ok(200, []);
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const all: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const json = commitJson(repo, sha);
    if (!json) continue;
    all.push(json);
    const commit = parseCommit(repo.objects.get(sha)!.data);
    queue.push(...commit.parents);
  }
  void tip;
  return ok(200, all.slice((page - 1) * perPage, page * perPage));
}

function routeGitRefs(ctx: RestContext, repo: Repo, tail: string[]): RestReply {
  // POST /git/refs {ref, sha}; GET /git/refs[/...]; DELETE /git/refs/...
  if (tail[0] !== 'refs') return notFound();
  if (ctx.method === 'POST' && tail.length === 1) {
    const parsed = parseJsonBody(ctx.bodyText);
    if ('error' in parsed) return parsed.error;
    const ref = str(parsed.value.ref);
    const sha = str(parsed.value.sha);
    if (!ref || !sha) return unprocessable('ref and sha are required');
    if (!repo.objects.has(sha)) return unprocessable('sha does not exist');
    if (repo.refs.has(ref)) return ok(422, { message: 'Reference already exists' });
    const wasEmpty = repo.refs.size === 0;
    repo.refs.set(ref, sha);
    invalidateRepo(repo);
    if (wasEmpty && ref.startsWith('refs/heads/')) repo.defaultBranch = ref.slice('refs/heads/'.length);
    return ok(201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
  }
  const ref = tail.join('/');
  if (ctx.method === 'GET') {
    const sha = repo.refs.get(ref);
    if (!sha) return notFound();
    return ok(200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
  }
  if (ctx.method === 'DELETE') {
    if (!repo.refs.has(ref)) return notFound();
    repo.refs.delete(ref);
    invalidateRepo(repo);
    return { status: 204 };
  }
  return notFound();
}

// ---------------------------------------------------------------- labels

function routeLabels(ctx: RestContext, repo: Repo, tail: string[]): RestReply {
  if (ctx.method === 'POST' && tail.length === 0) {
    const parsed = parseJsonBody(ctx.bodyText);
    if ('error' in parsed) return parsed.error;
    const name = str(parsed.value.name);
    if (!name) return unprocessable('name is required');
    if (repo.labels.has(name)) return ok(422, { message: 'Validation Failed: label already exists' });
    repo.labels.set(name, {
      name,
      color: str(parsed.value.color) ?? 'ededed',
      description: str(parsed.value.description) ?? null,
    });
    return ok(201, labelJson(repo, name));
  }
  if (ctx.method === 'GET' && tail.length === 0) {
    return ok(200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
  }
  if (ctx.method === 'GET' && tail.length === 1) {
    const label = labelJson(repo, tail[0]);
    return label ? ok(200, label) : notFound();
  }
  return notFound();
}

// ---------------------------------------------------------------- issues

function routeIssues(ctx: RestContext, repo: Repo, tail: string[]): RestReply {
  const { store, method, query } = ctx;
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx.bodyText);
      if ('error' in parsed) return parsed.error;
      const title = str(parsed.value.title);
      if (title === undefined) return unprocessable('title is required');
      const labelNames: string[] = [];
      const rawLabels = parsed.value.labels;
      if (Array.isArray(rawLabels)) {
        for (const entry of rawLabels) {
          const name = typeof entry === 'string' ? entry : str((entry as Record<string, unknown>)?.name);
          if (!name) continue;
          if (!repo.labels.has(name)) return unprocessable(`label "${name}" does not exist`);
          labelNames.push(name);
        }
      }
      const now = store.clock.nowIso();
      const issue: Issue = {
        id: repo.nextIssueId,
        number: repo.nextIssueNumber,
        title,
        body: str(parsed.value.body) ?? null,
        state: 'open',
        labels: labelNames,
        createdAt: now,
        updatedAt: now,
        comments: [],
        isPull: false,
      };
      repo.nextIssueId += 1;
      repo.nextIssueNumber += 1;
      repo.issues.set(issue.number, issue);
      return ok(201, issueJson(store, repo, issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      const direction = query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return ok(200, list.map((issue) => issueJson(store, repo, issue)));
    }
    return notFound();
  }
  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (tail.length === 1) {
    if (!issue || issue.isPull) return notFound();
    if (method === 'GET') return ok(200, issueJson(store, repo, issue));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx.bodyText);
      if ('error' in parsed) return parsed.error;
      if (str(parsed.value.title) !== undefined) issue.title = str(parsed.value.title)!;
      if (str(parsed.value.body) !== undefined) issue.body = str(parsed.value.body) ?? null;
      const state = str(parsed.value.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      issue.updatedAt = store.clock.nowIso();
      return ok(200, issueJson(store, repo, issue));
    }
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue || issue.isPull) return notFound();
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx.bodyText);
      if ('error' in parsed) return parsed.error;
      const body = str(parsed.value.body);
      if (body === undefined) return unprocessable('body is required');
      const now = store.clock.nowIso();
      const comment = { id: issue.id * 100000 + issue.comments.length + 1, body, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      issue.updatedAt = now;
      return ok(201, {
        id: comment.id,
        body: comment.body,
        user: { login: store.viewerLogin ?? 'viewer', id: store.viewerId, type: 'User' },
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      });
    }
    if (method === 'GET') {
      return ok(
        200,
        issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: store.viewerLogin ?? 'viewer', id: store.viewerId, type: 'User' },
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        })),
      );
    }
  }
  return notFound();
}

// ---------------------------------------------------------------- pulls

function routePulls(ctx: RestContext, repo: Repo, tail: string[]): RestReply {
  const { store, method, query } = ctx;
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx.bodyText);
      if ('error' in parsed) return parsed.error;
      const title = str(parsed.value.title);
      const head = str(parsed.value.head);
      const base = str(parsed.value.base);
      if (title === undefined || !head || !base) return unprocessable('title, head and base are required');
      const headRef = head.includes(':') ? head.split(':').pop()! : head;
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) return unprocessable(`head ref ${headRef} does not exist`);
      if (!baseSha) return unprocessable(`base ref ${base} does not exist`);
      const now = store.clock.nowIso();
      const pull: Pull = {
        id: repo.nextIssueId,
        number: repo.nextIssueNumber,
        title,
        body: str(parsed.value.body) ?? null,
        state: 'open',
        headRef,
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
      return ok(201, pullJson(store, repo, pull));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.number - a.number);
      return ok(200, list.map((pull) => pullJson(store, repo, pull)));
    }
    return notFound();
  }
  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (!pull) return notFound();
  if (tail.length === 1) {
    if (method === 'GET') {
      // Refresh the head/base shas GitHub would report live.
      pull.headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      return ok(200, pullJson(store, repo, pull));
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx.bodyText);
      if ('error' in parsed) return parsed.error;
      if (str(parsed.value.title) !== undefined) pull.title = str(parsed.value.title)!;
      if (str(parsed.value.body) !== undefined) pull.body = str(parsed.value.body) ?? null;
      const state = str(parsed.value.state);
      if (state === 'open' || state === 'closed') pull.state = state;
      pull.updatedAt = store.clock.nowIso();
      return ok(200, pullJson(store, repo, pull));
    }
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    return ok(200, pullFiles(repo, pull));
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    return mergePull(ctx, repo, pull);
  }
  return notFound();
}

/** Line-based diff counts between two blobs (LCS on lines; files are small). */
export function diffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // Trim common prefix/suffix first: keeps the LCS table tiny.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const dp: number[] = new Array(midB.length + 1).fill(0);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    let prev = 0;
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      const tmp = dp[j];
      dp[j] = midA[i] === midB[j] ? prev + 1 : Math.max(dp[j], dp[j + 1]);
      prev = tmp;
    }
  }
  const common = dp[0];
  return { additions: midB.length - common, deletions: midA.length - common };
}

export function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const baseFiles = filesAt(repo, pull.baseSha);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const headFiles = filesAt(repo, headTip);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base && head && base.sha === head.sha) continue;
    const oldText = base ? (repo.objects.get(base.sha)?.data.toString('utf8') ?? '') : '';
    const newText = head ? (repo.objects.get(head.sha)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = diffCounts(oldText, newText);
    out.push({
      sha: head?.sha ?? base!.sha,
      filename: path,
      status: !base ? 'added' : !head ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

/** Three-way, file-level merge of a tree set; null when a path conflicts. */
export function threeWayMerge(
  originFiles: Map<string, { sha: string; mode: string }>,
  baseFiles: Map<string, { sha: string; mode: string }>,
  headFiles: Map<string, { sha: string; mode: string }>,
): Map<string, { sha: string; mode: string }> | null {
  const merged = new Map<string, { sha: string; mode: string }>();
  const paths = new Set([...originFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const origin = originFiles.get(path);
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    const sameSha = (a?: { sha: string }, b?: { sha: string }): boolean => a?.sha === b?.sha;
    if (sameSha(head, base)) {
      if (base) merged.set(path, base);
    } else if (sameSha(head, origin)) {
      if (base) merged.set(path, base);
    } else if (sameSha(base, origin)) {
      if (head) merged.set(path, head);
    } else {
      return null;
    }
  }
  return merged;
}

/** Whether the pull can merge cleanly into its base branch right now. */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return false;
  return threeWayMerge(filesAt(repo, pull.baseSha), filesAt(repo, baseTip), filesAt(repo, headTip)) !== null;
}

/**
 * Merge the pull into its base branch: 'squash' lands one commit with the
 * merged tree, 'merge' lands a two-parent merge commit. Returns the new
 * commit sha, or null when the merge conflicts.
 */
export function doMerge(store: Store, repo: Repo, pull: Pull, method: 'squash' | 'merge'): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return null;
  const mergedFiles = threeWayMerge(filesAt(repo, pull.baseSha), filesAt(repo, baseTip), filesAt(repo, headTip));
  if (mergedFiles === null) return null;
  let sha: string;
  if (method === 'merge') {
    const tree = buildTreeFromMap(repo, mergedFiles);
    const stamp = store.clock.nowGit();
    const identity = `Forge <forge@forge.invalid> ${stamp}`;
    const data = buildCommitData({
      tree,
      parents: [baseTip, headTip],
      author: identity,
      committer: identity,
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
    });
    sha = storeObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    invalidateRepo(repo);
    repo.updatedAt = store.clock.nowIso();
  } else {
    sha = commitOnto(store, repo, pull.baseRef, mergedFiles, `${pull.title} (#${pull.number})`);
  }
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.clock.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return sha;
}

function mergePull(ctx: RestContext, repo: Repo, pull: Pull): RestReply {
  const { store } = ctx;
  if (pull.state === 'closed' && pull.merged) return ok(405, { message: 'Pull Request is not mergeable' });
  const sha = doMerge(store, repo, pull, 'squash');
  if (sha === null) return ok(405, { message: 'Pull Request is not mergeable' });
  return ok(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// Keep tree parsing referenced for future endpoints (avoid unused warnings in
// strict TS setups; harmless at runtime).
void parseTree;

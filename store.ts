// The forge's in-memory store: one token account, its repositories, and every
// object, ref, issue, pull request, label and comment those repositories hold.
// Everything lives in Maps so reads are O(1); a logical clock (never the wall
// clock) stamps created_at fields so two runs of the same trial agree.

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  /** The raw object payload (after the "<type> <len>\0" header). */
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
  /** Pull requests share the issue number space, as on GitHub. */
  isPull: boolean;
  /** Memoized REST serialization of this issue (rest.ts issueJsonText). */
  jsonKey?: string;
  jsonText?: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export class Repo {
  id: number;
  name: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** sha hex -> object */
  objects = new Map<string, GitObject>();
  /** full ref name ("refs/heads/main") -> sha hex */
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  nextIssueNumber = 1;
  nextIssueId = 1;
  /** Cache of generated packs (bytes + shallow list), keyed by want+depth. */
  packCache = new Map<string, { pack: Buffer; shallow: string[] }>();
  /** Bumped on every ref change; keys the advertisement/ls-refs caches. */
  version = 0;
  /** Bumped when a label is created; part of the issue-JSON cache key. */
  labelVersion = 0;
  /** Rendered ls-refs replies, keyed by version + arguments. */
  lsRefsCache = new Map<string, Buffer>();

  constructor(id: number, name: string, isPrivate: boolean, description: string | null, now: string) {
    this.id = id;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.defaultBranch = 'main';
    this.createdAt = now;
    this.updatedAt = now;
  }

  tip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  defaultTip(): string | undefined {
    return this.refs.get(`refs/heads/${this.defaultBranch}`);
  }
}

/** A deterministic clock: starts at a fixed instant, +1s per stamp. */
export class LogicalClock {
  private t = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000;
  nowIso(): string {
    this.t += 1;
    return new Date(this.t * 1000).toISOString().replace('.000Z', 'Z');
  }
  /** Git timestamp pair "epoch +0000" for commit objects. */
  nowGit(): string {
    this.t += 1;
    return `${this.t} +0000`;
  }
}

/** Forget every rendered answer a ref change invalidates. */
export function invalidateRepo(repo: Repo): void {
  repo.packCache.clear();
  repo.lsRefsCache.clear();
  repo.version += 1;
}

export class Store {
  clock = new LogicalClock();
  /** The token owner's login, adopted from the first owner-naming request. */
  viewerLogin: string | null = null;
  viewerId = 1001;
  repos = new Map<string, Repo>();
  nextRepoId = 5001;
  private requestSeq = 0;

  nextRequestId(): string {
    this.requestSeq += 1;
    return `REQ-${this.requestSeq.toString(36).toUpperCase()}`;
  }

  /** Learn the token owner's login the first time a request names it. */
  adoptViewer(login: string): void {
    if (this.viewerLogin === null && login !== '') this.viewerLogin = login;
  }

  createRepo(name: string, isPrivate: boolean, description: string | null): Repo {
    const repo = new Repo(this.nextRepoId, name, isPrivate, description, this.clock.nowIso());
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  /** A repo is visible only under the adopted viewer's name (or before adoption). */
  repoFor(owner: string, name: string): Repo | undefined {
    if (this.viewerLogin !== null && owner !== this.viewerLogin) return undefined;
    return this.repos.get(name);
  }
}

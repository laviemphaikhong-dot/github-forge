// A compact GraphQL executor for the documents gh and github-mcp-server
// send: queries and mutations over repositories, issues and pull requests,
// __type introspection for the types those clients feature-detect, Relay
// node(id:) lookups, cursor pagination on issues, and operation batching
// (an array body answers an array of results, in order).

import type { Issue, Pull, Repo, Store } from './store.ts';
import { doMerge, pullFiles, pullMergeable } from './rest.ts';

// ------------------------------------------------------------------ ids

export function repoNodeId(repo: Repo): string {
  return Buffer.from(`Repository${repo.id}`).toString('base64');
}
export function issueNodeId(issue: Issue): string {
  return Buffer.from(`Issue${issue.id}`).toString('base64');
}
export function pullNodeId(pull: Pull): string {
  return Buffer.from(`PullRequest${pull.id}`).toString('base64');
}
export function commentNodeId(id: number): string {
  return Buffer.from(`IssueComment${id}`).toString('base64');
}

function decodeNodeId(id: string): { kind: string; num: number } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+)(\d+)$/.exec(raw);
    if (!m) return null;
    return { kind: m[1], num: Number(m[2]) };
  } catch {
    return null;
  }
}

function findRepoById(store: Store, num: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === num) return repo;
  return undefined;
}

// ------------------------------------------------------------------ schema (for introspection + validation)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name'],
  RepositoryOwner: ['id', 'login'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasWikiEnabled', 'isPrivate', 'description', 'createdAt', 'updatedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'url',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt',
    'closedAt', 'url', 'repository',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'createdAt', 'updatedAt', 'closedAt',
    'url', 'repository', 'author',
  ],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: Value }>;
  selection: FieldNode[] | null;
  fragmentType: string | null; // set on inline-fragment pseudo-fields
  fragmentName: string | null; // set on spread pseudo-fields
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: FieldNode[];
}

class ParseError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new ParseError('unterminated block string');
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          out += source[j + 1] === 'u' ? String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)) : escapeChar(source[j + 1]);
          j += source[j + 1] === 'u' ? 6 : 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new ParseError('unterminated string');
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const m = /^[_A-Za-z][_0-9A-Za-z]*|^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
    if (m) {
      tokens.push(m[0]);
      i += m[0].length;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

function escapeChar(c: string): string {
  switch (c) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'b': return '\b';
    case 'f': return '\f';
    default: return c;
  }
}

class Parser {
  private tokens: string[];
  private pos = 0;
  fragments = new Map<string, { typeCondition: string; selection: FieldNode[] }>();

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    const t = this.tokens[this.pos];
    this.pos += 1;
    if (t === undefined) throw new ParseError('unexpected end of document');
    return t;
  }
  private expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new ParseError(`expected ${t}, got ${got}`);
  }
  private skipType(): void {
    // A type reference: Name, [Type], with optional '!'.
    if (this.peek() === '[') {
      this.next();
      this.skipType();
      this.expect(']');
    } else {
      this.next(); // the type name
    }
    if (this.peek() === '!') this.next();
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (t === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (t === 'query' || t === 'mutation' || t === 'subscription') {
        const kind = this.next();
        let name: string | null = null;
        if (this.peek() !== undefined && /^[_A-Za-z]/.test(this.peek()!) && this.peek() !== '(' && this.peek() !== '{') {
          name = this.next();
        }
        // Variable definitions.
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            this.next(); // variable name
            this.expect(':');
            this.skipType();
            if (this.peek() === '=') {
              this.next();
              this.parseValue();
            }
            if (this.peek() === '@') this.skipDirectives();
          }
          this.expect(')');
        }
        this.skipDirectives();
        operations.push({ type: kind === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (t === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        this.fragments.set(name, { typeCondition, selection });
      } else {
        throw new ParseError(`unexpected token ${t}`);
      }
    }
    return operations;
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek() === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t === '(') depth += 1;
          else if (t === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          const selection = this.parseSelectionSet();
          fields.push({ name: '', alias: null, args: [], selection, fragmentType: typeCondition, fragmentName: null });
        } else {
          const name = this.next();
          this.skipDirectives();
          fields.push({ name: '', alias: null, args: [], selection: null, fragmentType: null, fragmentName: name });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: FieldNode['args'] = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      this.skipDirectives();
      let selection: FieldNode[] | null = null;
      if (this.peek() === '{') selection = this.parseSelectionSet();
      fields.push({ name, alias, args, selection, fragmentType: null, fragmentName: null });
    }
    this.expect('}');
    return fields;
  }

  private parseValue(): Value {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.startsWith('"')) return { kind: 'string', value: t.slice(1, -1) };
    if (t === 'true' || t === 'false') return { kind: 'bool', value: t === 'true' };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    if (/^-?\d/.test(t)) return { kind: 'float', value: Number(t) };
    return { kind: 'enum', value: t };
  }
}

// ------------------------------------------------------------------ executor

type Variables = Record<string, unknown>;

function resolveValue(value: Value, vars: Variables): unknown {
  switch (value.kind) {
    case 'var':
      return vars[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, vars);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, vars: Variables): unknown {
  const arg = field.args.find((a) => a.name === name);
  return arg ? resolveValue(arg.value, vars) : undefined;
}

/** A typed value the executor walks: __typename + a field resolver. */
interface GObject {
  __typename: string;
  resolve: (field: string, fieldNode: FieldNode, vars: Variables) => unknown;
}

interface ExecContext {
  store: Store;
  errors: Array<{ message: string }>;
  fragments: Parser['fragments'];
}

function viewerObject(ctx: ExecContext): GObject {
  const login = ctx.store.viewerLogin ?? 'viewer';
  return {
    __typename: 'User',
    resolve: (field) => {
      if (field === 'id') return Buffer.from(`User${ctx.store.viewerId}`).toString('base64');
      if (field === 'login') return login;
      if (field === 'name') return login;
      return undefined;
    },
  };
}

function repoObject(ctx: ExecContext, repo: Repo): GObject {
  const store = ctx.store;
  return {
    __typename: 'Repository',
    resolve: (field, fieldNode, vars) => {
      switch (field) {
        case 'id':
          return repoNodeId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${store.viewerLogin ?? 'viewer'}/${repo.name}`;
        case 'owner':
          return viewerObject(ctx);
        case 'defaultBranchRef': {
          if (!repo.defaultTip()) return null;
          return {
            __typename: 'Ref',
            resolve: (f: string) => (f === 'name' ? repo.defaultBranch : f === 'prefix' ? 'refs/heads/' : undefined),
          } as GObject;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'hasWikiEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'description':
          return repo.description;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'issue': {
          const number = Number(argValue(fieldNode, 'number', vars));
          const issue = repo.issues.get(number);
          return issue && !issue.isPull ? issueObject(ctx, repo, issue) : null;
        }
        case 'issues':
          return issuesConnection(ctx, repo, fieldNode, vars);
        case 'pullRequest': {
          const number = Number(argValue(fieldNode, 'number', vars));
          const pull = repo.pulls.get(number);
          return pull ? pullObject(ctx, repo, pull) : null;
        }
        case 'pullRequests':
          return pullsConnection(ctx, repo, fieldNode, vars);
        default:
          return undefined;
      }
    },
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function issuesConnection(ctx: ExecContext, repo: Repo, fieldNode: FieldNode, vars: Variables): GObject {
  let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
  const states = argValue(fieldNode, 'states', vars) as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = argValue(fieldNode, 'orderBy', vars) as { field?: string; direction?: string } | undefined;
  const desc = orderBy?.direction === 'DESC';
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const after = argValue(fieldNode, 'after', vars) as string | undefined;
  let startIndex = 0;
  if (typeof after === 'string' && after !== '') {
    try {
      const raw = Buffer.from(after, 'base64').toString('utf8');
      const m = /^cursor:(\d+)$/.exec(raw);
      if (m) {
        const idx = list.findIndex((issue) => issue.number === Number(m[1]));
        if (idx >= 0) startIndex = idx + 1;
      }
    } catch {
      /* an opaque cursor we do not recognise: start from the beginning */
    }
  }
  const first = Number(argValue(fieldNode, 'first', vars) ?? 100);
  const page = list.slice(startIndex, startIndex + Math.max(0, first));
  const hasNext = startIndex + page.length < list.length;
  const nodes = page.map((issue) => issueObject(ctx, repo, issue));
  return {
    __typename: 'IssueConnection',
    resolve: (field) => {
      if (field === 'nodes') return nodes;
      if (field === 'totalCount') return list.length;
      if (field === 'edges') {
        return page.map((issue) => ({
          __typename: 'IssueEdge',
          resolve: (f: string) => (f === 'node' ? issueObject(ctx, repo, issue) : f === 'cursor' ? cursorFor(issue.number) : undefined),
        }));
      }
      if (field === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          resolve: (f: string) => {
            if (f === 'hasNextPage') return hasNext;
            if (f === 'hasPreviousPage') return startIndex > 0;
            if (f === 'endCursor') return page.length ? cursorFor(page[page.length - 1].number) : null;
            if (f === 'startCursor') return page.length ? cursorFor(page[0].number) : null;
            return undefined;
          },
        } as GObject;
      }
      return undefined;
    },
  };
}

function pullsConnection(ctx: ExecContext, repo: Repo, fieldNode: FieldNode, vars: Variables): GObject {
  let list = [...repo.pulls.values()];
  const states = argValue(fieldNode, 'states', vars) as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
  } else {
    list = list.filter((pull) => pull.state === 'open');
  }
  list.sort((a, b) => b.number - a.number);
  const first = Number(argValue(fieldNode, 'first', vars) ?? 100);
  const page = list.slice(0, Math.max(0, first));
  const nodes = page.map((pull) => pullObject(ctx, repo, pull));
  return {
    __typename: 'PullRequestConnection',
    resolve: (field) => {
      if (field === 'nodes') return nodes;
      if (field === 'totalCount') return list.length;
      if (field === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          resolve: (f: string) => (f === 'hasNextPage' ? list.length > page.length : f === 'hasPreviousPage' ? false : null),
        } as GObject;
      }
      return undefined;
    },
  };
}

function issueObject(ctx: ExecContext, repo: Repo, issue: Issue): GObject {
  return {
    __typename: 'Issue',
    resolve: (field) => {
      switch (field) {
        case 'id':
          return issueNodeId(issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.state === 'closed' ? issue.updatedAt : null;
        case 'author':
          return viewerObject(ctx);
        case 'repository':
          return repoObject(ctx, repo);
        default:
          return undefined;
      }
    },
  };
}

function pullObject(ctx: ExecContext, repo: Repo, pull: Pull): GObject {
  return {
    __typename: 'PullRequest',
    resolve: (field, fieldNode, vars) => {
      switch (field) {
        case 'id':
          return pullNodeId(pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeable':
          return pull.merged ? 'UNKNOWN' : pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'closedAt':
          return pull.state === 'closed' ? pull.updatedAt : null;
        case 'author':
          return viewerObject(ctx);
        case 'repository':
          return repoObject(ctx, repo);
        case 'files': {
          const files = pullFiles(repo, pull);
          const first = Number(argValue(fieldNode, 'first', vars) ?? 100);
          const page = files.slice(0, Math.max(0, first));
          return {
            __typename: 'PullRequestChangedFileConnection',
            resolve: (f: string) => {
              if (f === 'nodes') {
                return page.map((file) => ({
                  __typename: 'PullRequestChangedFile',
                  resolve: (ff: string) => {
                    if (ff === 'path') return file.filename;
                    if (ff === 'additions') return file.additions;
                    if (ff === 'deletions') return file.deletions;
                    if (ff === 'changeType') return String(file.status).toUpperCase();
                    return undefined;
                  },
                }));
              }
              if (f === 'totalCount') return files.length;
              return undefined;
            },
          } as GObject;
        }
        default:
          return undefined;
      }
    },
  };
}

function typeObject(name: string): GObject {
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  return {
    __typename: '__Type',
    resolve: (field) => {
      if (field === 'name') return name;
      if (field === 'kind') return enumValues ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        if (!fields) return null;
        return fields.map((fname) => ({
          __typename: '__Field',
          resolve: (f: string) => (f === 'name' ? fname : f === 'isDeprecated' ? false : undefined),
        }));
      }
      if (field === 'enumValues') {
        if (!enumValues) return null;
        return enumValues.map((ename) => ({
          __typename: '__EnumValue',
          resolve: (f: string) => (f === 'name' ? ename : f === 'isDeprecated' ? false : undefined),
        }));
      }
      return undefined;
    },
  };
}

function findRepo(ctx: ExecContext, owner: unknown, name: unknown): Repo | null {
  if (typeof owner === 'string' && owner !== '') ctx.store.adoptViewer(owner);
  if (typeof name !== 'string') return null;
  return ctx.store.repoFor(String(owner ?? ''), name) ?? null;
}

function executeOperation(ctx: ExecContext, operation: Operation, vars: Variables): Record<string, unknown> {
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GObject = {
    __typename: rootType,
    resolve: (field, fieldNode, v) => {
      switch (field) {
        case 'viewer':
          return viewerObject(ctx);
        case 'repository': {
          const repo = findRepo(ctx, argValue(fieldNode, 'owner', v), argValue(fieldNode, 'name', v));
          return repo ? repoObject(ctx, repo) : null;
        }
        case 'node': {
          const decoded = decodeNodeId(String(argValue(fieldNode, 'id', v) ?? ''));
          if (!decoded) return null;
          if (decoded.kind === 'Repository') {
            const repo = findRepoById(ctx.store, decoded.num);
            return repo ? repoObject(ctx, repo) : null;
          }
          if (decoded.kind === 'User') return viewerObject(ctx);
          return null;
        }
        case '__type': {
          const name = String(argValue(fieldNode, 'name', v) ?? '');
          return TYPE_FIELDS[name] || ENUM_VALUES[name] ? typeObject(name) : null;
        }
        case '__schema':
          return {
            __typename: '__Schema',
            resolve: (f: string) => (f === 'queryType' ? typeObject('Query') : f === 'mutationType' ? typeObject('Mutation') : undefined),
          } as GObject;
        case 'createIssue': {
          const input = (argValue(fieldNode, 'input', v) ?? {}) as Record<string, unknown>;
          const decoded = decodeNodeId(String(input.repositoryId ?? ''));
          const repo = decoded ? findRepoById(ctx.store, decoded.num) : undefined;
          if (!repo) throw new Error('repository not found');
          const now = ctx.store.clock.nowIso();
          const issue: Issue = {
            id: repo.nextIssueId,
            number: repo.nextIssueNumber,
            title: String(input.title ?? ''),
            body: typeof input.body === 'string' ? input.body : null,
            state: 'open',
            labels: [],
            createdAt: now,
            updatedAt: now,
            comments: [],
            isPull: false,
          };
          repo.nextIssueId += 1;
          repo.nextIssueNumber += 1;
          repo.issues.set(issue.number, issue);
          return {
            __typename: 'CreateIssuePayload',
            resolve: (f: string) => (f === 'issue' ? issueObject(ctx, repo, issue) : undefined),
          } as GObject;
        }
        case 'closeIssue': {
          const input = (argValue(fieldNode, 'input', v) ?? {}) as Record<string, unknown>;
          const decoded = decodeNodeId(String(input.issueId ?? ''));
          let found: { repo: Repo; issue: Issue } | null = null;
          if (decoded) {
            for (const repo of ctx.store.repos.values()) {
              for (const issue of repo.issues.values()) if (issue.id === decoded.num) found = { repo, issue };
            }
          }
          if (!found) throw new Error('issue not found');
          found.issue.state = 'closed';
          found.issue.updatedAt = ctx.store.clock.nowIso();
          const { repo, issue } = found;
          return {
            __typename: 'CloseIssuePayload',
            resolve: (f: string) => (f === 'issue' ? issueObject(ctx, repo, issue) : undefined),
          } as GObject;
        }
        case 'createPullRequest': {
          const input = (argValue(fieldNode, 'input', v) ?? {}) as Record<string, unknown>;
          const decoded = decodeNodeId(String(input.repositoryId ?? ''));
          const repo = decoded ? findRepoById(ctx.store, decoded.num) : undefined;
          if (!repo) throw new Error('repository not found');
          const headRef = String(input.headRefName ?? '');
          const baseRef = String(input.baseRefName ?? '');
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (!headSha || !baseSha) throw new Error('head or base ref does not exist');
          const now = ctx.store.clock.nowIso();
          const pull: Pull = {
            id: repo.nextIssueId,
            number: repo.nextIssueNumber,
            title: String(input.title ?? ''),
            body: typeof input.body === 'string' ? input.body : null,
            state: 'open',
            headRef,
            headSha,
            baseRef,
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
          return {
            __typename: 'CreatePullRequestPayload',
            resolve: (f: string) => (f === 'pullRequest' ? pullObject(ctx, repo, pull) : undefined),
          } as GObject;
        }
        case 'mergePullRequest': {
          const input = (argValue(fieldNode, 'input', v) ?? {}) as Record<string, unknown>;
          const decoded = decodeNodeId(String(input.pullRequestId ?? ''));
          let found: { repo: Repo; pull: Pull } | null = null;
          if (decoded) {
            for (const repo of ctx.store.repos.values()) {
              for (const pull of repo.pulls.values()) if (pull.id === decoded.num) found = { repo, pull };
            }
          }
          if (!found) throw new Error('pull request not found');
          const method = String(input.mergeMethod ?? 'MERGE').toUpperCase() === 'SQUASH' ? 'squash' : 'merge';
          const sha = doMerge(ctx.store, found.repo, found.pull, method);
          if (sha === null) throw new Error('pull request is not mergeable');
          const { repo, pull } = found;
          return {
            __typename: 'MergePullRequestPayload',
            resolve: (f: string) => (f === 'pullRequest' ? pullObject(ctx, repo, pull) : undefined),
          } as GObject;
        }
        case 'addComment': {
          const input = (argValue(fieldNode, 'input', v) ?? {}) as Record<string, unknown>;
          const decoded = decodeNodeId(String(input.subjectId ?? ''));
          let found: { repo: Repo; issue: Issue } | null = null;
          if (decoded) {
            for (const repo of ctx.store.repos.values()) {
              for (const issue of repo.issues.values()) if (issue.id === decoded.num) found = { repo, issue };
            }
          }
          if (!found) throw new Error('subject not found');
          const now = ctx.store.clock.nowIso();
          const comment = {
            id: found.issue.id * 100000 + found.issue.comments.length + 1,
            body: String(input.body ?? ''),
            createdAt: now,
            updatedAt: now,
          };
          found.issue.comments.push(comment);
          return {
            __typename: 'AddCommentPayload',
            resolve: (f: string) => {
              if (f === 'commentEdge') {
                return {
                  __typename: 'IssueCommentEdge',
                  resolve: (ff: string) => {
                    if (ff === 'node') {
                      return {
                        __typename: 'IssueComment',
                        resolve: (fff: string) => {
                          if (fff === 'id') return commentNodeId(comment.id);
                          if (fff === 'body') return comment.body;
                          if (fff === 'createdAt') return comment.createdAt;
                          return undefined;
                        },
                      } as GObject;
                    }
                    return undefined;
                  },
                } as GObject;
              }
              return undefined;
            },
          } as GObject;
        }
        default:
          return undefined;
      }
    },
  };
  const out: Record<string, unknown> = {};
  executeSelection(ctx, root, operation.selection, vars, out);
  return out;
}

function executeSelection(ctx: ExecContext, obj: GObject, selection: FieldNode[], vars: Variables, out: Record<string, unknown>): void {
  for (const field of selection) {
    if (field.fragmentType !== null) {
      if (field.fragmentType === obj.__typename) executeSelection(ctx, obj, field.selection ?? [], vars, out);
      continue;
    }
    if (field.fragmentName !== null) {
      const fragment = ctx.fragments.get(field.fragmentName);
      if (fragment && fragment.typeCondition === obj.__typename) executeSelection(ctx, obj, fragment.selection, vars, out);
      continue;
    }
    const key = field.alias ?? field.name;
    const known = TYPE_FIELDS[obj.__typename];
    if (known && !known.includes(field.name) && field.name !== '__typename') {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${obj.__typename}'` });
      out[key] = null;
      continue;
    }
    if (field.name === '__typename') {
      out[key] = obj.__typename;
      continue;
    }
    const value = obj.resolve(field.name, field, vars);
    out[key] = materialize(ctx, value, field, vars);
  }
}

function materialize(ctx: ExecContext, value: unknown, field: FieldNode, vars: Variables): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => materialize(ctx, item, field, vars));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const obj = value as GObject;
    const out: Record<string, unknown> = {};
    if (field.selection) executeSelection(ctx, obj, field.selection, vars, out);
    return out;
  }
  return value;
}

export interface GraphqlReply {
  status: number;
  body: unknown;
}

function executeOne(store: Store, payload: Record<string, unknown>): Record<string, unknown> {
  const query = String(payload.query ?? '');
  const vars = (payload.variables ?? {}) as Variables;
  const parser = new Parser(query);
  let operations: Operation[];
  try {
    operations = parser.parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const ctx: ExecContext = { store, errors: [], fragments: parser.fragments };
  let operation = operations[0];
  const operationName = typeof payload.operationName === 'string' ? payload.operationName : null;
  if (operationName) operation = operations.find((op) => op.name === operationName) ?? operation;
  if (!operation) return { errors: [{ message: 'no operation in document' }] };
  try {
    const data = executeOperation(ctx, operation, vars);
    const reply: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) reply.errors = ctx.errors;
    return reply;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphql(store: Store, text: string): GraphqlReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => executeOne(store, entry as Record<string, unknown>)) };
  }
  return { status: 200, body: executeOne(store, parsed as Record<string, unknown>) };
}

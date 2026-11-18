// Git object model, packfiles and the smart-HTTP protocol (upload-pack v2 and
// v0, receive-pack v0), implemented on node:crypto/node:zlib only — there is
// no git binary in the trial pod, and none is needed: the wire formats are
// small and fully deterministic.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, Repo } from './store.ts';

export const ZERO = '0'.repeat(40);
export type ObjType = GitObject['type'];
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

// ---------------------------------------------------------------- commits/trees

export interface CommitView {
  tree: string;
  parents: string[];
  message: string;
  /** Committer timestamp (seconds), 0 when unparsable. */
  time: number;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const head = text.split('\n\n', 1)[0];
  let tree = '';
  const parents: string[] = [];
  let time = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('committer ')) {
      const m = / (\d+) [+-]\d{4}$/.exec(line);
      if (m) time = Number(m[1]);
    }
  }
  const message = text.slice(head.length + 2);
  return { tree, parents, message, time };
}

/**
 * Header-only commit parse for the hot paths (fetch/push): tree and parents,
 * without slicing out the message or running the timestamp regex.
 */
export function parseCommitHead(data: Buffer): { tree: string; parents: string[] } {
  const end = data.indexOf('\n\n');
  const head = data.toString('utf8', 0, end === -1 ? data.length : end);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries by name, directories as if suffixed with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {sha, mode}. */
export function flattenTree(repo: Repo, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(repo, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** Build nested trees from a flat path -> {sha, mode} map; returns the root tree sha. */
export function buildTreeFromMap(repo: Repo, files: Map<string, { sha: string; mode: string }>): string {
  interface Node {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], { files: new Map(), dirs: new Map() });
      node = node.dirs.get(segments[i])!;
    }
    node.files.set(segments[segments.length - 1], value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, sha: value.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: build(child) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return build(root);
}

export function buildCommitData(fields: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

/** Is `ancestor` reachable from `descendant` through commit parents? */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const sha = queue.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj && obj.type === 'commit') queue.push(...parseCommitHead(obj.data).parents);
  }
  return false;
}

/**
 * The object closure for a fetch: everything reachable from `wants`, minus
 * everything reachable from `haves`, honouring a depth limit (commits at the
 * limit are included without their parents and reported as shallow).
 */
export function collectForFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowBoundary: ReadonlySet<string> = new Set(),
): { objects: string[]; shallow: string[] } {
  const haveSet = new Set<string>();
  const markHave = (sha: string): void => {
    if (haveSet.has(sha)) return;
    const obj = repo.objects.get(sha);
    if (!obj) return;
    haveSet.add(sha);
    if (obj.type === 'commit') {
      const commit = parseCommitHead(obj.data);
      markHave(commit.tree);
      // A commit on the client's shallow boundary is had, but its parents
      // are not: the client's clone was cut there.
      if (!shallowBoundary.has(sha)) {
        for (const parent of commit.parents) markHave(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) markHave(entry.sha);
    } else if (obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (target) markHave(target[1]);
    }
  };
  for (const have of haves) markHave(have);

  const out: string[] = [];
  const included = new Set<string>();
  const shallow: string[] = [];
  const include = (sha: string): boolean => {
    if (included.has(sha) || haveSet.has(sha)) return false;
    if (!repo.objects.has(sha)) return false;
    included.add(sha);
    out.push(sha);
    return true;
  };
  // Breadth-first over commits so depth is the shortest distance from a want.
  const commitDepth = new Map<string, number>();
  let frontier: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'commit') {
      if (!commitDepth.has(want)) {
        commitDepth.set(want, 0);
        frontier.push(want);
      }
    } else {
      // A tree/blob/tag want: include it and its closure without depth limits.
      const stack = [want];
      while (stack.length) {
        const sha = stack.pop()!;
        if (!include(sha)) continue;
        const o = repo.objects.get(sha)!;
        if (o.type === 'tree') for (const entry of parseTree(o.data)) stack.push(entry.sha);
        else if (o.type === 'tag') {
          const target = /^object ([0-9a-f]{40})/m.exec(o.data.toString('utf8'));
          if (target) stack.push(target[1]);
        } else if (o.type === 'commit') {
          const commit = parseCommitHead(o.data);
          stack.push(commit.tree, ...commit.parents);
        }
      }
    }
  }
  const includeTreeOf = (commitSha: string): void => {
    const commit = parseCommitHead(repo.objects.get(commitSha)!.data);
    const stack = [commit.tree];
    while (stack.length) {
      const sha = stack.pop()!;
      if (!include(sha)) continue;
      const o = repo.objects.get(sha)!;
      if (o.type === 'tree') for (const entry of parseTree(o.data)) stack.push(entry.sha);
    }
  };
  while (frontier.length) {
    const next: string[] = [];
    for (const sha of frontier) {
      // A want may also be a have (a deepen request names its own tip):
      // the object is excluded from the pack, but the walk still descends
      // from it, because depth counts from the want.
      include(sha);
      includeTreeOf(sha);
      const commit = parseCommitHead(repo.objects.get(sha)!.data);
      const d = commitDepth.get(sha)!;
      if (depth !== null && d >= depth - 1) {
        if (commit.parents.length > 0 && depth !== null) shallow.push(sha);
        continue;
      }
      for (const parent of commit.parents) {
        if (!commitDepth.has(parent)) {
          commitDepth.set(parent, d + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return { objects: out, shallow };
}

// ---------------------------------------------------------------- packfiles

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A pack of full (undeltified) objects: always valid, and fast to build. */
export function writePack(repo: Repo, shas: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { offset |= delta[pos] << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { size |= delta[pos] << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  void produced;
  return result;
}

/** Parse a pack into the repo store; returns the object ids it carried. */
export function readPackInto(repo: Repo, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack');
  }
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const byOffset = new Map<number, string>();
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const start = pos;
    let byte = pack[pos];
    pos += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (code === 6) {
      // OFS_DELTA: negative offset varint to the base object's start.
      let offsetByte = pack[pos];
      pos += 1;
      let offset = offsetByte & 0x7f;
      while (offsetByte & 0x80) {
        offsetByte = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (offsetByte & 0x7f);
      }
      const baseSha = byOffset.get(start - offset);
      if (baseSha === undefined) throw new Error('ofs-delta base missing');
      const inflated = inflateSync(pack.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      pos += inflated.engine.bytesWritten;
      const base = repo.objects.get(baseSha);
      if (!base) throw new Error('ofs-delta base not in store');
      const data = applyDelta(base.data, inflated.buffer);
      const sha = storeObject(repo, base.type, data);
      byOffset.set(start, sha);
      ids.push(sha);
    } else if (code === 7) {
      // REF_DELTA: base named by id (may already be in the store: a thin pack).
      const baseSha = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const inflated = inflateSync(pack.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      pos += inflated.engine.bytesWritten;
      const base = repo.objects.get(baseSha);
      if (!base) throw new Error('ref-delta base not in store');
      const data = applyDelta(base.data, inflated.buffer);
      const sha = storeObject(repo, base.type, data);
      byOffset.set(start, sha);
      ids.push(sha);
    } else {
      const type = CODE_TYPE[code];
      if (type === undefined) throw new Error(`bad pack object code ${code}`);
      const inflated = inflateSync(pack.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      pos += inflated.engine.bytesWritten;
      void size;
      const sha = storeObject(repo, type, inflated.buffer);
      byOffset.set(start, sha);
      ids.push(sha);
    }
  }
  return ids;
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Split a request body into pkt-lines plus the raw remainder (a pack, for pushes). */
export function splitPktLines(body: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const head = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(pos + 4, pos + length) });
    pos += length;
    // After a flush the rest is raw (the packfile in a push).
    if (packets.length > 0 && packets[packets.length - 1].kind === 'flush') break;
  }
  return { packets, rest: body.subarray(pos) };
}

/** Parse a pkt-line stream that is entirely framed (protocol v2 requests). */
export function parsePktStream(body: Buffer): { args: string[]; sections: string[][] } {
  const { packets } = splitPktLines(body);
  const args: string[] = [];
  const sections: string[][] = [];
  let current: string[] = args;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      current = [];
      sections.push(current);
    } else if (packet.kind === 'data') {
      current.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  return { args, sections };
}

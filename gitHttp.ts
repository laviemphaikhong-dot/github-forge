// Smart-HTTP endpoints: GET info/refs and POST git-upload-pack /
// git-receive-pack for /{owner}/{repo}.git. Upload-pack speaks protocol v2
// when the client asks for it (Git-Protocol: version=2) and v0 otherwise;
// receive-pack is v0 only, as the suite's client requires.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { invalidateRepo, type Repo, type Store } from './store.ts';
import {
  ZERO,
  collectForFetch,
  isAncestor,
  parseCommit,
  parsePktStream,
  pktLine,
  PKT_DELIM,
  PKT_FLUSH,
  readPackInto,
  splitPktLines,
  writePack,
} from './git.ts';

const AGENT = 'makefun-forge/1.0';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  send(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

export function readBody(req: IncomingMessage, cap = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Refs in advertisement order: HEAD first, then heads, tags, others sorted. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  const names = [...repo.refs.keys()].sort();
  return names.map((name) => [name, repo.refs.get(name)!] as [string, string]);
}

function peeledOf(repo: Repo, sha: string): string | null {
  let current = sha;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
    if (!m) return null;
    current = m[1];
  }
  return null;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const capList =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${headTarget(repo)}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headSha = repo.defaultTip();
  const lines: string[] = [];
  if (headSha) lines.push(`${headSha} HEAD`);
  else lines.push(`${ZERO} capabilities^{}`);
  for (const [name, sha] of refs) {
    lines.push(`${sha} ${name}`);
    const peeled = peeledOf(repo, sha);
    if (peeled && peeled !== sha) lines.push(`${peeled} ${name}^{}`);
  }
  lines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${capList}\n` : `${line}\n`));
  });
  if (!headSha && refs.length === 0) {
    // The capabilities^{} line already went out as the first (and only) line.
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 advertisement never changes: build it once. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  ...[
    'version 2',
    `agent=${AGENT}`,
    'ls-refs=unborn',
    'fetch=shallow',
    'object-format=sha1',
  ].map((line) => pktLine(`${line}\n`)),
  PKT_FLUSH,
]);

function v2Advertisement(service: string): Buffer {
  if (service !== 'git-upload-pack') return v2ReceiveAdvertisement();
  return V2_ADVERTISEMENT;
}

function v2ReceiveAdvertisement(): Buffer {
  // The suite's client never requests v2 for receive-pack; answer v0-shaped
  // callers by falling back in the handler. This is unreachable in practice.
  const lines = ['version 2', `agent=${AGENT}`, 'object-format=sha1'];
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

export function handleInfoRefs(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string): void {
  const repo = store.repoFor(owner, repoName);
  if (!repo) {
    sendText(res, 404, 'repository not found\n');
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendText(res, 400, 'unknown service\n');
    return;
  }
  store.adoptViewer(owner);
  const wantsV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
  const body = service === 'git-upload-pack' && wantsV2 ? v2Advertisement(service) : v0Advertisement(repo, service);
  send(res, 200, `application/x-${service}-advertisement`, body);
}

// ------------------------------------------------------------------ ls-refs

function handleLsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  const cacheKey = `${repo.version}|${args.join('|')}`;
  const cached = repo.lsRefsCache.get(cacheKey);
  if (cached) {
    send(res, 200, 'application/x-git-upload-pack-result', cached);
    return;
  }
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headSha = repo.defaultTip();
  if (keep('HEAD')) {
    if (headSha) {
      parts.push(pktLine(`${headSha} HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    }
  }
  for (const [name, sha] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${sha} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, sha);
      if (peeled && peeled !== sha) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (repo.lsRefsCache.size > 32) repo.lsRefsCache.clear();
  repo.lsRefsCache.set(cacheKey, body);
  send(res, 200, 'application/x-git-upload-pack-result', body);
}

// ------------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowIn: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
  filter: string | null;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallowIn: [], depth: null, deepenSince: null, deepenNot: [], done: false, filter: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallowIn.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.depth = Number(arg.slice(7));
    else if (arg.startsWith('deepen-since ')) out.deepenSince = Number(arg.slice(13));
    else if (arg.startsWith('deepen-not ')) out.deepenNot.push(arg.slice(11).trim());
    else if (arg === 'done') out.done = true;
    else if (arg.startsWith('filter ')) out.filter = arg.slice(7);
  }
  return out;
}

/** Sideband-framed pack packets: band 1 chunks of at most 65520-4-1 bytes. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65520 - 5;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function fetchPack(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[] } {
  const cacheKey = JSON.stringify([args.wants, args.haves, args.depth, args.shallowIn]);
  const boundary = new Set(args.shallowIn);
  const cached = repo.packCache.get(cacheKey);
  if (cached) {
    const shallow = collectForFetch(repo, args.wants, args.haves, args.depth, boundary).shallow;
    return { pack: cached, shallow };
  }
  const { objects, shallow } = collectForFetch(repo, args.wants, args.haves, args.depth, boundary);
  const pack = writePack(repo, objects);
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(cacheKey, pack);
  return { pack, shallow };
}

function handleFetchV2(repo: Repo, args: FetchArgs, res: ServerResponse): void {
  const parts: Buffer[] = [];
  if (!args.done) {
    // Negotiation round: acknowledge the haves we hold, then say ready when
    // every want is already reachable, else NAK.
    parts.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const have of args.haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have} common\n`));
        acked = true;
      }
    }
    const allWantsKnown = args.wants.every((want) => repo.objects.has(want));
    if (allWantsKnown && args.wants.length > 0) parts.push(pktLine('ready\n'));
    else if (!acked) parts.push(pktLine('NAK\n'));
    parts.push(PKT_FLUSH);
    send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  const { pack, shallow } = fetchPack(repo, args);
  if (args.depth !== null || args.shallowIn.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetchV0(repo: Repo, args: FetchArgs, res: ServerResponse): void {
  const parts: Buffer[] = [];
  const { pack, shallow } = fetchPack(repo, args);
  for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
  let ack: string | null = null;
  for (const have of args.haves) if (repo.objects.has(have)) ack = have;
  parts.push(pktLine(ack ? `ACK ${ack}\n` : 'NAK\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

export async function handleUploadPack(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  const repo = store.repoFor(owner, repoName);
  if (!repo) {
    sendText(res, 404, 'repository not found\n');
    return;
  }
  store.adoptViewer(owner);
  const body = await readBody(req);
  const { args, sections } = parsePktStream(body);
  const commandLine = args.find((line) => line.startsWith('command='));
  const command = commandLine ? commandLine.slice('command='.length) : '';
  const argLines = sections.length ? sections[sections.length - 1] : [];
  if (command === 'ls-refs') {
    handleLsRefs(repo, argLines, res);
    return;
  }
  if (command === 'fetch') {
    handleFetchV2(repo, parseFetchArgs(argLines), res);
    return;
  }
  // No command line: a protocol v0 fetch request.
  const v0Args = parseFetchArgs([...args, ...sections.flat()]);
  // v0 wants carry capabilities on the first want line; strip them.
  v0Args.wants = v0Args.wants.map((want) => want.split(' ')[0]);
  handleFetchV0(repo, v0Args, res);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldSha: string;
  newSha: string;
  ref: string;
  caps: string;
}

export async function handleReceivePack(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  const repo = store.repoFor(owner, repoName);
  if (!repo) {
    sendText(res, 404, 'repository not found\n');
    return;
  }
  store.adoptViewer(owner);
  const body = await readBody(req);
  const { packets, rest } = splitPktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    let caps = '';
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const [oldSha, newSha, ref] = line.split(' ');
    if (oldSha && newSha && ref) commands.push({ oldSha, newSha, ref, caps });
  }
  const capSet = new Set((commands[0]?.caps ?? '').split(' ').filter(Boolean));
  const wantsReport = capSet.has('report-status') || capSet.has('report-status-v2');
  const sideband = capSet.has('side-band-64k');

  let unpackOk = true;
  let unpackError = '';
  if (rest.length > 0) {
    try {
      readPackInto(repo, rest);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const wasEmpty = repo.refs.size === 0;
  let firstHead: string | null = null;
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newSha === ZERO) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
        } else if (current !== command.oldSha) {
          results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        } else {
          repo.refs.delete(command.ref);
          invalidateRepo(repo);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newSha)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
        continue;
      }
      if (command.oldSha === ZERO) {
        if (current !== undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'reference already exists' });
          continue;
        }
      } else {
        if (current !== command.oldSha) {
          results.push({ ref: command.ref, ok: false, reason: 'stale info' });
          continue;
        }
        // Every update must fast-forward.
        const newObj = repo.objects.get(command.newSha);
        if (newObj && newObj.type === 'commit' && !isAncestor(repo, command.oldSha, command.newSha)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(command.ref, command.newSha);
      invalidateRepo(repo);
      if (firstHead === null && command.ref.startsWith('refs/heads/')) firstHead = command.ref;
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  // An empty repository takes its default branch from its first pushed
  // branch, as GitHub does: the suite's fixture pushes the scenario's
  // default branch first and reads defaultBranchRef back.
  if (wasEmpty && firstHead !== null) {
    repo.defaultBranch = firstHead.slice('refs/heads/'.length);
  }

  if (!wantsReport) {
    send(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportLines: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError || 'error'}\n`)];
  if (unpackOk) {
    for (const result of results) {
      reportLines.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
    }
  }
  reportLines.push(PKT_FLUSH);
  const report = Buffer.concat(reportLines);
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65520 - 5;
    for (let i = 0; i < report.length; i += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(i, Math.min(report.length, i + CHUNK))])));
    }
    parts.push(PKT_FLUSH);
    send(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
  } else {
    send(res, 200, 'application/x-git-receive-pack-result', report);
  }
}

export function parseCommitMessage(repo: Repo, sha: string): string {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommit(obj.data).message;
}

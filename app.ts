// The HTTP server: routing, auth, JSON bodies, and git smart HTTP.
// main.ts owns the lifecycle (bind, register, poll /done); this file owns the
// surfaces the suite drives.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER_LOGIN } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  pktLine,
  parsePktLines,
  parsePktLinesUntilFlush,
  pktTextLines,
  parsePack,
  buildPack,
  sidebandPackets,
  parseTag,
  ZERO_OID,
  isOid,
  PKT_DELIM,
  PKT_FLUSH,
  type GitObject,
} from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function bearerToken(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  return m ? (m[1] as string) : '';
}

/** The token the entry was given (empty when the harness gave none). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  const got = bearerToken(req);
  if (got === '') return false;
  if (expected === '') return true;
  return got === expected;
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp(forge: Forge = new Forge()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const query = queryOf(req);

      // Boot probe: no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Everything else needs the bearer token.
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }

      const body = await readBody(req).catch(() => null);
      if (body === null) {
        sendJson(res, 400, { message: 'could not read request body' });
        return;
      }

      // GraphQL v4.
      if (method === 'POST' && path === '/api/graphql') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'request body is not valid JSON' });
          return;
        }
        try {
          sendJson(res, 200, handleGraphql(forge, parsed.value));
        } catch (e) {
          sendJson(res, 200, { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] });
        }
        return;
      }

      // MCP.
      if (path === '/mcp') {
        if (method === 'DELETE') {
          res.writeHead(202, { 'x-github-request-id': nextRequestId() });
          res.end();
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const result = handleMcp(forge, body);
        if (result.body === null) {
          res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
        const segments = restPath
          .split('/')
          .filter((s) => s !== '')
          .map((s) => {
            try {
              return decodeURIComponent(s);
            } catch {
              return s;
            }
          });
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'request body is not valid JSON' });
          return;
        }
        const result = handleRest(forge, {
          method,
          segments,
          query,
          json: parsed.value,
          body,
          host: req.headers.host ?? 'localhost',
        });
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, result.headers);
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/...
      const gitMatch = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(.+)$/.exec(path);
      if (gitMatch) {
        const owner = gitMatch[1] as string;
        const repoName = gitMatch[2] as string;
        const rest = gitMatch[3] as string;
        const repo = forge.getRepo(owner, repoName);
        if (!repo || owner !== VIEWER_LOGIN) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        try {
          if (method === 'GET' && rest === 'info/refs') {
            handleInfoRefs(forge, repo, req, res, query);
            return;
          }
          if (method === 'POST' && rest === 'git-upload-pack') {
            handleUploadPack(forge, repo, req, res, body);
            return;
          }
          if (method === 'POST' && rest === 'git-receive-pack') {
            handleReceivePack(forge, repo, req, res, body);
            return;
          }
        } catch (e) {
          sendJson(res, 400, { message: e instanceof Error ? e.message : String(e) });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    })().catch((e: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: e instanceof Error ? e.message : String(e) });
      } else {
        res.end();
      }
    });
  });
}

// ---------------------------------------------------------------- git helpers

function gitHeaders(service: 'upload-pack' | 'receive-pack', kind: 'advertisement' | 'result'): string {
  return `application/x-git-${service}-${kind}`;
}

function refLines(forge: Forge, repo: Forge['repos'] extends Map<string, infer V> ? V : never, caps: string, withHead: boolean): Buffer[] {
  const lines: Buffer[] = [];
  const refs = forge.allRefs(repo);
  const entries = [...refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const mainTip = repo.refs.get('main') ?? '';
  let first = true;
  const emit = (oid: string, ref: string): void => {
    const suffix = first && caps !== '' ? `\0${caps}` : '';
    lines.push(pktLine(`${oid} ${ref}${suffix}\n`));
    first = false;
  };
  if (withHead && mainTip !== '' && isOid(mainTip)) {
    emit(mainTip, 'HEAD');
  }
  for (const [ref, oid] of entries) {
    emit(oid, ref);
    // Peeled line for annotated tags.
    if (ref.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        lines.push(pktLine(`${parseTag(obj.content).object} ${ref}^{}\n`));
      }
    }
  }
  if (entries.length === 0 && (!withHead || mainTip === '')) {
    emit(ZERO_OID, 'capabilities^{}');
  }
  return lines;
}

function handleInfoRefs(
  forge: Forge,
  repo: Parameters<typeof refLines>[1],
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): void {
  const service = query.get('service') ?? '';
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      const parts: Buffer[] = [
        pktLine('version 2\n'),
        pktLine('ls-refs=unborn\n'),
        pktLine('fetch=shallow filter\n'),
        pktLine('object-format=sha1\n'),
        pktLine('agent=makefun-forge/1.0\n'),
        PKT_FLUSH,
      ];
      sendBytes(res, 200, Buffer.concat(parts), gitHeaders('upload-pack', 'advertisement'));
      return;
    }
    const caps = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=makefun-forge/1.0';
    const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH, ...refLines(forge, repo, caps, true), PKT_FLUSH];
    sendBytes(res, 200, Buffer.concat(parts), gitHeaders('upload-pack', 'advertisement'));
    return;
  }
  if (service === 'git-receive-pack') {
    const caps = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';
    const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH, ...refLines(forge, repo, caps, false), PKT_FLUSH];
    sendBytes(res, 200, Buffer.concat(parts), gitHeaders('receive-pack', 'advertisement'));
    return;
  }
  sendJson(res, 400, { message: `unknown service ${service}` });
}

// ---------------------------------------------------------------- upload-pack

function handleUploadPack(
  forge: Forge,
  repo: Parameters<typeof refLines>[1],
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    handleUploadPackV2(forge, repo, res, body);
  } else {
    handleUploadPackV0(forge, repo, res, body);
  }
}

function handleUploadPackV2(forge: Forge, repo: Parameters<typeof refLines>[1], res: ServerResponse, body: Buffer): void {
  const packets = parsePktLines(body);
  let i = 0;
  let command = '';
  const args: string[] = [];
  for (; i < packets.length; i += 1) {
    const p = packets[i] as { kind: string; payload: Buffer };
    if (p.kind === 'delim') {
      i += 1;
      break;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) command = line.slice('command='.length);
  }
  for (; i < packets.length; i += 1) {
    const p = packets[i] as { kind: string; payload: Buffer };
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    args.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (command === 'ls-refs') {
    handleLsRefs(forge, repo, res, args);
    return;
  }
  if (command === 'fetch') {
    handleFetch(forge, repo, res, args, 2);
    return;
  }
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

function handleLsRefs(forge: Forge, repo: Parameters<typeof refLines>[1], res: ServerResponse, args: string[]): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: string[] = [];
  const mainTip = repo.refs.get('main') ?? '';
  const refs = forge.allRefs(repo);
  if (mainTip !== '' && isOid(mainTip)) {
    if (keep('HEAD')) {
      out.push(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  } else if (unborn && keep('refs/heads/main')) {
    out.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  }
  const sorted = [...refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [ref, oid] of sorted) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel && ref.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') line += ` peeled:${parseTag(obj.content).object}`;
    }
    out.push(`${line}\n`);
  }
  const parts: Buffer[] = out.map((l) => pktLine(l));
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, Buffer.concat(parts), gitHeaders('upload-pack', 'result'));
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
  wantRefs: string[];
  deepenRelative: boolean;
}

function parseFetchArgs(args: string[]): FetchPlan {
  const plan: FetchPlan = { wants: [], haves: [], shallowBoundaries: [], depth: null, wantRefs: [], deepenRelative: false };
  for (const line of args) {
    if (line.startsWith('want ')) plan.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.depth = Number(line.slice(7).trim());
    else if (line.startsWith('want-ref ')) plan.wantRefs.push(line.slice(9).trim());
    else if (line === 'deepen-relative') plan.deepenRelative = true;
    // thin-pack, no-progress, ofs-delta, filter, done, agent, object-format: ignored.
  }
  return plan;
}

function planPack(
  forge: Forge,
  repo: Parameters<typeof refLines>[1],
  plan: FetchPlan,
): { objects: GitObject[]; shallow: string[]; unshallow: string[]; acks: string[] } {
  const wants = plan.wants.filter((w) => isOid(w) && forge.getObject(repo, w) !== undefined);
  const haves = plan.haves.filter((h) => isOid(h));
  if (wants.length === 0) return { objects: [], shallow: [], unshallow: [], acks: [] };
  // ACKs need the common base even for shallow fetches (real git expects
  // ACK + ready, not NAK, when the haves are ancestors of the wants).
  const acks = forge.commonHaves(repo, wants, haves);
  if (plan.depth !== null && Number.isFinite(plan.depth) && plan.depth > 0) {
    // `deepen-relative` (real git --deepen): the deepen value counts from the
    // current shallow boundary, so the absolute depth is the boundary's
    // distance from the wants plus the requested deepen.
    let depth = plan.depth;
    if (plan.deepenRelative && plan.shallowBoundaries.length > 0) {
      const base = forge.depthOfBoundary(repo, wants, plan.shallowBoundaries);
      if (base > 0) depth = base + plan.depth;
    }
    const { objects, shallow, commits } = forge.shallowWalk(repo, wants, haves, depth, plan.shallowBoundaries);
    // A previous boundary that is now inside the walked range stops being
    // shallow (real git reports it as unshallow even though it is not in
    // the pack — the client already holds it).
    const commitSet = new Set(commits);
    const unshallow = plan.shallowBoundaries.filter((b) => commitSet.has(b) && !shallow.includes(b));
    return { objects: [...objects.values()], shallow, unshallow, acks };
  }
  const objects = forge.newObjects(repo, wants, haves);
  return { objects: [...objects.values()], shallow: [], unshallow: [], acks };
}

function packResponse(
  forge: Forge,
  repo: Parameters<typeof refLines>[1],
  plan: FetchPlan,
  protocol: 0 | 2,
  res: ServerResponse,
): void {
  const { objects, shallow, unshallow, acks } = planPack(forge, repo, plan);
  const pack = objects.length > 0 ? buildPack(objects) : null;
  if (protocol === 2) {
    const parts: Buffer[] = [];
    // The acknowledgments section only exists when the client negotiated
    // with 'have' lines; a no-haves fetch (clone) has nothing to ack, and
    // real git rejects an acknowledgments section in that position.
    if (plan.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      if (acks.length > 0) {
        for (const a of acks) parts.push(pktLine(`ACK ${a}\n`));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      // 'ready' tells the client the server is done negotiating and more
      // sections (shallow-info / packfile) follow; without it git expects
      // the response to end right after the acknowledgments section.
      parts.push(pktLine('ready\n'));
      // Protocol v2 sections are separated by delimiter packets (0001); a
      // flush packet (0000) ends the whole response.
      parts.push(PKT_DELIM);
    }
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
      parts.push(PKT_DELIM);
    }
    const refs = forge.allRefs(repo);
    const wantedLines: string[] = [];
    // wanted-refs is only sent when the client asked for it (want-ref lines);
    // real git rejects an unsolicited wanted-refs section.
    for (const wantRef of plan.wantRefs) {
      const oid = refs.get(wantRef) ?? (wantRef === 'HEAD' ? repo.refs.get('main') ?? '' : '');
      if (oid !== '') wantedLines.push(`${oid} ${wantRef}\n`);
    }
    if (wantedLines.length > 0) {
      parts.push(pktLine('wanted-refs\n'));
      for (const l of wantedLines) parts.push(pktLine(l));
      parts.push(PKT_DELIM);
    }
    if (pack) {
      parts.push(pktLine('packfile\n'));
      for (const p of sidebandPackets(pack, 1)) parts.push(p);
      parts.push(PKT_FLUSH);
    }
    sendBytes(res, 200, Buffer.concat(parts), gitHeaders('upload-pack', 'result'));
    return;
  }
  // Protocol v0: ACK/NAK + shallow lines, then sideband pack.
  const parts: Buffer[] = [];
  if (acks.length > 0) {
    for (const a of acks) parts.push(pktLine(`ACK ${a}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  if (pack) {
    for (const p of sidebandPackets(pack, 1)) parts.push(p);
  }
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, Buffer.concat(parts), gitHeaders('upload-pack', 'result'));
}

function handleFetch(
  forge: Forge,
  repo: Parameters<typeof refLines>[1],
  res: ServerResponse,
  args: string[],
  protocol: 0 | 2,
): void {
  const plan = parseFetchArgs(args);
  packResponse(forge, repo, plan, protocol, res);
}

function handleUploadPackV0(forge: Forge, repo: Parameters<typeof refLines>[1], res: ServerResponse, body: Buffer): void {
  // Two sections: wants (+ shallow/deepen), flush, then haves + done, flush.
  const first = parsePktLinesUntilFlush(body);
  const wantsLines = pktTextLines(first.packets);
  const rest = body.subarray(first.consumed);
  const second = parsePktLinesUntilFlush(rest);
  const haveLines = pktTextLines(second.packets);
  const plan = parseFetchArgs([...wantsLines, ...haveLines]);
  packResponse(forge, repo, plan, 0, res);
}

// ---------------------------------------------------------------- receive-pack

function handleReceivePack(
  forge: Forge,
  repo: Parameters<typeof refLines>[1],
  _req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  const first = parsePktLinesUntilFlush(body);
  const lines = pktTextLines(first.packets);
  const packBytes = body.subarray(first.consumed);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const line of lines) {
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid)) throw new Error('bad object id in receive-pack command');
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack got no commands');
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const objects = parsePack(packBytes, (oid) => forge.getObject(repo, oid));
        for (const [oid, obj] of objects) {
          if (!forge.getObject(repo, oid)) {
            repo.objects.set(oid, obj);
          }
        }
      } catch (e) {
        unpackOk = false;
        unpackDetail = e instanceof Error ? e.message : 'unpacker error';
      }
    }
  }
  const report: string[] = [];
  if (unpackOk) {
    report.push('unpack ok\n');
  } else {
    report.push(`unpack ${unpackDetail}\n`);
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpacker error\n`);
      continue;
    }
    const result = applyCommand(forge, repo, cmd);
    if (result.ok) report.push(`ok ${cmd.ref}\n`);
    else report.push(`ng ${cmd.ref} ${result.reason}\n`);
  }
  const reportStream = Buffer.concat([...report.map((l) => pktLine(l)), PKT_FLUSH]);
  const parts: Buffer[] = [...sidebandPackets(reportStream, 1), PKT_FLUSH];
  sendBytes(res, 200, Buffer.concat(parts), gitHeaders('receive-pack', 'result'));
}

function applyCommand(
  forge: Forge,
  repo: Parameters<typeof refLines>[1],
  cmd: { oldOid: string; newOid: string; ref: string },
): { ok: boolean; reason: string } {
  if (!cmd.ref.startsWith('refs/') || cmd.ref.length > 200 || /[\s\x00-\x1f]/.test(cmd.ref)) {
    return { ok: false, reason: 'invalid ref' };
  }
  if (cmd.ref.startsWith('refs/heads/')) {
    const branch = cmd.ref.slice('refs/heads/'.length);
    const current = repo.refs.get(branch) ?? '';
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
      repo.refs.delete(branch);
      return { ok: true, reason: '' };
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== '') return { ok: false, reason: 'already exists' };
      if (!forge.getObject(repo, cmd.newOid)) return { ok: false, reason: 'object not found' };
      repo.refs.set(branch, cmd.newOid);
      return { ok: true, reason: '' };
    }
    // Update: must be a fast-forward from the advertised old value.
    if (current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
    if (!forge.getObject(repo, cmd.newOid)) return { ok: false, reason: 'object not found' };
    if (!forge.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.set(branch, cmd.newOid);
    return { ok: true, reason: '' };
  }
  if (cmd.ref.startsWith('refs/tags/')) {
    const tag = cmd.ref.slice('refs/tags/'.length);
    const current = repo.tags.get(tag) ?? '';
    if (cmd.newOid === ZERO_OID) {
      if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
      repo.tags.delete(tag);
      return { ok: true, reason: '' };
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== '') return { ok: false, reason: 'already exists' };
      if (!forge.getObject(repo, cmd.newOid)) return { ok: false, reason: 'object not found' };
      repo.tags.set(tag, cmd.newOid);
      return { ok: true, reason: '' };
    }
    if (current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
    repo.tags.set(tag, cmd.newOid);
    return { ok: true, reason: '' };
  }
  return { ok: false, reason: 'invalid ref' };
}

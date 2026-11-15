// Git primitives: object ids, zlib objects, packfiles, pkt-lines and deltas.
// Standard library only. No git binary, no network, no clock.
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The object id of a git object: sha1("<type> <size>\0" + content). */
export function objectId(type: string, content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, content]));
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  content: Buffer;
}

/** Parse a commit's tree line and parent lines. */
export function parseCommit(content: Buffer): { tree: string; parents: string[]; message: string } {
  const text = content.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries (already in git sort order). */
export function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < content.length) {
    const space = content.indexOf(0x20, i);
    const nul = content.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > content.length) break;
    const mode = content.subarray(i, space).toString('ascii');
    const name = content.subarray(space + 1, nul).toString('utf8');
    const oid = content.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (caller keeps git sort order). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree sort order: entries compare by name, directories as name + '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (e: TreeEntry): string => (e.mode === '40000' ? `${e.name}/` : e.name);
  return entries.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Parse a tag object: the object it points at. */
export function parseTag(content: Buffer): { object: string; type: string; tag: string } {
  const text = content.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

// ---------------------------------------------------------------- pkt-line

/** Encode one pkt-line (data must already end with '\n' when it is a line). */
export function pktLine(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

/** Encode a list of lines as pkt-lines, with a trailing flush. */
export function pktLines(lines: string[]): Buffer {
  const parts: Buffer[] = lines.map((l) => pktLine(l));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/**
 * Split a buffer into pkt-line packets. Throws on a bad length, a truncated
 * packet, or trailing bytes that do not parse.
 */
export function parsePktLines(buf: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (hex === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (hex === '0002') {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || len > 65520 || i + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return packets;
}

/** Split a buffer into pkt-line packets, stopping at the first flush. Returns packets and bytes consumed. */
export function parsePktLinesUntilFlush(buf: Buffer): { packets: PktPacket[]; consumed: number } {
  const packets: PktPacket[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, consumed: i + 4 };
    }
    if (hex === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (hex === '0002') {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || len > 65520 || i + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  throw new Error('pkt-line stream ended without flush');
}

/** The text lines (without trailing newline) of data packets, in order. */
export function pktTextLines(packets: PktPacket[]): string[] {
  const out: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    out.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

// ---------------------------------------------------------------- deltas

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= buf.length) throw new Error('truncated delta varint');
    const byte = buf[i] ?? 0;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    i += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** Apply a git delta to a base object, returning the result bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const baseSize = readVarint(delta, 0);
  const resultSize = readVarint(delta, baseSize.next);
  if (baseSize.value !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  let i = resultSize.next;
  while (i < delta.length) {
    const op = delta[i] ?? 0;
    i += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) {
        offset = delta[i] ?? 0;
        i += 1;
      }
      if ((op & 0x02) !== 0) {
        offset |= (delta[i] ?? 0) << 8;
        i += 1;
      }
      if ((op & 0x04) !== 0) {
        offset |= (delta[i] ?? 0) << 16;
        i += 1;
      }
      if ((op & 0x08) !== 0) {
        offset |= (delta[i] ?? 0) << 24;
        i += 1;
      }
      if ((op & 0x10) !== 0) {
        size = delta[i] ?? 0;
        i += 1;
      }
      if ((op & 0x20) !== 0) {
        size |= (delta[i] ?? 0) << 8;
        i += 1;
      }
      if ((op & 0x40) !== 0) {
        size |= (delta[i] ?? 0) << 16;
        i += 1;
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      const chunk = base.subarray(offset, offset + size);
      out.push(chunk);
      total += chunk.length;
    } else if (op !== 0) {
      if (i + op > delta.length) throw new Error('delta insert out of range');
      const chunk = delta.subarray(i, i + op);
      out.push(chunk);
      total += chunk.length;
      i += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  if (total !== resultSize.value) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Parse a packfile, resolving deltas against `resolveBase` (local store + in-pack objects). */
export function parsePack(
  buf: Buffer,
  resolveBase: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  // First pass: read raw entries in order (offsets matter for OFS_DELTA).
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer; // inflated payload
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  let i = 12;
  for (let n = 0; n < count; n += 1) {
    const start = i;
    if (i >= buf.length) throw new Error('pack truncated');
    let byte = buf[i] ?? 0;
    i += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (i >= buf.length) throw new Error('pack truncated in size varint');
      byte = buf[i] ?? 0;
      i += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      if (i >= buf.length) throw new Error('pack truncated in ofs base');
      let b = buf[i] ?? 0;
      i += 1;
      let off = b & 0x7f;
      while ((b & 0x80) !== 0) {
        if (i >= buf.length) throw new Error('pack truncated in ofs base');
        b = buf[i] ?? 0;
        i += 1;
        off = ((off + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - off;
    } else if (typeCode === 7) {
      if (i + 20 > buf.length) throw new Error('pack truncated in ref base');
      baseOid = buf.subarray(i, i + 20).toString('hex');
      i += 20;
    }
    // The zlib stream's length: inflateSync ignores trailing bytes, so the
    // smallest prefix that inflates to the expected size is the stream's end.
    const input = buf.subarray(i);
    let lo = 0;
    let hi = input.length;
    let inflated: Buffer | undefined;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      try {
        const out = inflateSync(input.subarray(0, mid));
        if (out.length === size) {
          hi = mid;
          inflated = out;
        } else {
          lo = mid + 1;
        }
      } catch {
        lo = mid + 1;
      }
    }
    if (inflated === undefined || inflated.length !== size) {
      throw new Error('pack zlib stream did not inflate to declared size');
    }
    const consumed = lo;
    raw.push({ offset: start, typeCode, size, data: inflated, baseOffset, baseOid });
    i += consumed;
  }
  // Trailer: 20 bytes of sha1 over everything before it.
  if (i + 20 !== buf.length) throw new Error('pack has stray bytes before trailer');
  const trailer = buf.subarray(i, i + 20).toString('hex');
  if (trailer !== sha1Hex(buf.subarray(0, i))) throw new Error('pack trailer checksum mismatch');
  // Resolve entries (deltas may reference earlier entries by offset or any oid).
  const byOffset = new Map<number, RawEntry>();
  for (const e of raw) byOffset.set(e.offset, e);
  const resolve = (entry: RawEntry, seen: Set<number>): GitObject => {
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      const type = PACK_TYPES[entry.typeCode] as ObjectType;
      if (entry.data.length !== entry.size) throw new Error('pack object size mismatch');
      return { type, content: entry.data };
    }
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        if (entry.baseOffset === undefined) throw new Error('ofs delta without base');
        if (seen.has(entry.baseOffset)) throw new Error('delta cycle');
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('ofs delta base outside pack');
        seen.add(entry.baseOffset);
        base = resolve(baseEntry, seen);
      } else {
        if (!entry.baseOid) throw new Error('ref delta without base');
        base = objects.get(entry.baseOid) ?? resolveBase(entry.baseOid);
        if (!base) {
          // Base may be a later pack entry (ref delta by oid): search raw entries.
          const baseEntry = raw.find((e) => {
            if (e.typeCode < 1 || e.typeCode > 4) return false;
            return objectId(PACK_TYPES[e.typeCode] as ObjectType, e.data) === entry.baseOid;
          });
          if (baseEntry) base = resolve(baseEntry, new Set(seen));
        }
        if (!base) throw new Error(`ref delta base not found: ${entry.baseOid}`);
      }
      const content = applyDelta(base.content, entry.data);
      return { type: base.type, content };
    }
    throw new Error(`unknown pack type ${entry.typeCode}`);
  };
  for (const entry of raw) {
    const obj = resolve(entry, new Set([entry.offset]));
    objects.set(objectId(obj.type, obj.content), obj);
  }
  if (objects.size !== count && raw.length !== count) throw new Error('pack count mismatch');
  return objects;
}

/** Build a packfile (v2, no deltas) from objects. */
export function buildPack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = PACK_TYPE_CODES[obj.type];
    const size = obj.content.length;
    // type/size varint: first byte holds type in bits 4-6 and low 4 size bits.
    const varint: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    while (remaining > 0) {
      varint.push(first | 0x80);
      first = remaining & 0x7f;
      remaining >>= 7;
    }
    varint.push(first);
    parts.push(Buffer.from(varint));
    parts.push(deflateSync(obj.content));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Encode a sideband packet (band 1 = data). Chunked to the pkt-line limit. */
export function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const maxPayload = 65520 - 4 - 1;
  for (let i = 0; i < data.length; i += maxPayload) {
    const chunk = data.subarray(i, Math.min(data.length, i + maxPayload));
    const pkt = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(pktLine(pkt));
  }
  if (data.length === 0) {
    // An empty payload still needs no packet; callers add the flush themselves.
  }
  return out;
}

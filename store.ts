// The forge's in-memory store: repositories, git objects and refs, issues,
// pull requests, labels and comments. Deterministic: sequence numbers order
// everything; timestamps come from a logical clock, never the wall clock.
import {
  objectId,
  parseCommit,
  parseTree,
  buildTree,
  sortTreeEntries,
  parseTag,
  ZERO_OID,
  isOid,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** A fixed author/committer line for commits this forge creates. */
function gitPerson(epochSec: number): string {
  return `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${epochSec} +0000`;
}

export interface Repo {
  id: number;
  globalId: string;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  /** refs/heads/<branch> -> commit oid (or '' when unborn). */
  refs: Map<string, string>;
  /** refs/tags/<tag> -> object oid. */
  tags: Map<string, string>;
  /** oid -> object. */
  objects: Map<string, GitObject>;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: Comment[];
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  seq: number;
}

export interface Pull {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export function globalId(kind: string, n: number): string {
  return `${kind}_${Buffer.from(`${kind}:${n}`).toString('base64url')}`;
}

export class Forge {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextObjectSeq = 1;
  seq = 0;
  /** Logical clock: seconds since the scenario epoch, +1 per event. */
  clockSec = 1735689600;

  tick(): { epoch: number; iso: string; seq: number } {
    this.clockSec += 1;
    this.seq += 1;
    return { epoch: this.clockSec, iso: new Date(this.clockSec * 1000).toISOString(), seq: this.seq };
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const repo: Repo = {
      id,
      globalId: globalId('R', id),
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.seq,
      issues: [],
      pulls: [],
      labels: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      refs: new Map(),
      tags: new Map(),
      objects: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // ---------------------------------------------------------- git objects

  putObject(repo: Repo, type: ObjectType, content: Buffer): string {
    const oid = objectId(type, content);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, content });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** All refs of a repo as <refname> -> oid (heads, tags, HEAD resolved separately). */
  allRefs(repo: Repo): Map<string, string> {
    const out = new Map<string, string>();
    for (const [name, oid] of repo.refs) out.set(`refs/heads/${name}`, oid);
    for (const [name, oid] of repo.tags) out.set(`refs/tags/${name}`, oid);
    return out;
  }

  /** The oid a ref name resolves to, or '' when it does not exist. */
  resolveRef(repo: Repo, ref: string): string {
    if (ref === 'HEAD') return repo.refs.get(DEFAULT_BRANCH) ?? '';
    if (ref.startsWith('refs/heads/')) return repo.refs.get(ref.slice('refs/heads/'.length)) ?? '';
    if (ref.startsWith('refs/tags/')) {
      const oid = repo.tags.get(ref.slice('refs/tags/'.length)) ?? '';
      if (oid === '') return '';
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') return parseTag(obj.content).object;
      return oid;
    }
    // Bare branch name.
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    return '';
  }

  /** True when `ancestor` is reachable from `descendant` (or equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    if (!isOid(ancestor) || !isOid(descendant)) return false;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.content).parents) queue.push(p);
    }
    return false;
  }

  /** Commits reachable from `tip`, newest first (parents after children). */
  walkCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      for (const p of parseCommit(obj.content).parents) queue.push(p);
    }
    return out;
  }

  /** Every object reachable from a set of tips (commits, trees, blobs, tags). */
  reachableObjects(repo: Repo, tips: string[]): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const queue: string[] = [...tips];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      out.set(oid, obj);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.content);
        queue.push(c.tree);
        for (const p of c.parents) queue.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.content)) queue.push(e.oid);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.content).object);
      }
    }
    return out;
  }

  /** Objects reachable from `wants` minus those reachable from `haves`. */
  newObjects(repo: Repo, wants: string[], haves: string[]): Map<string, GitObject> {
    const haveSet = this.reachableObjects(repo, haves);
    const wantSet = this.reachableObjects(repo, wants);
    for (const oid of haveSet.keys()) wantSet.delete(oid);
    return wantSet;
  }

  /** Haves that are ancestors of (or equal to) the wants: the common base. */
  commonHaves(repo: Repo, wants: string[], haves: string[]): string[] {
    const wantAncestors = new Set<string>();
    const queue: string[] = [];
    for (const w of wants) {
      // Tag wants peel to their target commit before ancestry is computed.
      const peeled = this.peelToCommit(repo, w);
      queue.push(peeled !== '' ? peeled : w);
    }
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (wantAncestors.has(oid)) continue;
      wantAncestors.add(oid);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') {
        for (const p of parseCommit(obj.content).parents) queue.push(p);
      }
    }
    return haves.filter((h) => wantAncestors.has(h));
  }

  /**
   * Distance (1-based, want = 1) from the wants to the deepest reachable
   * shallow boundary, peeling tag wants to their target commits. 0 when no
   * boundary is reachable.
   */
  depthOfBoundary(repo: Repo, wants: string[], boundaries: string[]): number {
    const boundarySet = new Set(boundaries);
    const seen = new Set<string>();
    const queue: Array<{ oid: string; d: number }> = [];
    for (const w of wants) {
      const peeled = this.peelToCommit(repo, w);
      if (peeled !== '') queue.push({ oid: peeled, d: 1 });
    }
    let best = 0;
    while (queue.length > 0) {
      const { oid, d } = queue.shift() as { oid: string; d: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (boundarySet.has(oid)) best = Math.max(best, d);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') {
        for (const p of parseCommit(obj.content).parents) queue.push({ oid: p, d: d + 1 });
      }
    }
    return best;
  }

  /** Peel a tag (possibly nested) to its target commit oid, or '' if none. */
  peelToCommit(repo: Repo, oid: string): string {
    let cur = oid;
    for (let i = 0; i < 8; i++) {
      const obj = repo.objects.get(cur);
      if (!obj) return '';
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') {
        cur = parseTag(obj.content).object;
        continue;
      }
      return '';
    }
    return '';
  }

  /**
   * Depth-limited walk: commits within `depth` steps of `wants` (depth 1 = the
   * want commits only), minus anything reachable from `haves`. Returns the
   * commits to send, the objects to send, and the new shallow boundary oids.
   */
  shallowWalk(
    repo: Repo,
    wants: string[],
    haves: string[],
    depth: number,
    shallowBoundaries: string[] = [],
  ): { commits: string[]; objects: Map<string, GitObject>; shallow: string[] } {
    // A "have" that is also a shallow boundary is held by the client as a
    // commit plus its tree, but NOT its parents: exclude only the commit and
    // its tree from the pack, never its ancestors (a deepen must deliver them).
    const boundarySet = new Set(shallowBoundaries);
    const haveSet = new Set<string>();
    for (const h of haves) {
      const obj = repo.objects.get(h);
      if (boundarySet.has(h) && obj?.type === 'commit') {
        haveSet.add(h);
        const tree = parseCommit(obj.content).tree;
        for (const [o] of this.reachableObjects(repo, [tree])) haveSet.add(o);
      } else {
        for (const [o] of this.reachableObjects(repo, [h])) haveSet.add(o);
      }
    }
    const commits: string[] = [];
    const shallow: string[] = [];
    const seen = new Set<string>();
    // Tag wants peel to their target commit for the walk; the tag objects
    // themselves are still sent (unless the client already has them).
    const tagWants: string[] = [];
    const walkRoots: Array<{ oid: string; d: number }> = [];
    for (const w of wants) {
      const obj = repo.objects.get(w);
      if (obj?.type === 'tag') {
        tagWants.push(w);
        const peeled = this.peelToCommit(repo, w);
        if (peeled !== '') walkRoots.push({ oid: peeled, d: 1 });
      } else {
        walkRoots.push({ oid: w, d: 1 });
      }
    }
    const queue: Array<{ oid: string; d: number }> = walkRoots;
    while (queue.length > 0) {
      const { oid, d } = queue.shift() as { oid: string; d: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      commits.push(oid);
      if (d >= depth) {
        shallow.push(oid);
        continue;
      }
      for (const p of parseCommit(obj.content).parents) queue.push({ oid: p, d: d + 1 });
    }
    // Only the walked commits and their trees/blobs go in the pack: never
    // leak ancestors' trees through a full reachability walk.
    const objects = new Map<string, GitObject>();
    for (const tagOid of tagWants) {
      const tagObj = repo.objects.get(tagOid);
      if (tagObj && !haveSet.has(tagOid)) objects.set(tagOid, tagObj);
    }
    for (const oid of commits) {
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (!haveSet.has(oid)) objects.set(oid, obj);
      if (obj.type === 'commit') {
        const tree = parseCommit(obj.content).tree;
        for (const [o, tobj] of this.reachableObjects(repo, [tree])) {
          if (!haveSet.has(o)) objects.set(o, tobj);
        }
      }
    }
    return { commits, objects, shallow };
  }

  /** The tree oid at a ref, or '' when the ref has no commit. */
  treeAt(repo: Repo, ref: string): string {
    const tip = this.resolveRef(repo, ref);
    if (tip === '') return '';
    const obj = repo.objects.get(tip);
    if (!obj || obj.type !== 'commit') return '';
    return parseCommit(obj.content).tree;
  }

  /** Read one path out of a tree (recursive). Returns the blob entry or undefined. */
  treeLookup(repo: Repo, treeOid: string, path: string): TreeEntry | undefined {
    if (treeOid === '') return undefined;
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return undefined;
      const entries = parseTree(obj.content);
      const entry = entries.find((e) => e.name === parts[i]);
      if (!entry) return undefined;
      if (i === parts.length - 1) return entry;
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** List a directory tree's entries ('' = root). */
  treeList(repo: Repo, treeOid: string, path: string): TreeEntry[] | undefined {
    if (treeOid === '') return undefined;
    if (path === '' || path === '/') {
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return undefined;
      return parseTree(obj.content);
    }
    const entry = this.treeLookup(repo, treeOid, path);
    if (!entry || entry.mode !== '40000') return undefined;
    const obj = repo.objects.get(entry.oid);
    if (!obj || obj.type !== 'tree') return undefined;
    return parseTree(obj.content);
  }

  /**
   * Build a new tree with `path` set to `blobOid` (or removed when null),
   * starting from `baseTreeOid` ('' for an empty tree). Returns the new tree oid.
   */
  treeSet(repo: Repo, baseTreeOid: string, path: string, blobOid: string | null): string {
    const parts = path.split('/').filter((p) => p !== '');
    const build = (treeOid: string, depth: number): string => {
      const obj = treeOid === '' ? undefined : repo.objects.get(treeOid);
      const entries: TreeEntry[] = obj && obj.type === 'tree' ? parseTree(obj.content) : [];
      const name = parts[depth] as string;
      const last = depth === parts.length - 1;
      const idx = entries.findIndex((e) => e.name === name);
      if (last) {
        if (blobOid === null) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '100644', name, oid: blobOid };
        } else {
          entries.push({ mode: '100644', name, oid: blobOid });
        }
      } else {
        const child = idx >= 0 ? entries[idx] : undefined;
        const childTree = child && child.mode === '40000' ? child.oid : '';
        const newChild = build(childTree, depth + 1);
        const newChildObj = repo.objects.get(newChild);
        const empty = !newChildObj || (newChildObj.type === 'tree' && newChildObj.content.length === 0);
        if (empty) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '40000', name, oid: newChild };
        } else {
          entries.push({ mode: '40000', name, oid: newChild });
        }
      }
      const sorted = sortTreeEntries(entries);
      return this.putObject(repo, 'tree', buildTree(sorted));
    };
    return build(baseTreeOid, 0);
  }

  /** Create a commit object on `branch` ('' tip = unborn). Returns the new commit oid. */
  makeCommit(repo: Repo, branch: string, treeOid: string, message: string): string {
    const { epoch } = this.tick();
    const parent = repo.refs.get(branch) ?? '';
    const lines: string[] = [`tree ${treeOid}`];
    if (parent !== '' && isOid(parent)) lines.push(`parent ${parent}`);
    const person = gitPerson(epoch);
    lines.push(`author ${person}`, `committer ${person}`, '', message);
    const content = Buffer.from(lines.join('\n'), 'utf8');
    const oid = this.putObject(repo, 'commit', content);
    repo.refs.set(branch, oid);
    return oid;
  }

  /** Paths changed between two trees (recursive), as filename -> 'added' | 'modified' | 'deleted'. */
  diffTrees(repo: Repo, oldTree: string, newTree: string): Map<string, 'added' | 'modified' | 'deleted'> {
    const out = new Map<string, 'added' | 'modified' | 'deleted'>();
    const flat = (treeOid: string, prefix: string, into: Map<string, string>): void => {
      if (treeOid === '') return;
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.content)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') flat(e.oid, path, into);
        else into.set(path, e.oid);
      }
    };
    const oldFiles = new Map<string, string>();
    const newFiles = new Map<string, string>();
    flat(oldTree, '', oldFiles);
    flat(newTree, '', newFiles);
    for (const [path, oid] of newFiles) {
      if (!oldFiles.has(path)) out.set(path, 'added');
      else if (oldFiles.get(path) !== oid) out.set(path, 'modified');
    }
    for (const path of oldFiles.keys()) {
      if (!newFiles.has(path)) out.set(path, 'deleted');
    }
    return out;
  }

  /** Line counts for a pull-request file entry. */
  fileStats(repo: Repo, oldOid: string | undefined, newOid: string | undefined): { additions: number; deletions: number } {
    const lines = (oid: string | undefined): string[] => {
      if (!oid) return [];
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'blob') return [];
      const text = obj.content.toString('utf8');
      if (text === '') return [];
      return text.split('\n');
    };
    const oldLines = lines(oldOid);
    const newLines = lines(newOid);
    const oldCount = new Map<string, number>();
    for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
    let additions = 0;
    const newCount = new Map<string, number>();
    for (const l of newLines) {
      newCount.set(l, (newCount.get(l) ?? 0) + 1);
      const used = newCount.get(l) as number;
      if ((oldCount.get(l) ?? 0) < used) additions += 1;
    }
    const oldTotal = new Map<string, number>();
    for (const l of newLines) oldTotal.set(l, (oldTotal.get(l) ?? 0) + 1);
    let deletions = 0;
    const seen = new Map<string, number>();
    for (const l of oldLines) {
      seen.set(l, (seen.get(l) ?? 0) + 1);
      const used = seen.get(l) as number;
      if ((oldTotal.get(l) ?? 0) < used) deletions += 1;
    }
    if (additions === 0 && deletions === 0 && (oldOid !== newOid)) {
      // Same lines, different bytes (e.g. no trailing newline): count as one change.
      additions = newOid !== undefined && oldOid === undefined ? Math.max(1, newLines.length) : 1;
    }
    return { additions, deletions };
  }
}

export { ZERO_OID };

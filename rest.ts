// REST v3 (/api/v3) handlers. Pure functions over the Forge store; the HTTP
// server in app.ts owns transport, auth and body parsing.
import { Forge, VIEWER_LOGIN, VIEWER_ID, globalId, type Repo, type Issue, type Pull } from './store.ts';
import { isOid } from './git.ts';

export interface RestCtx {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body (null when no body / not JSON). */
  json: unknown;
  /** Raw body bytes (for contents endpoints). */
  body: Buffer;
  host: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => ok(status, { message });
const notFound = (): RestResult => err(404, 'Not Found');

function isoOf(seq: number): string {
  return new Date((1735689600 + seq) * 1000).toISOString();
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1000 + repo.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoOf(repo.seq),
    updated_at: isoOf(repo.seq),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.find((l) => l.name === name)?.color ?? 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: isoOf(issue.seq),
    updated_at: isoOf(issue.seq),
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: isoOf(pull.seq),
    updated_at: isoOf(pull.seq),
  };
}

function bodyObj(ctx: RestCtx): Record<string, unknown> {
  if (ctx.json !== null && typeof ctx.json === 'object' && !Array.isArray(ctx.json)) {
    return ctx.json as Record<string, unknown>;
  }
  return {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Decode a base64 body field; returns null when it is not valid base64 text. */
function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  if (value === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/=\n\r]+$/.test(value)) return null;
  try {
    return Buffer.from(value.replace(/\n/g, ''), 'base64');
  } catch {
    return null;
  }
}

export function handleRest(forge: Forge, ctx: RestCtx): RestResult {
  const { method, segments: s } = ctx;
  const get = method === 'GET';
  const post = method === 'POST';
  const put = method === 'PUT';
  const patch = method === 'PATCH';
  const del = method === 'DELETE';

  // GET /api/v3/ — the API root.
  if (s.length === 0) {
    if (!get) return notFound();
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (s.length === 1 && s[0] === 'meta') {
    if (!get) return notFound();
    return ok(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (s.length === 1 && s[0] === 'user') {
    if (!get) return notFound();
    return ok(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
  }

  // /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (post) {
      const body = bodyObj(ctx);
      const name = str(body.name);
      if (name === '') return err(422, 'name is required');
      if (forge.getRepo(VIEWER_LOGIN, name)) return err(422, 'Repository already exists');
      const repo = forge.createRepo(VIEWER_LOGIN, name, body.private === true, str(body.description));
      return ok(201, repoJson(repo));
    }
    if (get) {
      const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '10') || 10));
      const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
      const all = forge.listViewerRepos();
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const next = `http://${ctx.host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers.link = `<${next}>; rel="next"`;
      }
      return ok(200, slice.map(repoJson), headers);
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1] as string;
    const name = s[2] as string;
    const repo = forge.getRepo(owner, name);
    const rest = s.slice(3);
    // A repository belongs to the token owner; any other owner is 404.
    if (!repo || owner !== VIEWER_LOGIN) return notFound();

    if (rest.length === 0) {
      if (get) return ok(200, repoJson(repo));
      if (patch) {
        const body = bodyObj(ctx);
        if (typeof body.description === 'string') repo.description = body.description;
        return ok(200, repoJson(repo));
      }
      if (del) {
        forge.deleteRepo(owner, name);
        return { status: 204, body: '' };
      }
      return notFound();
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (post && rest.length === 2) {
        const body = bodyObj(ctx);
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/heads/') || !isOid(sha)) return err(422, 'invalid ref');
        if (!forge.getObject(repo, sha)) return err(422, 'unknown sha');
        const branch = ref.slice('refs/heads/'.length);
        repo.refs.set(branch, sha);
        return ok(201, { ref, object: { sha } });
      }
      if (get && rest.length >= 3) {
        // GET /git/refs/heads/<branch>
        const ref = rest.slice(2).join('/');
        if (!ref.startsWith('heads/')) return notFound();
        const branch = ref.slice('heads/'.length);
        const sha = repo.refs.get(branch);
        if (!sha) return notFound();
        return ok(200, { ref: `refs/heads/${branch}`, object: { sha } });
      }
      return notFound();
    }

    // branches
    if (rest[0] === 'branches') {
      if (get && rest.length === 1) {
        const out: Record<string, unknown>[] = [];
        for (const [branch, sha] of repo.refs) {
          out.push({ name: branch, commit: { sha } });
        }
        out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return ok(200, out);
      }
      if (get && rest.length === 2) {
        const sha = repo.refs.get(rest[1] as string);
        if (!sha) return notFound();
        return ok(200, { name: rest[1], commit: { sha } });
      }
      return notFound();
    }

    // commits
    if (rest[0] === 'commits') {
      if (!get) return notFound();
      const refName = ctx.query.get('sha') ?? repo.defaultBranch;
      const tip = forge.resolveRef(repo, refName);
      if (tip === '') return ok(200, []);
      const commits = forge.walkCommits(repo, tip).map((oid) => {
        const obj = forge.getObject(repo, oid);
        const c = obj ? parseCommitText(obj.content) : { message: '' };
        return { sha: oid, commit: { message: c.message } };
      });
      return ok(200, commits);
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const refName = ctx.query.get('ref') ?? repo.defaultBranch;
      if (put) return putContents(forge, repo, ctx, path, refName);
      if (del) return deleteContents(forge, repo, ctx, path, refName);
      if (get) return getContents(forge, repo, path, refName);
      return notFound();
    }

    // labels
    if (rest[0] === 'labels') {
      if (post && rest.length === 1) {
        const body = bodyObj(ctx);
        const name = str(body.name);
        if (name === '') return err(422, 'name is required');
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        const existing = repo.labels.find((l) => l.name === name);
        if (existing) return ok(201, { name, color: existing.color });
        repo.labels.push({ name, color });
        return ok(201, { name, color });
      }
      if (get && rest.length === 1) {
        return ok(200, repo.labels.map((l) => ({ name: l.name, color: l.color })));
      }
      return notFound();
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (post) return createIssue(forge, repo, ctx);
        if (get) return listIssues(forge, repo, ctx);
        return notFound();
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return notFound();
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!issue) return notFound();
        if (get) return ok(200, issueJson(issue, repo));
        if (patch) {
          const body = bodyObj(ctx);
          if (body.state === 'closed') issue.state = 'closed';
          else if (body.state === 'open') issue.state = 'open';
          return ok(200, issueJson(issue, repo));
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return notFound();
        if (post) {
          const body = bodyObj(ctx);
          const text = str(body.body);
          if (text === '') return err(422, 'body is required');
          const id = repo.nextCommentId;
          repo.nextCommentId += 1;
          const { seq } = forge.tick();
          const comment = { id, globalId: globalId('C', id), body: text, seq };
          issue.comments.push(comment);
          return ok(201, { id, node_id: comment.globalId, body: text });
        }
        if (get) {
          return ok(200, issue.comments.map((c) => ({ id: c.id, node_id: c.globalId, body: c.body })));
        }
        return notFound();
      }
      return notFound();
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (post) return createPull(forge, repo, ctx);
        if (get) return listPulls(forge, repo, ctx);
        return notFound();
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return notFound();
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (!pull) return notFound();
        if (get) return ok(200, pullJson(pull, repo));
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pull) return notFound();
        if (!get) return notFound();
        return ok(200, pullFiles(forge, repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) return notFound();
        if (!put) return notFound();
        return mergePull(forge, repo, pull, ctx);
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}

function parseCommitText(content: Buffer): { message: string } {
  const text = content.toString('utf8');
  const idx = text.indexOf('\n\n');
  return { message: idx >= 0 ? text.slice(idx + 2) : '' };
}

// ---------------------------------------------------------------- contents

function putContents(forge: Forge, repo: Repo, ctx: RestCtx, path: string, refName: string): RestResult {
  const body = bodyObj(ctx);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : refName;
  const content = decodeBase64(body.content);
  if (content === null) return err(422, 'content must be base64');
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const tip = repo.refs.get(branch) ?? '';
  const existing = tip === '' ? undefined : forge.treeLookup(repo, forge.treeAt(repo, branch), path);
  if (typeof body.sha === 'string' && body.sha !== '') {
    if (!existing || existing.oid !== body.sha) return err(409, 'sha does not match the current file');
  }
  const isUpdate = existing !== undefined;
  const blobOid = forge.putObject(repo, 'blob', content);
  const baseTree = forge.treeAt(repo, branch);
  const newTree = forge.treeSet(repo, baseTree, path, blobOid);
  const commitOid = forge.makeCommit(repo, branch, newTree, message);
  return ok(isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64' },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(forge: Forge, repo: Repo, ctx: RestCtx, path: string, refName: string): RestResult {
  const body = bodyObj(ctx);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : refName;
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const tip = repo.refs.get(branch) ?? '';
  if (tip === '') return notFound();
  const existing = forge.treeLookup(repo, forge.treeAt(repo, branch), path);
  if (!existing) return notFound();
  if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.oid) {
    return err(409, 'sha does not match the current file');
  }
  const baseTree = forge.treeAt(repo, branch);
  const newTree = forge.treeSet(repo, baseTree, path, null);
  const commitOid = forge.makeCommit(repo, branch, newTree, message);
  return ok(200, { commit: { sha: commitOid, message } });
}

function getContents(forge: Forge, repo: Repo, path: string, refName: string): RestResult {
  const treeOid = forge.treeAt(repo, refName);
  if (treeOid === '') return notFound();
  if (path === '') {
    const entries = forge.treeList(repo, treeOid, '');
    if (!entries) return notFound();
    return ok(200, entries.map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: e.name,
      sha: e.oid,
    })));
  }
  const entry = forge.treeLookup(repo, treeOid, path);
  if (!entry) return notFound();
  if (entry.mode === '40000') {
    const entries = forge.treeList(repo, treeOid, path);
    if (!entries) return notFound();
    return ok(200, entries.map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: `${path}/${e.name}`,
      sha: e.oid,
    })));
  }
  const obj = forge.getObject(repo, entry.oid);
  if (!obj || obj.type !== 'blob') return notFound();
  return ok(200, {
    type: 'file',
    encoding: 'base64',
    content: obj.content.toString('base64'),
    sha: entry.oid,
    size: obj.content.length,
    name: path.split('/').pop() ?? path,
    path,
  });
}

// ---------------------------------------------------------------- issues

function createIssue(forge: Forge, repo: Repo, ctx: RestCtx): RestResult {
  const body = bodyObj(ctx);
  const title = str(body.title);
  if (title === '') return err(422, 'title is required');
  const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.some((l) => l.name === label)) return err(422, `label ${label} does not exist`);
  }
  const number = repo.nextIssueNumber;
  repo.nextIssueNumber += 1;
  const id = number;
  const { seq } = forge.tick();
  const issue: Issue = {
    id,
    globalId: globalId('I', repo.id * 100000 + number),
    number,
    title,
    body: str(body.body),
    state: 'open',
    labels,
    seq,
    comments: [],
  };
  repo.issues.push(issue);
  return ok(201, issueJson(issue, repo));
}

function listIssues(forge: Forge, repo: Repo, ctx: RestCtx): RestResult {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let list = repo.issues.slice();
  if (state !== 'all') list = list.filter((i) => i.state === state);
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  return ok(200, list.slice(start, start + perPage).map((i) => issueJson(i, repo)));
}

// ---------------------------------------------------------------- pulls

function createPull(forge: Forge, repo: Repo, ctx: RestCtx): RestResult {
  const body = bodyObj(ctx);
  const head = str(body.head);
  const base = str(body.base);
  if (head === '' || base === '') return err(422, 'head and base are required');
  const headSha = repo.refs.get(head);
  const baseSha = repo.refs.get(base);
  if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
  const number = repo.nextPullNumber;
  repo.nextPullNumber += 1;
  const id = number;
  const { seq } = forge.tick();
  const pull: Pull = {
    id,
    globalId: globalId('PR', repo.id * 100000 + number),
    number,
    title: str(body.title),
    body: str(body.body),
    state: 'open',
    merged: false,
    mergedAt: '',
    mergeCommitSha: '',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    seq,
  };
  repo.pulls.push(pull);
  return ok(201, pullJson(pull, repo));
}

function listPulls(forge: Forge, repo: Repo, ctx: RestCtx): RestResult {
  const state = ctx.query.get('state') ?? 'open';
  let list = repo.pulls.slice();
  if (state !== 'all') list = list.filter((p) => p.state === state);
  list.sort((a, b) => a.number - b.number);
  return ok(200, list.map((p) => pullJson(p, repo)));
}

function pullFiles(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown>[] {
  // Diff the trees at the PR's recorded base sha and its head tip.
  const baseTip = pull.baseSha;
  const headTip = forge.resolveRef(repo, `refs/heads/${pull.headRef}`);
  const baseTreeOid = treeOfCommit(forge, repo, baseTip);
  const headTreeOid = headTip === '' ? '' : treeOfCommit(forge, repo, headTip);
  const diff = forge.diffTrees(repo, baseTreeOid, headTreeOid);
  const out: Record<string, unknown>[] = [];
  for (const [path, status] of [...diff.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const oldEntry = status === 'added' ? undefined : forge.treeLookup(repo, baseTreeOid, path);
    const newEntry = status === 'deleted' ? undefined : forge.treeLookup(repo, headTreeOid, path);
    const stats = forge.fileStats(repo, oldEntry?.oid, newEntry?.oid);
    out.push({
      filename: path,
      status: status === 'modified' ? 'modified' : status,
      additions: stats.additions,
      deletions: stats.deletions,
      changes: stats.additions + stats.deletions,
    });
  }
  return out;
}

export function treeOfCommit(forge: Forge, repo: Repo, commitOid: string): string {
  const obj = forge.getObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommitTextTree(obj.content);
}

function parseCommitTextTree(content: Buffer): string {
  const text = content.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('tree ')) return line.slice(5).trim();
  }
  return '';
}

/** Squash-merge a pull request. Returns the merge sha, or an error status/message. */
export function squashMerge(
  forge: Forge,
  repo: Repo,
  pull: Pull,
): { status: number; sha?: string; message: string } {
  if (pull.state !== 'open') return { status: 405, message: 'pull request is not open' };
  const currentBaseTip = repo.refs.get(pull.baseRef) ?? '';
  const headTip = repo.refs.get(pull.headRef) ?? '';
  if (currentBaseTip === '' || headTip === '') return { status: 422, message: 'head or base branch is missing' };
  const headTree = treeOfCommit(forge, repo, headTip);
  const baseAtPrTree = treeOfCommit(forge, repo, pull.baseSha);
  const baseNowTree = treeOfCommit(forge, repo, currentBaseTip);
  const prChanged = forge.diffTrees(repo, baseAtPrTree, headTree);
  const baseChanged = forge.diffTrees(repo, baseAtPrTree, baseNowTree);
  for (const path of prChanged.keys()) {
    if (baseChanged.has(path)) return { status: 405, message: 'merge conflict' };
  }
  const { epoch, iso } = forge.tick();
  const person = `${VIEWER_LOGIN} <adaiversen@example.invalid> ${epoch} +0000`;
  const lines = [
    `tree ${headTree}`,
    `parent ${currentBaseTip}`,
    `author ${person}`,
    `committer ${person}`,
    '',
    pull.title === '' ? `Merge pull request #${pull.number}` : pull.title,
  ];
  const content = Buffer.from(lines.join('\n'), 'utf8');
  const mergeSha = forge.putObject(repo, 'commit', content);
  repo.refs.set(pull.baseRef, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = iso;
  pull.mergeCommitSha = mergeSha;
  return { status: 200, sha: mergeSha, message: `Pull request #${pull.number} merged` };
}

/** True when a pull request would conflict with the current base branch. */
export function pullIsConflicted(forge: Forge, repo: Repo, pull: Pull): boolean {
  const currentBaseTip = repo.refs.get(pull.baseRef) ?? '';
  const headTip = repo.refs.get(pull.headRef) ?? '';
  if (currentBaseTip === '' || headTip === '' || pull.baseSha === currentBaseTip) return false;
  const headTree = treeOfCommit(forge, repo, headTip);
  const baseAtPrTree = treeOfCommit(forge, repo, pull.baseSha);
  const baseNowTree = treeOfCommit(forge, repo, currentBaseTip);
  const prChanged = forge.diffTrees(repo, baseAtPrTree, headTree);
  const baseChanged = forge.diffTrees(repo, baseAtPrTree, baseNowTree);
  for (const path of prChanged.keys()) {
    if (baseChanged.has(path)) return true;
  }
  return false;
}

function mergePull(forge: Forge, repo: Repo, pull: Pull, ctx: RestCtx): RestResult {
  const body = bodyObj(ctx);
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
    return err(422, 'unknown merge_method');
  }
  if (!repo.pulls.includes(pull)) return notFound();
  const result = squashMerge(forge, repo, pull);
  if (result.status !== 200 || !result.sha) return err(result.status, result.message);
  return ok(200, { sha: result.sha, merged: true, message: result.message });
}

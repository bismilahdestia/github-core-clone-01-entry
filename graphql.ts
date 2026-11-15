// GraphQL v4 (/api/graphql): a small parser for the documents the suite sends,
// plus resolvers over the Forge store. No schema generation, no validation
// beyond unknown-field errors (HTTP 200 with an errors array naming the field).
import { Forge, VIEWER_LOGIN, globalId, type Repo, type Issue, type Pull } from './store.ts';
import { squashMerge, pullIsConflicted, treeOfCommit } from './rest.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      const raw = src.slice(i, j);
      if (raw.includes('.') || raw.includes('e') || raw.includes('E')) {
        tokens.push({ kind: 'float', value: Number(raw) });
      } else {
        tokens.push({ kind: 'int', value: Number(raw) });
      }
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldSelection {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selections?: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition?: string;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  varDefs: Array<{ name: string; type: string; defaultValue?: Value }>;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek() as Token;
      if (t.kind === 'punct' && t.value === '{') {
        ops.push({ kind: 'query', varDefs: [], selections: this.parseSelections() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        const next = this.peek();
        if (next && next.kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        const selections = this.parseSelections();
        ops.push({ kind, name, varDefs, selections });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(t)} in GraphQL document`);
    }
    return ops;
  }

  private parseVarDefs(): Array<{ name: string; type: string; defaultValue?: Value }> {
    const defs: Array<{ name: string; type: string; defaultValue?: Value }> = [];
    const t = this.peek();
    if (!t || t.kind !== 'punct' || t.value !== '(') return defs;
    this.next();
    while (true) {
      const next = this.peek() as Token;
      if (next.kind === 'punct' && next.value === ')') {
        this.next();
        break;
      }
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: Value | undefined;
      const eq = this.peek();
      if (eq && eq.kind === 'punct' && eq.value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  private parseType(): string {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '[') {
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      const bang = this.peek();
      if (bang && bang.kind === 'punct' && bang.value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    if (t.kind !== 'name') throw new Error('expected a type name in GraphQL document');
    let out = t.value;
    const bang = this.peek();
    if (bang && bang.kind === 'punct' && bang.value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  private parseSelections(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    for (;;) {
      const t = this.peek() as Token;
      if (t.kind === 'punct' && t.value === '}') {
        this.next();
        break;
      }
      out.push(this.parseSelection());
    }
    return out;
  }

  private parseSelection(): Selection {
    const t = this.peek() as Token;
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const next = this.peek();
      if (next && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelections() };
      }
      if (next && next.kind === 'name') {
        // Named fragment spread (not used by the suite); skip its selections.
        this.next();
        return { kind: 'fragment', selections: [] };
      }
      throw new Error('bad fragment spread in GraphQL document');
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    const colon = this.peek();
    if (colon && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    const open = this.peek();
    if (open && open.kind === 'punct' && open.value === '(') {
      this.next();
      for (;;) {
        const next = this.peek() as Token;
        if (next.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selections: Selection[] | undefined;
    const brace = this.peek();
    if (brace && brace.kind === 'punct' && brace.value === '{') {
      selections = this.parseSelections();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: Value[] = [];
      for (;;) {
        const next = this.peek() as Token;
        if (next.kind === 'punct' && next.value === ']') {
          this.next();
          break;
        }
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      for (;;) {
        const next = this.peek() as Token;
        if (next.kind === 'punct' && next.value === '}') {
          this.next();
          break;
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)} in GraphQL document`);
  }
}

// ---------------------------------------------------------------- values

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argsMap(field: FieldSelection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------- introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'author', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt'],
  SearchType: [],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION', 'CODE'],
};

// ---------------------------------------------------------------- execution

class GqlError extends Error {}

interface NodeValue {
  __type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

function issueState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`).toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function findRepoByGlobalId(forge: Forge, id: unknown): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    if (repo.globalId === id) return repo;
  }
  return undefined;
}

function findIssueByGlobalId(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    const issue = repo.issues.find((i) => i.globalId === id);
    if (issue) return { repo, issue };
  }
  return undefined;
}

function findPullByGlobalId(forge: Forge, id: unknown): { repo: Repo; pull: Pull } | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    const pull = repo.pulls.find((p) => p.globalId === id);
    if (pull) return { repo, pull };
  }
  return undefined;
}

function issueNode(issue: Issue): NodeValue {
  return {
    __type: 'Issue',
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    state: issueState(issue.state),
    body: issue.body,
  };
}

function pullNode(forge: Forge, repo: Repo, pull: Pull): NodeValue {
  return {
    __type: 'PullRequest',
    id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pullIsConflicted(forge, repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    _repo: repo,
    _pull: pull,
  };
}

function repoNode(repo: Repo): NodeValue {
  return {
    __type: 'Repository',
    id: repo.globalId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __type: 'User', login: repo.owner },
    defaultBranchRef: { __type: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    _repo: repo,
  };
}

function executeSelections(
  forge: Forge,
  type: string,
  value: NodeValue | Record<string, unknown>,
  selections: Selection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== type) continue;
      const nested = executeSelections(forge, type, value, sel.selections, variables);
      Object.assign(out, nested);
      continue;
    }
    const key = sel.alias ?? sel.name;
    out[key] = resolveField(forge, type, value, sel, variables);
  }
  return out;
}

function resolveField(
  forge: Forge,
  type: string,
  value: NodeValue | Record<string, unknown>,
  field: FieldSelection,
  variables: Record<string, unknown>,
): unknown {
  const args = argsMap(field, variables);
  const subs = field.selections ?? [];

  if (type === 'Query') {
    if (field.name === 'viewer') {
      const node: NodeValue = { __type: 'User', login: VIEWER_LOGIN };
      return subs.length > 0 ? executeSelections(forge, 'User', node, subs, variables) : node;
    }
    if (field.name === 'repository') {
      const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      const node = repoNode(repo);
      return subs.length > 0 ? executeSelections(forge, 'Repository', node, subs, variables) : node;
    }
    if (field.name === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const repo = findRepoByGlobalId(forge, id);
      if (repo) {
        const node = repoNode(repo);
        return subs.length > 0 ? executeSelections(forge, 'Repository', node, subs, variables) : node;
      }
      const issue = findIssueByGlobalId(forge, id);
      if (issue) {
        const node = issueNode(issue.issue);
        return subs.length > 0 ? executeSelections(forge, 'Issue', node, subs, variables) : node;
      }
      const pull = findPullByGlobalId(forge, id);
      if (pull) {
        const node = pullNode(forge, pull.repo, pull.pull);
        return subs.length > 0 ? executeSelections(forge, 'PullRequest', node, subs, variables) : node;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      const fields = TYPE_FIELDS[name];
      if (fields === undefined) return null;
      const node: NodeValue = {
        __type: '__Type',
        name,
        fields: fields.map((f) => ({ __type: '__Field', name: f })),
        enumValues: (TYPE_ENUMS[name] ?? []).map((n) => ({ __type: '__EnumValue', name: n })),
      };
      return subs.length > 0 ? executeSelections(forge, '__Type', node, subs, variables) : node;
    }
    throw new GqlError(`Cannot query field "${field.name}" on type "Query".`);
  }

  if (type === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(forge, input.repositoryId);
      if (!repo) throw new GqlError('createIssue: unknown repositoryId');
      const number = repo.nextIssueNumber;
      repo.nextIssueNumber += 1;
      const { seq } = forge.tick();
      const issue: Issue = {
        id: number,
        globalId: globalId('I', repo.id * 100000 + number),
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        seq,
        comments: [],
      };
      repo.issues.push(issue);
      const payload: NodeValue = { __type: 'CreateIssuePayload', issue: issueNode(issue) };
      return subs.length > 0 ? executeSelections(forge, 'CreateIssuePayload', payload, subs, variables) : payload;
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(forge, input.issueId);
      if (!found) throw new GqlError('closeIssue: unknown issueId');
      found.issue.state = 'closed';
      const payload: NodeValue = { __type: 'CloseIssuePayload', issue: issueNode(found.issue) };
      return subs.length > 0 ? executeSelections(forge, 'CloseIssuePayload', payload, subs, variables) : payload;
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(forge, input.repositoryId);
      if (!repo) throw new GqlError('createPullRequest: unknown repositoryId');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(head);
      const baseSha = repo.refs.get(base);
      if (!headSha || !baseSha) throw new GqlError('createPullRequest: head or base branch does not exist');
      const number = repo.nextPullNumber;
      repo.nextPullNumber += 1;
      const { seq } = forge.tick();
      const pull: Pull = {
        id: number,
        globalId: globalId('PR', repo.id * 100000 + number),
        number,
        title: String(input.title ?? ''),
        body: '',
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
      const payload: NodeValue = { __type: 'CreatePullRequestPayload', pullRequest: pullNode(forge, repo, pull) };
      return subs.length > 0 ? executeSelections(forge, 'CreatePullRequestPayload', payload, subs, variables) : payload;
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullByGlobalId(forge, input.pullRequestId);
      if (!found) throw new GqlError('mergePullRequest: unknown pullRequestId');
      const result = squashMerge(forge, found.repo, found.pull);
      if (result.status !== 200) throw new GqlError(`mergePullRequest: ${result.message}`);
      const payload: NodeValue = { __type: 'MergePullRequestPayload', pullRequest: pullNode(forge, found.repo, found.pull) };
      return subs.length > 0 ? executeSelections(forge, 'MergePullRequestPayload', payload, subs, variables) : payload;
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(forge, input.subjectId);
      if (!found) throw new GqlError('addComment: unknown subjectId');
      const id = found.repo.nextCommentId;
      found.repo.nextCommentId += 1;
      const { seq } = forge.tick();
      const comment = { id, globalId: globalId('C', id), body: String(input.body ?? ''), seq };
      found.issue.comments.push(comment);
      const node: NodeValue = { __type: 'IssueComment', id: comment.globalId, body: comment.body };
      const edge: NodeValue = { __type: 'IssueCommentEdge', node };
      const payload: NodeValue = { __type: 'AddCommentPayload', commentEdge: edge };
      return subs.length > 0 ? executeSelections(forge, 'AddCommentPayload', payload, subs, variables) : payload;
    }
    throw new GqlError(`Cannot query field "${field.name}" on type "Mutation".`);
  }

  if (type === 'Repository') {
    const repo = (value as NodeValue)._repo as Repo;
    if (field.name === 'issue') {
      const issue = repo.issues.find((i) => i.number === Number(args.number));
      if (!issue) return null;
      const node = issueNode(issue);
      return subs.length > 0 ? executeSelections(forge, 'Issue', node, subs, variables) : node;
    }
    if (field.name === 'issues') {
      let list = repo.issues.slice();
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        list = list.filter((i) => states.includes(issueState(i.state)));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'DESC');
      list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      const afterNum = decodeCursor(args.after);
      if (afterNum !== null) {
        // DESC order: keep issues with a smaller number than the cursor's.
        list = direction === 'ASC' ? list.filter((i) => i.number > afterNum) : list.filter((i) => i.number < afterNum);
      }
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      const hasNext = list.length > page.length;
      const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null;
      const conn: NodeValue = {
        __type: 'IssueConnection',
        nodes: page.map((i) => issueNode(i)),
        pageInfo: { __type: 'PageInfo', hasNextPage: hasNext, endCursor },
      };
      if (subs.length === 0) return conn;
      // Expand nested selections (nodes / pageInfo) manually.
      const out: Record<string, unknown> = {};
      for (const s of subs) {
        if (s.kind !== 'field') continue;
        if (s.name === 'nodes') {
          out[s.alias ?? 'nodes'] = conn.nodes.map((n) => executeSelections(forge, 'Issue', n, s.selections ?? [], variables));
        } else if (s.name === 'pageInfo') {
          out[s.alias ?? 'pageInfo'] = executeSelections(forge, 'PageInfo', conn.pageInfo, s.selections ?? [], variables);
        } else if (s.name === 'totalCount') {
          out[s.alias ?? 'totalCount'] = list.length;
        } else {
          throw new GqlError(`Cannot query field "${s.name}" on type "IssueConnection".`);
        }
      }
      return out;
    }
    if (field.name === 'pullRequests') {
      let list = repo.pulls.slice();
      list.sort((a, b) => b.seq - a.seq);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      const conn: NodeValue = {
        __type: 'PullRequestConnection',
        nodes: page.map((p) => pullNode(forge, repo, p)),
        pageInfo: { __type: 'PageInfo', hasNextPage: list.length > page.length, endCursor: null },
      };
      if (subs.length === 0) return conn;
      const out: Record<string, unknown> = {};
      for (const s of subs) {
        if (s.kind !== 'field') continue;
        if (s.name === 'nodes') {
          out[s.alias ?? 'nodes'] = conn.nodes.map((n) => executeSelections(forge, 'PullRequest', n, s.selections ?? [], variables));
        } else if (s.name === 'pageInfo') {
          out[s.alias ?? 'pageInfo'] = executeSelections(forge, 'PageInfo', conn.pageInfo, s.selections ?? [], variables);
        } else {
          throw new GqlError(`Cannot query field "${s.name}" on type "PullRequestConnection".`);
        }
      }
      return out;
    }
    if (field.name === 'pullRequest') {
      const pull = repo.pulls.find((p) => p.number === Number(args.number));
      if (!pull) return null;
      const node = pullNode(forge, repo, pull);
      return subs.length > 0 ? executeSelections(forge, 'PullRequest', node, subs, variables) : node;
    }
    if (field.name === 'owner') {
      const node: NodeValue = { __type: 'User', login: repo.owner };
      return subs.length > 0 ? executeSelections(forge, 'User', node, subs, variables) : node;
    }
    if (field.name === 'defaultBranchRef') {
      const node: NodeValue = { __type: 'Ref', name: repo.defaultBranch };
      return subs.length > 0 ? executeSelections(forge, 'Ref', node, subs, variables) : node;
    }
    const scalar: Record<string, unknown> = {
      id: repo.globalId,
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      description: repo.description,
    };
    if (field.name in scalar) {
      if (subs.length > 0) throw new GqlError(`Field "${field.name}" on type "Repository" must not have a selection set.`);
      return scalar[field.name];
    }
    throw new GqlError(`Cannot query field "${field.name}" on type "Repository".`);
  }

  if (type === 'PullRequest') {
    const node = value as NodeValue;
    if (field.name === 'files') {
      const repo = node._repo as Repo;
      const pull = node._pull as Pull;
      const baseTree = treeOfCommit(forge, repo, pull.baseSha);
      const headTip = forge.resolveRef(repo, `refs/heads/${pull.headRef}`);
      const headTree = headTip === '' ? '' : treeOfCommit(forge, repo, headTip);
      const diff = forge.diffTrees(repo, baseTree, headTree);
      const first = typeof args.first === 'number' ? args.first : diff.size;
      const paths = [...diff.keys()].sort().slice(0, first);
      const conn: NodeValue = {
        __type: 'PullRequestChangedFileConnection',
        nodes: paths.map((p) => ({ __type: 'PullRequestChangedFile', path: p })),
      };
      if (subs.length === 0) return conn;
      const out: Record<string, unknown> = {};
      for (const s of subs) {
        if (s.kind !== 'field') continue;
        if (s.name === 'nodes') {
          out[s.alias ?? 'nodes'] = conn.nodes.map((n) => executeSelections(forge, 'PullRequestChangedFile', n, s.selections ?? [], variables));
        } else {
          throw new GqlError(`Cannot query field "${s.name}" on type "PullRequestChangedFileConnection".`);
        }
      }
      return out;
    }
    const scalar: Record<string, unknown> = {
      id: node.id,
      number: node.number,
      title: node.title,
      body: node.body,
      state: node.state,
      merged: node.merged,
      headRefName: node.headRefName,
      baseRefName: node.baseRefName,
      mergeable: node.mergeable,
    };
    if (field.name in scalar) return scalar[field.name];
    throw new GqlError(`Cannot query field "${field.name}" on type "PullRequest".`);
  }

  // Leaf / passthrough types: scalar fields live on the value itself.
  const record = value as Record<string, unknown>;
  if (field.name in record) {
    const v = record[field.name];
    if (subs.length > 0) {
      if (Array.isArray(v)) {
        return v.map((el) => {
          if (el !== null && typeof el === 'object') {
            const childType = (el as NodeValue).__type ?? type;
            return executeSelections(forge, childType, el as NodeValue, subs, variables);
          }
          return el;
        });
      }
      if (v !== null && typeof v === 'object') {
        const childType = (v as NodeValue).__type ?? type;
        return executeSelections(forge, childType, v as NodeValue, subs, variables);
      }
      throw new GqlError(`Field "${field.name}" on type "${type}" must not have a selection set.`);
    }
    return v;
  }
  throw new GqlError(`Cannot query field "${field.name}" on type "${type}".`);
}

export interface GraphqlResult {
  data: unknown;
  errors?: Array<{ message: string }>;
}

function executeOperation(forge: Forge, op: Operation, variables: Record<string, unknown>): GraphqlResult {
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: NodeValue = { __type: rootType };
  try {
    const data = executeSelections(forge, rootType, root, op.selections, variables);
    return { data };
  } catch (e) {
    if (e instanceof GqlError) {
      return { data: null, errors: [{ message: e.message }] };
    }
    throw e;
  }
}

/** Execute one GraphQL request body (object or array of operations). */
export function handleGraphql(forge: Forge, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => {
      if (item === null || typeof item !== 'object') return { data: null, errors: [{ message: 'request is not an object' }] };
      const rec = item as Record<string, unknown>;
      const query = typeof rec.query === 'string' ? rec.query : '';
      const variables = (rec.variables ?? {}) as Record<string, unknown>;
      try {
        const ops = new Parser(tokenize(query)).parseDocument();
        const op = selectOperation(ops, typeof rec.operationName === 'string' ? rec.operationName : undefined);
        if (!op) return { data: null, errors: [{ message: 'no operation found' }] };
        return executeOperation(forge, op, variables);
      } catch (e) {
        return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
      }
    });
  }
  if (body === null || typeof body !== 'object') {
    return { data: null, errors: [{ message: 'request body must be a JSON object' }] };
  }
  const rec = body as Record<string, unknown>;
  const query = typeof rec.query === 'string' ? rec.query : '';
  const variables = (rec.variables ?? {}) as Record<string, unknown>;
  try {
    const ops = new Parser(tokenize(query)).parseDocument();
    const op = selectOperation(ops, typeof rec.operationName === 'string' ? rec.operationName : undefined);
    if (!op) return { data: null, errors: [{ message: 'no operation found' }] };
    return executeOperation(forge, op, variables);
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
}

function selectOperation(ops: Operation[], name: string | undefined): Operation | undefined {
  if (ops.length === 0) return undefined;
  if (name !== undefined) return ops.find((o) => o.name === name);
  return ops[0];
}

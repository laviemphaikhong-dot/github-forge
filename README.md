# A GitHub-compatible git forge in one Node process

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/laviemphaikhong-dot/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/laviemphaikhong-dot/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

Entry for the make.fun bounty [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01).

A standalone forge that serves, from one process and its own in-memory
store, everything an agent client speaks:

- **git smart HTTP** — upload-pack protocol v2 (capability advertisement,
  ls-refs with ref-prefix/peel/symrefs/unborn, fetch with shallow/deepen and
  have negotiation) and v0, receive-pack v0 with report-status, side-band-64k
  and delete-refs; fast-forward-only updates, per-ref ok/ng reports. Packfiles
  are written and read natively (full objects out; ofs/ref deltas resolved
  in), no git binary anywhere.
- **REST v3** under `/api/v3` — repositories (create/list with Link
  pagination, patch, delete), contents (PUT/GET/DELETE as real git commits),
  branches, commits, git refs, labels, issues and comments, pull requests
  with file diffs and three-way merges (squash or merge commits).
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  github-mcp-server send: viewer, repository fields, issue/pullRequest
  connections with cursor pagination and ordering, the create/close/merge
  mutations, Relay `node(id:)`, `__type` introspection for Issue,
  PullRequest, Repository and SearchType, and operation batching.
- **MCP** at `/mcp` — JSON-RPC over Streamable HTTP, the 2026-07-28
  revision (`server/discover`) and the initialize handshake era, with
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request` acting on the same store
  as REST.

Everything is Node 22 standard library only (`node:http`, `node:crypto`,
`node:zlib`). State is deterministic: ids are sequential and timestamps
come from a logical clock, so a replayed trial answers byte for byte.

## Run

```sh
node main.ts
```

The platform runs `node /bot/main.ts`; `main.ts` is the entry ↔ env
lifecycle (bind an ephemeral port, register it with `$MAKEFUN_ENV_URL`,
poll `/done`, exit 0) and stays as the starter shipped it. The server
itself is `app.ts` plus `store.ts`, `git.ts`, `gitHttp.ts`, `rest.ts`,
`graphql.ts` and `mcp.ts`.

## Layout

- `main.ts` — the lifecycle (unchanged from the starter).
- `app.ts` — routing and auth for the four surfaces.
- `store.ts` — the in-memory store: repos, objects, refs, issues, pulls.
- `git.ts` — the git object model and packfile reader/writer.
- `gitHttp.ts` — smart HTTP: advertisements, ls-refs, fetch, receive-pack.
- `rest.ts` — the REST v3 resources and the merge engine.
- `graphql.ts` — a compact GraphQL parser/executor for the clients' documents.
- `mcp.ts` — the MCP endpoint and its six tools.

# WIKI.md — the repo-wiki schema

> This is the **schema and rulebook** for the repo-wiki. It is the wiki's equivalent of `CLAUDE.md`:
> it defines what the wiki is for, how pages are structured, the citation/freshness conventions, and
> the three workflows (ingest / query / lint). The agent reads this before maintaining the wiki.

## 1. What this wiki is (and is not)

The repo-wiki is a **persistent, interlinked map of *this* codebase** — the "fourth box" the harness was
missing. It answers **"what exists and where, and how does data flow"** so the agent navigates straight
to the right code instead of re-deriving structure by grep every session.

It sits beside the other three knowledge surfaces; it does **not** replace them:

| Surface | Axis | Loaded |
|---|---|---|
| `CLAUDE.md` | Operating law + router (stack, skill dispatch, non-negotiables) | Every prompt |
| `.claude/skills/` | **How to build** one part well (reusable craft) | On demand, by task |
| **`.claude/repo-wiki/` (this)** | **What exists & where** (this repo's live structure) | On demand, at task start |
| `…/memory/` | Cross-session preferences + identity | Per session |

**Skill = verb (how to build). Wiki = noun (what is built, where).** A feature page names its owning
skill; a skill points back to its feature page for current state.

### Hard rules
- **The code is the source of truth, never the wiki.** The wiki is a navigational index and a record of
  intent. If a page and the code disagree, the **code wins** — fix the page (that is a lint finding).
- **Every structural claim cites `path:line` or `path → symbol`.** No citation = not a wiki fact, just
  prose. Citations are what make the lint pass mechanically possible.
- **Line numbers drift.** Treat any `:line` as a *hint that must be re-confirmed* before you assert it as
  fact or edit there. The `path → symbol` half is the durable anchor; the line is a convenience.
- **The wiki is dev-only.** It lives under `.claude/` and is never shipped to or loaded by the product.

## 2. Directory layout & page taxonomy

```
.claude/repo-wiki/
  WIKI.md          # this schema
  index.md         # content catalog: every page + 1-line summary + cites + freshness, by category
  log.md           # append-only chronological record (ingest / query / lint), parseable prefix

  features/        # one page per vertical/feature: "what is this & how is it wired"
  flows/           # end-to-end data-flow traces (route → render) — the highest-value pages
  entities/        # "where does X live" reference pages (routes table, wire protocol, providers, tools…)
  rules/           # one cross-cutting non-negotiable each (expands a CLAUDE.md §, with the why)
  decisions/       # ADRs — why a choice was made + the alternative not taken
  glossary.md      # project vocabulary (the terms this repo uses that a newcomer would not know)
```

`features/`, `flows/`, and `entities/` are the load-bearing categories. `rules/`, `decisions/`, and
`glossary.md` are smaller and change rarely.

## 3. Page conventions

Every page starts with YAML frontmatter so `index.md` and lint can be generated/checked mechanically:

```markdown
---
title: Finance vertical
kind: feature            # feature | flow | entity | rule | decision | glossary
owning_skill: finance-markets   # the skill that teaches how to BUILD this (omit if none)
cites:                   # the real source files this page describes — the lint manifest
  - backend/finance/routes.ts
  - backend/finance/tools.ts
  - frontend/src/components/finance/finance-view.tsx
fresh: 2026-06-22        # last time a human/agent verified this page against the cited code
---
```

Body conventions:
- **Link related pages** with relative markdown links, e.g. `[ask-request-lifecycle](../flows/ask-request-lifecycle.md)`.
  Link liberally — a link to a page that doesn't exist yet marks a page worth writing.
- **Cite code inline** as `` `backend/lib/wire.ts → encodeEvent()` `` or `backend/index.ts:512`.
- **Flow pages are numbered walk-throughs** — each step names the file/symbol it happens in.
- Keep pages **short and navigational**. The wiki points at code; it does not duplicate it. If you find
  yourself pasting large code blocks, link instead.

## 4. The three operations

### Ingest — run AFTER building or changing a feature
The codebase analog of "a new source arrived." One change typically touches 5–15 pages.
1. Read the new/changed code.
2. Update the affected `features/` page(s); update or add the `flows/` trace if the flow changed.
3. Update the `entities/` pages it touches (whatever reference pages this repo keeps — e.g. `routes.md`, `data-model.md`, `jobs.md`, `config.md`).
4. Add a `decisions/NNNN-*.md` ADR **if a real decision was made** (a tradeoff, an alternative rejected).
5. Refresh each touched page's `fresh:` date and its line in `index.md`.
6. Append one entry to `log.md` (see §5).
Trigger: the `/wiki-ingest` command, and the Stop hook nudges it at the end of a feature.

### Query — run at the START of a task, before grepping
The behavior change that pays for the whole system.
1. Read `index.md`; open the 1–3 relevant `features/` / `flows/` / `entities/` pages.
2. Follow their citations **straight to the right code**, then read code.
3. If answering required discovering something not written down (an undocumented flow, a non-obvious
   coupling), **file it back** — create/update a page so the next session doesn't re-discover it.

### Lint — run periodically (and before a PR): drift detection
1. **Drift** — re-read each page's `cites:` files; flag any page describing a route/handler/event/symbol
   that no longer matches the code.
2. **Staleness** — `git log -1 --format=%cs -- <cited paths>`; if a cited file changed after the page's
   `fresh:` date, the page is suspect.
3. **Orphans** — pages with no inbound links from `index.md` or siblings.
4. **Gaps** — code with no page (a new route absent from `routes.md`; a registry entry absent from its entity page; a feature dir with no `features/` page).
5. **Contradiction** — two pages making incompatible claims.
Emit a punch-list; fix or file. Trigger: the `/wiki-lint` command.

## 5. index.md and log.md

**`index.md`** — content catalog, grouped by category. Each line: link + one-line summary + cited paths +
freshness. The cited paths make it double as the lint manifest:
```
## Flows
- [request-lifecycle](flows/request-lifecycle.md) — POST /search end to end.
  cites: src/server.ts, src/query/parse.ts, src/serve/rank.ts | fresh: 2026-08-05
```

**`log.md`** — append-only, newest at top, parseable prefix `## [YYYY-MM-DD] <op> | <title>` so
`grep "^## \[" log.md | head` gives a timeline:
```
## [2026-08-05] ingest | Seed the repo-wiki (server shell, query path, storage)
Touched: index.md, entities/routes.md, entities/data-model.md, features/search.md,
flows/request-lifecycle.md.
```

## 6. Relationship to the existing memory
The point-in-time `…/memory/` files are *de-facto wiki pages that never got structure*. Over time:
- **Decision-shaped** memory → `decisions/*.md` ADRs (with file citations, so they're lint-able).
- **Build/structure** memory (how a subsystem was built and wired) → `features/*.md` + `flows/*.md`.
- **Identity/preference** memory (operator preferences, product identity) → stays in memory / `rules/`.
Memory keeps holding cross-session *preferences*; structural facts graduate to the wiki where they can be
kept honest by lint.
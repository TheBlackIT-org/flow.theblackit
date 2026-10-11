# BlackIT Flow

A single vertical task chain per project. Every task carries its own status,
nothing is forced into order, and anyone can claim work that has no owner.

This is the Astro rebuild of the `workflow-chain.html` prototype: same screens,
same state model, same interactions — restructured into typed modules with a
test suite and a static build.

## Quick start

```bash
npm install
npm run dev        # http://localhost:4321
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Astro dev server with HMR |
| `npm run build` | Static build into `dist/` |
| `npm run preview` | Serve the built `dist/` |
| `npm run check` | `astro check` + `tsc` over the tests |
| `npm test` | Vitest (232 tests) |
| `npm run verify` | check + test + build |
| `npm run watch:schema` | waits for the shared schema to appear, then runs `check:supabase` automatically |
| `npm run check:two-clients` | live proof of instant push: one client writes, a second receives it over Realtime |
| `npm run check:supabase` | end-to-end check against the real project: schema, anon writes, atomic keys, the duplicate-key guarantee, the `updated_at` trigger, a live Realtime broadcast |
| `npm run shot -- <url> <out.png> <w> <h>` | headless-Chrome screenshot at an exact viewport, plus an overflow probe (Chrome's `--window-size` has a ~500px floor, so this drives CDP instead) |

## Shared workspace (Supabase)

Copy `.env.example` to `.env` and fill in the two public values from
**Supabase → Settings → API**:

```
PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

Then apply the schema once, either by pasting
[supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql) into the
dashboard's SQL Editor, or with the Supabase CLI:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

If the migration has not been applied yet, the app still runs: it falls back to
browser-local storage and shows a **setup banner** with the exact SQL to run.
The header chip distinguishes *Updates paused* (saving works, realtime is down)
from *Not saving* (writes are failing), and *Local only* (no backend configured).

**The shared workspace starts empty.** No sample content is created.
`PUBLIC_SEED_SAMPLE=true` in `.env` fills an empty database with a demo
workspace instead — useful for a fresh environment or a showcase, never for a
real team.

**No sign-in by design.** Everyone on the team picks their name under *Acting
as*. That means the URL and anon key are effectively the only protection on
this data — they are public by construction (they ship in the client bundle),
so treat the deployment URL as internal. Row Level Security is enabled on every
table with a permissive `anon` policy, so tightening to real accounts later is
a policy change rather than a schema or client change.

### How the data is laid out

```
workspaces ─┬─ members   (the "Acting as" list; user_id reserved for later auth)
            └─ projects ──── tasks ──── subtasks
                                └─ activity (append-only trail)
```

Task keys (`NE-1`, `NE-2`) come from `next_task_key(project_id)`, a Postgres
function that reserves the number atomically, so two people creating a task at
the same moment cannot be handed the same key. It is also **self-healing**: if
the counter is behind the keys already stored (a re-import, or a project seeded
outside the app), it jumps past the highest suffix instead of re-issuing a key
that exists. Seeding goes through `bootstrap()`, which sets each project's
counter to the number of tasks it holds.

### Sync behaviour worth knowing

| Situation | What happens |
| --- | --- |
| You edit anything | Applied locally immediately, written to Postgres ~0.2s later |
| Someone else edits | Pushed over Realtime and rendered in their tab within a second |
| Someone drags a card | Order is rewritten as `position`; others resync to avoid partial orders |
| Your laptop sleeps | The socket resubscribes; a focus listener and 60s heartbeat resync |
| The network is down | The change stays queued; writes retry with backoff (1.5s → 30s) and the chip counts pending changes and the next retry |
| The socket drops and returns | A resync fires immediately on reconnect, not just on the next heartbeat |
| Two people, same second | Each write carries its own mutation id; the origin drops its echo, everyone else applies it |
| Same field, same second | Last write wins; different tasks never conflict at all |

## What it does

- **One chain per project.** Tasks are a vertical list; order is cosmetic.
  Drag the **⠿ grip handle** on a card — and only the grip, so cards stay
  selectable — to reorder; a teal line shows where it will land. Reordering
  never touches a status.
- **Insert where you need it.** The **+** handle below a card drops a composer
  directly underneath it; *Add task at the end of the chain* appends.
- **Five statuses per task**, cycled by clicking the rail node:
  Not Taken → In Progress → In Review → Done → Blocked. Each status recolours
  the node, the card border and the connector segment.
- **Open pool.** A task with no owner shows *Take this task*; claiming records
  who took it and when, and moves it to In Progress.
- **Subtasks.** Any member can tick, add or delete steps; the chip shows
  progress.
- **Advisory dependencies.** `dependsOn` renders as "Waiting on …· optional,
  not enforced" — it informs, it never blocks.
- **Flow assistant.** Answers what is blocked, what is due, who is busiest and
  what is unowned; it can also draft a task from a sentence ("add task Publish
  the beta invite for Meera due friday"), reassign by key, or complete by key.
- **Shared by default.** With Supabase configured, every project, task,
  subtask and member lives in Postgres and every action is pushed to everyone
  else in real time. Without it, the app falls back to browser-local storage
  and works exactly as it did before — no backend needed to run or to test.
- **Instant push, two ways.** Your own edit applies locally first (so the UI is
  never waiting on the network) and flushes in the background; everyone else
  receives the row change over a realtime channel and re-renders. Each write is
  tagged with a mutation id so you ignore the echo of your own write.
- **Who's online, and what just happened.** The header chip shows connection
  state, writes still in flight, and who else has the board open; the panel
  beside it is the shared activity feed (and the audit trail the browser-only
  version never had).

## Architecture

```
src/
  pages/index.astro        prerendered shell + client entry
  layouts/Layout.astro     head, fonts, first-run guard, inline theme
  components/AppShell.astro  the element skeleton the client takes over
  scripts/main.ts          client entry: new BlackitFlowApp().start()
  styles/flow.css          the whole design system, ported 1:1
  lib/
    types.ts               the shared data model
    constants.ts           status/priority tables, action map, icons
    domain.ts              FlowDomain: seed, storage, mutations, assistant
    render.ts              every HTML string (server + client)
    reorder.ts             pure drop-target geometry
    sync.ts                write queue, realtime apply, reconnect/resync
    repository/
      types.ts             the WorkspaceRepository contract
      local.ts             browser-local implementation (demo + offline)
      supabase.ts          Postgres + Realtime implementation
      mappers.ts           row ⇄ domain mapping
      apply.ts             remote change application + echo suppression
      host.ts              repository selection and workspace bootstrap
    actions.ts             FlowActions: the click → mutation map
    app.ts                 BlackitFlowApp: DOM adapter, events, drag
test/
  domain.test.ts           rules: claim, cycle, ordering, assistant, storage
  app.test.ts              real DOM (happy-dom): clicks, modals, wizard, chat
  reorder.test.ts          drop-target maths, including no-op cases
  wiring.test.ts           markup actions ↔ handler coverage
  injection.test.ts        hostile user input stays inert in every renderer
  repository.test.ts       repository contract, echo suppression, reorder rule
  schema-contract.test.ts  the SQL migration and the mappers agree on names
  supabase-repository.test.ts  diff-flush, echo tagging, realtime wiring
  two-client-sync.test.ts      two browsers, one database, echo suppression
  helpers/fake-supabase.ts     a recording stand-in for PostgREST
```

Two decisions carry most of the design:

1. **`render.ts` is the only place markup exists.** The same functions produce
   the prerendered HTML and every client update, so the static build and the
   live app cannot drift apart.
2. **`domain.ts` never touches the DOM or storage APIs.** `FlowDomain` owns the
   rules and takes an injectable `Storage`, which is what makes the whole
   interaction model testable in Node.

Events are delegated from `document` to `[data-act]` elements, and
`test/wiring.test.ts` asserts that the set of actions the markup can emit
exactly equals the set `FlowActions.run()` handles.

## Divergences from the prototype

This build follows the prototype's behaviour except where the product owner
asked for a change. Deliberate, and covered by tests:

- **Reordering needs the grip.** The prototype let you drag a card from
  anywhere; here only the ⠿ handle starts a drag, so card text stays selectable
  and clicks are reliable.
- **The rail `+` inserts below its card.** The prototype inserted above.
- **The ⋯ menu offers no demo-data entries.** Only *New project*, *Add a task*,
  *Manage team*, *Export data as JSON*, *Ask the assistant* and *Reset to a
  fresh project*. The demo workspace is offered on the first-run welcome screen
  only.
- **The header is a four-slot grid** — brand · controls · compact progress ·
  menu — with the menu in its own slot so the controls can size independently.
  The compact percentage is always visible instead of expanding on scroll,
  which removes the old layout shift. On phones it collapses to two rows.
- **No "prototype" badge** in the brand — the product name stands alone.
- **`prefers-reduced-motion` is respected.** The pulsing node and flowing
  connector stop animating for users who ask for less motion.
- **A `noscript` note and real `aria-label`s** were added; the prototype had
  neither.
- **The assistant transcript escapes on the way in**, exactly as the prototype
  did, and additionally every id interpolated into an HTML attribute is
  escaped — ids can arrive from a hand-edited `localStorage` blob.

Everything else — seed data (32 tasks across 4 projects, 6 members), status
colours, drag thresholds, toast copy, assistant phrasing, the composer's
acting-user owner preselection, and both project-key derivations
(`keyFrom` and the New-project fallback) — follows the original line for line.
The key derivations are asserted value-for-value against the prototype in
`test/domain.test.ts`.
`docs/parity-audit.md` records the line-by-line audit, and every finding it
raised has a regression test in the suite.

## Browser support

Static HTML with one ES module. Works in current Chrome, Safari, Firefox and
Edge; `localStorage` is required for persistence but not for rendering.

## Deploying

The app is static — no server, no adapter. `npm run build` emits `dist/`.

**Target:** `https://flow.theblackit.com`

### Environment variables must be set on the host

`PUBLIC_*` values are inlined into the bundle **at build time**. If they are
missing, the deployed app silently falls back to browser-local mode: it looks
correct, shows "Local only", and shares nothing. Set these in the hosting
dashboard *before* the first build:

| Variable | Value |
| --- | --- |
| `PUBLIC_SUPABASE_URL` | your Supabase project URL |
| `PUBLIC_SUPABASE_ANON_KEY` | your Supabase anon key — safe to ship, it is public by design |
| `PUBLIC_SEED_SAMPLE` | `false` — never seed sample content into a real workspace |

### Build settings (Cloudflare Pages / Netlify / Vercel)

```
Build command      npm run build
Output directory   dist
```

### Caching

`/_astro/*` filenames are content-hashed, so they can be cached immutably.

### Security posture

There is **no authentication** by design — team members pick their name from an
"Acting as" list. The database is therefore open to anyone holding the URL:

- `public/robots.txt` and a `noindex` meta tag keep it out of search engines
- This is *not* access control. Put an identity gate (e.g. Cloudflare Access) in
  front of the domain if the contents are sensitive.

### DNS

Point the subdomain at the host with a CNAME record:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `flow` | your-host-target |

Remove any A/AAAA record the registrar auto-creates for the same name, or it
will conflict.

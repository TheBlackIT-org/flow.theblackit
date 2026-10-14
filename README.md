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
| `npm test` | Vitest (328 tests) |
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

Then apply the schema once, either by pasting the files in
[supabase/migrations/](supabase/migrations) into the dashboard's SQL Editor one
at a time, in order, or with the Supabase CLI:

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

## Sign-in

Sign-in is **opt-in** and off until you ask for it: set
`PUBLIC_REQUIRE_LOGIN=true` and the board waits behind a sign-in screen. Leave
it unset and the app behaves exactly as it did before — which is also why the
browser-local demo and the whole test suite stay login-free.

**Identity is the whole point.** Before sign-in, "who am I" was a dropdown
(*Acting as*), so an owner, a take-time or an audit entry was a claim about a
dropdown rather than a person. With sign-in on, that picker is gone: the header
names the signed-in account, and `members.user_id` records which account owns
which member row.

There are no passwords anywhere — nothing to hash, reset or leak.

### How a person gets in

1. An owner adds them under **Team**, with their email. That writes
   `members.email` — an invitation, not yet a binding.
2. They open the app and sign in with **GitHub** (or, if they have no GitHub
   account, ask for a sign-in link by email).
3. The first sign-in whose account matches an unclaimed invite claims that row:
   `members.user_id` is written, and every later sign-in goes straight to it.
   Matching is case-insensitive, because GitHub returns whatever capitalisation
   the person used when they registered.

Somebody who signs in without an invitation sees *"Not on this workspace yet"*
and nothing else. They never inherit another member's identity — which matters,
because the old code path quietly fell back to the first member row.

### If your workspace already exists

A team that used Flow *before* sign-in has member rows with names but no email
addresses, so there is nothing to invite them by and nobody could get in. For
exactly that case — and only while **nobody** in the workspace is bound — the
first person to sign in sees **"Which one of these are you?"** and picks their
own name once.

- The window closes the moment anybody is bound. After that the picker is gone
  permanently and joining is by invitation only.
- The refusal is enforced in the repository, not just the UI, and the claim
  write is filtered on `user_id is null`, so two people racing cannot both take
  the same row.
- It grants nothing that the anon key did not already grant before sign-in
  existed. It is a migration step, not an access-control feature.
- **Bind everyone before applying `0004_tighten_rls.sql`.** That migration is
  the cutover to real access control, and it deliberately does *not* carry the
  unbound-claim rule; afterwards an unbound teammate needs an email invite.

### Setting up the GitHub provider (once)

1. **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.**
   - Homepage URL: `https://flow.theblackit.com`
   - Authorization callback URL: `https://<project-ref>.supabase.co/auth/v1/callback`
2. **Supabase → Authentication → Providers → GitHub:** paste the client id and
   secret, and enable it.
3. **Supabase → Authentication → URL Configuration:** set the Site URL to
   `https://flow.theblackit.com` and add redirect URLs for it plus
   `http://localhost:4321/**` for development.
4. The client asks for the `read:user user:email` scope on purpose: without
   `user:email`, GitHub reports a private address as `null`, and the invitation
   it is meant to match cannot be found.

The email fallback works with Supabase's built-in mailer, but that is
rate-limited and meant for testing. Add custom SMTP (Resend, Postmark, …) before
relying on it, and note that typing the code from the email — rather than only
clicking the link — needs `{{ .Token }}` in the Magic Link template.

### Applying migrations in the right order

`0003_member_identity.sql` is **additive** and must be applied *before* the
client that requires sign-in is deployed. It only adds `members.email` and two
partial unique indexes, so the currently-deployed app is unaffected by it — but
the new client sends `email` on every member write, and PostgREST rejects a
whole upsert when a column is unknown. Additive first, then deploy.

`0004_tighten_rls.sql` is the **cutover**, and must be applied *last*:

| Order | Step | Why |
| --- | --- | --- |
| 1 | Apply `0003_member_identity.sql` | Additive; old client unaffected |
| 1b | Apply `0005_task_assignees.sql` | Additive; old client unaffected |
| 1c | Apply `0006_subtask_assignee.sql` | Additive; old client unaffected |
| 2 | Set `PUBLIC_REQUIRE_LOGIN=true` and deploy | The board now needs a session |
| 3 | Everyone signs in and is bound (existing team: the name picker; new team: the wizard, then email invites) | Confirm nobody is locked out |
| 4 | Apply `0004_tighten_rls.sql` | Replaces the permissive `anon` policies |

`0004` carries the highest-stakes change and runs **last, whatever its number** —
it is the moment the anon key stops being a credential. Everything before it is
additive and safe to apply while the old build is still live. Tell everyone to
reload after the deploy: a tab still running the previous build keeps working,
but its assignment writes are only visible to the new client through the
`tasks_mirror_assignee` bridge.

Applying `0004` before step 2 locks every deployed client out: their requests
carry no access token, so `anon` is denied and the board stops saving for the
whole team. Up to and including step 3 the anon key behaves exactly as it does
today.

`0004` drops the permissive policies, revokes `anon`, and grants to
`authenticated` only, with membership resolved through `SECURITY DEFINER`
helpers (`is_workspace_member`, `is_project_member`, `is_task_member`) — a
policy on `members` that queried `members` would recurse. The audit trail is
append-only by policy: there is no update or delete policy on `activity`.

### What sign-in deliberately does not do yet

- **No notifications.** Assignments do not alert anybody; that is the next
  piece of work.
- **No roles enforcement.** `owner`/`lead`/`member` are still labels. Any member
  can add or remove people, same as before.
- **Anybody with an email can create an account** (`shouldCreateUser`), then
  land on the "not invited" screen. Close sign-ups in
  **Supabase → Authentication → Sign In / Providers** once the team is in.

### How the data is laid out

```
workspaces ─┬─ members   (the "Acting as" list; email = invite, user_id = account)
            └─ projects ──── tasks ─┬─ subtasks
                                   ├─ task_assignees (who is on it — many, equal)
                                   └─ activity (append-only trail)
```

Assignment is a join table rather than a column because a task can have several
people on it. `tasks.assignee_id` still exists for the transition — see
`0005_task_assignees.sql` — but the client ignores it, and a trigger keeps the
old column and the join table in step so a tab still running the previous build
does not lose anybody's work.

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
- **Shared ownership.** A task can have any number of assignees, all equal — no
  primary owner and nobody demoted to a watcher. The card shows overlapping
  faces plus a count, ticking people in the **Assign people** modal sets the
  whole list, and **Assign me too** puts you on somebody else's task without
  disturbing them. An empty list is the open pool, and anyone can
  **Take this task**.
- **Subtasks, with owners.** Any member can tick, add or delete steps; the chip
  shows progress. Any step can be handed to one person — the row shows their
  face, the picker has *Assign to me* in its footer, and a step without an owner
  is the normal state rather than a gap. A task's people and a step's owner are
  separate: sharing happens at the task, a step is one person's action.
- **Advisory dependencies.** `dependsOn` renders as "Waiting on …· optional,
  not enforced" — it informs, it never blocks.
- **Flow assistant.** Answers what is blocked, what is due, who is busiest and
  what is unowned; it can also draft a task from a sentence ("add task Publish
  the beta invite for Meera due friday"), reassign by key, or complete by key.
- **Shared by default.** With Supabase configured, every project, task,
  subtask and member lives in Postgres and every action is pushed to everyone
  else in real time. Without it, the app falls back to browser-local storage
  and works exactly as it did before — no backend needed to run or to test.
- **Real identity, when you want it.** `PUBLIC_REQUIRE_LOGIN=true` puts a
  sign-in screen in front of the board: GitHub OAuth, or an emailed link and
  code. Your account binds to a member row, the *Acting as* picker disappears,
  and assignments and audit entries name a person instead of a dropdown. Off by
  default, and ignored entirely in the browser-local build.
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
    auth.ts                AuthPort: GitHub OAuth + email link, and NoAuth
    domain.ts              FlowDomain: seed, storage, mutations, assistant
    render.ts              every HTML string (server + client)
    reorder.ts             pure drop-target geometry
    sync.ts                write queue, realtime apply, reconnect/resync
    repository/
      types.ts             the WorkspaceRepository contract
      client.ts            the one Supabase client auth and data share
      local.ts             browser-local implementation (demo + offline)
      supabase.ts          Postgres + Realtime implementation
      mappers.ts           row ⇄ domain mapping
      apply.ts             remote change application + echo suppression
      host.ts              repository selection and workspace bootstrap
    actions.ts             FlowActions: the click → mutation map
    app.ts                 BlackitFlowApp: DOM adapter, events, drag
supabase/migrations/
  0001_init.sql            tables, task-key function, permissive RLS
  0002_add_mutation_ids.sql  the echo-suppression tag on members/projects
  0003_member_identity.sql   members.email + the two unique indexes (additive)
  0004_tighten_rls.sql       the cutover: authenticated members only (RUN LAST)
  0005_task_assignees.sql    the join table + backfill + the stale-tab bridge
  0006_subtask_assignee.sql  a step can be somebody's (one person, not many)
test/
  domain.test.ts           rules: claim, cycle, ordering, assistant, storage
  app.test.ts              real DOM (happy-dom): clicks, modals, wizard, chat
  login.test.ts            the sign-in gate, account binding, invites, sign-out
  auth.test.ts             the auth port: calls made, errors translated
  account-link.test.ts     invite claiming: matching, ambiguity, migrations
  reorder.test.ts          drop-target maths, including no-op cases
  wiring.test.ts           markup actions ↔ handler coverage
  injection.test.ts        hostile user input stays inert in every renderer
  repository.test.ts       repository contract, echo suppression, reorder rule
  schema-contract.test.ts  the SQL migrations and the mappers agree
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
3. **Sign-in is a port, not a provider call.** `auth.ts` exposes `AuthPort`;
   the browser-local build is handed `NoAuth`, and the sign-in screen is
   rendered by the same functions the tests drive. That is what keeps "no
   accounts anywhere" a supported configuration rather than a special case.

Events are delegated from `document` to `[data-act]` elements, and
`test/wiring.test.ts` asserts that the set of actions the markup can emit
exactly equals the set `FlowActions.run()` handles.

## Divergences from the prototype

This build follows the prototype's behaviour except where the product owner
asked for a change. Deliberate, and covered by tests:

- **Reordering needs the grip.** The prototype let you drag a card from
  anywhere; here only the ⠿ handle starts a drag, so card text stays selectable
  and clicks are reliable.
- **Sign-in replaces *Acting as* once it is switched on.** With an account
  bound to a member row, the impersonation picker is removed rather than kept
  alongside it. Without a backend it stays exactly as the prototype had it.
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
| `PUBLIC_REQUIRE_LOGIN` | `true` to require sign-in. Leave unset during the rollout — see *Applying migrations in the right order* |

### Build settings (Cloudflare Pages / Netlify / Vercel)

```
Build command      npm run build
Output directory   dist
```

### Caching

`/_astro/*` filenames are content-hashed, so they can be cached immutably.

### Security posture

**Sign-in on (`PUBLIC_REQUIRE_LOGIN=true`) plus `0004_tighten_rls.sql`:** the
database is readable only by accounts that belong to a workspace. The anon key
is then what it is meant to be — a public identifier for the project, not a
credential. Keep `public/robots.txt` and the `noindex` meta tag, and put an
identity gate (e.g. Cloudflare Access) in front of the domain if you want the
sign-in screen itself to be private.

**Sign-in off:** there is no authentication at all. The URL and anon key are
the only protection, and they are public by construction (they ship in the
client bundle), so treat the deployment URL as internal. This is the state a
fresh deployment is in, and it is why the cutover above is ordered the way it
is.

In both states, sign-in is **not** role enforcement: every member can add
people, edit every task and reset the workspace. Tightening that is a policy
change on the same schema.

### DNS

Point the subdomain at the host with a CNAME record:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `flow` | your-host-target |

Remove any A/AAAA record the registrar auto-creates for the same name, or it
will conflict.

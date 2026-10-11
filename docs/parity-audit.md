# Behavioural parity audit — BlackIT Flow port vs `workflow-chain.html`

**Source of truth:** `/Users/shithin/.aside/u/0/sessions/2026-10-10_p38Yjg3Tfifik04g/artifacts/workflow-chain.html` (1401 lines).
**Port under review:** `/Users/shithin/Blackflow` (Astro 7 + TS).
**Audited at:** 2026-10-10 20:00:26 IST.
**Read-only audit** — the only file written is this report.

## Summary

The port is a close, well-structured translation of the prototype: seed data is byte-for-byte
equivalent, the status/priority tables and `data-act` wiring are complete and orphan-free, every
emitted CSS class is styled, and the reorder/escape/modal/filter/team/assistant logic matches the
prototype step for step. I found **2 BLOCKERs, 5 MAJORs, 8 MINORs and 5 NOTEs**.

Two of the BLOCKER/MAJOR items are regressions introduced *by edits made while this audit was
running* (the inline-composer owner preselection was removed from `render.ts`, and the reset/load-demo
confirmation is still absent), so the tree must be frozen before the Lead's final sign-off. The port
changed at least six times during the audit (see snapshot hashes below); findings were re-verified
against the final hashes, and `npx vitest run` (92 tests, 4 files) was green at that revision.

Two things are cleanly verified because they are mechanical: (1) all 48 `data-act` values in markup
are declared (44 click actions + 4 change actions) and every one has a handler — no orphans in either
direction; (2) no prototype CSS class was dropped and no emitted class is unstyled except `.btn.sm`,
which the prototype also leaves unstyled.

### Audit snapshot (md5 of the revision reviewed)

| File | md5 |
| --- | --- |
| src/lib/constants.ts | e9e1965e499676f6eeffaaf6cbd0b61f |
| src/lib/types.ts | a4a4a4bc1ba8bdb65fa9da7a38e4165b |
| src/lib/domain.ts | 74b6ca4e3e3a342876cdc2445e090854 |
| src/lib/reorder.ts | 4ac550d43d48a6de95d4f9f5182a80d3 |
| src/lib/render.ts | 73759b1586e96fe05ea1f5614681f02b |
| src/lib/actions.ts | 7bf93a48101e255090a1822fe774995c |
| src/lib/app.ts | fe77df336608fa9d7242cc5d3e9c8cee |
| src/styles/flow.css | e7b5b4181b557056e7ed8983ddfc1d89 |
| src/components/AppShell.astro | d9bad3eee5aef4c7d5509280ee3d25f6 |
| src/layouts/Layout.astro | 49781062ba764e1eba84d1df9952df6f |
| src/pages/index.astro | 752b9ded195336b8c0ae1acbf8a9aa49 |
| src/scripts/main.ts | cba22c088ae296d5decb4d28396ae21a |
| test/domain.test.ts | 83ff2da8d1e12eb4f61114a8122f64e6 |
| test/app.test.ts | 60b95ae19d31964c18018d4bce1a3928 |
| test/reorder.test.ts | 897be0497f587d9293eccfcdedda44b6 |
| test/wiring.test.ts | 66833bed2a41fc7adeb87ebef7a2f4f5 |

Gates at this revision: `npx vitest run` → **92/92 pass**; `npx astro check` → **0 errors**.

---

## Verified-matching checklist

1. **Constants** — `STATUS` (5 entries, ids/labels/`cls`/`color`/`line`), `PRIO` (4), `CYCLE`
   (`TODO → PROG → REVIEW → DONE → BLOCK`), `PALETTE`, `DEFAULT_TYPES`, `ICON`, brand/chain glyphs are
   value-identical to the prototype.
2. **Status cycle order** — `domain.cycleStatus` + `setStatus` (`completedAt` stamped on DONE only,
   cleared otherwise) match; only the toast is missing (MIN-8).
3. **Claim** — no-`me` guard ("Add yourself in Team first"), "Already taken by X", sets
   `assigneeId/claimedBy/claimedAt`, `TODO → PROG`, toast wording — match.
4. **Reassign / unassign** — assign sets owner + take time and starts a TODO task; empty owner clears
   `assigneeId/claimedBy/claimedAt` and toasts "back in the open pool" — match.
5. **Delete task** — confirm text `Delete KEY · title?`, removal, `<key> deleted` toast — match.
6. **Subtasks** — index-based toggle, add (trim, `open = true`, toast), delete, Enter-key delegation —
   match (focus side effect diverges, MAJ-6).
7. **Insert / compose-end / cancel-compose** — `composer` + `composerAnchor` bookkeeping, `#newTitle`
   focus after opening, cancel clears both — match.
8. **create** — empty-title guard, `typeId/owner/due/priority/desc` mapping, `stage: 'New'`,
   `estimate: 3`, due parsed at `T12:00:00`, `PROG` when an owner is set, anchor insert, entrance
   animation, toast wording — match (default owner diverges, MAJ-4).
9. **Filters** — member `all`/`none`/id, status chips, `clear-filters`, "Nothing matches these
   filters" state — match.
10. **Project switch / acting-as switch** — project change keeps filters and closes the composer;
    acting-as only accepts a known member — match.
11. **Team** — row markup (avatar, `title || role`, role select, remove), add member (trim, first
    member becomes `me`, toast, modal stays open), remove member (last-member guard, owned-task
    confirm, tasks returned to the open pool, `me` re-pointed), role change persisted — match.
12. **Workspace menu** — 8 items in order, "Reset demo data" only in demo mode, popover toggle and
    outside-click close — match except confirmation (BLK-2).
13. **Welcome screen** — Start fresh / Explore the demo choices, `booting` class, copy — match
    (product name rebranded, NOTE-16).
14. **Wizard** — 3 steps, step dots, name/project validation toasts, Back/Continue/Skip/Finish
    footers, member + project creation, `mode/setup/fMember/fStatus/composer` reset, returns to the
    chain with the composer open — match (key preview, MAJ-7).
15. **Modal** — scrim click closes, `formData()` over `#modal [name]`, submit closes unless the
    callback returns `false`, edit/reassign/project/team bodies and footer labels — match.
16. **Escape precedence** — modal → chat → composer → open popovers — match.
17. **Assistant** — chips, send (trim, ignore empty), Enter, transcript rendering, preview +
    Add/Discard, and every reply branch (blocked, due, workload, unowned, progress, reorder,
    subtasks, insert, claim/assign, greeting, fallback); `parseTask` priority/weekday/"in N days"
    heuristics and owner/date stripping — match (greeting lifecycle, MAJ-3).
18. **Drag reorder** — grip-only plus free mouse-drag, 6px threshold, ghost, midpoint marker, end
    anchor, edge auto-scroll, no-op rules (`to === from`, `to === from + 1`), `__end__` append,
    order never touches status, "moved to position N" toast — match (`reorder.ts` extraction keeps
    the same geometry; escaping diverges, BLK-1).
19. **Seed data** — 32 rows byte-identical to the prototype rows; per project 15 / 6 / 6 / 5; keys
    `NE-1..NE-15` (t12 is last → `NE-15`), `NLM-1..6`, `WEB-1..6`, `FLOW-1..5`; `t28` absent;
    statuses, owners, priorities, estimates, due offsets, `dependsOn` edges, `createdAt`/
    `completedAt` formulas and the 10 subtask lists all match.
20. **Storage** — `hydrate`/`normalise` backfill (`mode`, `setup`, `types`, `subs`/`dependsOn`
    arrays), corrupt payload falls back to a blank workspace — matches the prototype `load()`.
21. **Action wiring** — 48 `data-act` values used in `render.ts`/`AppShell.astro` = 44 `ACTIONS` + 4
    `CHANGE_ACTIONS`; every declared action has a handler in `run()`/`onChange()`. No orphan in
    either direction.
22. **CSS** — no prototype class is missing from `flow.css`; all emitted classes resolve to a rule
    except `.btn.sm` (also unstyled in the prototype). Formatting-only differences ignored.
23. **Lifecycle hygiene** — one `bind()` per app instance (no listener growth), scrim listener bound
    once, toast timers self-clean, and `endDrag` resets ghost/classes/marker/`drag`/`dropAnchor` on
    both `pointerup` and `pointercancel`. `ctx.domain` is a getter onto `app.domain`, so
    `replaceDomain()` cannot leave renderers on a stale workspace — verified.
24. **XSS scan** — the only unescaped user-controlled interpolation in `render.ts`/`app.ts` is the
    drag ghost (BLK-1); task titles, descriptions, stages, member names, chat text and assistant HTML
    all pass through `esc()`.

---

## Findings

Severities: **BLOCKER** = broken behaviour / data loss / crash / security · **MAJOR** = visible
divergence · **MINOR** = cosmetic or edge case · **NOTE** = intentional/documented divergence or
acceptable design choice.

| ID | Severity | Area | Evidence (prototype → port) | Consequence |
| --- | --- | --- | --- | --- |
| BLK-1 | BLOCKER | Drag ghost XSS | Prototype `startDrag` escapes everything: `esc(t.key)`, `esc(statusOf(t.status).label)`, `esc(t.title)` (HTML 961). Port `app.ts:409` assigns raw values: `g.innerHTML = ...<div class="gt">${t ? t.title : ''}</div>` | A task title is user-controlled (composer, edit modal, assistant). A title such as `<img src=x onerror=alert(1)>` executes when its card is dragged — stored XSS in the workspace. `t.key` is also unescaped (generated, lower risk). |
| BLK-2 | BLOCKER | Reset / Load demo data loss | Prototype: `resetAll(){ if(confirm('Reload the demo workspace? This replaces your current data.')){ db = seed(); ... } }` and both `case 'reset'` and `case 'ws-demo'` call `resetAll()` (HTML 629, 1286-1289). Port: `case 'reset': case 'ws-demo': this.loadDemo();` and `loadDemo(){ this.replaceWorkspace('demo'); }` — no confirm anywhere (`actions.ts:291-295`, `642-644`) | One click on "Reset demo data" or "Load demo data" silently destroys the current workspace (tasks, members, projects, chat) with no confirmation and no undo. |
| MAJ-3 | MAJOR | Assistant greeting after workspace swap | Prototype `renderChat()` always calls `chatInit()`, which re-pushes the greeting whenever `chat.msg` is empty (HTML 1010-1014); `resetAll`/`loadDemo`/`finishSetup` only clear `chat.msg` (HTML 629, 1194, 1233). Port calls `ensureGreeting` exactly once in `start()` (`app.ts:63`, def `actions.ts:517`) while `replaceWorkspace` (`actions.ts:652`) and `finishSetup` (`actions.ts:631`) empty the transcript | After "Load demo data", "Start a fresh workspace" or finishing the wizard, opening the assistant shows a completely empty panel (no greeting, the chips and input only). The prototype always re-greets with the current user's name. |
| MAJ-4 | MAJOR | Inline composer default owner | Prototype composer Owner select marks the acting user: `<option value="'+x.id+'" '+(x.id===db.me?'selected':'')+'>` (HTML 866-868). Port renders plain options with no `selected` (`render.ts:319-324`) | "Add task" from the inline composer now creates an unowned `TODO` ("… · not taken yet", "Take this task" button) where the prototype created a `PROG` task claimed by the acting user ("… · assigned to Arjun Menon"). Default owner of every composed task regressed. |
| MAJ-5 | MAJOR | Add-at-end button hidden during insert | Prototype pushes the addend unless the composer is open **with no anchor**: `if(!(db.composer !== null && !db.composerAnchor))` (HTML 773-777). Port only pushes when `composer === null` (`render.ts:367`) | While the "insert here" composer is open (rail `+`), the "Add task at the end of the chain" button disappears, so the user must cancel and reopen to append. |
| MAJ-6 | MAJOR | Subtask focus after add | Prototype: `t0.subs.push(...); db.focusSub = id; render();` and `render()` refocuses `[data-subinput=id]` (HTML 1336-1337, 643). Port sets `this.focusSub = id` but then calls only `renderChain()` (`actions.ts:167-168`); `focusSub` is consumed only in `refresh()` (`actions.ts:94-97`) | Typing a subtask and pressing Enter re-renders the card and loses input focus, so consecutive subtask entry breaks. The stale `focusSub` also hijacks focus on the next unrelated refresh. |
| MAJ-7 | MAJOR | Project-key derivation | (a) Wizard step-2 re-render uses `domain.keyFrom` (`render.ts:503`) while live typing and `finishSetup` use `actions.keyFromSafe` (`actions.ts:590`, `616`). (b) Prototype modal fallback deletes non-letters: `.replace(/[^A-Za-z ]/g,'')` (HTML 1210); port `createProject` replaces with a space: `.replace(/[^A-Za-z ]/g,' ')` (`domain.ts:663-669`). Computed from the quoted source: "Mobile app v1" → prototype `MAV`, typed preview `MAV`, but after Back→Continue the preview becomes `MV`; "Redesign" → prototype `REDE`, port `RED`; "theblackit.com Redesign" with an empty Key field → prototype `TR`, port `TCR` | Task-ID prefixes are user-visible and used to reference work. The wizard preview flips value when navigating back, and single-word project names get `RED-1` instead of `REDE-1`; the "+ Project" modal derives `TCR-1` instead of `TR-1` for names with punctuation. |
| MIN-8 | MINOR | Node click feedback | Prototype `case 'cycle'` → `cycleStatus` → `setStatus` toasts `<key> → <label>` (HTML 579, 1254). Port `case 'cycle'` re-renders with no toast (`actions.ts:126-131`) | Clicking a status node silently changes status; the prototype confirmed the transition with a toast. |
| MIN-9 | MINOR | Extra toasts | Prototype `chat-add` has no toast (HTML 1350-1362) and `startFresh` has none (HTML 630-634). Port toasts `${t.key} added` (`actions.ts:537`) and "Fresh workspace ready" (`actions.ts:660`) | Extra feedback the prototype never showed (harmless, but a visible difference). |
| MIN-10 | MINOR | Reset toast wording | Prototype `resetAll` toasts "Demo data loaded" (HTML 629); port always toasts "Demo workspace loaded" (`actions.ts:660`) | Wrong copy on the reset path. |
| MIN-11 | MINOR | Edit modal trims title | Prototype validates `d.title.trim()` but assigns the raw value: `t.title = d.title` (HTML 902-903); port assigns the trimmed value (`actions.ts:437`, `442`) | Leading/trailing spaces entered in the edit modal are silently stripped. |
| MIN-12 | MINOR | `replaceWorkspace` vs `closeModal` | Prototype `startFresh` calls `closeModal()` (HTML 632); port only resets `this.modal = { onOK: null }` and never calls `ctx.closeModal()` (`actions.ts:651-661`) | Latent: if a workspace swap is ever triggered while the modal is visible, the overlay stays on screen. Not reachable through the current UI (scrim covers the header), but the prototype guaranteed it. |
| MIN-13 | MINOR | Wizard product fallback | Prototype uses `wz.product.trim() || wz.project.trim()` as the project product (HTML 1186); port passes `wz.product || wz.project` into `createProject`, which then does `product.trim() || 'My workspace'` (`actions.ts:616`, `domain.ts:673`) | A whitespace-only product in wizard step 2 yields "My workspace" instead of the project name. |
| MIN-14 | MINOR | Doc/comment drift | `domain.ts:147` and `test/domain.test.ts:33` say "33 tasks" but `seed()` builds 32 (verified). `index.astro:5` claims the page "is prerendered to static HTML from the demo workspace, so it is meaningful without JavaScript", but `AppShell.astro` renders empty containers and `dist/index.html` contains 0 `data-task` rows | Misleading comments/tests for the next reader; no runtime impact. |
| MIN-15 | MINOR | `confirm` fallback | Port: `confirm: (message) => typeof globalThis.confirm === 'function' ? globalThis.confirm(message) : true` (`app.ts:109-110`); prototype calls `confirm(...)` directly | Outside a browser (tests/SSR) destructive confirmations (delete task, remove member, start fresh) auto-approve. Deliberate test seam, but it means the guard can never fail closed and the port's tests cannot exercise a declined confirm. |
| NOTE-16 | NOTE | Intentional rebrand | `APP_NAME = 'BlackIT Flow'` vs "Workflow Chain", `STORAGE_KEY = 'blackit_flow_v1'` vs `'workflow_chain_v2'` (`constants.ts:11-12`), export file/toast `blackit-flow.json` vs `workflow-chain.json` (`app.ts:201-204`) | Documented product rename; means existing prototype storage is not migrated (acceptable, but worth stating). |
| NOTE-17 | NOTE | `keyFrom` divergence is mis-documented | `test/domain.test.ts:325-332` asserts `keyFrom('Mobile app v1') === 'MV'` and `keyFrom('theblackit.com Redesign') === 'TR'` with the comment "The prototype produced TCR here (it kept the leading article and the TLD)". The prototype's `keyFrom` (HTML 1141-1145) actually produces `TR`; `TCR` is what the port's `createProject` fallback produces (MAJ-7b) | The stated justification is factually wrong, so the "documented divergence" note cannot be relied on; it also hides the real `keyFrom` divergence (stop-word removal, `MV` vs `MAV`). |
| NOTE-18 | NOTE | Reduced-motion block added | `flow.css:376-379` adds `@media (prefers-reduced-motion: reduce)` disabling pulse/flow/enter animations; the prototype has no such block | Intentional accessibility improvement, not a parity defect; no class names added. |
| NOTE-19 | NOTE | `.btn.sm` unstyled | Both the prototype style block and `flow.css` have no `.sm` rule, yet markup emits `btn sm` (render.ts:119-121, and `teamBody`) | Pre-existing prototype gap faithfully reproduced — not a regression. Every other emitted class resolves. |
| NOTE-20 | NOTE | Additive a11y/no-JS affordances | Port adds `role`/`aria-label`/`aria-live` on `#fab`/`#chat`/`#toast` (`AppShell.astro:31-36`), a `<noscript>` notice (`index.astro:16-21`) and the `first-run` flash guard (`Layout.astro:35-49`) | Additions with no prototype counterpart; they do not change prototype behaviour. |

---

## Recommended actions (ordered by severity)

1. **BLK-1 — escape the drag ghost** (`app.ts:409`): use `esc(t.key)`, `esc(statusLabelOf(...))`,
   `esc(t.title)`, or build the ghost with `textContent`. This is the only XSS site found.
2. **BLK-2 — restore the confirmation for `reset` / `ws-demo`** (`actions.ts:291-295`): route both
   through a `resetAll()`-equivalent that runs `confirm('Reload the demo workspace? This replaces your
   current data.')`. Leave `welcome-demo` (Load demo from the welcome screen) unconfirmed, as the
   prototype did.
3. **MAJ-3 — make the greeting lazy again**: call `ensureGreeting`/`chatGreeting` inside `renderChat`
   whenever the transcript is empty (or re-seed the greeting in `replaceWorkspace` and `finishSetup`
   after clearing), matching `chatInit()`.
4. **MAJ-4 — restore the composer owner preselection** (`render.ts:319-324`): mark the acting user's
   option `selected` so composed tasks default to them, as the prototype does.
5. **MAJ-5 — fix the addend condition** (`render.ts:367`): push the add row when
   `!(composer !== null && !composerAnchor)`.
6. **MAJ-6 — restore subtask focus**: in `case 'sub-add'`, call `this.refresh()` (which consumes
   `focusSub`) instead of `this.ctx.renderChain()`, or focus the input directly.
7. **MAJ-7 — collapse to one key derivation** that matches the prototype (initials for multi-word;
   single word = full word upper-cased then `slice(0,4)`): use it in `wizardBody`,
   `syncWizardKeyPreview` and `finishSetup`, and make `createProject`'s fallback delete non-letters
   rather than replacing them with spaces. Update `test/domain.test.ts` expectations and drop the
   incorrect comment.
8. **MIN-8/9/10 — align feedback**: add the missing `<key> → <label>` toast on node click, remove the
   two extra toasts (chat-add, fresh), and use "Demo data loaded" on the reset path.
9. **MIN-11/12/13/14 — small alignments**: stop trimming the edited title (or document it), call
   `ctx.closeModal()` in `replaceWorkspace`, fix the wizard product fallback, and correct the "33
   tasks"/"prerendered" comments.
10. **MIN-15 — keep the test seam but fail safe**: default a missing `confirm` to `false` for
    destructive actions, or inject the confirm function through the test harness instead of a global.
11. **Freeze the revision before sign-off** and re-run `npx vitest run` + `npx astro check`: the tree
    changed repeatedly during this audit (including a MAJOR regression introduced mid-audit), so the
    Lead should re-diff against the hashes above before declaring parity.

---

# Re-verification (revision 2 — fixed / frozen)

Re-audited the delta only, against the original prototype and the current source.
**Revision 2 snapshot (md5):** domain `bdc5173933252581c804ec6925fec2ce` · render
`c6fb827f37117c9c937f1985dbdacce2` · actions `e513816a7bbca694b41141dc7df09050` · app
`6bfb89acc66ecb5ed16f468e04d7b395` · reorder `4ac550d43d48a6de95d4f9f5182a80d3` · constants
`e9e1965e499676f6eeffaaf6cbd0b61f` · types `a4a4a4bc1ba8bdb65fa9da7a38e4165b` · flow.css
`e7b5b4181b557056e7ed8983ddfc1d89` · AppShell `d9bad3eee5aef4c7d5509280ee3d25f6` · Layout
`49781062ba764e1eba84d1df9952df6f` · index `752b9ded195336b8c0ae1acbf8a9aa49` · main
`cba22c088ae296d5decb4d28396ae21a` · tests: app `9f649a3b65e1cbc979119a63a0a54643`, domain
`098715874d330189020103dee0f1da08`, injection `9261a4c549a01f40ae4166875ce138b0`, reorder
`897be0497f587d9293eccfcdedda44b6`, wiring `66833bed2a41fc7adeb87ebef7a2f4f5`.

**`npm run verify` (run at 20:13): PASS, exit 0.** `astro check` → 0 errors / 0 warnings / 0 hints over
14 files; `tsc -p test/tsconfig.json --noEmit` → 0 errors; `vitest run` → 5 files, **111/111 tests
pass**; `astro build` → 1 static page, complete.

## Per-finding verdict

| ID | Verdict | Evidence in revision 2 |
| --- | --- | --- |
| BLK-1 | **FIXED** | `app.ts:415-417` builds the ghost with `esc(t.key)`, `esc(statusLabelOf(t.status))`, `esc(t.title)`, matching the prototype's escaped ghost (HTML 961). |
| BLK-2 | **FIXED** | `actions.ts:294-298` routes `reset`/`ws-demo` to `loadDemo(true)`; `loadDemo` (`650-658`) confirms with the prototype's exact wording "Reload the demo workspace? This replaces your current data."; `welcome-demo` (`328-331`) → `loadDemo(false)` (no confirm, as HTML 1233). `app.ts:110-111` now defaults to **false** when `globalThis.confirm` is absent; `replaceWorkspace` (`665-666`) calls `ctx.closeModal()`. Tests cover accept, decline and confirm-unavailable. |
| MAJ-3 | **FIXED** | `app.ts:142-146` calls `ensureGreeting(chatGreeting(this.domain))` at the top of every `renderChat`, mirroring `chatInit()`; `ensureGreeting` still guards on `!msg.length` (`actions.ts:526-528`), so no duplication. `start()` no longer calls it separately. |
| MAJ-4 | **FIXED** | `render.ts:322-325` restores `x.id === domain.workspace.me ? 'selected' : ''`. Test asserts `#newOwner.value === 'm1'` and the created task is `PROG`/`m1`. |
| MAJ-5 | **FIXED** | `render.ts:370` is now `if (!(composer !== null && !composerAnchor))` — the prototype's guard (HTML 773) exactly. |
| MAJ-6 | **FIXED** | `actions.ts:169` stores the full selector `[data-subinput="id"]`, `171` calls `refresh()`, and `refresh` consumes it at `94-97`. |
| MAJ-7 | **PARTIALLY FIXED** | The three implementations are gone: `render.ts:506`, `actions.ts:598`/`624` and `createProject` all use one `keyFrom`. Single-word names keep 4 letters ("Redesign" → `REDE`, was `RED`) and the punctuation case matches ("theblackit.com Redesign" → `TR`). **Still divergent:** `keyFrom` filters `STOP_WORDS` and strips TLDs, which the prototype never did. Executing the current source: "Mobile app v1" → port `MV` vs prototype `MAV`; "Natil Evidayaa · Mobile App" → `NEM` vs `NEMA`; "New Website" → `WEBS` vs `NW`; "Our new tool" → `TOOL` vs `ONT`; "App v1" → `V` vs `AV`. **New regression on the modal path:** `createProject`'s empty-key fallback now delegates to `keyFrom`, so "+ Project" with a one-word name yields `REDE` where the prototype's `openProjectModal` derivation yields `R` (HTML 1210), and `WEBS` where it yields `NW`. |
| MIN-8 | **FIXED** | `actions.ts:126-132` toasts `${t.key} → ${statusLabel(t.status)}` after cycling, matching `setStatus`'s toast (HTML 579). |
| MIN-9 | **FIXED** | `addAssistantTask` no longer toasts (`530-546`); `replaceWorkspace` toasts only for demo (`676`), so "Fresh workspace ready" is gone. Both match the prototype. |
| MIN-10 | **NOT FIXED** | `actions.ts:676` still toasts "Demo workspace loaded" on the `reset`/`ws-demo` path; the prototype's `resetAll` says "Demo data loaded" (HTML 629); only `loadDemo` (welcome) says "Demo workspace loaded". |
| MIN-11 | **FIXED** | `actions.ts:442-448` validates on `title.trim()` but assigns the raw `title`, exactly like HTML 902-903. |
| MIN-12 | **FIXED** | `actions.ts:666` — `replaceWorkspace` calls `ctx.closeModal()`. |
| MIN-13 | **FIXED** | `actions.ts:624` uses `wz.product.trim() \|\| wz.project`, so a whitespace-only product falls back to the project name (HTML 1186). |
| MIN-14 | **NOT FIXED** | `domain.ts:147` and `test/domain.test.ts:33` still say "33 tasks"; `index.astro:5-7` still claims the page is "meaningful without JavaScript" while `AppShell.astro` renders empty containers and the rebuilt `dist/index.html` contains 0 `data-task` rows. |
| MIN-15 | **FIXED** | `app.ts:110-111` fails closed; `test/app.test.ts:507-517` deletes `globalThis.confirm` and asserts the workspace is untouched. |
| NOTE-16 | unchanged | Intentional rebrand (APP_NAME, STORAGE_KEY, export filename) — still the only deliberate copy/identifier divergence. |
| NOTE-17 | **NOT FIXED (comment is wrong)** | `test/domain.test.ts:325-334` still asserts "The prototype produced 'TCR' here (it kept the leading article, which we drop)" and `keyFrom('Mobile app v1') === 'MV'` without noting the prototype's `MAV`. Executed against the prototype source, `keyFrom('theblackit.com Redesign')` is `TR`, not `TCR`, and `keyFrom('Mobile app v1')` is `MAV`. The real residual divergence is the stop-word/TLD filtering under MAJ-7. |
| Beyond-report attribute escaping | **FIXED** | Every attribute interpolation now passes through `esc()` (`data-id`, `data-task`, `data-pop`, `data-anchor`, `data-subinput`, `data-idx`, `value=`, `title=`, `<option>` values). Only three raw attribute values remain and all are provably inert: `data-w="${width}"` (number), `data-idx="${index}"` (number), `value="${r}"` (literal role). DOM entity decoding round-trips `dataset`/`value`, and `test/injection.test.ts` covers task/member/project/type ids. |

## New / residual findings from the fix pass

| ID | Severity | Area | Evidence | Consequence |
| --- | --- | --- | --- | --- |
| RV-1 | MINOR | Welcome copy | `render.ts:392` now reads "…6 members and **32 tasks**…"; the prototype says "30+ tasks" (HTML 656) | Visible copy divergence on the first-run screen. It is factually more accurate (the seed is exactly 32), so it may be accepted deliberately — but it is not prototype parity. |
| RV-2 | (part of MAJ-7) | Modal key fallback | `domain.ts` `createProject` fallback → `keyFrom(name)`; prototype `openProjectModal` derives first letters only (HTML 1210) | "+ Project" with an empty Key field and a one-word (or stop-word) name now produces a different prefix than the prototype: "Redesign" → `REDE` vs `R`, "New Website" → `WEBS` vs `NW`. Previously this path matched the prototype for those names. |
| RV-3 | NOTE (residual) | Selector interpolation | Task ids are still interpolated raw into CSS selectors: `[data-subinput="${id}"]` (`actions.ts:163`, `169`) and `[data-act="sub-add"][data-id="${el.dataset.subinput}"]` (`app.ts:332`) | An id containing a double quote would make `querySelector` throw (a tampered `localStorage` could do this; ids created by the app are alphanumeric). The prototype has the same pattern, so this is parity, not a regression. `CSS.escape` would close it. |

## New blocker/major hunt (areas requested)

- **Confirm flow vs wizard:** `replaceWorkspace` closes the modal before swapping the domain, and the
  wizard's own Finish/Skip path calls `closeModal()` explicitly (`actions.ts:642`), then `refresh()`.
  `loadDemo`/`startFresh` are only reachable from the workspace menu (behind the scrim) or the welcome
  screen, so no wizard/modal interaction is broken. `welcome-demo` correctly stays unconfirmed.
- **Greeting duplication:** none. `ensureGreeting` pushes only when the transcript is empty and runs
  synchronously; every transcript-clearing path (`replaceWorkspace`, `finishSetup`) is followed by
  `refresh()` → `renderChat()`. Tests assert exact message counts (`#chat .msg` = 3 after one send;
  `.msg.user` = 1).
- **Composer default owner vs "not taken":** verified both directions — the select defaults to the
  acting member (matches HTML 866-868) and explicitly choosing "Not taken · open pool" still creates a
  `TODO`/unowned card with the "Take this task" button.
- **`esc()` vs dataset round-trip:** verified safe. Escaped entities are decoded by the DOM before
  `dataset`/`value` reads, escaped ids are compared only against other decoded `dataset` values
  (`p.dataset.pop === keep`), and `data-idx`/`data-w` are numeric.
- **Remaining unescaped interpolation into markup anywhere in `src/`:** **none found.** I enumerated
  every `${…}` in `render.ts` and `app.ts`; the raw values are numbers, fixed constants/palette colours,
  conditional class fragments, date-derived labels, or the chat transcript HTML that is itself built
  from `esc()`-ed parts. The attribute scan returns only the three inert cases listed above.
- Seed parity re-confirmed on revision 2 (32 rows identical; subtask map identical); `data-act`
  coverage still complete (48 used = 44 `ACTIONS` + 4 `CHANGE_ACTIONS`, no orphans); CSS still shows no
  dropped prototype class and no unstyled emitted class except `.btn.sm` (also unstyled in the
  prototype).

## Remaining actions

1. **MAJ-7 (partial):** either drop `STOP_WORDS`/TLD stripping from `keyFrom` (prototype parity:
   "Mobile app v1" → `MAV`, "New Website" → `NW`, "Natil Evidayaa · Mobile App" → `NEMA`) or accept it
   as a documented divergence and correct the test comment. Note the modal fallback currently inherits
   it, which changed that path's output.
2. **MIN-10:** use "Demo data loaded" for the `reset`/`ws-demo` path.
3. **MIN-14:** fix the "33 tasks" comment/test title and the `index.astro` prerender claim (or render the
   demo workspace statically).
4. **RV-1:** decide whether "32 tasks" is an intentional copy change; if not, restore "30+ tasks".
5. **RV-3 (optional hardening):** `CSS.escape` the ids used in selectors.

---

# Re-verification (revision 3 — final)

**Revision 3 snapshot (md5):** domain `b5cee97df1adcfcbf7d1b140e2c7142e` · render
`6742eab0b44a0fc8803b142ec1d1ef63` · actions `e513816a7bbca694b41141dc7df09050` · app
`6bfb89acc66ecb5ed16f468e04d7b395` · reorder `4ac550d43d48a6de95d4f9f5182a80d3` · constants
`e9e1965e499676f6eeffaaf6cbd0b61f` · types `a4a4a4bc1ba8bdb65fa9da7a38e4165b` · flow.css
`e7b5e4181b557056e7ed8983ddfc1d89` · AppShell `d9bad3eee5aef4c7d5509280ee3d25f6` · Layout
`49781062ba764e1eba84d1df9952df6f` · index `ad2e976787715077e9093bfc2ff4f715` · main
`cba22c088ae296d5decb4d28396ae21a` · tests: app `be2e667538e00524cd025c253b7a3af7`, domain
`ecd80511cb1b898b25286353364bf59d`, injection `9261a4c549a01f40ae4166875ce138b0`, reorder
`897be0497f587d9293eccfcdedda44b6`, wiring `66833bed2a41fc7adeb87ebef7a2f4f5`.

**`npm run verify` (run at 20:31): PASS, exit 0.** `astro check` → 0 errors / 0 warnings / 0 hints;
`tsc -p test/tsconfig.json --noEmit` → 0 errors; `vitest run` → 5 files, **112/112 tests pass**;
`astro build` → 1 static page, complete.

## Verdicts

| ID | Verdict | Evidence in revision 3 |
| --- | --- | --- |
| MAJ-7 | **FULLY FIXED** | `keyFrom` (`domain.ts:110-118`) is a verbatim transcription of the prototype (HTML 1141): non-letters dropped, no stop-word/TLD filtering, initials for multi-word, whole word slice(0,4) for single-word. `projectKeyFallback` (`128-141`) mirrors the prototype's `openProjectModal` derivation (HTML 1210). `keyFromSafe` is deleted. Call sites: `render.ts:506` (wizard body) and `actions.ts:598`/`624` (live preview + finish) use `keyFrom`; `createProject:688` uses `projectKeyFallback` only when the Key field is empty — i.e. the prototype's own two algorithms, including its single-word inconsistency. **Independently executed** both port functions against both transcribed prototype functions over 19 inputs (the 11 quoted values plus `''`, `'  '`, `'a'`, `'MiXeD CaSe'`, `'x1 y2'`, `'   spaced   out   '`, `'the blackit redesign'`, `'UPPER lower'`): **0 mismatches**, e.g. `MAV`, `NEMA`, `TR`, `Redesign`→`REDE`/`R`, `New Website`→`NW`, `Our new tool`→`ONT`, `App v1`→`AV`, `v1`→`V`, `!!!`→`PRJ`. Asserted in `test/domain.test.ts:334-362`. |
| MIN-10 | **NOT FIXED** | `actions.ts` is byte-identical to revision 2 (md5 `e513816a`); `replaceWorkspace` (`676`) still toasts "Demo workspace loaded" on the `reset`/`ws-demo` path, while the prototype's `resetAll` says "Demo data loaded" (HTML 629). Only `welcome-demo` matches. Cosmetic single-string divergence; the "fresh is silent" behaviour the Lead described is correct and matches the prototype. |
| MIN-14 | **FIXED** | `domain.ts:169` and `test/domain.test.ts:42` now say 32; no "33 tasks" remains anywhere in `src/`/`test/`; `index.astro:3-9` was rewritten to describe a shell-only prerender and no longer claims JS-free meaningfulness. |
| NOTE-17 | **FIXED** | The "prototype produced TCR" claim is gone. `test/domain.test.ts:334-362` cites the prototype source (HTML line 1141) and asserts the prototype's exact values for both derivations. |
| RV-1 | **FIXED** | `render.ts:392` restored to the prototype's "…6 members and 30+ tasks…". |
| RV-2 | **FIXED** | The modal fallback now uses `projectKeyFallback` = the prototype's modal derivation (`Redesign` → `R`, `New Website` → `NW`), instead of inheriting `keyFrom`. |

## New findings this round

| ID | Severity | Area | Evidence | Consequence |
| --- | --- | --- | --- | --- |
| RV-4 | MINOR (doc) | Stale comment | `domain.ts:685` still reads "Same derivation the wizard previews and the domain's `keyFrom()` produces", but the call on the next line is `projectKeyFallback(name)` — which intentionally differs from `keyFrom` for single-word names | The comment now contradicts the code it documents; no runtime impact. It is the same class of defect as the NOTE-17 comment that was just fixed. |

**New blocker/major: none.** Re-checked on revision 3 and unchanged: seed rows byte-identical to the
prototype (32 rows), `data-act` wiring complete (48 used = 44 `ACTIONS` + 4 `CHANGE_ACTIONS`, no
orphans), no emitted class unstyled except `.btn.sm` (also unstyled in the prototype), and no new raw
attribute interpolation (only `data-w`/`data-idx` numeric and literal role values). The RV-3 residual
(raw ids inside CSS selectors, prototype parity) is unchanged.

## Overall parity status

Apart from **MIN-10** (one cosmetic toast string on the reset path) and the documented, intentional
additions listed under NOTE-16/18/19/20 (product rebrand and storage/export names, the
`prefers-reduced-motion` block, `role`/`aria-*` attributes, the `<noscript>` note and the `first-run`
flash guard), the port is now **behaviourally equivalent to `workflow-chain.html`** — including the
prototype's own quirks (two key derivations with their single-word difference, `.btn.sm` unstyled, the
chat-add preview remaining in the transcript).


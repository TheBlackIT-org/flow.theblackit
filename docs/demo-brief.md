# Demo brief — the four new features

For a walkthrough with Vaisakh. Everything here is on the `new-features` branch
and **nothing is deployed**; the live board still runs the old build until the
review is done.

---

## Before the demo — do not skip

The app now writes to three tables that do not exist in the project yet. Skip
this and the demo looks broken in a specific, misleading way: assignments appear
on screen and never save, and the bell never rings.

Paste each file below into **Supabase → SQL Editor → New query → Run**, in this
order. All three are additive, so the live board keeps working while you do it.

| # | File | What it adds |
| - | ---- | ------------ |
| 1 | `supabase/migrations/0005_task_assignees.sql` | several assignees per task |
| 2 | `supabase/migrations/0006_subtask_assignee.sql` | an owner per subtask step |
| 3 | `supabase/migrations/0007_notifications.sql` | the bell + the triggers that fill it |
| 4 | `supabase/migrations/0008_subtask_assignees.sql` | several people per subtask step |

Then:

5. **Invite the remaining people** — Team → name + email. Anybody the demo will
   sign in as needs their email on their member row.
5. **Everybody reloads.** A tab still running the old build keeps working, but
   its assignment writes are only visible to the new client through the
   `tasks_mirror_assignee` bridge. Reloading removes the ambiguity.

> **Do not run `0004_tighten_rls.sql`.** That is the cutover to real access
> control, and it runs only after this review.

### The demo needs two accounts

Notifications deliberately never fire for your own action — a bell that rings
when you click is a bell people switch off. So the bell cannot be demonstrated
from one signed-in account.

Use **two browser profiles** (or one normal window plus one incognito):

- Profile A — you, signed in with GitHub.
- Profile B — Vaisakh, signed in with GitHub (his account must use
  `vaisakh.k591@gmail.com` to claim his invite) or with the email link.

**Use a scratch project.** The board is live and shared: create a project called
`Demo` and do the walkthrough there, so the real board is not disturbed.

---

## The walkthrough

### 1. Sign-in

*Profile A, if not already signed in.*

1. Open `http://localhost:4321` → the sign-in card, and nothing else: no board,
   no member names, nobody to act as.
2. **Continue with GitHub** → back on the board, and the header shows **your
   name** where *Acting as* used to be. The picker is gone; you cannot be
   anybody else.
3. Open the **⋯** menu → *Sign out* is there, with your email above it.

**What to say:** identity stopped being a dropdown. Owner, take-time and every
activity entry now name a person instead of whatever the picker was set to.

Also worth showing if you have a second account of your own: signing in with an
account nobody invited lands on *"Not on this workspace yet"* — never on
somebody else's board.

### 2. Several people on one task

*Profile A.*

1. On any card: **⋯ → Assign people**. Every member is a checkbox; tick two.
   Save.
2. The card now shows **overlapping faces** and both names. Tick four on another
   card and the fourth collapses into **+1**.
3. **Assign me too** on a card puts you on somebody else's task without
   disturbing them.
4. Header → *Member* filter → pick yourself: you now see everything you are on,
   including tasks you joined rather than claimed.

**What to say:** before this, one task had one owner and everybody else guessed.
There is no primary owner and no watcher tier — two people sharing work is the
normal case now. The *took it 3d ago* stamp is still the honest record of who
first pulled it out of the pool.

### 3. A step can be somebody's

*Profile A, on a card that has subtasks.*

1. Expand **Subtasks**. Each step row now has an owner control on the right:
   a muted person icon means nobody has it.
2. Click it → the picker quotes the step at the top, lists everyone, and starts
   on **Nobody**. Choose somebody, Save → their face appears on the row.
3. Tick **two** people on one step and Save → the row shows both faces; tick a
   third somewhere and the pill counts the overflow.
4. Re-open the picker and use **Assign to me** in the footer → you join the step
   without displacing anybody, and the modal closes.
5. Edit the task (**⋯ → Edit task**) and save without changing the steps: the
   step owners survive.

**What to say:** a step takes several people for the same reason a task does —
pairing on one step is a real way to work. The last point is the bug this could
have shipped with: editing a description used to wipe every step owner
silently.

### 4. The bell

*Profile A assigns something to Vaisakh, then Vaisakh looks. Keep both windows
visible.*

1. *Profile A:* assign a task to **Vaisakh**, and hand him a **subtask step**.
2. *Profile B:* the bell shows a badge within about a second — no reload. Open
   it: *"Shithin put you on DEMO-3"*, *"Shithin handed you a step in DEMO-3 ·
   <the step text>"*.
3. *Profile B:* click an entry → the board switches to that task's project, the
   task flashes, and the entry is marked read (the badge drops).
4. *Profile A:* move one of Vaisakh's tasks to **Blocked** → *Profile B* gets
   "moved DEMO-3 / Blocked".
5. *Profile B:* **Mark all read** → the badge clears and the shortcut disappears.

**What to say:** nobody is emailed and no push service is involved — this is the
in-app bell only. The rows are written by **database triggers**, not by the
browser, which is why one assignment arrives once rather than once per open tab,
and why it still arrives if the person who assigned it closed their tab a second
later. It also never notifies you about your own click.

### 5. What is deliberately not in this round

- No email notifications, no browser popups, no mobile push.
- No due-date reminders.
- Roles (`owner` / `lead` / `member`) are still labels — any member can edit
  anything, same as before.
- Sign-in is layered on top of the permissive policies: **until `0004` runs, the
  anon key still opens the database.** Sign-in is the front door, not the lock.
  That is the one thing to be explicit about if Vaisakh asks whether the data is
  now protected.

---

## After the review

If Vaisakh is happy, the release order is:

1. Apply `0003` ✅, `0005`, `0006`, `0007` *(done above)*.
2. Deploy with `PUBLIC_REQUIRE_LOGIN=true`.
3. Confirm everyone can sign in.
4. **Then** apply `0004_tighten_rls.sql`, and verify that an anon request now
   returns nothing:

   ```bash
   curl "$SUPABASE_URL/rest/v1/tasks?select=id&limit=1" \
        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
   # expected: []
   ```

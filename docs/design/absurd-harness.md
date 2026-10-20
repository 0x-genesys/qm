# QM turns on Absurd, and the harness as its own service

Status: draft for review. Author: Regan Bell. Written 2026-10-20 (Pacific).

## Summary

QM's run queue (`src/runs/`) is a hand-built durable-execution engine: claims, leases, heartbeats, a reaper, retries, preemption, signals, and a deploy-ownership protocol. This spec replaces the engine with Absurd while keeping QM's own record of turns. It also moves turn execution out of the API process into a separate harness service.

The design in one paragraph: each turn is one Absurd task. A conversation has at most one active turn, and a pointer on the session row (`sessions.active_turn_id`) enforces that when a turn is created, not when a worker claims it. Input that arrives while the conversation is busy becomes a steer (a `SteeringMessage` item) or waits as queued input that the turn-end transaction starts next. Absurd queues therefore hold only runnable turns, and no claim ever checks sibling runs. Three queues (people, delegated, background) carry priority. `items` remains the only record of what a turn did, and Absurd stores no transcript. The harness runs as its own ECS service, so API and Slack deploys never touch a running turn.

## Why now

- QM is about to run swarms of hundreds of subagents and work that lasts several days. Today's engine scales poorly on exactly those shapes. Every claim checks every sibling run of the candidate's session, which is about 37% of production database load by Regan's measurement. Every notification wakes every idle worker. A parent learns about each child separately, so N children cost N parent turns. A turn that waits for something keeps its worker slot the whole time.
- Session history moved to `items` on Oct 19 (cut over in prod). Turn content now lives in one append-only table keyed by `(tenant_id, session_id, seq)`, with `turn_id` on every row. That makes "the transcript is the checkpoint" practical.
- Absurd (earendil-works) is already the chosen layer for qm-crystal, where a turn is an Absurd task, model and tool calls are steps, and approvals and steers suspend for events. Temporal is ruled out; DBOS was rejected.

## Terms used here

- **Turn**: one unit of agent work in a conversation. It starts from input (a message, cron fire, child result) and ends with a reply or a stop. Today a turn is a row in `runs`.
- **Absurd task / run**: Absurd's names. A _task_ is the logical job; a _run_ is one attempt at it. A new run is created only when an attempt fails. Sleeping and waking keep the same run.
- **Claim / lease**: a worker takes a run for N seconds (Absurd's `claim_timeout`) and must extend that lease (`extend_claim`) or another worker can take the run over.
- **Suspend**: a run gives up its worker and goes to `sleeping` until a time (`schedule_run`) or a named event (`await_event`). No process holds it while it sleeps.
- **Event**: a named, one-shot message inside one Absurd queue. The first emit wins and is cached, so a waiter that arrives late still sees it.
- **Harness**: the code that runs a turn: orchestrator, model calls, tools, and the pi/Claude adapters. Today it runs inside `core`.

## What Absurd actually provides (verified against the SQL)

Read from `migrations/0001_absurd.sql` in qm-crystal (0.5.0) and upstream `sql/absurd.sql` (0.5.1, released 2026-10-20 04:07 PT).

| Fact                                                                                                                                                                                                     | Consequence for QM                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Each queue is a set of five tables (`t_`, `r_`, `c_`, `e_`, `w_`). `claim_task` orders by `available_at, run_id`, with no priority column.                                                               | Priority needs separate queues and a worker that prefers one.                                                                                                                              |
| `spawn_task(queue, name, params, {idempotency_key, max_attempts, retry_strategy, cancellation})` has no dependency (`after`) option.                                                                     | qm-crystal's `docs/PROTOCOL.md` line "spawn_task with `after=<turn_id>`" describes a feature that does not exist. QM has to provide turn ordering, which is what the session pointer does. |
| All functions are plain SQL. `spawn_task`, `complete_run`, and `emit_event` can run inside the caller's transaction.                                                                                     | Creating a turn, ending a turn, and starting the next one can each be one transaction that touches QM tables and Absurd together.                                                          |
| `await_event(queue, task, run, step, event, timeout)` waits on exactly one event name. `emit_event` wakes waiters **in the same queue only**. Event names are first-write-wins and cached until cleanup. | Fan-in needs a counter that emits one event. Emitters must emit into the waiter's queue. Each suspension needs a fresh event name.                                                         |
| `schedule_run(queue, run, wake_at)` moves a running run to `sleeping` with no attempt used. A sleeping run whose `available_at` has passed is claimable.                                                 | Parking and planned handback on deploy are both `schedule_run(run, now())`: no retry is spent, and any worker can resume the run.                                                          |
| An expired lease is noticed only inside `claim_task` (a bounded sweep per call), which calls `fail_run`. That uses an attempt and creates a new run.                                                     | A hard crash costs an attempt, so `max_attempts` must allow for crashes. QM keeps its own error budget (below).                                                                            |
| `set_task_checkpoint_state` and `await_event` check that the run is not failed or cancelled. They do **not** check which worker holds the claim.                                                         | Absurd does not fence a stale worker's writes to QM tables. QM fences item appends itself (below).                                                                                         |
| `cancel_task` cancels one task. A worker learns about it only when its next Absurd call raises `AB001`.                                                                                                  | Cancelling a subagent tree is QM's job, and stopping quickly needs a notification as well.                                                                                                 |
| Through 0.5.0, `claim_task` scanned the whole task table for cancellation rules on every call, with no index. 0.5.1 adds an index (upstream #140).                                                       | Vendor 0.5.1, not 0.5.0.                                                                                                                                                                   |
| `enable_cron` schedules Absurd's own maintenance (partitions, cleanup) through pg_cron. It is not a user-cron feature.                                                                                   | QM's cron scheduler stays. qm-crystal's "crons via enable_cron" needs correcting.                                                                                                          |
| Retention: `cleanup_tasks` / `cleanup_events` by TTL, or weekly partitions in partitioned mode.                                                                                                          | Retention is a periodic call from the harness.                                                                                                                                             |

TypeScript SDK (`absurd-sdk` 0.5.1, about 1,600 lines in `src/index.ts`, peer dependency `pg`): it provides `step`, `awaitEvent`, `sleepFor`, `heartbeat`, `emitEvent`, and `spawn`. Its worker polls one queue every 250 ms with no LISTEN. By default it calls `process.exit(1)` when a task overruns twice its claim timeout, which would kill every other turn in the process. Its `TaskContext` issues its own queries, so it cannot join a QM transaction. See decision D1.

## Today, concretely

Example (illustrative): Regan sends a DM while a nightly cron turn is running in the same DM, and a coordinator in another conversation has 40 subagents running.

1. **Enqueue** (`postgres-run-store.ts` `enqueue`): inserts a `runs` row (`status='pending'`, `claim_priority` 0/1/2 from `runPriority`) and calls `pg_notify('qm_run_available')`.
2. **Wake**: every worker in every core process (16 per process by default) subscribes to that channel. All of them wake and run `claim`.
3. **Claim** (`claim`): the candidate query has a `NOT EXISTS` subquery that rejects any run whose session has a running sibling or an earlier pending one. That keeps one turn per conversation in FIFO order, and it runs for every candidate on every wake.
4. **Run** (`worker.ts` `processRun`): heartbeats every `leaseTtlMs/3` (120 s TTL). Steers, aborts, and client tool results arrive through `run_signals` (`postgres-run-signal-store.ts`), polled about every 5 s and also notified.
5. **Priority** (#2356): `createRunPreemption` checks `personWaiting()`. If a person's turn waits and every worker holds something, it aborts the newest background run with `PARKED`. That run's lease is released, and it is claimed again later.
6. **Crash or deploy**: the lease lapses, `reapExpired` or the next claim requeues the run, and `turn-resume.ts` scans items backwards to find the partial turn and continue from it.
7. **Deploy ownership**: blue and green core stacks share one database. Only the stack named in the `background_ownership` record claims runs, runs crons, and opens Slack ingress (`background-controller.ts`, `/v1/background-work`, `cli/src/background-work.ts`, the ownership guards in `cli/src/backends/aws.ts`, most recently #2472). An API deploy is a background-work handoff, so a turn in flight on the old stack either finishes there or is resumed after a lease lapse.
8. **Subagent results** (`deliverSubagentMail`, `pendingReturns`): every finished child sends mail to its parent session, which becomes a parent turn or a steer. Forty children produce up to forty parent wakes, each re-reading a growing context.

## Proposed design

### 1. Tables: what lives where

- **`items`** (unchanged): the only record of turn content. No transcript, tool output, or model payload is written to Absurd.
- **`runs` becomes the turn ledger**. The name is kept for now (decision D9). Each row is one turn: id (= `turn_id` on its items), session, request envelope, origin, tier, status, result, delivery state, dedup key, parent turn, and error count. New columns: `engine` (`legacy` | `absurd`), `absurd_queue`, `absurd_task_id`. Statuses: `queued` (waiting for its conversation), `pending` (spawned in Absurd), `running`, `waiting` (suspended), `parked`, `done`, `failed`, `stopped`. Lease columns (`lease_token`, `lease_expires_at`, `worker_id`, `retry_after`, `attempts`) stay only for legacy rows and are dropped with the legacy engine. The API's status queries (`activeForThread`, `inFlightForThread`, `latestForThreads`, run-result delivery) read this table and never read Absurd's per-queue tables.
- **`sessions.active_turn_id`** (new, nullable): the conversation's one active turn, either running or suspended.
- **Absurd**: task params are `{ turnId }` only. Absurd checkpoints exist only where Absurd requires a step name, at suspension points (`await_event`, `schedule_run`), and they hold small markers such as `{ "wokeBy": "steer", "throughSeq": 812 }`.

**Challenge to the brief: model and tool calls are not Absurd steps.** qm-crystal maps each model or tool call to an Absurd step. In QM that would write every step twice: once as items, and again as an Absurd checkpoint row that says "step N done, see seq X". Items already provide what a step checkpoint gives:

- `ToolCall` and `ToolResult` are unique per `(session, kind, call_id)`.
- `AgentMessage` carries `step`.
- A `ToolCall` without a `ToolResult` is exactly the "in doubt" case that resume already handles (`unrecordedToolResult`).

Resume reads the turn's items through the `items_by_turn` index and continues. Checkpoint growth then tracks suspensions (a handful per turn) instead of steps (hundreds per long turn). See decision D2.

### 2. One task per turn, ordered by the session pointer

**Admission** happens when input arrives, in `app-turn.ts`, `session-syscalls.ts`, the cron runner, `swarm-service.ts`, and child returns. It is one transaction:

```sql
BEGIN;
SELECT active_turn_id FROM sessions WHERE id = $session FOR UPDATE;
-- conversation idle:
INSERT INTO runs (id, session_id, engine, status, tier, request, ...) VALUES ($turn, $session, 'absurd', 'pending', $tier, ...);
UPDATE sessions SET active_turn_id = $turn WHERE id = $session;
SELECT * FROM absurd.spawn_task($queue, 'turn', jsonb_build_object('turnId', $turn), jsonb_build_object('idempotency_key', $turn, 'max_attempts', 10));
SELECT pg_notify('qm_turn_ready', $queue);
COMMIT;
```

If the conversation is busy (`active_turn_id` is set):

- **Steerable input**: a person's message for the same model account, using the existing rules in `app-turn.ts`. It is appended as a `SteeringMessage` item with `turn_id = active_turn_id` and announced with `pg_notify('qm_turn_input', turn)`. The running turn folds it in at the next model step, as it does today. If the active turn is suspended (`status='waiting'`), admission also emits that turn's current wake event (section 5) so it resumes immediately.
- **Everything else** (cron fire, child result, another account's message, a person's message into an automation turn): inserted as a `runs` row with `status='queued'` and no Absurd task.

**Turn end** happens in the turn task, after the final reply items are written. It is also one transaction:

```sql
BEGIN;
SELECT active_turn_id FROM sessions WHERE id = $session FOR UPDATE;
-- if a SteeringMessage for this turn arrived after the last model step: ROLLBACK and run another model step
UPDATE runs SET status = 'done', result = $result, finished_at = now() WHERE id = $turn;
-- next: a parked turn first, then queued rows by tier, then FIFO; child results are batched (section 4)
--   found  -> UPDATE sessions SET active_turn_id = $next; spawn_task(...) or emit_event(resume:<next>); runs.status = 'pending'
--   none   -> UPDATE sessions SET active_turn_id = NULL
SELECT absurd.complete_run($queue, $run, '{"ok":true}');
COMMIT;
```

The session row lock is what makes this race-free. A steer either commits before the turn-end lock, so turn end sees it and keeps working, or after it, so it sees the pointer cleared or moved and becomes a new turn. Because `complete_run` is in the same transaction, there is no window where Absurd says done and QM says running.

**What this removes**: the `NOT EXISTS` sibling subquery is gone. Absurd queues contain only turns that may run right now, so a claim is an indexed pick from `r_<queue>(state, available_at)`.

**Crash or deploy mid-turn**: the pointer names the turn, not a worker, so it stays held. If the worker dies hard, the lease expires (proposed `claim_timeout` 60 s, extended every 20 s). The next `claim_task` on that queue fails the old run and creates attempt n+1. Any harness process claims it, reads the turn's items, and resumes. On a planned shutdown the worker calls `schedule_run(run, now())` instead, so no attempt is used and another process resumes within one poll. Absurd's `max_attempts` (10) is a backstop for crash loops. QM's real error budget stays in `runs.error_attempts` (3, as today): a model or provider error increments it, and on the last one the task runs turn end with `status='failed'` itself.

**Fencing**: the Absurd lease token is the `claimed_by` value, made unique per claim (`<process>:<nonce>`). Item appends from a turn, and the capability-token checks that use `runLeaseToken` today (`composio.ts`, `external-slack.ts`, `swarm-fence.ts`), verify `absurd.r_<queue>.state='running' AND claimed_by=$token` for the turn's current run. This replaces the `runs.lease_token` comparison.

**Stuck-pointer repair**: a pointer can outlive its turn if Absurd fails the task outside QM code (attempts exhausted by lease expiries) or if someone cancels it in Absurd directly. A sweep every 60 s on the harness leader looks for sessions whose `active_turn_id` row is terminal, or whose Absurd task is `failed` or `cancelled`. For each one it runs turn end with `status='failed'` (and an `Error` item), which advances the queued input. The query uses a partial index on `sessions(active_turn_id) WHERE active_turn_id IS NOT NULL`, so it scans only busy conversations.

**Rejected alternative: one long-lived task per conversation.** One task would run turns in order and sleep on an event between them. It fails on Absurd's actual semantics:

1. A conversation lives for months. The task never completes, so `cleanup_tasks` can never retire it, and with partitioned storage it pins its partition.
2. Every turn's suspension adds checkpoint rows to the same task forever, and resume reads all of them (`get_task_checkpoint_states`).
3. Events are one-shot names, so each between-turn wake needs a fresh name and a counter anyway.
4. Cancelling "this turn" would mean cancelling the conversation, and attempt counts and retry policy would be shared across unrelated turns.
5. Most conversations are idle, so thousands of permanently sleeping tasks would sit in the table that claims sweep.

The pointer gives the same ordering with tasks that end.

### 3. Priority: three queues, a preferring claim loop, and parking

Queues: `turns_people`, `turns_delegated`, `turns_background`. The tier comes from the existing `runPriority()`: a person's turn goes to people; a subagent of a person's turn goes to delegated; crons, loops, swarms, and anything descended from them go to background.

**Claim loop** (one per harness process, replacing the 16 per-slot loops in `worker.ts`):

- Wake on `LISTEN qm_turn_ready` (sent by the spawn and emit wrappers), with a 1 s fallback poll for timers and expired leases.
- With `free` open slots, call `claim_task` on people, then delegated, then background, asking for up to `free` runs each time.
- **People overcommit**: people-queue claims ignore the slot limit, up to `slots/4` extra. Each overcommitted slot is paid back by parking a background turn.

**Parking for capacity** (replaces `createRunPreemption` / `personWaiting`): when a people turn is claimed over capacity, the newest background turn on that process with `preemptions < 3` is asked to yield. At its next step boundary it calls `schedule_run(run, now())` and the turn row becomes `parked`. The pointer stays, so its conversation is still busy. Because workers drain people and delegated before background, it resumes as soon as capacity frees. It uses no attempt and resumes from items. If a step takes too long (30 s), the in-flight model call is aborted and resume repeats it.

**Parking inside one conversation** (a person writes into a conversation whose active turn is a cron): the person's input is queued with tier people, and the cron turn is asked to yield the conversation. At its next step boundary it runs one transaction:

1. Mark itself `parked`.
2. Point `active_turn_id` at the person's turn and spawn it.
3. Suspend with `await_event('resume:<cron_turn>')`.

When the person's turn ends, turn end prefers parked turns. It moves the pointer back and emits `resume:<cron_turn>` into the background queue. The transcript then shows the cron turn's earlier items, the person's turn, and the cron turn continuing. See decision D3.

**Fairness across tenants and swarms**: Absurd is FIFO within a queue, so a swarm that admits 500 child turns makes every other background turn wait behind it. Proposed fix: a per-owner cap on active background turns (owner = swarm id, else cron or loop owner), default 8 (D4). Admission over the cap inserts the turn as `queued` on an owner backlog instead of spawning it. The turn-end transaction already spawns the next queued input, and it also spawns the owner's next backlog item. That reuses one mechanism and adds no new queues or polling.

### 4. Fan-out and fan-in

- **Fan-out**: spawning N subagents is one transaction with N `runs` rows, N pointer sets, and N `spawn_task` calls. Either all children exist or none do.
- **Batching (default)**: a finished child's turn end inserts a `queued` child-result row on the parent session, or spawns a parent turn if the parent is idle. When the parent's next turn starts, it takes **all** queued child results at once as `Wake` items with `wake_cause='child_done'`. Forty children finishing while the parent is busy become one parent turn, not forty. This replaces `pendingReturns` / `markReturned` / `deferReturn` and the `session-return-sweep`.
- **Barrier wait (`subagents wait all`)**: the parent turn writes `turn_barriers(turn_id, remaining = N, queue)` and suspends with `await_event('barrier:<turn>', timeout)`. Each child's turn end decrements `remaining` in its own transaction. The one that reaches 0 emits `barrier:<turn>` into the parent's queue (events are per queue). The parent gets one wake and holds no worker slot while it waits, even for days. Children covered by a barrier do not also queue child-result rows.
- **Cancelling a tree**: `cancelTree(session)` uses a recursive CTE over `sessions.parent_session_id`. For every descendant it runs `cancel_task` on the active turn's task, marks queued rows `stopped`, clears pointers, and sends `pg_notify('qm_turn_cancel', turn)`. The owning harness process aborts the in-process turn at once instead of waiting for the next `AB001`. This is one transaction per tree.

### 5. Suspension, timers, and multi-day work

- **Inside a turn** (waiting minutes for CI, a barrier, an approval): the turn sets `runs.status='waiting'` and suspends on one event name per suspension, `wake:<turn>:<k>`, with an optional timeout for "at most until T". Anything that should wake it emits that name: a steer, a cancel, a child, an approval answer, or a client tool result. Because a single name covers every wake cause, the one-event limit of `await_event` does not matter. The pointer stays held, so the conversation shows as busy.
- **Across turns** (check back tomorrow, multi-day loops): a turn should **end** and schedule a wake instead of sleeping for a day while holding its conversation. The wake is a tiny Absurd task in the background queue (`wake_at` through `schedule_run`) that runs admission for the session with a `Wake` (`wake_cause='system'`) input. A person can talk to that conversation in the meantime.
- **Approvals and client tools**: today an approval ends the turn and a new run resumes it. Moving these to `wake:<turn>:<k>` suspension is a later PR (PR 7). It frees the worker while a person decides.

### 6. The harness as its own ECS service

**Split**: process roles come from `QM_ROLES` (default `api,surfaces,harness`, so a self-hosted install remains one process).

- **core** (`api,surfaces`): HTTP API, web streaming, Slack ingress, admission transactions. It never runs a turn.
- **harness** (`harness`, grown from today's `src/runs/worker-main.ts`): the claim loop, turn tasks, cron scheduler, maintenance sweepers, stuck-pointer repair, and Absurd cleanup.

One harness ECS service per deployment, with rolling updates (minimum healthy 100%, maximum 200%). No blue/green and no ownership record.

**Already cross-process today (verified)**: run stream deltas go over Postgres NOTIFY (`run-stream-events.ts` chunks them to fit), session-state events go through `postgres-session-state-bus.ts`, and delivery to Slack and web is outbound from whichever process runs the turn. Blue/green already runs turns on one stack while the other serves web, so the split adds no new streaming path.

**Deploys after the split**:

- **API or Slack deploy**: no turn runs in core, so nothing is interrupted. In-flight turns keep streaming through NOTIFY to whichever core task the browser reconnects to.
- **Harness deploy**: ECS sends SIGTERM. The process stops claiming and asks each in-flight turn to yield at its next step boundary. After 20 s it aborts the remaining in-flight calls and calls `schedule_run(run, now())` on each run. The new tasks, already up because maximum is 200%, claim them within about a second. A hard kill falls back to lease expiry (60 s). What the user sees (proposed): a pause of a few seconds, and at worst one repeated model call.
- **Version skew** during a rolling harness deploy: old and new processes claim from the same queues. Task params are `{turnId}` only, and unknown task names are deferred, not failed (the same rule as the SDK). Schema changes stay expand/contract, as today.

**What this deletes**: the background-ownership record and protocol, the controller, `/v1/background-work`, the CLI ownership guards (including #2472's stopped-core proof), the drain controller and instance registry, and the requirement that API deploys hand off background work. The cron scheduler already has its own leader lease and slot claims (`src/cron/scheduler.ts`), and the other sweepers already use advisory locks, so they need no owner record in the harness. Whether core itself keeps blue/green routing for safe rollback is separate (D10).

### 7. Cutover

- **Install**: a startup migration installs the vendored Absurd 0.5.1 SQL into the `absurd` schema if `absurd.get_schema_version()` is missing. The vendored file uses `create function` without `or replace`, so the guard is required. The migration then creates the three queues idempotently and sets the cleanup policy (completed tasks kept 7 days). Later upgrades apply upstream's versioned migration files (`sql/migrations/0.5.0-0.5.1.sql` and so on).
- **Routing**: a feature flag `absurd_turns` per scope. Admission uses the Absurd engine when the flag is on **and** the session has no legacy run pending or running. Otherwise it writes a legacy row, so each conversation drains its legacy work in order.
- **Legacy claim**: gains `AND candidate.engine='legacy'`. Its existing `NOT EXISTS` check already treats Absurd turns in the same session as running siblings, which is the correct exclusion while both engines run.
- **No data migration**: in-flight runs finish on the old engine, and new turns start on Absurd.
- **Ramp**: Regan's personal scope, then background tier org-wide, then everyone.
- **Removal**: once `SELECT count(*) FROM runs WHERE engine='legacy' AND status IN ('pending','running')` stays 0 for a day, delete the legacy engine.

## Code: what goes, what comes

All counts are estimates from `wc -l` on main at `69b2cfb0`. Production code only; tests move with their code.

**Deleted (about 2,600 to 3,000 lines)**:

| Code                                                                                                                               | Lines       | Why it goes                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `src/runs/postgres-run-store.ts`: claim, sibling check, leases, heartbeat, reaper, retry, availability polling, preemption queries | ~350 of 679 | Absurd claims and leases; the pointer orders turns                                 |
| `src/runs/worker.ts`                                                                                                               | 330         | Replaced by the harness claim loop                                                 |
| `src/runs/memory-run-store.ts`                                                                                                     | 422         | Tests run on Postgres (D7); #2453 already removes in-memory stores from prod       |
| `src/runs/run-signal-store.ts`, `postgres-run-signal-store.ts`                                                                     | 393         | Steer becomes an item, abort becomes `cancel_task`, client result becomes an event |
| `src/runs/background-ownership.ts`, `background-controller.ts`, `drain.ts`, `instance-registry.ts`, `reaper.ts`, `retry-delay.ts`  | 377         | Separate harness, Absurd retries                                                   |
| `src/core/turn-resume.ts` backward scan                                                                                            | ~100 of 178 | The turn's items are found by `turn_id`, with no heuristic                         |
| `src/api/routes/background-work.ts`, `cli/src/background-work.ts`, ownership guards in `cli/src/backends/aws.ts`                   | ~550        | No ownership protocol                                                              |
| `src/wiring.ts`: preemption sweep, return sweep, signal pruning, reaper and ownership wiring                                       | ~250        | Folded into the admission and turn-end transactions                                |
| `docs/background-ownership.md`                                                                                                     | —           |                                                                                    |

**New (about 1,200 lines, plus the vendored SQL)**:

| Code                                                                    | Lines (est.)        | What it does                                                                   |
| ----------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `vendor/absurd/absurd.sql` (0.5.1) and install guard                    | 3,158 vendored + 40 | Absurd itself, not hand-reviewed line by line                                  |
| `src/turns/absurd.ts`                                                   | ~300                | Thin client over the stored functions, transaction-aware (D1)                  |
| `src/turns/admission.ts`                                                | ~250                | Admission and turn-end transactions, queued input, batching, owner cap         |
| `src/turns/harness-loop.ts`                                             | ~250                | Multi-queue claim, LISTEN, slots and overcommit, extend, yield and park, drain |
| `src/turns/turn-task.ts`                                                | ~200                | Runs the orchestrator for a turn, suspension points, fencing, error budget     |
| `src/turns/repair.ts`, `cancel-tree.ts`, `barriers.ts`                  | ~150                | Stuck pointers, tree cancel, fan-in counter                                    |
| `src/harness-main.ts`, roles                                            | ~60                 | Separate process entry                                                         |
| qm-yc infrastructure: harness ECS service, task definition, autoscaling | separate repo       |                                                                                |

Net: roughly 1,400 to 1,800 fewer production lines (estimate).

## Risks

1. **Absurd maturity (0.5.x, "an experiment in durability", about 2.5k stars, 34 open issues).** Mitigations: vendor a pinned SQL file; we use only about 10 functions; the code is readable plpgsql we can patch. Upstream shipped a real performance fix today (0.5.1). That shows active care, and also that rough edges remain.
2. **Polling cost.** `claim_task` runs a cancellation sweep, an expired-lease sweep (bounded per call), and the candidate pick on every call. With one loop per process, three queues, LISTEN, and a 1 s fallback poll, four harness tasks idle at about 12 claims per second. Today every notification wakes 16 workers per process. Watch the `t_` table size, because cancellation-sweep cost on 0.5.0 grew with history. 0.5.1 indexes it, and cleanup keeps history to 7 days.
3. **Table growth.** Per turn: one `t_` row, one `r_` row per attempt, checkpoints only at suspensions, and one `e_` row per suspension. At 50k turns a day that is about 350k task rows at 7-day retention, which is small. Partitioned storage is the next step if needed (weekly partitions, dropped whole).
4. **Fairness.** FIFO queues let one swarm starve other background work. The owner cap (section 3) handles it. A misconfigured cap either starves swarms or lets them flood the queue, so the cap needs a dashboard number.
5. **Crash attempts.** Lease-expiry crashes use Absurd attempts. A process that crash-loops across deploys could exhaust 10 attempts on a healthy turn. Planned handback (`schedule_run`) avoids this for deploys. Hard kills still count.
6. **Version skew** between old and new harness during rolling deploys (section 6). It is the same discipline as today's blue/green overlap, without the ownership handoff.
7. **Two engines at once** during cutover. The legacy claim must ignore Absurd rows, and sessions must not split across engines. Both rules are in section 7 and get tests.
8. **Event scope.** Emitting into the wrong queue silently wakes nothing. The barrier and resume rows record the target queue, and tests cover cross-queue fan-in (a background child waking a people-tier parent).

## Staged PR plan (estimates; dates Pacific)

ETA for the whole series: about 3 weeks of focused work, landing around **Mon Nov 9** with the harness split live on dogfood by **Thu Nov 5**.

| PR        | Contents                                                                                                                                                                                                                            | ETA (est.)          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1         | Vendor Absurd 0.5.1, startup install, three queues, thin client and its tests. No behaviour change.                                                                                                                                 | 1 day, Wed Oct 21   |
| 2         | Turn ledger columns, `sessions.active_turn_id`, admission and turn-end transactions, turn task on Absurd (single queue), steer as item, stop as `cancel_task`, fencing, stuck-pointer repair; runs in-process behind `absurd_turns` | 3 days, Mon Oct 26  |
| 3         | Three queues, preferring claim loop with LISTEN, people overcommit and capacity parking, same-conversation parking                                                                                                                  | 2 days, Wed Oct 28  |
| 4         | Fan-in batching, barrier wait, tree cancel, scheduled wakes, owner cap                                                                                                                                                              | 3 days, Mon Nov 2   |
| 5         | `QM_ROLES`, `harness-main`, SIGTERM handback; crons and sweepers to harness; qm-yc harness ECS service; dogfood rehearsal                                                                                                           | 2–3 days, Thu Nov 5 |
| 6         | Ramp to all, wait for the legacy drain, delete the legacy engine, signals, ownership protocol and CLI guards                                                                                                                        | 2 days, Mon Nov 9   |
| 7 (later) | Approvals and client tools as suspend-for-event; port the thin client to Rust for crystal                                                                                                                                           | —                   |

**Ways to be faster:**

- Merge PRs 1 and 2.
- Ship PR 3 with reserved people slots instead of overcommit-and-park (fewer moving parts), and add parking only if people still wait.
- Delete the ownership protocol in PR 5 instead of PR 6.
- Skip same-conversation parking entirely if D3 goes that way.

## Open decisions for Regan

- **D1. Thin client vs `absurd-sdk`.** Recommend a thin TypeScript client of about 300 lines. Admission and turn end must call `spawn_task` and `complete_run` inside QM's own transactions. The SDK's `TaskContext` cannot do that, its worker polls one queue, and its default `process.exit` on overrun is unsafe for a shared process. The same API also ports directly to crystal's Rust client.
- **D2. Items are the steps.** Use no per-model or per-tool Absurd checkpoints, only suspension markers. This departs from qm-crystal's step mapping. Recommend yes.
- **D3. Same-conversation parking.** Should a person's message into a conversation running a cron turn park that turn mid-way, interleaving it in the transcript? Alternatives: the person waits, or the message stops the cron turn. Recommend park, as specified in #2356's intent.
- **D4. Owner cap** for background fairness: per swarm, else per owner, default 8. Is that the right key and number?
- **D5. Vendoring policy**: pin 0.5.1 and patch locally when needed, or track upstream releases.
- **D6. Timing**: `claim_timeout` 60 s (extended every 20 s), a 20 s graceful yield before handback, and 7-day Absurd retention.
- **D7. Tests on Postgres**: delete `memory-run-store.ts` and run run-engine tests on real Postgres (or PGlite, which supports plpgsql).
- **D8. Order of queued input in a busy conversation**: tier first, then FIFO (proposed), or strict FIFO as today.
- **D9. Keep the `runs` table name** for the turn ledger now and rename to `turns` later, or rename during the cutover.
- **D10. Core rollout**: once no turns run in core, should core keep blue/green routing for rollback safety or switch to plain rolling deploys?

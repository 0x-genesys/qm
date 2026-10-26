import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { forEachTerminalRun, type Run, type RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { goalCapSpent, type GoalRecord } from "../harness/goal.ts";
import { swallowAs } from "../util/errors.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import {
  appendMessage,
  controlState,
  goalOwner,
  memberById,
  swarmExpired,
  SWARM_LIMITS,
  type Swarm,
  type SwarmMember,
  type SwarmStore,
} from "./swarm-store.ts";

const GOAL_CONTINUATION_TEXT =
  "Your previous turn ended before your goal was finished, and the goal is still active. Continue working on it.";

function goalPauseText(goal: GoalRecord): string {
  return [
    "The governor paused my goal; it needs a decision from you, as the agent that gave me the goal (or my parent, if I set it myself).",
    `Goal: ${goal.objective}`,
    `Why it paused: ${goal.pauseReason ?? goal.governor?.reasons ?? ""}`,
    "Reply to me with notify:true: a reply from you or the swarm root lets me resume the goal. Sending me a new goal replaces it instead.",
  ].join("\n");
}

type GoalProgress = NonNullable<SwarmMember["goalContinuation"]>;

function goalWorker(swarm: Swarm, memberId: string): SwarmMember | undefined {
  const member = memberById(swarm, memberId);
  if (!member?.sessionId || member.id === swarm.id || member.state !== "ready" || swarmExpired(swarm)) return undefined;
  return member;
}

function continuationDue(swarm: Swarm, memberId: string, progress: GoalProgress): SwarmMember | undefined {
  const member = goalWorker(swarm, memberId);
  const last = member?.goalContinuation;
  if (
    !member ||
    controlState(swarm, member.id) !== "active" ||
    (last?.goalCreatedAt === progress.goalCreatedAt && last.tokensUsed >= progress.tokensUsed) ||
    swarm.messages.some((message) => message.notifications[member.id]?.state === "pending")
  )
    return undefined;
  return member;
}

function pauseNoticeDue(swarm: Swarm, memberId: string, goal: GoalRecord): SwarmMember | undefined {
  const member = goalWorker(swarm, memberId);
  const last = member?.goalPauseNotice;
  if (
    !member ||
    controlState(swarm, member.id) === "stopped" ||
    (last?.goalCreatedAt === goal.createdAt && last.pausedAt === goal.updatedAt)
  )
    return undefined;
  return member;
}

export function createSwarmGoalContinuation(deps: {
  store: SwarmStore;
  sessions: SessionStore;
  runs: RunStore;
  lock: AdvisoryLock;
}): Sweeper & { sweep(): Promise<void> } {
  const { store, sessions, runs } = deps;

  async function noticePause(swarm: Swarm, memberId: string, goal: GoalRecord): Promise<void> {
    if (!pauseNoticeDue(swarm, memberId, goal)) return;
    await store.update(swarm.id, (current) => {
      const worker = pauseNoticeDue(current, memberId, goal);
      if (!worker) return;
      worker.goalPauseNotice = { goalCreatedAt: goal.createdAt, pausedAt: goal.updatedAt };
      const owner = goalOwner(current, worker.id, goal.createdAt);
      appendMessage(
        current,
        {
          senderId: worker.id,
          senderSessionId: worker.sessionId!,
          author: "agent",
          actorId: current.ownerId,
          text: goalPauseText(goal),
          audience: [owner],
        },
        [owner],
        { budgeted: false },
      );
    });
  }

  async function sweepRun(run: Run, checked: Set<string>): Promise<void> {
    const target = run.request.swarm;
    if (!target) return;
    const interrupted = run.result?.stopped || run.lastStop?.kind === "shutdown" || run.lastStop?.kind === "parked";
    const worker = `${target.swarmId}:${target.recipientId}`;
    if (!interrupted && checked.has(worker)) return;
    checked.add(worker);
    const swarm = await store.get(target.swarmId);
    const sessionId = swarm ? memberById(swarm, target.recipientId)?.sessionId : undefined;
    if (!swarm || !sessionId) return;
    const goal = (await sessions.goals([sessionId])).get(sessionId);
    if (goal?.status === "paused" && goal.governor?.verdict === "pause")
      return noticePause(swarm, target.recipientId, goal);
    if (!interrupted || goal?.status !== "active" || goalCapSpent(goal)) return;
    const progress = { goalCreatedAt: goal.createdAt, tokensUsed: goal.tokensUsed };
    const member = continuationDue(swarm, target.recipientId, progress);
    if (!member || (await runs.inFlightForThread(member.threadRef)).length) return;
    await store.update(swarm.id, (current) => {
      const recipient = continuationDue(current, member.id, progress);
      if (!recipient) return;
      recipient.goalContinuation = progress;
      appendMessage(
        current,
        {
          senderId: recipient.id,
          senderSessionId: recipient.sessionId!,
          author: "agent",
          actorId: current.ownerId,
          text: GOAL_CONTINUATION_TEXT,
          audience: [recipient.id],
          unbudgeted: true,
        },
        [recipient.id],
      );
    });
  }

  async function sweep(): Promise<void> {
    const claim = deps.lock.tryWithLock?.bind(deps.lock) ?? deps.lock.withLock.bind(deps.lock);
    await claim("swarm-goal-continuation", () => {
      const now = Date.now();
      const checked = new Set<string>();
      return forEachTerminalRun(
        runs,
        { fromMs: now - SWARM_LIMITS.continuationLookbackMs, beforeMs: now, page: SWARM_LIMITS.continuationPage },
        async (batch) => {
          for (const run of batch) await sweepRun(run, checked).catch(swallowAs("swarm: goal continuation", undefined));
        },
      );
    });
  }

  return {
    ...createSweeper(sweep, SWARM_LIMITS.continuationSweepMs, { label: "swarm-goal-continuation", immediate: true }),
    sweep,
  };
}

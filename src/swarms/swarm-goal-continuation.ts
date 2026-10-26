import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { forEachTerminalRun, type Run, type RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { goalCapSpent } from "../harness/goal.ts";
import { swallowAs } from "../util/errors.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import {
  appendMessage,
  controlState,
  memberById,
  swarmExpired,
  SWARM_LIMITS,
  type Swarm,
  type SwarmMember,
  type SwarmStore,
} from "./swarm-store.ts";

const GOAL_CONTINUATION_TEXT =
  "Your previous turn ended before your goal was finished, and the goal is still active. Continue working on it.";

type GoalProgress = NonNullable<SwarmMember["goalContinuation"]>;

function continuationDue(swarm: Swarm, memberId: string, progress: GoalProgress): SwarmMember | undefined {
  const member = memberById(swarm, memberId);
  const last = member?.goalContinuation;
  if (
    !member?.sessionId ||
    member.id === swarm.id ||
    member.state !== "ready" ||
    controlState(swarm, member.id) !== "active" ||
    swarmExpired(swarm) ||
    (last?.goalCreatedAt === progress.goalCreatedAt && last.tokensUsed >= progress.tokensUsed) ||
    swarm.messages.some((message) => message.notifications[member.id]?.state === "pending")
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

  async function continueGoal(run: Run): Promise<void> {
    const target = run.request.swarm;
    const interrupted = run.result?.stopped || run.lastStop?.kind === "shutdown" || run.lastStop?.kind === "parked";
    if (!target || !interrupted) return;
    const swarm = await store.get(target.swarmId);
    const sessionId = swarm ? memberById(swarm, target.recipientId)?.sessionId : undefined;
    if (!swarm || !sessionId) return;
    const goal = (await sessions.goals([sessionId])).get(sessionId);
    if (goal?.status !== "active" || goalCapSpent(goal)) return;
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
        },
        [recipient.id],
        { budgeted: false },
      );
    });
  }

  async function sweep(): Promise<void> {
    const claim = deps.lock.tryWithLock?.bind(deps.lock) ?? deps.lock.withLock.bind(deps.lock);
    await claim("swarm-goal-continuation", () => {
      const now = Date.now();
      return forEachTerminalRun(
        runs,
        { fromMs: now - SWARM_LIMITS.continuationLookbackMs, beforeMs: now, page: SWARM_LIMITS.continuationPage },
        async (batch) => {
          for (const run of batch)
            if (run.request.swarm) await continueGoal(run).catch(swallowAs("swarm: goal continuation", undefined));
        },
      );
    });
  }

  return {
    ...createSweeper(sweep, SWARM_LIMITS.continuationSweepMs, { label: "swarm-goal-continuation", immediate: true }),
    sweep,
  };
}

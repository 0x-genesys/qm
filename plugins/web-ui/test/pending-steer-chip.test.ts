import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";

let turnPosts = 0;

test("a steered queued message stays visible as Steering until model intake or the run ends", async (t) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="composer"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async (input: string) => {
      if (input.endsWith("/api/turn")) {
        turnPosts++;
        return Response.json({ runId: `typed${turnPosts}` });
      }
      return Response.json({ sessions: [] });
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let composer: ComposerSurface | undefined;
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { createComposerSurface } = await vite.ssrLoadModule("/src/composer.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
    const { render } = await vite.ssrLoadModule("lit");
    appState.me = { user: "tester", org: "test" };
    const model = {
      id: "alpha",
      name: "Alpha",
      label: "Alpha",
      buttonLabel: "Alpha",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    };
    seedRuntimeConfig("personal:tester", {
      scopeId: "personal:tester",
      approvedHarnesses: ["pi"],
      modelsByHarness: { pi: ["alpha"] },
      modelCatalog: { alpha: model },
      orgDefault: { harnessId: "pi", modelId: "alpha", revision: 1 },
      effective: { harnessId: "pi", modelId: "alpha" },
      scopeOverride: null,
      upgradeAvailable: false,
    });
    const threadRef = "web:tester:steering";
    const host = document.querySelector<HTMLElement>("#composer")!;
    const agentState = { isStreaming: true, model, messages: [] as unknown[] };
    const agent = { state: agentState } as unknown as Agent;
    let live = true;
    let liveRunId = "r1";
    const signalled: string[] = [];
    let signalOutcome: { ok: boolean; reason?: string } = { ok: true };
    const draw = (): void => render([composer!.queuedStrip(agent), composer!.composerForm(agent)], host);
    const ctx = {
      pane: false,
      chat: {
        state: {
          agent,
          host,
          threadRef,
          sessionId: "s",
          scopeId: "personal:tester",
          resolvingApprovals: new Set<string>(),
        },
        activePendingApprovals: () => [],
        hasUnresolvedApproval: () => false,
        isStopping: () => false,
        hasLiveRun: () => live,
        liveRunId: () => (live ? liveRunId : null),
        currentTurnOptions: () => ({}),
        signalLiveRun: async (_kind: string, _text: string, queuedRunId: string) => {
          signalled.push(queuedRunId);
          return signalOutcome;
        },
        drawActiveChat: draw,
        resumeIfIdle() {},
      },
    } as unknown as ConvCtx;
    composer = createComposerSurface(ctx);
    ctx.composer = composer!;
    await composer!.refreshRuntimeSelection("personal:tester", agent);
    const chips = () =>
      [...host.querySelectorAll(".queued-chip")].map((chip) => ({
        tag: chip.querySelector(".queued-tag")?.textContent?.trim(),
        text: chip.querySelector(".queued-text")?.textContent?.trim(),
      }));
    const steer = async (runId: string): Promise<void> => {
      composer!.setQueuedRuns(threadRef, [{ runId, text: "same text" }]);
      draw();
      host.querySelector<HTMLButtonElement>(".queued-steer")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(signalled.includes(runId));
      draw();
    };
    const intake = (runId: string, entrySeq: number): void => {
      agentState.messages.push({
        role: "user",
        content: "same text",
        steered: true,
        entrySeq,
        ts: `queued-steer:${threadRef}:${runId}`,
      });
    };

    await t.test("accepting a steer keeps the chip and fabricates no transcript message", async () => {
      await steer("q1");
      assert.deepEqual(composer!.queuedRunsFor(threadRef), []);
      assert.deepEqual(chips(), [{ tag: "Steering", text: "same text" }]);
      assert.equal(agentState.messages.length, 0);
    });

    await t.test("repeated text settles only the steer whose intake ts arrived", async () => {
      await steer("q2");
      assert.deepEqual(chips(), [
        { tag: "Steering", text: "same text" },
        { tag: "Steering", text: "same text" },
      ]);
      intake("q2", 4);
      draw();
      assert.deepEqual(chips(), [{ tag: "Steering", text: "same text" }]);
      intake("q1", 5);
      draw();
      assert.deepEqual(chips(), []);
    });

    await t.test("an unrelated steered message with the same text does not settle the chip", async () => {
      await steer("q3");
      agentState.messages.push({ role: "user", content: "same text", steered: true, entrySeq: 6, ts: "other" });
      draw();
      assert.deepEqual(chips(), [{ tag: "Steering", text: "same text" }]);
    });

    const queuedChips = () => chips().filter((chip) => chip.tag !== "Steering");
    const until = async (done: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !done(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        draw();
      }
      assert.ok(done());
    };
    const typeAndSend = async (text: string, how: "enter" | "queue"): Promise<void> => {
      const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
      input.value = text;
      input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
      if (how === "enter")
        host
          .querySelector<HTMLTextAreaElement>("textarea")!
          .dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      else host.querySelector<HTMLButtonElement>('[aria-label="Queue for after this turn"]')!.click();
      await until(() => queuedChips().some((chip) => chip.text === text) || chips().some((chip) => chip.text === text));
      await new Promise((resolve) => setTimeout(resolve, 0));
      draw();
    };

    await t.test("Enter during a run queues once and steers that message", async () => {
      const posts = turnPosts;
      const sent = signalled.length;
      await typeAndSend("use the smaller change", "enter");
      assert.equal(turnPosts, posts + 1);
      assert.deepEqual(signalled.slice(sent), [`typed${turnPosts}`]);
      assert.deepEqual(composer!.queuedRunsFor(threadRef), []);
      assert.ok(chips().some((chip) => chip.tag === "Steering" && chip.text === "use the smaller change"));
    });

    await t.test("Queue leaves the message for after the turn without steering", async () => {
      const sent = signalled.length;
      await typeAndSend("then write the tests", "queue");
      assert.equal(signalled.length, sent);
      assert.deepEqual(queuedChips(), [{ tag: "Queued", text: "then write the tests" }]);
      composer!.setQueuedRuns(threadRef, []);
    });

    await t.test("a refused steer stays as After this turn and is not retried during the run", async () => {
      signalOutcome = { ok: false, reason: "account_changed: send a new message to use your selected AI account" };
      const sent = signalled.length;
      await typeAndSend("first refused", "enter");
      assert.equal(signalled.length, sent + 1);
      assert.deepEqual(queuedChips(), [{ tag: "After this turn", text: "first refused" }]);
      await typeAndSend("second message", "enter");
      assert.equal(signalled.length, sent + 1);
      assert.deepEqual(queuedChips(), [
        { tag: "After this turn", text: "first refused" },
        { tag: "After this turn", text: "second message" },
      ]);
      assert.ok(
        [...host.querySelectorAll<HTMLButtonElement>(".queued-steer")]
          .filter((b) => b.textContent?.includes("Steer"))
          .every((b) => b.disabled),
      );
      assert.equal(host.querySelector('[aria-label="Steer the running task"]'), null);
      assert.equal(composer!.state.error, "");
    });

    await t.test("the next run can be steered again", async () => {
      signalOutcome = { ok: true };
      liveRunId = "r2";
      draw();
      assert.deepEqual(queuedChips(), [
        { tag: "Queued", text: "first refused" },
        { tag: "Queued", text: "second message" },
      ]);
      assert.ok(host.querySelector('[aria-label="Steer the running task"]'));
      composer!.setQueuedRuns(threadRef, []);
      const sent = signalled.length;
      await typeAndSend("now it can steer", "enter");
      assert.deepEqual(signalled.slice(sent), [`typed${turnPosts}`]);
      assert.deepEqual(queuedChips(), []);
    });

    await t.test("the chip goes when the run ends without intake", async () => {
      agentState.isStreaming = false;
      live = false;
      draw();
      assert.deepEqual(chips(), []);
      agentState.isStreaming = true;
      live = true;
      draw();
      assert.deepEqual(chips(), []);
    });
  } finally {
    composer?.dispose?.();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

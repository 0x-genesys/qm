import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { loadInjectedSource } from "./injected-engine.mjs";
const WORLD = "qm-browse";
const DEFAULT_TIMEOUT = 15000;
const MAX_TIMEOUT = 60000;
const METHODS = new Set([
  "tabs.list",
  "tabs.new",
  "tabs.close",
  "tab.goto",
  "tab.url",
  "tab.title",
  "tab.evaluate",
  "tab.screenshot",
  "tab.snapshot",
  "locator.count",
  "locator.textContent",
  "locator.click",
  "locator.fill",
]);
const text = (value, name) => {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
};
const pageUrl = (value) => {
  const raw = text(value, "url");
  const parsed = new URL(raw);
  if (raw !== "about:blank" && !["http:", "https:"].includes(parsed.protocol))
    throw new Error("Page URL must use http:// or https://, or be about:blank");
  return raw;
};
const remaining = (deadline) => {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error("Browser command timed out; do not automatically repeat a mutating action");
  return ms;
};
async function inPage(operation, selector, value, timeoutMs) {
  const expires = performance.now() + timeoutMs;
  const checkDeadline = () => {
    if (performance.now() >= expires) throw new Error("Locator precondition timed out");
  };
  const engine = globalThis.__qmInjected;
  if (operation === "snapshot") {
    const descriptors = [];
    try {
      for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        descriptors.push([proto, descriptor]);
        Object.defineProperty(proto, "value", {
          ...descriptor,
          get() {
            const kind = `${this.type} ${this.autocomplete} ${this.name} ${this.id}`.toLowerCase();
            if (/password|passwd|one-time-code|otp|email|username|phone|(?:^|[ _-])tel(?:$|[ _-])/.test(kind))
              return "<redacted>";
            return descriptor.get.call(this);
          },
        });
      }
      return engine.ariaSnapshot(document.body || document.documentElement, { mode: "ai" });
    } finally {
      for (const [proto, descriptor] of descriptors) Object.defineProperty(proto, "value", descriptor);
    }
  }
  if (operation === "finishClick") {
    const result = globalThis.__qmAction?.interceptor?.stop();
    delete globalThis.__qmAction;
    return result || "done";
  }
  if (operation === "fill") {
    const element = globalThis.__qmAction?.element;
    delete globalThis.__qmAction;
    if (!element?.isConnected) throw new Error("Fill target detached before input; no text was inserted");
    const target = engine.retarget(element, "follow-label");
    const result = engine.fill(element, value);
    if (result === "needsinput") {
      if (!target.isConnected || target.getRootNode().activeElement !== target)
        throw new Error("Fill target lost focus; no text was inserted");
      if (!document.execCommand(value ? "insertText" : "delete", false, value))
        throw new Error("Native text editing failed");
      return "done";
    }
    return result;
  }
  const parsed = engine.parseSelector(selector);
  const checkFrames = (parsed) => {
    for (const part of parsed.parts) {
      if (part.name === "internal:control")
        throw new Error("Frame traversal is not supported by this CDP service; no frame action was performed");
      if (part.body?.parsed) checkFrames(part.body.parsed);
    }
  };
  checkFrames(parsed);
  if (operation === "count") return engine.querySelectorAll(parsed, document).length;
  const element = engine.querySelector(parsed, document, true);
  if (!element) return { retry: "No element matched the selector" };
  if (operation === "textContent") return { value: element.textContent };
  const states = operation === "prepareClick" ? ["visible", "enabled", "stable"] : ["visible", "enabled", "editable"];
  let state = await engine.checkElementStates(element, states, true);
  checkDeadline();
  if (state) return { retry: typeof state === "string" ? state : `Element is not ${state.missingState}` };
  if (operation === "prepareFill") {
    globalThis.__qmAction = { element };
    return { ready: true };
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  state = await engine.checkElementStates(element, states, true);
  checkDeadline();
  if (state) return { retry: typeof state === "string" ? state : `Element is not ${state.missingState}` };
  const rects = [...element.getClientRects()]
    .map((rect) => ({
      left: Math.max(0, rect.left),
      right: Math.min(innerWidth, rect.right),
      top: Math.max(0, rect.top),
      bottom: Math.min(innerHeight, rect.bottom),
    }))
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
  const rect = rects.sort(
    (a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top),
  )[0];
  if (!rect) return { retry: "Element has no visible click point" };
  const point = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  const interceptor = engine.setupHitTargetInterceptor(element, "mouse", point, false);
  if (typeof interceptor === "string") return { retry: `Click is blocked: ${interceptor}` };
  setTimeout(() => interceptor.stop(), Math.max(1, expires - performance.now()));
  globalThis.__qmAction = { element, interceptor };
  return point;
}
const initialize = (injectedSource) => `"qm:init";\n(() => {
  if (globalThis.__qmInjected) return;
  const module = {};
  ${injectedSource}
  globalThis.__qmInjected = new (module.exports.InjectedScript())(globalThis, {
    isUnderTest: false, sdkLanguage: 'javascript', testIdAttributeName: 'data-testid',
    stableRafCount: 2, browserName: 'chromium', isUtilityWorld: true, customEngines: []
  });
})()`;
export async function connectBrowser(endpoint) {
  const initExpression = initialize(await loadInjectedSource());
  const url = new URL(text(endpoint, "CDP endpoint"));
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("CDP endpoint must use ws:// or wss://");
  const socket = new WebSocket(url);
  const service = new EventEmitter();
  const pending = new Map();
  const sessions = new Map();
  let tabs = new Map();
  let nextId = 0;
  let closed = false;
  let queue = Promise.resolve();
  function disconnect(reason = "Browser disconnected") {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
    sessions.clear();
    service.emit("disconnected");
  }
  socket.addEventListener("close", () => disconnect());
  socket.addEventListener("error", () => disconnect("Browser WebSocket failed"));
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      disconnect("Invalid CDP response");
      socket.close();
      return;
    }
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`CDP ${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result ?? {});
    } else if (message.method === "Target.targetDestroyed") {
      tabs.delete(message.params.targetId);
      const session = sessions.get(message.params.targetId);
      if (session) detach(session.id);
    } else if (message.method === "Target.detachedFromTarget") {
      detach(message.params.sessionId);
    } else if (message.method === "Runtime.executionContextsCleared") {
      for (const session of sessions.values()) if (session.id === message.sessionId) session.contexts.clear();
    } else if (message.method === "Runtime.executionContextDestroyed") {
      for (const session of sessions.values())
        if (session.id === message.sessionId) session.contexts.delete(message.params.executionContextId);
    } else if (message.method === "Page.lifecycleEvent") {
      for (const session of sessions.values())
        if (session.id === message.sessionId && message.params.name === "DOMContentLoaded") {
          session.loaded.add(message.params.loaderId);
          if (session.loaded.size > 32) session.loaded.delete(session.loaded.values().next().value);
        }
    }
  });
  function detach(sessionId) {
    for (const [id, session] of sessions) if (session.id === sessionId) sessions.delete(id);
    for (const [id, entry] of pending)
      if (entry.sessionId === sessionId) {
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(new Error("Browser tab detached; action outcome may be unknown"));
      }
  }
  function send(method, params = {}, sessionId, deadline = Date.now() + DEFAULT_TIMEOUT) {
    if (closed || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Browser disconnected"));
    const ms = remaining(deadline);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out; action outcome may be unknown`));
      }, ms);
      pending.set(id, { resolve, reject, timer, method, sessionId });
      try {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }
  service.close = () => {
    disconnect();
    socket.close();
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error("CDP connection timed out"));
      }, DEFAULT_TIMEOUT);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("CDP connection failed"));
      };
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
    });
    await send("Target.setDiscoverTargets", { discover: true });
    await list();
  } catch (error) {
    service.close();
    throw error;
  }
  async function list(deadline) {
    const { targetInfos } = await send("Target.getTargets", {}, undefined, deadline);
    tabs = new Map(targetInfos.filter((target) => target.type === "page").map((target) => [target.targetId, target]));
    return [...tabs.values()].map((target) => ({ id: target.targetId, url: target.url, title: target.title }));
  }
  async function attach(tabId, deadline) {
    if (sessions.has(tabId)) return sessions.get(tabId);
    const { sessionId } = await send("Target.attachToTarget", { targetId: tabId, flatten: true }, undefined, deadline);
    const session = { id: sessionId, contexts: new Set(), loaded: new Set() };
    sessions.set(tabId, session);
    try {
      for (const [method, params] of [
        ["Runtime.enable", {}],
        ["Page.enable", {}],
        ["Page.setLifecycleEventsEnabled", { enabled: true }],
      ])
        await send(method, params, sessionId, deadline);
      return session;
    } catch (error) {
      sessions.delete(tabId);
      throw error;
    }
  }
  async function evaluate(session, expression, deadline, contextId) {
    const result = await send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: remaining(deadline),
        ...(contextId === undefined ? {} : { contextId }),
      },
      session.id,
      deadline,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Page evaluation failed",
      );
    if (result.result?.unserializableValue) return result.result.unserializableValue;
    return result.result?.value;
  }
  async function world(session, deadline) {
    const { frameTree } = await send("Page.getFrameTree", {}, session.id, deadline);
    const { executionContextId } = await send(
      "Page.createIsolatedWorld",
      {
        frameId: frameTree.frame.id,
        worldName: WORLD,
        grantUniveralAccess: false,
      },
      session.id,
      deadline,
    );
    if (!session.contexts.has(executionContextId)) {
      await evaluate(session, initExpression, deadline, executionContextId);
      session.contexts.add(executionContextId);
    }
    return executionContextId;
  }
  const pageCall = (session, contextId, operation, selector, value, deadline) =>
    evaluate(
      session,
      `"qm:${operation === "snapshot" ? "snapshot" : `locator.${operation}`}";\n(${inPage.toString()})(${JSON.stringify(operation)},${JSON.stringify(selector)},${JSON.stringify(value)},${remaining(deadline)})`,
      deadline,
      contextId,
    );
  async function execute(command) {
    if (closed) throw new Error("Browser disconnected");
    if (!command || typeof command !== "object" || !METHODS.has(command.method))
      throw new Error("Unknown browser command");
    const { method, tabId, params = {} } = command;
    if (!params || typeof params !== "object" || Array.isArray(params))
      throw new Error("Command params must be an object");
    const allowed = new Set(["timeoutMs"]);
    if (method === "tabs.new" || method === "tab.goto") allowed.add("url");
    if (method === "tab.evaluate") allowed.add("expression");
    if (method.startsWith("locator.")) allowed.add("selector");
    if (method === "locator.fill") allowed.add("value");
    for (const key of Object.keys(params))
      if (!allowed.has(key)) throw new Error(`Unsupported ${method} parameter: ${key}`);
    const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > MAX_TIMEOUT)
      throw new Error(`timeoutMs must be between 1 and ${MAX_TIMEOUT}`);
    const deadline = Date.now() + timeout;
    if (method === "tabs.list") return list(deadline);
    if (method === "tabs.new") {
      const { targetId } = await send(
        "Target.createTarget",
        { url: pageUrl(params.url ?? "about:blank") },
        undefined,
        deadline,
      );
      const { targetInfo } = await send("Target.getTargetInfo", { targetId }, undefined, deadline);
      tabs.set(targetId, targetInfo);
      return { id: targetId, url: targetInfo.url, title: targetInfo.title };
    }
    if (typeof tabId !== "string" || !tabs.has(tabId)) throw new Error("Unknown tab ID; use tabs.list() first");
    if (method === "tabs.close") {
      const { success } = await send("Target.closeTarget", { targetId: tabId }, undefined, deadline);
      if (!success) throw new Error("Browser refused to close tab");
      tabs.delete(tabId);
      return null;
    }
    const session = await attach(tabId, deadline);
    if (method === "tab.url") return evaluate(session, "location.href", deadline);
    if (method === "tab.title") return evaluate(session, "document.title", deadline);
    if (method === "tab.evaluate") return evaluate(session, text(params.expression, "expression"), deadline);
    if (method === "tab.screenshot")
      return (await send("Page.captureScreenshot", { format: "png" }, session.id, deadline)).data;
    if (method === "tab.goto") {
      const result = await send("Page.navigate", { url: pageUrl(params.url) }, session.id, deadline);
      if (result.errorText || result.isDownload)
        throw new Error(`Navigation did not load a page: ${result.errorText || "download"}`);
      while (result.loaderId && !session.loaded.has(result.loaderId)) {
        if (closed || !sessions.has(tabId)) throw new Error("Browser disconnected during navigation");
        await sleep(Math.min(50, remaining(deadline)));
      }
      return evaluate(session, "location.href", deadline);
    }
    const contextId = await world(session, deadline);
    if (method === "tab.snapshot") return pageCall(session, contextId, "snapshot", null, null, deadline);
    const selector = text(params.selector, "selector");
    if (method === "locator.fill") text(params.value, "value");
    if (method === "locator.count") return pageCall(session, contextId, "count", selector, null, deadline);
    const operation =
      method === "locator.click" ? "prepareClick" : method === "locator.fill" ? "prepareFill" : "textContent";
    let result;
    for (;;) {
      result = await pageCall(session, contextId, operation, selector, null, deadline);
      if (!result?.retry) break;
      if (deadline - Date.now() <= 100) throw new Error(`${method} timed out: ${result.retry}`);
      await sleep(100);
    }
    if (method === "locator.textContent") return result.value;
    if (method === "locator.fill") {
      const filled = await pageCall(session, contextId, "fill", null, params.value, deadline);
      if (filled !== "done") throw new Error(`Fill failed: ${filled}`);
      return null;
    }
    let dispatched = false;
    let pressAttempted = false;
    const point = { x: result.x, y: result.y };
    try {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, session.id, deadline);
      pressAttempted = true;
      await send(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 },
        session.id,
        deadline,
      );
      await send(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 },
        session.id,
        deadline,
      );
      dispatched = true;
      const hit = await pageCall(session, contextId, "finishClick", null, null, deadline);
      if (hit !== "done")
        throw new Error(
          `Click was intercepted: ${typeof hit === "string" ? hit : hit.hitTargetDescription}; not retried`,
        );
    } catch (error) {
      if (
        dispatched &&
        /Cannot find context|Execution context was destroyed|Inspected target navigated/.test(error.message)
      )
        return null;
      throw error;
    } finally {
      if (pressAttempted && !dispatched && !closed)
        await send(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 },
          session.id,
          Date.now() + 1000,
        ).catch(() => {});
      if (!closed) await pageCall(session, contextId, "finishClick", null, null, Date.now() + 1000).catch(() => {});
    }
    return null;
  }
  service.execute = (command) => {
    const result = queue.then(() => execute(command));
    queue = result.catch(() => {});
    return result;
  };
  return service;
}

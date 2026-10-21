import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "vite";
import { harness } from "./deep-link-boot-fixture.ts";

test("keychain and connect cards take names and descriptions from the provider list", async () => {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
    virtualConsole,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of [
    "window",
    "document",
    "location",
    "history",
    "localStorage",
    "navigator",
    "HTMLElement",
    "Node",
    "DOMParser",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  const originalFetch = globalThis.fetch;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell.ts");
    const { noteConnectorResult, renderConnectors } = await vite.ssrLoadModule("/src/connectors.ts");
    const { connectorCard } = await vite.ssrLoadModule("/src/connector-widget.ts");
    const { connectorLinksIn } = await vite.ssrLoadModule("/src/connector-link.ts");
    const { render } = await vite.ssrLoadModule("lit");
    globalThis.fetch = async (input) =>
      String(input).includes("/api/connectors")
        ? Response.json({
            providers: {
              google: { label: "Google Workspace", description: "Gmail, Calendar, Drive, Sheets", available: true },
              acme: { label: "Acme CRM", description: "Deals & contacts", available: true },
              bare: { available: true },
            },
          })
        : Response.json({});
    const main = document.getElementById("main")!;
    appState.mainEl = main;
    appState.currentView = "keychain";
    noteConnectorResult("acme", "connected");
    await renderConnectors();
    assert.equal(main.querySelector(".status")!.textContent, "Acme CRM: connected.");
    const rows = [...main.querySelectorAll(".kc-account")].map((row) => ({
      name: row.querySelector("h3")!.textContent,
      description: row.querySelector(".kc-resource-meta")?.textContent ?? "",
      logo: row.querySelector(".connector-logo")!.getAttribute("data-service"),
    }));
    assert.deepEqual(rows, [
      { name: "Google Workspace", description: "Gmail, Calendar, Drive, Sheets", logo: "google" },
      { name: "Acme CRM", description: "Deals & contacts", logo: null },
      { name: "Bare", description: "", logo: null },
    ]);

    const links = connectorLinksIn("https://agent.example.com/connect/redeem/x?p=acme", "https://agent.example.com");
    assert.deepEqual(links, [{ provider: "acme", url: "https://agent.example.com/connect/redeem/x?p=acme" }]);
    const host = document.createElement("div");
    render(connectorCard(links[0]), host);
    assert.equal(host.querySelector("strong")!.textContent, "Connect Acme CRM");
    assert.equal(host.querySelector(".connector-logo")!.hasAttribute("data-service"), false);
    assert.ok(host.querySelector(".connector-logo svg"));
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
  }
});

test("a chat connect card picks up the provider label once the provider list loads", async () => {
  let releaseConnectors = (): void => {};
  const held = new Promise<void>((resolve) => (releaseConnectors = resolve));
  const h = await harness({
    path: "/s/sess-deep",
    entries: [
      {
        seq: 1,
        type: "assistant",
        createdAt: 1,
        payload: { text: "[Connect](http://localhost/connect/redeem/x?p=acme)" },
      },
    ],
    api: (path) =>
      path === "/api/connectors"
        ? held.then(() => Response.json({ providers: { acme: { label: "Acme CRM" } } }))
        : undefined,
  });
  const cardTitle = () => document.querySelector(".connector-widget strong")?.textContent;
  try {
    await h.boot();
    for (let i = 0; i < 100 && !cardTitle(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cardTitle(), "Connect Acme");
    releaseConnectors();
    for (let i = 0; i < 100 && cardTitle() !== "Connect Acme CRM"; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cardTitle(), "Connect Acme CRM");
  } finally {
    releaseConnectors();
    await h.close();
  }
});

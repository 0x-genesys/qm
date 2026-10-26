import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import pg from "pg";

const { base, signal, port } = workerData as { base: string; signal: Int32Array; port: MessagePort };
const baseUrl = new URL(base);
const prefix = baseUrl.pathname.slice(1);
const prepared = new Map<string, Promise<string>>();
let client: Promise<pg.Client> | undefined;

function admin(): Promise<pg.Client> {
  return (client ??= (async () => {
    const connected = new pg.Client({ connectionString: base });
    await connected.connect();
    return connected;
  })());
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function databaseUrl(name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(template: string): Promise<string> {
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  await (await admin()).query(`CREATE DATABASE ${quoted(name)}${template ? ` TEMPLATE ${quoted(template)}` : ""}`);
  return name;
}

function prepare(template: string): void {
  const next = createDatabase(template);
  next.catch(() => {});
  prepared.set(template, next);
}

async function migratedTemplate(): Promise<string> {
  const name = await createDatabase("");
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [new URL("./test-template.ts", import.meta.url).pathname, databaseUrl(name)], (error) =>
      error ? reject(error) : resolve(),
    );
  });
  return name;
}

async function take(template: string): Promise<string> {
  const name = await (prepared.get(template) ?? createDatabase(template));
  prepare(template);
  return name;
}

parentPort!.on("message", async (request: { template?: string; migrate?: boolean }) => {
  try {
    const name = request.migrate ? await migratedTemplate() : await take(request.template ?? "");
    port.postMessage({ ok: true, name });
  } catch (error) {
    port.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});

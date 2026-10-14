import { start } from "node:repl";
import { PassThrough, Writable } from "node:stream";
import { inspect } from "node:util";
import { createBrowserClient } from "./browser-client.mjs";
const send = (message) => process.send?.(message);
const { chromium } = await import(process.argv[3]);
const connection = await chromium.connect(process.argv[2]);
const browser = await createBrowserClient(connection);
let output = "";
const stream = new Writable({
  write(chunk, _encoding, done) {
    output = (output + chunk.toString()).slice(0, 10_000);
    done();
  },
});
const repl = start({ input: new PassThrough(), output: stream, terminal: false, prompt: "", useGlobal: false });
repl.context.browser = browser;
const tabs = await browser.tabs.list();
repl.context.tab = tabs.length ? await browser.tabs.get(tabs.at(-1).id) : await browser.tabs.new();
repl.context.console = new console.Console(stream, stream);
let active;
function complete(error, result, failed = error !== null && error !== undefined) {
  if (!active) return;
  const id = active;
  active = null;
  send({
    type: "result",
    id,
    error: failed ? error?.stack || error?.message || inspect(error) : undefined,
    result:
      result === undefined
        ? null
        : typeof result === "string"
          ? result
          : inspect(result, { depth: 6, maxArrayLength: 100, maxStringLength: 10_000 }),
    output,
  });
}
repl._domain.on("error", (error) => complete(error, undefined, true));
process.on("message", (message) => {
  if (message.type === "js") {
    output = "";
    active = message.id;
    repl.eval(message.code + "\n", repl.context, "browser-js", complete);
  }
});
process.on("disconnect", () => process.exit(0));

send({ type: "ready" });

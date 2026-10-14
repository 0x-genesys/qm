import { start } from "node:repl";
import { PassThrough, Writable } from "node:stream";
import { inspect } from "node:util";
import { createBrowserClient } from "./browser-client.mjs";
let sequence = 0;
const pending = new Map();
const send = (message) => process.send?.(message);
const browser = createBrowserClient(
  (command) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      send({ type: "command", id, command });
    }),
);
let output = "";
const stream = new Writable({
  write(chunk, _encoding, done) {
    output = (output + chunk.toString()).slice(0, 10_000);
    done();
  },
});
const repl = start({ input: new PassThrough(), output: stream, terminal: false, prompt: "", useGlobal: false });
repl.context.browser = browser;
repl.context.tab = browser.tabs.get(process.argv[2]);
repl.context.console = new console.Console(stream, stream);
let active;
function complete(error, result, failed = error !== null && error !== undefined) {
  if (!active) return;
  const id = active;
  active = null;
  send({
    type: "result",
    id,
    error: failed ? (error?.message ?? inspect(error)) : undefined,
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
  if (message.type === "reply") {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error));
    else request?.resolve(message.result);
  } else if (message.type === "js") {
    output = "";
    active = message.id;
    repl.eval(message.code + "\n", repl.context, "browser-js", complete);
  }
});
process.on("disconnect", () => process.exit(0));

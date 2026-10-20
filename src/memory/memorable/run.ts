import { spawn } from "node:child_process";

const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 2_048;

type MemorableRun =
  | { status: "exit"; code: number | null; stdout: string; stderr: string }
  | { status: "timeout" | "overflow" }
  | { status: "error"; message: string };

export function runMemorable(
  argv: readonly string[],
  args: readonly string[],
  input: string,
  timeoutMs: number,
  opts?: { env: NodeJS.ProcessEnv; apiKey?: string },
): Promise<MemorableRun> {
  return new Promise((resolve) => {
    const [cmd = "memorable", ...preArgs] = argv;
    const child = spawn(cmd, [...preArgs, ...args], {
      stdio: "pipe",
      ...(opts ? { env: { ...opts.env, ...(opts.apiKey ? { MEMORABLE_API_KEY: opts.apiKey } : {}) } } : {}),
    });
    child.unref();
    let stdout: Buffer[] = [];
    let stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (run: MemorableRun) => {
      if (settled) return;
      settled = true;
      stdout = [];
      stderr = [];
      clearTimeout(timer);
      resolve(run);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdout.push(chunk);
      else {
        child.kill();
        finish({ status: "overflow" });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < MAX_STDERR_BYTES) stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on("error", (error) => finish({ status: "error", message: error.message }));
    child.on("close", (code) =>
      finish({
        status: "exit",
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

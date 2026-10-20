import { spawn } from "node:child_process";

type MemorableRun =
  | { status: "exit"; code: number | null; stdout: string; stderr: string }
  | { status: "timeout" | "overflow" }
  | { status: "error"; message: string };

interface MemorableRunLimits {
  timeoutMs: number;
  maxStdoutBytes: number;
  stdoutOverflow: "kill" | "truncate";
  maxStderrBytes?: number;
}

export function runMemorable(
  argv: readonly string[],
  args: readonly string[],
  input: string,
  limits: MemorableRunLimits,
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
    }, limits.timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      const keep = stdoutBytes < limits.maxStdoutBytes;
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.maxStdoutBytes && limits.stdoutOverflow === "kill") {
        child.kill();
        finish({ status: "overflow" });
      } else if (keep) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < (limits.maxStderrBytes ?? 0)) stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on("error", (error) => finish({ status: "error", message: error.message }));
    child.on("exit", (code) =>
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

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeSlackCall {
  path: string;
  method: string;
  params: URLSearchParams;
}

export interface FakeSlackApi {
  origin: string;
  apiUrl: string;
  calls: FakeSlackCall[];
  errors: unknown[];
  close(): Promise<void>;
}

export async function startFakeSlackApi(
  reply: (call: FakeSlackCall) => Response | Promise<Response>,
): Promise<FakeSlackApi> {
  const calls: FakeSlackCall[] = [];
  const errors: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const path = req.url ?? "";
      const call = {
        path,
        method: path.split("/").at(-1)!,
        params: new URLSearchParams(Buffer.concat(chunks).toString()),
      };
      calls.push(call);
      try {
        const response = await reply(call);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      } catch (error) {
        errors.push(error);
        res.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    apiUrl: `${origin}/api/`,
    calls,
    errors,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parentPort, workerData } from "node:worker_threads";

const { entry } = workerData as { entry: string };
const surface = (await import(entry)) as { startServer(port: number, host?: string): Promise<Server> };
const server = await surface.startServer(0, "127.0.0.1");
parentPort?.postMessage((server.address() as AddressInfo).port);

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createS3DurableByteStore } from "../src/files/durable-byte-store.ts";
import { fakeS3Client } from "./support/fake-s3-client.ts";

test("S3 fallback streams large parts and aborts on transfer failure", async () => {
  let fail = false;
  const calls: string[] = [];
  const received: Buffer[] = [];
  const bytes = createS3DurableByteStore({
    bucket: "test",
    _client: fakeS3Client({
      async send(command: any) {
        const name = command.constructor.name;
        calls.push(name);
        if (name === "CreateMultipartUploadCommand") return { UploadId: "id" };
        if (name === "UploadPartCommand") {
          if (fail) throw new Error("network down");
          received.push(command.input.Body);
          return { ETag: "etag" };
        }
        return {};
      },
    }),
  });
  const input = Buffer.alloc(17 * 1024 * 1024, 0x31);
  const out = await bytes.put(Readable.from(input));
  assert.equal(out.sizeBytes, input.length);
  assert.equal(out.sha256, createHash("sha256").update(input).digest("hex"));
  assert.deepEqual(Buffer.concat(received), input);
  assert.deepEqual(
    received.map((part) => part.length),
    [16 * 1024 * 1024, 1024 * 1024],
  );
  fail = true;
  await assert.rejects(bytes.put(Readable.from(Buffer.alloc(17 * 1024 * 1024, 0x32))), /network down/);
  assert.equal(calls.at(-1), "AbortMultipartUploadCommand");
});

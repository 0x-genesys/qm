import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { uploadObject } from "../src/persistence/s3.ts";
import { fakeS3Client } from "./support/fake-s3-client.ts";

test("cancelling a multipart upload aborts it in S3 and never completes it", async () => {
  const calls: string[] = [];
  const partStarted = Promise.withResolvers<void>();
  const cancel = new AbortController();
  const client = fakeS3Client({
    async send(command: any) {
      const name = command.constructor.name;
      calls.push(name);
      if (name === "CreateMultipartUploadCommand") return { UploadId: "up-1" };
      if (name === "UploadPartCommand") {
        partStarted.resolve();
        await new Promise<void>((resolve) => cancel.signal.addEventListener("abort", () => resolve()));
        return { ETag: "etag" };
      }
      return {};
    },
  });
  const part = 5 * 1024 * 1024;
  const uploading = uploadObject(
    client,
    { Bucket: "b", Key: "k" },
    Readable.from([Buffer.alloc(part), Buffer.alloc(part), Buffer.alloc(10)]),
    part,
    cancel.signal,
  );
  await partStarted.promise;
  cancel.abort();
  await assert.rejects(uploading, { name: "AbortError" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(calls.includes("AbortMultipartUploadCommand"));
  assert.ok(!calls.includes("CompleteMultipartUploadCommand"));
});

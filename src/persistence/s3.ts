import { AbortMultipartUploadCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";

export function s3Client(region?: string): S3Client {
  return new S3Client(region ? { region } : {});
}

export async function uploadObject(
  client: S3Client,
  target: { Bucket: string; Key: string },
  body: Readable,
  partSize: number,
  signal?: AbortSignal,
): Promise<void> {
  const upload = new Upload({
    client,
    params: { ...target, Body: body },
    partSize,
    queueSize: 1,
    leavePartsOnError: true,
  });
  const cancel = (): void => void upload.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await upload.done();
  } catch (error) {
    const UploadId = upload.uploadId;
    if (UploadId)
      await client.send(new AbortMultipartUploadCommand({ ...target, UploadId })).catch((abortError: unknown) => {
        console.warn(
          `[s3] leaked S3 multipart parts for ${target.Key} (upload ${UploadId}) — abort failed: ${String(abortError)}`,
        );
      });
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export function bodyToReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body != null && typeof (body as ReadableStream).getReader === "function") {
    return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  }
  throw new Error("S3 GetObject returned an unreadable Body");
}

export function isNoSuchKey(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404;
}

export function isNoSuchLifecycleConfiguration(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NoSuchLifecycleConfiguration" ||
    e.Code === "NoSuchLifecycleConfiguration" ||
    e.$metadata?.httpStatusCode === 404
  );
}

import { S3Client } from "@aws-sdk/client-s3";

export function fakeS3Client(fake: { send(command: any): Promise<unknown> }): S3Client {
  const client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  client.send = fake.send as S3Client["send"];
  return client;
}

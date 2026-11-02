import { Pool } from "pg";
import { Redis } from "ioredis";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import type { Config } from "./config";
import type { Deps } from "./app";

export class StorageError extends Error {
  name = "StorageError";
}

export async function createServices(config: Config) {
  const db = new Pool({ connectionString: config.databaseUrl });
  // Placeholder for a real migration tool (node-pg-migrate, drizzle-kit, ...).
  await db.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id BIGSERIAL PRIMARY KEY,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const redis = new Redis(config.redisUrl);

  const s3 = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  });
  const Bucket = config.s3.bucket;
  await s3.send(new HeadBucketCommand({ Bucket })).catch(() => s3.send(new CreateBucketCommand({ Bucket })));

  // S3 messages are generic ("We encountered an internal error, please try again."): name the operation,
  // so log lines and Sentry issue titles say what failed. The original error stays as `cause`.
  const storageError = (op: string) => (err: unknown): never => {
    const { name, message } = err as Error;
    throw new StorageError(`S3 ${op} on bucket "${Bucket}" failed: ${name}: ${message}`, { cause: err });
  };

  const storage: Deps["storage"] = {
    async put(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType })).catch(storageError("PutObject"));
    },
    async get(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
        return { body: res.Body as Readable, contentType: res.ContentType };
      } catch (err) {
        if (err instanceof NoSuchKey) return null;
        return storageError("GetObject")(err);
      }
    },
    async ping() {
      await s3.send(new HeadBucketCommand({ Bucket }));
    },
  };

  return {
    deps: { db, redis, storage } satisfies Deps,
    async close() {
      await Promise.allSettled([db.end(), redis.quit()]);
      s3.destroy();
    },
  };
}

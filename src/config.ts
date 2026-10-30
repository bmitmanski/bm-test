function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env variable: ${name}`);
  return value;
}

export function loadConfig() {
  return {
    port: Number(process.env.PORT ?? 3000),
    logLevel: process.env.LOG_LEVEL ?? "info",
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    s3: {
      endpoint: required("S3_ENDPOINT"),
      region: process.env.S3_REGION ?? "us-east-1",
      bucket: required("S3_BUCKET"),
      accessKeyId: required("S3_ACCESS_KEY"),
      secretAccessKey: required("S3_SECRET_KEY"),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;

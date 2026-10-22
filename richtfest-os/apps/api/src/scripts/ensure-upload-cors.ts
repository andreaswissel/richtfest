import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../env";

const appOrigin = "https://app.richtfest.ai";

/** Add the approved app upload origin without replacing other origins or bucket permissions. */
export async function ensureUploadCors(client: S3Client, bucket: string) {
  const { CORSRules = [] } = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  const configured = CORSRules.some(rule =>
    rule.AllowedOrigins?.includes(appOrigin) &&
    rule.AllowedMethods?.includes("PUT") &&
    rule.AllowedHeaders?.some(header => ["content-type", "*"].includes(header.toLowerCase())),
  );
  if (configured) return { changed: false, origin: appOrigin };
  await client.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [...CORSRules, {
        AllowedOrigins: [appOrigin],
        AllowedMethods: ["PUT"],
        AllowedHeaders: ["content-type"],
        MaxAgeSeconds: 3000,
      }],
    },
  }));
  return { changed: true, origin: appOrigin };
}

if (import.meta.main) {
  if (!env.BUCKET || !env.ENDPOINT || !env.REGION || !env.ACCESS_KEY_ID || !env.SECRET_ACCESS_KEY)
    throw new Error("Railway Bucket credentials are required to configure upload CORS");
  const client = new S3Client({
    region: env.REGION,
    endpoint: env.ENDPOINT,
    forcePathStyle: false,
    credentials: { accessKeyId: env.ACCESS_KEY_ID, secretAccessKey: env.SECRET_ACCESS_KEY },
  });
  try {
    console.log("Upload CORS:", await ensureUploadCors(client, env.BUCKET));
  } finally {
    client.destroy();
  }
}

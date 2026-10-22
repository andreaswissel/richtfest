import { expect, test } from "bun:test";
import { GetBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";
import { ensureUploadCors } from "./ensure-upload-cors";

test("upload CORS adds only the app PUT rule, preserves existing rules and is idempotent", async () => {
  let policy = `<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <CORSRule><ID>existing-upload</ID><AllowedOrigin>https://richtfest-monorepo-production.up.railway.app</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedHeader>content-type</AllowedHeader><MaxAgeSeconds>3000</MaxAgeSeconds></CORSRule>
    <CORSRule><ID>existing-read</ID><AllowedOrigin>https://app.richtfest.ai</AllowedOrigin><AllowedMethod>GET</AllowedMethod><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>120</MaxAgeSeconds></CORSRule>
  </CORSConfiguration>`;
  let denyRead = false;
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (request.method === "GET") return denyRead
      ? new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })
      : new Response(policy, { headers: { "content-type": "application/xml" } });
    if (request.method === "PUT") { policy = await request.text(); return new Response(null, { status: 200 }); }
    return new Response(null, { status: 405 });
  } });
  const client = new S3Client({
    endpoint: `http://localhost:${server.port}`, region: "auto", forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" }, maxAttempts: 1,
  });
  const read = async () => (await client.send(new GetBucketCorsCommand({ Bucket: "fixture" }))).CORSRules;
  try {
    const original = await read();
    expect(await ensureUploadCors(client, "fixture")).toEqual({ changed: true, origin: "https://app.richtfest.ai" });
    expect(await read()).toEqual([...original!, {
      AllowedOrigins: ["https://app.richtfest.ai"], AllowedMethods: ["PUT"],
      AllowedHeaders: ["content-type"], MaxAgeSeconds: 3000,
    }]);
    const configured = policy;
    expect(await ensureUploadCors(client, "fixture")).toEqual({ changed: false, origin: "https://app.richtfest.ai" });
    expect(policy).toBe(configured);
    denyRead = true;
    await expect(ensureUploadCors(client, "fixture")).rejects.toThrow();
    expect(policy).toBe(configured);
  } finally {
    client.destroy();
    server.stop(true);
  }
});

// Railway Infrastructure as Code for the `richtfest-os` project. Apply it with
// `railway config plan` / `railway config apply`; Railway does not read this
// file during deploys. Pushes to `main` then deploy `richtfest-monorepo` from
// the root Dockerfile. Omitting a resource here deletes it on the next apply.
import { bucket, defineRailway, github, postgres, preserve, project, ref, service } from "railway/iac";

// Amsterdam keeps customer data in the EU.
const region = "europe-west4-drams3a";

export default defineRailway(() => {
  const db = postgres("Postgres", { region });
  const files = bucket("richtfest-files", { region: "ams" });

  const app = service("richtfest-monorepo", {
    source: github("andreaswissel/richtfest", { branch: "main" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    // The container applies database migrations before starting the API.
    healthcheck: "/health",
    healthcheckTimeout: 100,
    replicas: { [region]: 1 },
    env: {
      NODE_ENV: "production",
      DATABASE_URL: db.env.DATABASE_URL,
      BETTER_AUTH_URL: "https://${{RAILWAY_PUBLIC_DOMAIN}}",
      BUCKET: ref(files, "BUCKET"),
      ACCESS_KEY_ID: ref(files, "ACCESS_KEY_ID"),
      SECRET_ACCESS_KEY: ref(files, "SECRET_ACCESS_KEY"),
      REGION: ref(files, "REGION"),
      ENDPOINT: ref(files, "ENDPOINT"),
      // Secrets are set once in Railway (`railway variables --set`), never here.
      BETTER_AUTH_SECRET: preserve(),
      AI_CONNECTION_ENCRYPTION_KEY: preserve(),
      RESEND_API_KEY: preserve(),
      RESEND_FROM: preserve(),
    },
  });

  return project("richtfest-os", { resources: [app, db, files] });
});

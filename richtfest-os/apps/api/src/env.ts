import { z } from "zod";

export const env = z.object({
  TYPESAFE_API_KEY: z.string().trim().optional().transform(value => value || undefined),
  SOURCE_IMAGE_TRIAGE_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  GEOAPIFY_API_KEY: z.string().trim().optional(),
  PUBLIC_DATA_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  AGENT_SUPERVISOR_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  OPENAI_SUPERVISOR_MODEL: z.string().optional(), OPENAI_SPECIALIST_MODEL: z.string().optional(),
  ANTHROPIC_SUPERVISOR_MODEL: z.string().optional(), ANTHROPIC_SPECIALIST_MODEL: z.string().optional(),
  VERCEL_GATEWAY_URL: z.string().url().default("https://ai-gateway.vercel.sh/v1"),
  VERCEL_SUPERVISOR_MODEL: z.string().optional(), VERCEL_SPECIALIST_MODEL: z.string().optional(),
  DATABASE_URL: z.string().min(1), PORT: z.coerce.number().int().positive().default(3000),
  ALLOW_DEV_AUTH: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  SESSION_COOKIE: z.string().default("richtfest_session"), NODE_ENV: z.string().default("development"), AI_CONNECTION_ENCRYPTION_KEY: z.string().optional(), FILE_STORAGE_PATH: z.string().default("./.data/files"), BUCKET: z.string().optional(), ACCESS_KEY_ID: z.string().optional(), SECRET_ACCESS_KEY: z.string().optional(), REGION: z.string().optional(), ENDPOINT: z.string().url().optional(), BETTER_AUTH_SECRET: z.string().min(32).default("development-only-secret-change-me-1234567890"), BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"), RESEND_API_KEY: z.string().optional(), RESEND_FROM: z.string().optional()
}).parse({ SOURCE_IMAGE_TRIAGE_ENABLED: process.env.SOURCE_IMAGE_TRIAGE_ENABLED,
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, GEOAPIFY_API_KEY: process.env.GEOAPIFY_API_KEY, PUBLIC_DATA_ENABLED: process.env.PUBLIC_DATA_ENABLED, AGENT_SUPERVISOR_ENABLED: process.env.AGENT_SUPERVISOR_ENABLED, OPENAI_SUPERVISOR_MODEL: process.env.OPENAI_SUPERVISOR_MODEL, OPENAI_SPECIALIST_MODEL: process.env.OPENAI_SPECIALIST_MODEL, ANTHROPIC_SUPERVISOR_MODEL: process.env.ANTHROPIC_SUPERVISOR_MODEL, ANTHROPIC_SPECIALIST_MODEL: process.env.ANTHROPIC_SPECIALIST_MODEL, VERCEL_GATEWAY_URL: process.env.VERCEL_GATEWAY_URL, VERCEL_SUPERVISOR_MODEL: process.env.VERCEL_SUPERVISOR_MODEL, VERCEL_SPECIALIST_MODEL: process.env.VERCEL_SPECIALIST_MODEL, DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/richtfest", PORT: process.env.PORT ?? "3000", ALLOW_DEV_AUTH: process.env.NODE_ENV === "production" ? "false" : (process.env.ALLOW_DEV_AUTH ?? "false"), SESSION_COOKIE: process.env.SESSION_COOKIE ?? "richtfest_session", NODE_ENV: process.env.NODE_ENV ?? "development", AI_CONNECTION_ENCRYPTION_KEY: process.env.AI_CONNECTION_ENCRYPTION_KEY, FILE_STORAGE_PATH: process.env.FILE_STORAGE_PATH ?? "./.data/files", BUCKET: process.env.BUCKET, ACCESS_KEY_ID: process.env.ACCESS_KEY_ID, SECRET_ACCESS_KEY: process.env.SECRET_ACCESS_KEY, REGION: process.env.REGION, ENDPOINT: process.env.ENDPOINT, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "development-only-secret-change-me-1234567890", BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000", RESEND_API_KEY: process.env.RESEND_API_KEY, RESEND_FROM: process.env.RESEND_FROM });

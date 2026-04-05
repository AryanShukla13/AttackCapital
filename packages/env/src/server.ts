import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    CORS_ORIGIN: z.string().default("*"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    GCS_BUCKET_NAME: z.string().default(""),
    GCS_PROJECT_ID: z.string().default(""),
    GCS_KEY_FILE: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: false,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1",
});

import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().default(""),
    CORS_ORIGIN: z.string().default("*"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    BLOB_READ_WRITE_TOKEN: z.string().default(""),
    OPENAI_API_KEY: z.string().default(""),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: false,
});

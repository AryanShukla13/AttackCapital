import { env } from "@my-better-t-app/env/server";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function createDb() {
  return drizzle(env.DATABASE_URL, { schema });
}

export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_, prop) {
    if (!_db) {
      _db = createDb();
    }
    return (_db as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export * from "./schema";

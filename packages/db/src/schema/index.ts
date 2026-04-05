import { integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const recordingStatusEnum = pgEnum("recording_status", ["recording", "completed", "failed"]);

export const chunkStatusEnum = pgEnum("chunk_status", [
  "pending",
  "uploaded",
  "acknowledged",
  "failed",
]);

export const recordings = pgTable("recordings", {
  id: uuid("id").defaultRandom().primaryKey(),
  status: recordingStatusEnum("status").notNull().default("recording"),
  totalChunks: integer("total_chunks").default(0),
  sampleRate: integer("sample_rate").notNull().default(16000),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const chunks = pgTable("chunks", {
  id: uuid("id").defaultRandom().primaryKey(),
  recordingId: uuid("recording_id")
    .references(() => recordings.id, { onDelete: "cascade" })
    .notNull(),
  index: integer("index").notNull(),
  duration: integer("duration_ms").notNull(),
  gcsPath: text("gcs_path"),
  status: chunkStatusEnum("status").notNull().default("pending"),
  checksum: text("checksum"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
});

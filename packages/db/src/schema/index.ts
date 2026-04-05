import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const recordingStatusEnum = pgEnum("recording_status", ["recording", "completed", "failed"]);

export const chunkStatusEnum = pgEnum("chunk_status", [
  "pending",
  "uploaded",
  "acknowledged",
  "failed",
]);

export const transcriptionStatusEnum = pgEnum("transcription_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const recordings = pgTable("recordings", {
  id: uuid("id").defaultRandom().primaryKey(),
  status: recordingStatusEnum("status").notNull().default("recording"),
  totalChunks: integer("total_chunks").default(0),
  sampleRate: integer("sample_rate").notNull().default(16000),
  speakerCount: integer("speaker_count").default(0),
  languageCodes: jsonb("language_codes").$type<string[]>().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recordingId: uuid("recording_id")
      .references(() => recordings.id, { onDelete: "cascade" })
      .notNull(),
    index: integer("index").notNull(),
    duration: integer("duration_ms").notNull(),
    gcsPath: text("gcs_path"),
    status: chunkStatusEnum("status").notNull().default("pending"),
    checksum: text("checksum"),
    retryCount: integer("retry_count").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (table) => [unique("chunk_unique_idx").on(table.recordingId, table.index)],
);

export const transcriptions = pgTable("transcriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  chunkId: uuid("chunk_id")
    .references(() => chunks.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  recordingId: uuid("recording_id")
    .references(() => recordings.id, { onDelete: "cascade" })
    .notNull(),
  status: transcriptionStatusEnum("status").notNull().default("pending"),
  fullText: text("full_text"),
  languageCode: text("language_code"),
  confidence: real("confidence"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const speakerSegments = pgTable("speaker_segments", {
  id: uuid("id").defaultRandom().primaryKey(),
  transcriptionId: uuid("transcription_id")
    .references(() => transcriptions.id, { onDelete: "cascade" })
    .notNull(),
  recordingId: uuid("recording_id")
    .references(() => recordings.id, { onDelete: "cascade" })
    .notNull(),
  speakerTag: integer("speaker_tag").notNull(),
  speakerLabel: text("speaker_label"),
  text: text("text").notNull(),
  startTimeMs: integer("start_time_ms").notNull(),
  endTimeMs: integer("end_time_ms").notNull(),
  languageCode: text("language_code"),
  confidence: real("confidence"),
  wordTimings: jsonb("word_timings")
    .$type<Array<{ word: string; startMs: number; endMs: number; confidence: number }>>()
    .default([]),
});

// Write-ahead log for guaranteed delivery
export const uploadWal = pgTable("upload_wal", {
  id: uuid("id").defaultRandom().primaryKey(),
  recordingId: uuid("recording_id")
    .references(() => recordings.id, { onDelete: "cascade" })
    .notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  gcsPath: text("gcs_path"),
  checksum: text("checksum"),
  uploaded: boolean("uploaded").notNull().default(false),
  transcribed: boolean("transcribed").notNull().default(false),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

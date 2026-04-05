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

// --- Enums ---

export const sessionStatusEnum = pgEnum("session_status", ["active", "completed", "archived"]);

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

// --- Sessions (rooms) ---

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(), // short join code e.g. "ABC-1234"
  name: text("name"),
  status: sessionStatusEnum("status").notNull().default("active"),
  hostParticipantId: uuid("host_participant_id"), // set after first participant joins
  maxParticipants: integer("max_participants").notNull().default(10),
  languageCodes: jsonb("language_codes").$type<string[]>().default(["en-US"]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// --- Participants (users in a session) ---

export const participants = pgTable(
  "participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .references(() => sessions.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(), // display name e.g. "Alice"
    deviceId: text("device_id"), // browser fingerprint for reconnection
    isActive: boolean("is_active").notNull().default(true),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (table) => [unique("participant_device_idx").on(table.sessionId, table.deviceId)],
);

// --- Recordings (one per participant per session) ---

export const recordings = pgTable("recordings", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  participantId: uuid("participant_id").references(() => participants.id, { onDelete: "set null" }),
  status: recordingStatusEnum("status").notNull().default("recording"),
  totalChunks: integer("total_chunks").default(0),
  sampleRate: integer("sample_rate").notNull().default(16000),
  speakerCount: integer("speaker_count").default(1),
  languageCodes: jsonb("language_codes").$type<string[]>().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// --- Chunks ---

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recordingId: uuid("recording_id")
      .references(() => recordings.id, { onDelete: "cascade" })
      .notNull(),
    participantId: uuid("participant_id").references(() => participants.id, {
      onDelete: "set null",
    }),
    index: integer("index").notNull(),
    duration: integer("duration_ms").notNull(),
    gcsPath: text("gcs_path"),
    status: chunkStatusEnum("status").notNull().default("pending"),
    checksum: text("checksum"),
    retryCount: integer("retry_count").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    // Absolute timestamp when this chunk's audio starts (for cross-participant timeline merging)
    audioStartedAt: timestamp("audio_started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (table) => [unique("chunk_unique_idx").on(table.recordingId, table.index)],
);

// --- Transcriptions ---

export const transcriptions = pgTable("transcriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  chunkId: uuid("chunk_id")
    .references(() => chunks.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  recordingId: uuid("recording_id")
    .references(() => recordings.id, { onDelete: "cascade" })
    .notNull(),
  participantId: uuid("participant_id").references(() => participants.id, { onDelete: "set null" }),
  status: transcriptionStatusEnum("status").notNull().default("pending"),
  fullText: text("full_text"),
  languageCode: text("language_code"),
  confidence: real("confidence"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// --- Speaker Segments ---

export const speakerSegments = pgTable("speaker_segments", {
  id: uuid("id").defaultRandom().primaryKey(),
  transcriptionId: uuid("transcription_id")
    .references(() => transcriptions.id, { onDelete: "cascade" })
    .notNull(),
  recordingId: uuid("recording_id")
    .references(() => recordings.id, { onDelete: "cascade" })
    .notNull(),
  participantId: uuid("participant_id").references(() => participants.id, { onDelete: "set null" }),
  speakerTag: integer("speaker_tag").notNull(),
  speakerLabel: text("speaker_label"), // resolved from participant name
  text: text("text").notNull(),
  startTimeMs: integer("start_time_ms").notNull(),
  endTimeMs: integer("end_time_ms").notNull(),
  // Absolute timestamp for cross-participant merging
  absoluteStartMs: integer("absolute_start_ms"),
  languageCode: text("language_code"),
  confidence: real("confidence"),
  wordTimings: jsonb("word_timings")
    .$type<Array<{ word: string; startMs: number; endMs: number; confidence: number }>>()
    .default([]),
});

// --- Write-Ahead Log ---

export const uploadWal = pgTable("upload_wal", {
  id: uuid("id").defaultRandom().primaryKey(),
  recordingId: uuid("recording_id")
    .references(() => recordings.id, { onDelete: "cascade" })
    .notNull(),
  participantId: uuid("participant_id").references(() => participants.id, { onDelete: "set null" }),
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

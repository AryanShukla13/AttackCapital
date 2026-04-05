import { db, recordings, speakerSegments, transcriptions } from "@my-better-t-app/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const app = new Hono();

// Get all transcriptions for a recording (with speaker segments)
app.get("/:recordingId", async (c) => {
  const recordingId = c.req.param("recordingId");

  const recording = await db.query.recordings.findFirst({
    where: eq(recordings.id, recordingId),
  });
  if (!recording) {
    return c.json({ error: "Recording not found" }, 404);
  }

  const txns = await db
    .select()
    .from(transcriptions)
    .where(eq(transcriptions.recordingId, recordingId))
    .orderBy(transcriptions.createdAt);

  // Get all speaker segments for this recording
  const segments = await db
    .select()
    .from(speakerSegments)
    .where(eq(speakerSegments.recordingId, recordingId))
    .orderBy(speakerSegments.startTimeMs);

  // Build full transcript ordered by time
  const fullTranscript = segments
    .map(
      (seg) =>
        `[Speaker ${seg.speakerTag}${seg.speakerLabel ? ` (${seg.speakerLabel})` : ""}]: ${seg.text}`,
    )
    .join("\n");

  // Unique speakers
  const speakers = [...new Set(segments.map((s) => s.speakerTag))].map((tag) => {
    const speakerSegs = segments.filter((s) => s.speakerTag === tag);
    const languages = [...new Set(speakerSegs.map((s) => s.languageCode).filter(Boolean))];
    return {
      tag,
      label: speakerSegs[0]?.speakerLabel ?? `Speaker ${tag}`,
      languages,
      segmentCount: speakerSegs.length,
    };
  });

  return c.json({
    recordingId,
    status: {
      total: txns.length,
      completed: txns.filter((t) => t.status === "completed").length,
      processing: txns.filter((t) => t.status === "processing").length,
      failed: txns.filter((t) => t.status === "failed").length,
    },
    speakers,
    fullTranscript,
    segments,
    transcriptions: txns,
  });
});

// Get transcript for a single chunk
app.get("/chunk/:chunkId", async (c) => {
  const chunkId = c.req.param("chunkId");

  const txn = await db.query.transcriptions.findFirst({
    where: eq(transcriptions.chunkId, chunkId),
  });

  if (!txn) {
    return c.json({ error: "Transcription not found", status: "pending" }, 404);
  }

  const segments = await db
    .select()
    .from(speakerSegments)
    .where(eq(speakerSegments.transcriptionId, txn.id))
    .orderBy(speakerSegments.startTimeMs);

  return c.json({ ...txn, segments });
});

// Update speaker label (rename Speaker 1 to "Alice", etc.)
app.patch("/speaker/:recordingId/:speakerTag", async (c) => {
  const recordingId = c.req.param("recordingId");
  const speakerTag = Number(c.req.param("speakerTag"));
  const { label } = await c.req.json<{ label: string }>();

  const updated = await db
    .update(speakerSegments)
    .set({ speakerLabel: label })
    .where(eq(speakerSegments.recordingId, recordingId))
    .returning();

  const filtered = updated.filter((s) => s.speakerTag === speakerTag);
  return c.json({ updated: filtered.length });
});

// Set languages for a recording (used for transcription hints)
app.patch("/languages/:recordingId", async (c) => {
  const recordingId = c.req.param("recordingId");
  const { languages } = await c.req.json<{ languages: string[] }>();

  const [recording] = await db
    .update(recordings)
    .set({ languageCodes: languages })
    .where(eq(recordings.id, recordingId))
    .returning();

  if (!recording) {
    return c.json({ error: "Recording not found" }, 404);
  }
  return c.json(recording);
});

export default app;

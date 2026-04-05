import { chunks, db, recordings, transcriptions, uploadWal } from "@my-better-t-app/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { chunkExists } from "../lib/gcs";
import { transcribeChunk } from "../lib/transcribe";
import { broadcastToSession } from "../lib/ws";

const app = new Hono();

// Upload a chunk — returns IMMEDIATELY, transcription happens in background
app.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const recordingId = formData.get("recordingId") as string | null;
  const chunkIndex = formData.get("chunkIndex") as string | null;
  const durationMs = formData.get("durationMs") as string | null;
  const clientChecksum = formData.get("checksum") as string | null;
  const idempotencyKey = formData.get("idempotencyKey") as string | null;
  const participantId = formData.get("participantId") as string | null;
  const audioStartedAt = formData.get("audioStartedAt") as string | null;

  if (!file || !recordingId || chunkIndex === null || !durationMs) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  // Idempotency
  if (idempotencyKey) {
    const existing = await db.query.chunks.findFirst({
      where: and(eq(chunks.idempotencyKey, idempotencyKey), eq(chunks.recordingId, recordingId)),
    });
    if (existing) return c.json(existing, 200);
  }

  const existingByIndex = await db.query.chunks.findFirst({
    where: and(eq(chunks.recordingId, recordingId), eq(chunks.index, Number(chunkIndex))),
  });
  if (existingByIndex && existingByIndex.status === "acknowledged") {
    return c.json(existingByIndex, 200);
  }

  const recording = await db.query.recordings.findFirst({
    where: eq(recordings.id, recordingId),
  });
  if (!recording) return c.json({ error: "Recording not found" }, 404);

  const buffer = Buffer.from(await file.arrayBuffer());
  const serverChecksum = createHash("sha256").update(buffer).digest("hex");

  if (clientChecksum && clientChecksum !== serverChecksum) {
    return c.json({ error: "Checksum mismatch" }, 422);
  }

  // WAL
  await db
    .insert(uploadWal)
    .values({
      recordingId,
      participantId,
      chunkIndex: Number(chunkIndex),
      checksum: serverChecksum,
      attempts: 1,
    })
    .onConflictDoNothing();

  const storagePath = `db://${recordingId}/chunk-${chunkIndex}`;
  const audioTs = audioStartedAt ? new Date(Number(audioStartedAt)) : null;

  // Upsert chunk
  let chunk: typeof existingByIndex;
  if (existingByIndex) {
    [chunk] = await db
      .update(chunks)
      .set({
        gcsPath: storagePath,
        status: "uploaded",
        checksum: serverChecksum,
        retryCount: existingByIndex.retryCount + 1,
        idempotencyKey,
        participantId,
        audioStartedAt: audioTs,
      })
      .where(eq(chunks.id, existingByIndex.id))
      .returning();
  } else {
    [chunk] = await db
      .insert(chunks)
      .values({
        recordingId,
        participantId,
        index: Number(chunkIndex),
        duration: Number(durationMs),
        gcsPath: storagePath,
        status: "uploaded",
        checksum: serverChecksum,
        idempotencyKey,
        audioStartedAt: audioTs,
      })
      .returning();
  }

  if (!existingByIndex) {
    await db
      .update(recordings)
      .set({ totalChunks: (recording.totalChunks ?? 0) + 1 })
      .where(eq(recordings.id, recordingId));
  }

  // RETURN IMMEDIATELY — don't wait for transcription
  // Enqueue transcription in background
  if (chunk && process.env.GROQ_API_KEY) {
    const chunkId = chunk.id;
    const lang = recording.languageCodes?.[0] ?? "en";
    const sessionId = recording.sessionId;

    // Fire and forget — but use a global promise to keep Vercel alive
    enqueueTranscription(chunkId, recordingId, participantId, buffer, lang, sessionId);
  }

  return c.json(chunk, 201);
});

// Separate endpoint to trigger transcription manually
app.post("/:id/transcribe", async (c) => {
  const id = c.req.param("id");
  const chunk = await db.query.chunks.findFirst({ where: eq(chunks.id, id) });
  if (!chunk) return c.json({ error: "Chunk not found" }, 404);

  const txn = await db.query.transcriptions.findFirst({ where: eq(transcriptions.chunkId, id) });
  if (txn?.status === "completed") return c.json(txn);

  return c.json({ status: "queued", chunkId: id });
});

// Acknowledge
app.patch("/:id/ack", async (c) => {
  const id = c.req.param("id");
  const [chunk] = await db
    .update(chunks)
    .set({ status: "acknowledged", acknowledgedAt: new Date() })
    .where(eq(chunks.id, id))
    .returning();
  if (!chunk) return c.json({ error: "Chunk not found" }, 404);
  return c.json(chunk);
});

// Reconcile
app.post("/reconcile/:recordingId", async (c) => {
  const recordingId = c.req.param("recordingId");
  const allChunks = await db
    .select()
    .from(chunks)
    .where(eq(chunks.recordingId, recordingId))
    .orderBy(chunks.index);

  const missing: Array<{ chunkId: string; index: number }> = [];
  for (const chunk of allChunks) {
    if (chunk.gcsPath) {
      if (!chunkExists(chunk.gcsPath)) {
        await db
          .update(chunks)
          .set({ status: "failed", gcsPath: null })
          .where(eq(chunks.id, chunk.id));
        missing.push({ chunkId: chunk.id, index: chunk.index });
      }
    } else if (chunk.status !== "acknowledged") {
      missing.push({ chunkId: chunk.id, index: chunk.index });
    }
  }
  missing.sort((a, b) => a.index - b.index);
  return c.json({ recordingId, missing, total: allChunks.length });
});

// Get chunks with transcripts for a recording
app.get("/recording/:recordingId", async (c) => {
  const recordingId = c.req.param("recordingId");

  const allChunks = await db
    .select()
    .from(chunks)
    .where(eq(chunks.recordingId, recordingId))
    .orderBy(chunks.index);

  // Get transcripts for these chunks
  const result = [];
  for (const chunk of allChunks) {
    const txn = await db.query.transcriptions.findFirst({
      where: eq(transcriptions.chunkId, chunk.id),
    });
    result.push({
      ...chunk,
      transcript: txn?.status === "completed" ? txn.fullText : null,
      transcriptionStatus: txn?.status ?? "pending",
    });
  }

  return c.json(result);
});

// Status
app.get("/status/:recordingId", async (c) => {
  const recordingId = c.req.param("recordingId");
  const allChunks = await db
    .select()
    .from(chunks)
    .where(eq(chunks.recordingId, recordingId))
    .orderBy(chunks.index);

  return c.json({
    recordingId,
    chunks: allChunks.map((ch) => ({
      id: ch.id,
      index: ch.index,
      status: ch.status,
      retryCount: ch.retryCount,
    })),
  });
});

/**
 * Background transcription queue.
 * Processes chunks one at a time to respect Groq rate limits.
 */
const transcriptionQueue: Array<() => Promise<void>> = [];
let isProcessingQueue = false;

function enqueueTranscription(
  chunkId: string,
  recordingId: string,
  participantId: string | null,
  audioBuffer: Buffer,
  language: string,
  sessionId: string | null,
) {
  transcriptionQueue.push(async () => {
    try {
      const result = await transcribeChunk(audioBuffer, language);

      await db
        .insert(transcriptions)
        .values({
          chunkId,
          recordingId,
          participantId,
          status: "completed",
          fullText: result.fullText,
          languageCode: result.languageCode,
          confidence: result.confidence,
          completedAt: new Date(),
        })
        .onConflictDoNothing();

      await db
        .update(uploadWal)
        .set({ transcribed: true, updatedAt: new Date() })
        .where(eq(uploadWal.recordingId, recordingId));

      if (sessionId) {
        broadcastToSession(sessionId, {
          type: "transcription_ready",
          chunkId,
          participantId,
          text: result.fullText,
        });
      }
    } catch (err) {
      console.error("Transcription failed:", err);
      await db
        .insert(transcriptions)
        .values({
          chunkId,
          recordingId,
          participantId,
          status: "failed",
          error: err instanceof Error ? err.message : "Failed",
        })
        .onConflictDoNothing();
    }
  });

  processQueue();
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (transcriptionQueue.length > 0) {
    const job = transcriptionQueue.shift();
    if (job) await job();
  }

  isProcessingQueue = false;
}

export default app;

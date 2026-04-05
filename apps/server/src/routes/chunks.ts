import {
  chunks,
  db,
  participants,
  recordings,
  speakerSegments,
  transcriptions,
  uploadWal,
} from "@my-better-t-app/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { chunkExists } from "../lib/gcs";
import { transcribeChunk } from "../lib/transcribe";
import { broadcastToSession } from "../lib/ws";

const app = new Hono();

// Upload a chunk + transcribe it synchronously
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
    return c.json(
      { error: "Missing required fields: file, recordingId, chunkIndex, durationMs" },
      400,
    );
  }

  // Idempotency check
  if (idempotencyKey) {
    const existing = await db.query.chunks.findFirst({
      where: and(eq(chunks.idempotencyKey, idempotencyKey), eq(chunks.recordingId, recordingId)),
    });
    if (existing) {
      return c.json(existing, 200);
    }
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
  if (!recording) {
    return c.json({ error: "Recording not found" }, 404);
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  const serverChecksum = createHash("sha256").update(buffer).digest("hex");
  if (clientChecksum && clientChecksum !== serverChecksum) {
    return c.json({ error: "Checksum mismatch — data corrupted in transit" }, 422);
  }

  // WAL entry
  const [walEntry] = await db
    .insert(uploadWal)
    .values({
      recordingId,
      participantId,
      chunkIndex: Number(chunkIndex),
      checksum: serverChecksum,
      attempts: 1,
    })
    .onConflictDoNothing()
    .returning();

  const storagePath = `db://${recordingId}/chunk-${chunkIndex}`;
  const audioTs = audioStartedAt ? new Date(Number(audioStartedAt)) : null;

  // Upsert chunk record
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

  // Update WAL
  if (walEntry) {
    await db
      .update(uploadWal)
      .set({ gcsPath: storagePath, uploaded: true, updatedAt: new Date() })
      .where(eq(uploadWal.id, walEntry.id));
  }

  // Update total chunks count
  if (!existingByIndex) {
    await db
      .update(recordings)
      .set({ totalChunks: (recording.totalChunks ?? 0) + 1 })
      .where(eq(recordings.id, recordingId));
  }

  // --- TRANSCRIBE SYNCHRONOUSLY (critical for Vercel serverless) ---
  let transcriptionText: string | null = null;

  if (chunk && process.env.OPENAI_API_KEY) {
    try {
      // Look up participant name
      let participantName = "Speaker";
      if (participantId) {
        const p = await db.query.participants.findFirst({
          where: eq(participants.id, participantId),
        });
        if (p?.name) participantName = p.name;
      }

      const primaryLang = recording.languageCodes?.[0] ?? "en-US";
      const result = await transcribeChunk(buffer, participantName, primaryLang);

      // Save transcription record
      const [txn] = await db
        .insert(transcriptions)
        .values({
          chunkId: chunk.id,
          recordingId,
          participantId,
          status: "completed",
          fullText: result.fullText,
          languageCode: result.languageCode,
          confidence: result.confidence,
          completedAt: new Date(),
        })
        .returning();

      // Save speaker segments
      if (txn && result.speakers.length > 0) {
        const audioStartMs = audioTs?.getTime() ?? null;
        await db.insert(speakerSegments).values(
          result.speakers.map((seg) => ({
            transcriptionId: txn.id,
            recordingId,
            participantId,
            speakerTag: seg.speakerTag,
            speakerLabel: participantName,
            text: seg.text,
            startTimeMs: seg.startTimeMs,
            endTimeMs: seg.endTimeMs,
            absoluteStartMs: audioStartMs ? audioStartMs + seg.startTimeMs : null,
            languageCode: seg.languageCode,
            confidence: seg.confidence,
            wordTimings: seg.words,
          })),
        );
      }

      // Mark WAL transcribed
      await db
        .update(uploadWal)
        .set({ transcribed: true, updatedAt: new Date() })
        .where(eq(uploadWal.recordingId, recordingId));

      transcriptionText = result.fullText;

      // Broadcast to session
      if (recording.sessionId) {
        broadcastToSession(recording.sessionId, {
          type: "transcription_ready",
          chunkId: chunk.id,
          participantId,
          participantName,
          text: result.fullText,
          languageCode: result.languageCode,
        });
      }
    } catch (err) {
      console.error("Transcription failed:", err);
      // Save failed transcription record
      if (chunk) {
        await db
          .insert(transcriptions)
          .values({
            chunkId: chunk.id,
            recordingId,
            participantId,
            status: "failed",
            error: err instanceof Error ? err.message : "Transcription failed",
          })
          .onConflictDoNothing();
      }
    }
  }

  return c.json({ ...chunk, transcriptionText }, 201);
});

// Acknowledge a chunk
app.patch("/:id/ack", async (c) => {
  const id = c.req.param("id");
  const [chunk] = await db
    .update(chunks)
    .set({ status: "acknowledged", acknowledgedAt: new Date() })
    .where(eq(chunks.id, id))
    .returning();

  if (!chunk) {
    return c.json({ error: "Chunk not found" }, 404);
  }
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
      const exists = chunkExists(chunk.gcsPath);
      if (!exists) {
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

  const walEntries = await db
    .select()
    .from(uploadWal)
    .where(and(eq(uploadWal.recordingId, recordingId), eq(uploadWal.uploaded, false)));

  for (const entry of walEntries) {
    if (!missing.some((m) => m.index === entry.chunkIndex)) {
      missing.push({ chunkId: "", index: entry.chunkIndex });
    }
  }

  missing.sort((a, b) => a.index - b.index);
  return c.json({ recordingId, missing, total: allChunks.length });
});

// Get upload status
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
      hasGcsPath: !!ch.gcsPath,
      retryCount: ch.retryCount,
      participantId: ch.participantId,
    })),
  });
});

export default app;

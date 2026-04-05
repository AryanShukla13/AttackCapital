import {
  chunks,
  db,
  recordings,
  speakerSegments,
  transcriptions,
  uploadWal,
} from "@my-better-t-app/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { chunkExists, uploadChunk } from "../lib/gcs";
import { gcsUri, transcribeChunk } from "../lib/transcribe";

const app = new Hono();

// Upload a chunk (idempotent — safe to retry)
app.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const recordingId = formData.get("recordingId") as string | null;
  const chunkIndex = formData.get("chunkIndex") as string | null;
  const durationMs = formData.get("durationMs") as string | null;
  const clientChecksum = formData.get("checksum") as string | null;
  const idempotencyKey = formData.get("idempotencyKey") as string | null;

  if (!file || !recordingId || chunkIndex === null || !durationMs) {
    return c.json(
      { error: "Missing required fields: file, recordingId, chunkIndex, durationMs" },
      400,
    );
  }

  // Idempotency check — if this exact upload was already processed, return it
  if (idempotencyKey) {
    const existing = await db.query.chunks.findFirst({
      where: and(eq(chunks.idempotencyKey, idempotencyKey), eq(chunks.recordingId, recordingId)),
    });
    if (existing) {
      return c.json(existing, 200);
    }
  }

  // Also check by recordingId + index (unique constraint)
  const existingByIndex = await db.query.chunks.findFirst({
    where: and(eq(chunks.recordingId, recordingId), eq(chunks.index, Number(chunkIndex))),
  });
  if (existingByIndex && existingByIndex.status === "acknowledged") {
    return c.json(existingByIndex, 200);
  }

  // Verify recording exists
  const recording = await db.query.recordings.findFirst({
    where: eq(recordings.id, recordingId),
  });
  if (!recording) {
    return c.json({ error: "Recording not found" }, 404);
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Compute server-side checksum
  const serverChecksum = createHash("sha256").update(buffer).digest("hex");
  if (clientChecksum && clientChecksum !== serverChecksum) {
    return c.json({ error: "Checksum mismatch — data corrupted in transit" }, 422);
  }

  // Write to WAL first (guarantees we know about this chunk even if upload fails)
  const [walEntry] = await db
    .insert(uploadWal)
    .values({
      recordingId,
      chunkIndex: Number(chunkIndex),
      checksum: serverChecksum,
      attempts: 1,
    })
    .onConflictDoNothing()
    .returning();

  // Upload to GCS
  let gcsPath: string;
  try {
    gcsPath = await uploadChunk(recordingId, Number(chunkIndex), buffer);
  } catch (err) {
    // Mark WAL as failed
    if (walEntry) {
      await db
        .update(uploadWal)
        .set({
          lastError: err instanceof Error ? err.message : "Upload failed",
          updatedAt: new Date(),
        })
        .where(eq(uploadWal.id, walEntry.id));
    }
    return c.json({ error: "Failed to upload to storage" }, 502);
  }

  // Upsert chunk record (handles retry of previously failed chunk)
  let chunk: typeof existingByIndex;
  if (existingByIndex) {
    [chunk] = await db
      .update(chunks)
      .set({
        gcsPath,
        status: "uploaded",
        checksum: serverChecksum,
        retryCount: existingByIndex.retryCount + 1,
        idempotencyKey,
      })
      .where(eq(chunks.id, existingByIndex.id))
      .returning();
  } else {
    [chunk] = await db
      .insert(chunks)
      .values({
        recordingId,
        index: Number(chunkIndex),
        duration: Number(durationMs),
        gcsPath,
        status: "uploaded",
        checksum: serverChecksum,
        idempotencyKey,
      })
      .returning();
  }

  // Update WAL
  if (walEntry) {
    await db
      .update(uploadWal)
      .set({ gcsPath, uploaded: true, updatedAt: new Date() })
      .where(eq(uploadWal.id, walEntry.id));
  }

  // Update total chunks count
  if (!existingByIndex) {
    await db
      .update(recordings)
      .set({ totalChunks: (recording.totalChunks ?? 0) + 1 })
      .where(eq(recordings.id, recordingId));
  }

  // Trigger transcription asynchronously (fire and forget)
  if (chunk) {
    const chunkId = chunk.id;
    triggerTranscription(chunkId, recordingId, gcsPath, recording.languageCodes ?? []).catch(
      (err) => {
        console.error(`Transcription trigger failed for chunk ${chunkId}:`, err);
      },
    );
  }

  return c.json(chunk, 201);
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

// Reconcile: find chunks missing from GCS and re-upload from OPFS
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
      const exists = await chunkExists(chunk.gcsPath);
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

  // Also check WAL for chunks that never made it to the chunks table
  const walEntries = await db
    .select()
    .from(uploadWal)
    .where(and(eq(uploadWal.recordingId, recordingId), eq(uploadWal.uploaded, false)));

  for (const entry of walEntries) {
    const alreadyMissing = missing.some((m) => m.index === entry.chunkIndex);
    if (!alreadyMissing) {
      missing.push({ chunkId: "", index: entry.chunkIndex });
    }
  }

  missing.sort((a, b) => a.index - b.index);

  return c.json({ recordingId, missing, total: allChunks.length });
});

// Get upload status for a recording's chunks
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
    })),
  });
});

/**
 * Trigger transcription for a chunk after upload.
 * Runs async — does not block the upload response.
 */
async function triggerTranscription(
  chunkId: string,
  recordingId: string,
  gcsPath: string,
  languageCodes: string[],
): Promise<void> {
  // Create transcription record
  const [txn] = await db
    .insert(transcriptions)
    .values({
      chunkId,
      recordingId,
      status: "processing",
    })
    .returning();

  if (!txn) return;

  try {
    const recording = await db.query.recordings.findFirst({
      where: eq(recordings.id, recordingId),
    });

    const result = await transcribeChunk(
      gcsUri(gcsPath),
      recording?.speakerCount ?? 2,
      languageCodes.length > 0 ? languageCodes : ["en-US"],
    );

    // Save transcription result
    await db
      .update(transcriptions)
      .set({
        status: "completed",
        fullText: result.fullText,
        languageCode: result.languageCode,
        confidence: result.confidence,
        completedAt: new Date(),
      })
      .where(eq(transcriptions.id, txn.id));

    // Save speaker segments
    if (result.speakers.length > 0) {
      await db.insert(speakerSegments).values(
        result.speakers.map((seg) => ({
          transcriptionId: txn.id,
          recordingId,
          speakerTag: seg.speakerTag,
          text: seg.text,
          startTimeMs: seg.startTimeMs,
          endTimeMs: seg.endTimeMs,
          languageCode: seg.languageCode,
          confidence: seg.confidence,
          wordTimings: seg.words,
        })),
      );
    }

    // Mark WAL as transcribed
    await db
      .update(uploadWal)
      .set({ transcribed: true, updatedAt: new Date() })
      .where(
        and(eq(uploadWal.recordingId, recordingId), eq(uploadWal.chunkIndex, chunks.index as any)),
      );

    // Update speaker count on recording if we found more speakers
    const maxSpeaker = Math.max(0, ...result.speakers.map((s) => s.speakerTag));
    if (recording && maxSpeaker > (recording.speakerCount ?? 0)) {
      await db
        .update(recordings)
        .set({ speakerCount: maxSpeaker })
        .where(eq(recordings.id, recordingId));
    }
  } catch (err) {
    await db
      .update(transcriptions)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : "Transcription failed",
      })
      .where(eq(transcriptions.id, txn.id));
  }
}

export default app;

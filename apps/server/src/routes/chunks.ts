import { chunks, db, recordings } from "@my-better-t-app/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { chunkExists, uploadChunk } from "../lib/gcs";

const app = new Hono();

// Upload a chunk
app.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const recordingId = formData.get("recordingId") as string | null;
  const chunkIndex = formData.get("chunkIndex") as string | null;
  const durationMs = formData.get("durationMs") as string | null;
  const clientChecksum = formData.get("checksum") as string | null;

  if (!file || !recordingId || chunkIndex === null || !durationMs) {
    return c.json(
      { error: "Missing required fields: file, recordingId, chunkIndex, durationMs" },
      400,
    );
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

  // Upload to GCS
  const gcsPath = await uploadChunk(recordingId, Number(chunkIndex), buffer);

  // Insert chunk record
  const [chunk] = await db
    .insert(chunks)
    .values({
      recordingId,
      index: Number(chunkIndex),
      duration: Number(durationMs),
      gcsPath,
      status: "uploaded",
      checksum: serverChecksum,
    })
    .returning();

  // Update total chunks count
  await db
    .update(recordings)
    .set({ totalChunks: (recording.totalChunks ?? 0) + 1 })
    .where(eq(recordings.id, recordingId));

  return c.json(chunk, 201);
});

// Acknowledge a chunk (confirms client received upload confirmation)
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

// Reconcile: check for chunks that are acked in DB but missing from GCS
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
        // Mark as failed so client knows to re-upload from OPFS
        await db
          .update(chunks)
          .set({ status: "failed", gcsPath: null })
          .where(eq(chunks.id, chunk.id));
        missing.push({ chunkId: chunk.id, index: chunk.index });
      }
    }
  }

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
    })),
  });
});

export default app;

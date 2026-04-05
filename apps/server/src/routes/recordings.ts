import { chunks, db, recordings } from "@my-better-t-app/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const app = new Hono();

// Create a new recording session
app.post("/", async (c) => {
  const body = await c.req
    .json<{
      speakerCount?: number;
      languages?: string[];
    }>()
    .catch((): { speakerCount?: number; languages?: string[] } => ({}));

  const [recording] = await db
    .insert(recordings)
    .values({
      status: "recording",
      speakerCount: body.speakerCount ?? 2,
      languageCodes: body.languages ?? ["en-US"],
    })
    .returning();
  return c.json(recording, 201);
});

// Complete a recording session
app.patch("/:id/complete", async (c) => {
  const id = c.req.param("id");
  const [recording] = await db
    .update(recordings)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(recordings.id, id))
    .returning();

  if (!recording) {
    return c.json({ error: "Recording not found" }, 404);
  }
  return c.json(recording);
});

// Get recording with its chunks
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const recording = await db.query.recordings.findFirst({
    where: eq(recordings.id, id),
  });

  if (!recording) {
    return c.json({ error: "Recording not found" }, 404);
  }

  const recordingChunks = await db
    .select()
    .from(chunks)
    .where(eq(chunks.recordingId, id))
    .orderBy(chunks.index);

  return c.json({ ...recording, chunks: recordingChunks });
});

export default app;

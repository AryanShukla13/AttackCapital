import {
  db,
  participants,
  recordings,
  sessions,
  speakerSegments,
  transcriptions,
} from "@my-better-t-app/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const app = new Hono();

// Get all transcriptions for a recording (single participant)
app.get("/recording/:recordingId", async (c) => {
  const recordingId = c.req.param("recordingId");

  const txns = await db
    .select()
    .from(transcriptions)
    .where(eq(transcriptions.recordingId, recordingId))
    .orderBy(transcriptions.createdAt);

  const segments = await db
    .select()
    .from(speakerSegments)
    .where(eq(speakerSegments.recordingId, recordingId))
    .orderBy(speakerSegments.startTimeMs);

  return c.json({
    recordingId,
    status: {
      total: txns.length,
      completed: txns.filter((t) => t.status === "completed").length,
      processing: txns.filter((t) => t.status === "processing").length,
      failed: txns.filter((t) => t.status === "failed").length,
    },
    segments,
    transcriptions: txns,
  });
});

// Get merged timeline for an entire session (all participants combined)
app.get("/session/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  });
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Get all recordings in this session
  const sessionRecordings = await db
    .select()
    .from(recordings)
    .where(eq(recordings.sessionId, sessionId));

  const recordingIds = sessionRecordings.map((r) => r.id);
  if (recordingIds.length === 0) {
    return c.json({
      sessionId,
      session,
      participants: [],
      segments: [],
      fullTranscript: "",
      status: { total: 0, completed: 0, processing: 0, failed: 0 },
    });
  }

  // Get all participants
  const sessionParticipants = await db
    .select()
    .from(participants)
    .where(eq(participants.sessionId, sessionId))
    .orderBy(participants.joinedAt);

  // Get all transcriptions across all recordings in this session
  const allTxns: Array<(typeof transcriptions)["$inferSelect"]> = [];
  for (const rid of recordingIds) {
    const txns = await db.select().from(transcriptions).where(eq(transcriptions.recordingId, rid));
    allTxns.push(...txns);
  }

  // Get all speaker segments across all recordings, sorted by absolute time
  const allSegments: Array<(typeof speakerSegments)["$inferSelect"]> = [];
  for (const rid of recordingIds) {
    const segs = await db
      .select()
      .from(speakerSegments)
      .where(eq(speakerSegments.recordingId, rid));
    allSegments.push(...segs);
  }

  // Sort by absolute timestamp first, then by relative timestamp
  allSegments.sort((a, b) => {
    if (a.absoluteStartMs != null && b.absoluteStartMs != null) {
      return a.absoluteStartMs - b.absoluteStartMs;
    }
    // Fallback: sort by creation time from transcription
    return a.startTimeMs - b.startTimeMs;
  });

  // Build merged transcript
  const fullTranscript = allSegments
    .map((seg) => {
      const label = seg.speakerLabel ?? `Participant`;
      const lang = seg.languageCode ? ` [${seg.languageCode}]` : "";
      return `[${label}${lang}]: ${seg.text}`;
    })
    .join("\n");

  // Unique speakers with their info
  const speakerMap = new Map<
    string,
    { participantId: string | null; label: string; languages: Set<string>; segmentCount: number }
  >();
  for (const seg of allSegments) {
    const key = seg.participantId ?? `unknown-${seg.speakerTag}`;
    const existing = speakerMap.get(key);
    if (existing) {
      if (seg.languageCode) existing.languages.add(seg.languageCode);
      existing.segmentCount++;
    } else {
      const langs = new Set<string>();
      if (seg.languageCode) langs.add(seg.languageCode);
      speakerMap.set(key, {
        participantId: seg.participantId,
        label: seg.speakerLabel ?? "Unknown",
        languages: langs,
        segmentCount: 1,
      });
    }
  }

  const speakers = [...speakerMap.values()].map((s) => ({
    ...s,
    languages: [...s.languages],
  }));

  return c.json({
    sessionId,
    session,
    participants: sessionParticipants,
    speakers,
    fullTranscript,
    segments: allSegments,
    status: {
      total: allTxns.length,
      completed: allTxns.filter((t) => t.status === "completed").length,
      processing: allTxns.filter((t) => t.status === "processing").length,
      failed: allTxns.filter((t) => t.status === "failed").length,
    },
  });
});

// Backward compat: get transcriptions by recording (alias)
app.get("/:recordingId", async (c) => {
  const recordingId = c.req.param("recordingId");

  const txns = await db
    .select()
    .from(transcriptions)
    .where(eq(transcriptions.recordingId, recordingId))
    .orderBy(transcriptions.createdAt);

  const segments = await db
    .select()
    .from(speakerSegments)
    .where(eq(speakerSegments.recordingId, recordingId))
    .orderBy(speakerSegments.startTimeMs);

  const fullTranscript = segments
    .map((seg) => `[${seg.speakerLabel ?? `Speaker ${seg.speakerTag}`}]: ${seg.text}`)
    .join("\n");

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

// Update speaker label
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

// Set languages for a recording
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

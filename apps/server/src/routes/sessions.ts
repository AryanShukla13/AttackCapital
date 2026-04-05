import { db, participants, recordings, sessions } from "@my-better-t-app/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 3; i++) code += chars[Math.floor(Math.random() * chars.length)];
  code += "-";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const app = new Hono();

// Create a new session (room)
app.post("/create", async (c) => {
  const body = await c.req
    .json<{ name?: string; languages?: string[]; maxParticipants?: number }>()
    .catch((): { name?: string; languages?: string[]; maxParticipants?: number } => ({}));

  const code = generateCode();

  const [session] = await db
    .insert(sessions)
    .values({
      code,
      name: body.name ?? `Session ${code}`,
      languageCodes: body.languages ?? ["en-US"],
      maxParticipants: body.maxParticipants ?? 10,
    })
    .returning();

  return c.json(session, 201);
});

// Join a session
app.post("/join", async (c) => {
  const { code, name, deviceId } = await c.req.json<{
    code: string;
    name: string;
    deviceId?: string;
  }>();

  if (!code || !name) {
    return c.json({ error: "code and name are required" }, 400);
  }

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.code, code.toUpperCase()),
  });
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  if (session.status !== "active") {
    return c.json({ error: "Session is no longer active" }, 410);
  }

  // Check if device is already in session (reconnection)
  if (deviceId) {
    const existing = await db.query.participants.findFirst({
      where: and(eq(participants.sessionId, session.id), eq(participants.deviceId, deviceId)),
    });
    if (existing) {
      // Reactivate
      const [updated] = await db
        .update(participants)
        .set({ isActive: true, name, leftAt: null })
        .where(eq(participants.id, existing.id))
        .returning();

      // Find their existing recording
      const existingRecording = await db.query.recordings.findFirst({
        where: and(eq(recordings.sessionId, session.id), eq(recordings.participantId, existing.id)),
      });

      return c.json({
        session,
        participant: updated,
        recording: existingRecording,
        reconnected: true,
      });
    }
  }

  // Count current participants
  const currentParticipants = await db
    .select()
    .from(participants)
    .where(and(eq(participants.sessionId, session.id), eq(participants.isActive, true)));

  if (currentParticipants.length >= session.maxParticipants) {
    return c.json({ error: "Session is full" }, 409);
  }

  // Create participant
  const [newParticipant] = await db
    .insert(participants)
    .values({
      sessionId: session.id,
      name,
      deviceId: deviceId ?? null,
    })
    .returning();

  if (!newParticipant) {
    return c.json({ error: "Failed to create participant" }, 500);
  }

  // Create a recording for this participant
  const [recording] = await db
    .insert(recordings)
    .values({
      sessionId: session.id,
      participantId: newParticipant.id,
      status: "recording",
      speakerCount: 1, // each participant is 1 speaker from their device
      languageCodes: session.languageCodes ?? ["en-US"],
    })
    .returning();

  // Set host if first participant
  if (currentParticipants.length === 0) {
    await db
      .update(sessions)
      .set({ hostParticipantId: newParticipant.id })
      .where(eq(sessions.id, session.id));
  }

  return c.json({ session, participant: newParticipant, recording, reconnected: false }, 201);
});

// Leave a session
app.post("/leave", async (c) => {
  const { participantId } = await c.req.json<{ participantId: string }>();

  const [participant] = await db
    .update(participants)
    .set({ isActive: false, leftAt: new Date() })
    .where(eq(participants.id, participantId))
    .returning();

  if (!participant) {
    return c.json({ error: "Participant not found" }, 404);
  }

  // Complete their recording
  await db
    .update(recordings)
    .set({ status: "completed", completedAt: new Date() })
    .where(and(eq(recordings.participantId, participantId), eq(recordings.status, "recording")));

  return c.json({ participant });
});

// Get session info with all participants
app.get("/:id", async (c) => {
  const id = c.req.param("id");

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, id),
  });
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const sessionParticipants = await db
    .select()
    .from(participants)
    .where(eq(participants.sessionId, id))
    .orderBy(participants.joinedAt);

  return c.json({ ...session, participants: sessionParticipants });
});

// Get session by join code
app.get("/code/:code", async (c) => {
  const code = c.req.param("code").toUpperCase();

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.code, code),
  });
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const sessionParticipants = await db
    .select()
    .from(participants)
    .where(eq(participants.sessionId, session.id))
    .orderBy(participants.joinedAt);

  return c.json({ ...session, participants: sessionParticipants });
});

// Complete (end) a session
app.patch("/:id/complete", async (c) => {
  const id = c.req.param("id");

  // Complete all active recordings
  await db
    .update(recordings)
    .set({ status: "completed", completedAt: new Date() })
    .where(and(eq(recordings.sessionId, id), eq(recordings.status, "recording")));

  // Mark all participants as left
  await db
    .update(participants)
    .set({ isActive: false, leftAt: new Date() })
    .where(and(eq(participants.sessionId, id), eq(participants.isActive, true)));

  // Complete session
  const [session] = await db
    .update(sessions)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(sessions.id, id))
    .returning();

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json(session);
});

export default app;

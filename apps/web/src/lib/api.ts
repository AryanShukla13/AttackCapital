// Use relative URLs — API routes are mounted at /api/* in the same Next.js app
const BASE_URL = typeof window !== "undefined" ? "" : (process.env.NEXT_PUBLIC_SERVER_URL ?? "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...init?.headers },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as Record<string, string>).error ?? `Request failed: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// --- Types ---

export interface Session {
  id: string;
  code: string;
  name: string | null;
  status: string;
  hostParticipantId: string | null;
  maxParticipants: number;
  languageCodes: string[];
  createdAt: string;
  completedAt: string | null;
}

export interface Participant {
  id: string;
  sessionId: string;
  name: string;
  deviceId: string | null;
  isActive: boolean;
  joinedAt: string;
  leftAt: string | null;
}

export interface Recording {
  id: string;
  sessionId: string | null;
  participantId: string | null;
  status: string;
  totalChunks: number;
  sampleRate: number;
  speakerCount: number;
  languageCodes: string[];
  createdAt: string;
  completedAt: string | null;
}

export interface Chunk {
  id: string;
  recordingId: string;
  participantId: string | null;
  index: number;
  duration: number;
  gcsPath: string | null;
  status: string;
  checksum: string | null;
  retryCount: number;
  createdAt: string;
  acknowledgedAt: string | null;
}

export interface SpeakerSegment {
  id: string;
  transcriptionId: string;
  recordingId: string;
  participantId: string | null;
  speakerTag: number;
  speakerLabel: string | null;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
  absoluteStartMs: number | null;
  languageCode: string | null;
  confidence: number | null;
  wordTimings: Array<{ word: string; startMs: number; endMs: number; confidence: number }>;
}

export interface TranscriptionStatus {
  total: number;
  completed: number;
  processing: number;
  failed: number;
}

export interface TranscriptionResponse {
  recordingId?: string;
  sessionId?: string;
  status: TranscriptionStatus;
  speakers: Array<{
    tag?: number;
    participantId?: string | null;
    label: string;
    languages: string[];
    segmentCount: number;
  }>;
  fullTranscript: string;
  segments: SpeakerSegment[];
  participants?: Participant[];
}

export interface JoinResult {
  session: Session;
  participant: Participant;
  recording: Recording;
  reconnected: boolean;
}

// --- Sessions ---

export async function createSession(
  name?: string,
  languages?: string[],
  maxParticipants?: number,
): Promise<Session> {
  return request("/api/sessions/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, languages, maxParticipants }),
  });
}

export async function joinSession(
  code: string,
  name: string,
  deviceId?: string,
): Promise<JoinResult> {
  return request("/api/sessions/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name, deviceId }),
  });
}

export async function leaveSession(participantId: string): Promise<void> {
  await request("/api/sessions/leave", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ participantId }),
  });
}

export async function getSession(id: string): Promise<Session & { participants: Participant[] }> {
  return request(`/api/sessions/${id}`);
}

export async function completeSession(id: string): Promise<Session> {
  return request(`/api/sessions/${id}/complete`, { method: "PATCH" });
}

// --- Recordings ---

export async function createRecording(
  speakerCount?: number,
  languages?: string[],
): Promise<Recording> {
  return request("/api/recordings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speakerCount, languages }),
  });
}

export async function completeRecording(id: string): Promise<Recording> {
  return request(`/api/recordings/${id}/complete`, { method: "PATCH" });
}

// --- Chunks ---

export async function uploadChunk(
  recordingId: string,
  chunkIndex: number,
  blob: Blob,
  durationMs: number,
  checksum: string,
  idempotencyKey?: string,
  participantId?: string,
  audioStartedAt?: number,
): Promise<Chunk> {
  const formData = new FormData();
  formData.append("file", blob, `chunk-${chunkIndex}.wav`);
  formData.append("recordingId", recordingId);
  formData.append("chunkIndex", String(chunkIndex));
  formData.append("durationMs", String(durationMs));
  formData.append("checksum", checksum);
  if (idempotencyKey) formData.append("idempotencyKey", idempotencyKey);
  if (participantId) formData.append("participantId", participantId);
  if (audioStartedAt) formData.append("audioStartedAt", String(audioStartedAt));

  return request("/api/chunks/upload", { method: "POST", body: formData });
}

export async function acknowledgeChunk(chunkId: string): Promise<Chunk> {
  return request(`/api/chunks/${chunkId}/ack`, { method: "PATCH" });
}

export async function reconcileRecording(recordingId: string): Promise<{
  recordingId: string;
  missing: Array<{ chunkId: string; index: number }>;
  total: number;
}> {
  return request(`/api/chunks/reconcile/${recordingId}`, { method: "POST" });
}

// --- Transcriptions ---

export async function getTranscriptions(recordingId: string): Promise<TranscriptionResponse> {
  return request(`/api/transcriptions/${recordingId}`);
}

export async function getSessionTranscriptions(sessionId: string): Promise<TranscriptionResponse> {
  return request(`/api/transcriptions/session/${sessionId}`);
}

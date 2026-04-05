import { env } from "@my-better-t-app/env/web";

const BASE_URL = env.NEXT_PUBLIC_SERVER_URL;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as Record<string, string>).error ?? `Request failed: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export interface Recording {
  id: string;
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
  speakerTag: number;
  speakerLabel: string | null;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
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
  recordingId: string;
  status: TranscriptionStatus;
  speakers: Array<{
    tag: number;
    label: string;
    languages: string[];
    segmentCount: number;
  }>;
  fullTranscript: string;
  segments: SpeakerSegment[];
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

export async function getRecording(id: string): Promise<Recording & { chunks: Chunk[] }> {
  return request(`/api/recordings/${id}`);
}

// --- Chunks ---

export async function uploadChunk(
  recordingId: string,
  chunkIndex: number,
  blob: Blob,
  durationMs: number,
  checksum: string,
  idempotencyKey?: string,
): Promise<Chunk> {
  const formData = new FormData();
  formData.append("file", blob, `chunk-${chunkIndex}.wav`);
  formData.append("recordingId", recordingId);
  formData.append("chunkIndex", String(chunkIndex));
  formData.append("durationMs", String(durationMs));
  formData.append("checksum", checksum);
  if (idempotencyKey) {
    formData.append("idempotencyKey", idempotencyKey);
  }

  return request("/api/chunks/upload", { method: "POST", body: formData });
}

export async function acknowledgeChunk(chunkId: string): Promise<Chunk> {
  return request(`/api/chunks/${chunkId}/ack`, { method: "PATCH" });
}

export interface ReconcileResult {
  recordingId: string;
  missing: Array<{ chunkId: string; index: number }>;
  total: number;
}

export async function reconcileRecording(recordingId: string): Promise<ReconcileResult> {
  return request(`/api/chunks/reconcile/${recordingId}`, { method: "POST" });
}

// --- Transcriptions ---

export async function getTranscriptions(recordingId: string): Promise<TranscriptionResponse> {
  return request(`/api/transcriptions/${recordingId}`);
}

export async function setRecordingLanguages(
  recordingId: string,
  languages: string[],
): Promise<Recording> {
  return request(`/api/transcriptions/languages/${recordingId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ languages }),
  });
}

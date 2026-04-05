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
  createdAt: string;
  acknowledgedAt: string | null;
}

export async function createRecording(): Promise<Recording> {
  return request("/api/recordings", { method: "POST" });
}

export async function completeRecording(id: string): Promise<Recording> {
  return request(`/api/recordings/${id}/complete`, { method: "PATCH" });
}

export async function getRecording(id: string): Promise<Recording & { chunks: Chunk[] }> {
  return request(`/api/recordings/${id}`);
}

export async function uploadChunk(
  recordingId: string,
  chunkIndex: number,
  blob: Blob,
  durationMs: number,
  checksum: string,
): Promise<Chunk> {
  const formData = new FormData();
  formData.append("file", blob, `chunk-${chunkIndex}.wav`);
  formData.append("recordingId", recordingId);
  formData.append("chunkIndex", String(chunkIndex));
  formData.append("durationMs", String(durationMs));
  formData.append("checksum", checksum);

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

export async function getChunkStatus(
  recordingId: string,
): Promise<{
  recordingId: string;
  chunks: Array<{ id: string; index: number; status: string; hasGcsPath: boolean }>;
}> {
  return request(`/api/chunks/status/${recordingId}`);
}

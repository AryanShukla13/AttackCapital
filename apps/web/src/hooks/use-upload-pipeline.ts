import { useCallback, useRef, useState } from "react";
import type { WavChunk } from "./use-recorder";
import * as api from "@/lib/api";
import { computeChecksum } from "@/lib/checksum";
import { readChunkFromOPFS, removeChunkFromOPFS, saveChunkToOPFS } from "@/lib/opfs";

export type ChunkUploadStatus = "pending" | "saving" | "uploading" | "acknowledged" | "failed";

export interface TrackedChunk {
  localId: string;
  index: number;
  uploadStatus: ChunkUploadStatus;
  serverChunkId?: string;
  error?: string;
  transcriptionError?: string;
  retryCount: number;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useUploadPipeline() {
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [trackedChunks, setTrackedChunks] = useState<TrackedChunk[]>([]);
  const [isReconciling, setIsReconciling] = useState(false);
  const chunkIndexRef = useRef(0);
  const recordingStartTimeRef = useRef<number>(0);

  const updateChunk = useCallback((localId: string, update: Partial<TrackedChunk>) => {
    setTrackedChunks((prev) =>
      prev.map((tc) => (tc.localId === localId ? { ...tc, ...update } : tc)),
    );
  }, []);

  // Start a standalone recording session (no shared session)
  const startSession = useCallback(async (speakerCount?: number, languages?: string[]) => {
    const recording = await api.createRecording(speakerCount, languages);
    setRecordingId(recording.id);
    setParticipantId(null);
    setSessionId(null);
    setTrackedChunks([]);
    chunkIndexRef.current = 0;
    recordingStartTimeRef.current = Date.now();
    return recording.id;
  }, []);

  // Start from an existing session (multi-participant)
  const startFromSession = useCallback((recId: string, partId: string, sessId: string) => {
    setRecordingId(recId);
    setParticipantId(partId);
    setSessionId(sessId);
    setTrackedChunks([]);
    chunkIndexRef.current = 0;
    recordingStartTimeRef.current = Date.now();
  }, []);

  async function uploadWithRetry(
    sessionRecId: string,
    index: number,
    blob: Blob,
    durationMs: number,
    checksum: string,
    idempotencyKey: string,
    partId?: string,
    audioStartedAt?: number,
    maxRetries: number = MAX_RETRIES,
  ): Promise<api.Chunk> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await api.uploadChunk(
          sessionRecId,
          index,
          blob,
          durationMs,
          checksum,
          idempotencyKey,
          partId,
          audioStartedAt,
        );
      } catch (err) {
        lastError = err instanceof Error ? err : new Error("Upload failed");
        if (attempt < maxRetries) {
          await delay(RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  const processChunk = useCallback(
    async (chunk: WavChunk, sessionRecId: string) => {
      const index = chunkIndexRef.current++;
      const idempotencyKey = `${sessionRecId}-${index}-${chunk.id}`;
      const audioStartedAt = recordingStartTimeRef.current + index * 5000; // approximate
      const tracked: TrackedChunk = {
        localId: chunk.id,
        index,
        uploadStatus: "saving",
        retryCount: 0,
      };

      setTrackedChunks((prev) => [...prev, tracked]);

      try {
        await saveChunkToOPFS(sessionRecId, index, chunk.blob);
        updateChunk(chunk.id, { uploadStatus: "uploading" });

        const checksum = await computeChecksum(chunk.blob);
        const durationMs = Math.round(chunk.duration * 1000);
        const serverChunk = await uploadWithRetry(
          sessionRecId,
          index,
          chunk.blob,
          durationMs,
          checksum,
          idempotencyKey,
          participantId ?? undefined,
          audioStartedAt,
        );
        const txError = (serverChunk as unknown as Record<string, unknown>).transcriptionError as
          | string
          | undefined;
        updateChunk(chunk.id, {
          uploadStatus: "acknowledged",
          serverChunkId: serverChunk.id,
          transcriptionError: txError ?? undefined,
        });

        await api.acknowledgeChunk(serverChunk.id);
        await removeChunkFromOPFS(sessionRecId, index);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        updateChunk(chunk.id, { uploadStatus: "failed", error: message });
      }
    },
    [updateChunk, participantId],
  );

  const completeSession = useCallback(async () => {
    if (!recordingId) return;
    await api.completeRecording(recordingId);
  }, [recordingId]);

  const reconcile = useCallback(async () => {
    if (!recordingId) return;
    setIsReconciling(true);

    try {
      const result = await api.reconcileRecording(recordingId);

      for (const missing of result.missing) {
        const blob = await readChunkFromOPFS(recordingId, missing.index);
        if (!blob) {
          console.error(`Cannot recover chunk ${missing.index} — not in OPFS`);
          continue;
        }

        const checksum = await computeChecksum(blob);
        const durationMs = 5000;
        const idempotencyKey = `${recordingId}-${missing.index}-reconcile`;
        const audioStartedAt = recordingStartTimeRef.current + missing.index * 5000;
        const serverChunk = await uploadWithRetry(
          recordingId,
          missing.index,
          blob,
          durationMs,
          checksum,
          idempotencyKey,
          participantId ?? undefined,
          audioStartedAt,
        );
        await api.acknowledgeChunk(serverChunk.id);
        await removeChunkFromOPFS(recordingId, missing.index);

        setTrackedChunks((prev) =>
          prev.map((tc) =>
            tc.index === missing.index
              ? {
                  ...tc,
                  uploadStatus: "acknowledged",
                  serverChunkId: serverChunk.id,
                  error: undefined,
                }
              : tc,
          ),
        );
      }
    } finally {
      setIsReconciling(false);
    }
  }, [recordingId, participantId]);

  const retryChunk = useCallback(
    async (localId: string) => {
      if (!recordingId) return;

      const tracked = trackedChunks.find((tc) => tc.localId === localId);
      if (!tracked) return;

      const newRetryCount = tracked.retryCount + 1;
      updateChunk(localId, {
        uploadStatus: "uploading",
        error: undefined,
        retryCount: newRetryCount,
      });

      try {
        const blob = await readChunkFromOPFS(recordingId, tracked.index);
        if (!blob) throw new Error("Chunk not found in OPFS");

        const checksum = await computeChecksum(blob);
        const durationMs = 5000;
        const idempotencyKey = `${recordingId}-${tracked.index}-retry-${newRetryCount}`;
        const audioStartedAt = recordingStartTimeRef.current + tracked.index * 5000;
        const serverChunk = await uploadWithRetry(
          recordingId,
          tracked.index,
          blob,
          durationMs,
          checksum,
          idempotencyKey,
          participantId ?? undefined,
          audioStartedAt,
        );
        await api.acknowledgeChunk(serverChunk.id);
        await removeChunkFromOPFS(recordingId, tracked.index);
        updateChunk(localId, { uploadStatus: "acknowledged", serverChunkId: serverChunk.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Retry failed";
        updateChunk(localId, { uploadStatus: "failed", error: message });
      }
    },
    [recordingId, trackedChunks, updateChunk, participantId],
  );

  return {
    recordingId,
    participantId,
    sessionId,
    trackedChunks,
    isReconciling,
    startSession,
    startFromSession,
    processChunk,
    completeSession,
    reconcile,
    retryChunk,
  };
}

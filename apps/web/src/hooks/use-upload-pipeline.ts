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
  retryCount: number;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useUploadPipeline() {
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [trackedChunks, setTrackedChunks] = useState<TrackedChunk[]>([]);
  const [isReconciling, setIsReconciling] = useState(false);
  const chunkIndexRef = useRef(0);

  const updateChunk = useCallback((localId: string, update: Partial<TrackedChunk>) => {
    setTrackedChunks((prev) =>
      prev.map((tc) => (tc.localId === localId ? { ...tc, ...update } : tc)),
    );
  }, []);

  // Start a new recording session on the server
  const startSession = useCallback(async (speakerCount?: number, languages?: string[]) => {
    const recording = await api.createRecording(speakerCount, languages);
    setRecordingId(recording.id);
    setTrackedChunks([]);
    chunkIndexRef.current = 0;
    return recording.id;
  }, []);

  // Upload with automatic retry
  async function uploadWithRetry(
    sessionId: string,
    index: number,
    blob: Blob,
    durationMs: number,
    checksum: string,
    idempotencyKey: string,
    maxRetries: number = MAX_RETRIES,
  ): Promise<api.Chunk> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await api.uploadChunk(sessionId, index, blob, durationMs, checksum, idempotencyKey);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error("Upload failed");
        if (attempt < maxRetries) {
          await delay(RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }

    throw lastError;
  }

  // Process a single chunk: OPFS save -> upload -> ack
  const processChunk = useCallback(
    async (chunk: WavChunk, sessionId: string) => {
      const index = chunkIndexRef.current++;
      const idempotencyKey = `${sessionId}-${index}-${chunk.id}`;
      const tracked: TrackedChunk = {
        localId: chunk.id,
        index,
        uploadStatus: "saving",
        retryCount: 0,
      };

      setTrackedChunks((prev) => [...prev, tracked]);

      try {
        // 1. Save to OPFS for durability
        await saveChunkToOPFS(sessionId, index, chunk.blob);
        updateChunk(chunk.id, { uploadStatus: "uploading" });

        // 2. Compute checksum
        const checksum = await computeChecksum(chunk.blob);

        // 3. Upload to server with retry (idempotent)
        const durationMs = Math.round(chunk.duration * 1000);
        const serverChunk = await uploadWithRetry(
          sessionId,
          index,
          chunk.blob,
          durationMs,
          checksum,
          idempotencyKey,
        );
        updateChunk(chunk.id, { uploadStatus: "acknowledged", serverChunkId: serverChunk.id });

        // 4. Acknowledge
        await api.acknowledgeChunk(serverChunk.id);

        // 5. Remove from OPFS (uploaded and acked)
        await removeChunkFromOPFS(sessionId, index);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        updateChunk(chunk.id, { uploadStatus: "failed", error: message });
      }
    },
    [updateChunk],
  );

  // Complete the recording session
  const completeSession = useCallback(async () => {
    if (!recordingId) return;
    await api.completeRecording(recordingId);
  }, [recordingId]);

  // Reconcile: find chunks missing from GCS and re-upload from OPFS
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
        const serverChunk = await uploadWithRetry(
          recordingId,
          missing.index,
          blob,
          durationMs,
          checksum,
          idempotencyKey,
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
  }, [recordingId]);

  // Retry a single failed chunk from OPFS
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
        const serverChunk = await uploadWithRetry(
          recordingId,
          tracked.index,
          blob,
          durationMs,
          checksum,
          idempotencyKey,
        );
        await api.acknowledgeChunk(serverChunk.id);
        await removeChunkFromOPFS(recordingId, tracked.index);
        updateChunk(localId, { uploadStatus: "acknowledged", serverChunkId: serverChunk.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Retry failed";
        updateChunk(localId, { uploadStatus: "failed", error: message });
      }
    },
    [recordingId, trackedChunks, updateChunk],
  );

  return {
    recordingId,
    trackedChunks,
    isReconciling,
    startSession,
    processChunk,
    completeSession,
    reconcile,
    retryChunk,
  };
}

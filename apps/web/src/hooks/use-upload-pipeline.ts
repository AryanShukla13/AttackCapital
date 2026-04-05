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
  const startSession = useCallback(async () => {
    const recording = await api.createRecording();
    setRecordingId(recording.id);
    setTrackedChunks([]);
    chunkIndexRef.current = 0;
    return recording.id;
  }, []);

  // Process a single chunk: OPFS save -> upload -> ack
  const processChunk = useCallback(
    async (chunk: WavChunk, sessionId: string) => {
      const index = chunkIndexRef.current++;
      const tracked: TrackedChunk = {
        localId: chunk.id,
        index,
        uploadStatus: "saving",
      };

      setTrackedChunks((prev) => [...prev, tracked]);

      try {
        // 1. Save to OPFS for durability
        await saveChunkToOPFS(sessionId, index, chunk.blob);
        updateChunk(chunk.id, { uploadStatus: "uploading" });

        // 2. Compute checksum
        const checksum = await computeChecksum(chunk.blob);

        // 3. Upload to server (-> GCS)
        const durationMs = Math.round(chunk.duration * 1000);
        const serverChunk = await api.uploadChunk(
          sessionId,
          index,
          chunk.blob,
          durationMs,
          checksum,
        );
        updateChunk(chunk.id, { uploadStatus: "acknowledged", serverChunkId: serverChunk.id });

        // 4. Acknowledge
        await api.acknowledgeChunk(serverChunk.id);

        // 5. Remove from OPFS (uploaded and acked — no longer needed)
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
        const durationMs = 5000; // approximate; chunk duration from original recording
        const serverChunk = await api.uploadChunk(
          recordingId,
          missing.index,
          blob,
          durationMs,
          checksum,
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

      updateChunk(localId, { uploadStatus: "uploading", error: undefined });

      try {
        const blob = await readChunkFromOPFS(recordingId, tracked.index);
        if (!blob) throw new Error("Chunk not found in OPFS");

        const checksum = await computeChecksum(blob);
        const durationMs = 5000;
        const serverChunk = await api.uploadChunk(
          recordingId,
          tracked.index,
          blob,
          durationMs,
          checksum,
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

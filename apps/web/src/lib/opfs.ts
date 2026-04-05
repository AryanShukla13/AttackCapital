/**
 * OPFS (Origin Private File System) helper for persisting audio chunks locally.
 * Acts as a durable cache so chunks can be recovered if upload fails.
 */

async function getRecordingDir(recordingId: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle("recordings", { create: true });
  return recordings.getDirectoryHandle(recordingId, { create: true });
}

export async function saveChunkToOPFS(
  recordingId: string,
  chunkIndex: number,
  blob: Blob,
): Promise<void> {
  const dir = await getRecordingDir(recordingId);
  const fileHandle = await dir.getFileHandle(`chunk-${chunkIndex}.wav`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export async function readChunkFromOPFS(
  recordingId: string,
  chunkIndex: number,
): Promise<Blob | null> {
  try {
    const dir = await getRecordingDir(recordingId);
    const fileHandle = await dir.getFileHandle(`chunk-${chunkIndex}.wav`);
    const file = await fileHandle.getFile();
    return file;
  } catch {
    return null;
  }
}

export async function removeChunkFromOPFS(recordingId: string, chunkIndex: number): Promise<void> {
  try {
    const dir = await getRecordingDir(recordingId);
    await dir.removeEntry(`chunk-${chunkIndex}.wav`);
  } catch {
    // Ignore if file doesn't exist
  }
}

export async function clearRecordingFromOPFS(recordingId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const recordings = await root.getDirectoryHandle("recordings");
    await recordings.removeEntry(recordingId, { recursive: true });
  } catch {
    // Ignore if directory doesn't exist
  }
}

export async function listOPFSRecordings(): Promise<string[]> {
  try {
    const root = await navigator.storage.getDirectory();
    const recordings = await root.getDirectoryHandle("recordings");
    const ids: string[] = [];
    for await (const entry of (recordings as any).keys()) {
      ids.push(entry);
    }
    return ids;
  } catch {
    return [];
  }
}

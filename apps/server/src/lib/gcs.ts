/**
 * Chunk storage helpers.
 * Audio data is passed directly to transcription from the upload buffer.
 * The gcsPath field stores a reference key for tracking.
 */

export function chunkExists(path: string): boolean {
  return path.startsWith("db://");
}

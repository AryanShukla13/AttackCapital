import { Storage } from "@google-cloud/storage";
import { env } from "@my-better-t-app/env/server";

let _storage: Storage | null = null;

function getStorage(): Storage {
  if (!_storage) {
    _storage = new Storage({
      projectId: env.GCS_PROJECT_ID,
      ...(env.GCS_KEY_FILE ? { keyFilename: env.GCS_KEY_FILE } : {}),
    });
  }
  return _storage;
}

function getBucket() {
  return getStorage().bucket(env.GCS_BUCKET_NAME);
}

export async function uploadChunk(
  recordingId: string,
  chunkIndex: number,
  data: Buffer,
): Promise<string> {
  const path = `recordings/${recordingId}/chunk-${chunkIndex}.wav`;
  const file = getBucket().file(path);
  await file.save(data, { contentType: "audio/wav" });
  return path;
}

export async function chunkExists(gcsPath: string): Promise<boolean> {
  const [exists] = await getBucket().file(gcsPath).exists();
  return exists;
}

export async function getChunkUrl(gcsPath: string): Promise<string> {
  const [url] = await getBucket()
    .file(gcsPath)
    .getSignedUrl({
      action: "read",
      expires: Date.now() + 60 * 60 * 1000,
    });
  return url;
}

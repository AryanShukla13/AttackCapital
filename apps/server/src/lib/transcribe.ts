import speech from "@google-cloud/speech";
import { env } from "@my-better-t-app/env/server";

const client = new speech.SpeechClient({
  projectId: env.GCS_PROJECT_ID,
  ...(env.GCS_KEY_FILE ? { keyFilename: env.GCS_KEY_FILE } : {}),
});

export interface SpeakerSegment {
  speakerTag: number;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
  languageCode: string;
  confidence: number;
  words: Array<{ word: string; startMs: number; endMs: number; confidence: number }>;
}

export interface TranscriptionResult {
  fullText: string;
  languageCode: string;
  confidence: number;
  speakers: SpeakerSegment[];
}

/**
 * Transcribe a WAV audio chunk stored in GCS.
 * Supports multi-speaker diarization and multi-language detection.
 *
 * @param gcsUri - GCS URI (gs://bucket/path)
 * @param speakerCount - Expected number of speakers (hint, max 10)
 * @param languageCodes - Languages to detect (e.g. ["en-US", "hi-IN", "es-ES"])
 */
export async function transcribeChunk(
  gcsUri: string,
  speakerCount: number = 2,
  languageCodes: string[] = ["en-US"],
): Promise<TranscriptionResult> {
  const primaryLanguage = languageCodes[0] ?? "en-US";
  const alternativeLanguages = languageCodes.slice(1);

  const [operation] = await client.longRunningRecognize({
    audio: { uri: gcsUri },
    config: {
      encoding: "LINEAR16" as const,
      sampleRateHertz: 16000,
      languageCode: primaryLanguage,
      alternativeLanguageCodes: alternativeLanguages.length > 0 ? alternativeLanguages : undefined,
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
      enableWordConfidence: true,
      diarizationConfig: {
        enableSpeakerDiarization: true,
        minSpeakerCount: Math.max(1, speakerCount - 2),
        maxSpeakerCount: Math.min(10, speakerCount + 2),
      },
      model: "latest_long",
      useEnhanced: true,
    },
  });

  const [response] = await operation.promise();
  const results = response.results ?? [];

  if (results.length === 0) {
    return { fullText: "", languageCode: primaryLanguage, confidence: 0, speakers: [] };
  }

  // The last result contains the full diarized transcript with speaker tags
  const lastResult = results[results.length - 1];
  const alternative = lastResult?.alternatives?.[0];

  if (!alternative) {
    return { fullText: "", languageCode: primaryLanguage, confidence: 0, speakers: [] };
  }

  const fullText = alternative.transcript ?? "";
  const confidence = alternative.confidence ?? 0;
  const detectedLanguage =
    (lastResult as Record<string, unknown>).languageCode?.toString() ?? primaryLanguage;

  // Build speaker segments from word-level diarization
  const words = alternative.words ?? [];
  const speakerSegments = buildSpeakerSegments(words, detectedLanguage);

  return {
    fullText,
    languageCode: detectedLanguage,
    confidence,
    speakers: speakerSegments,
  };
}

/**
 * Groups consecutive words by speaker into segments.
 */
function buildSpeakerSegments(
  words: Array<{
    word?: string | null;
    speakerTag?: number | null;
    startTime?: { seconds?: string | number | Long | null; nanos?: number | null } | null;
    endTime?: { seconds?: string | number | Long | null; nanos?: number | null } | null;
    confidence?: number | null;
  }>,
  languageCode: string,
): SpeakerSegment[] {
  if (words.length === 0) return [];

  const segments: SpeakerSegment[] = [];
  let currentSpeaker = words[0]?.speakerTag ?? 0;
  let segmentWords: SpeakerSegment["words"] = [];
  let segmentStartMs = timeToMs(words[0]?.startTime);
  let segmentTexts: string[] = [];

  for (const word of words) {
    const speaker = word.speakerTag ?? 0;
    const wordText = word.word ?? "";
    const startMs = timeToMs(word.startTime);
    const endMs = timeToMs(word.endTime);
    const wordConfidence = word.confidence ?? 0;

    if (speaker !== currentSpeaker && segmentTexts.length > 0) {
      // Flush current segment
      segments.push({
        speakerTag: currentSpeaker,
        text: segmentTexts.join(" "),
        startTimeMs: segmentStartMs,
        endTimeMs: timeToMs(words[words.indexOf(word) - 1]?.endTime),
        languageCode,
        confidence: avgConfidence(segmentWords),
        words: segmentWords,
      });

      currentSpeaker = speaker;
      segmentWords = [];
      segmentTexts = [];
      segmentStartMs = startMs;
    }

    segmentTexts.push(wordText);
    segmentWords.push({ word: wordText, startMs, endMs, confidence: wordConfidence });
  }

  // Flush final segment
  if (segmentTexts.length > 0) {
    const lastWord = words[words.length - 1];
    segments.push({
      speakerTag: currentSpeaker,
      text: segmentTexts.join(" "),
      startTimeMs: segmentStartMs,
      endTimeMs: timeToMs(lastWord?.endTime),
      languageCode,
      confidence: avgConfidence(segmentWords),
      words: segmentWords,
    });
  }

  return segments;
}

type Long = { toNumber: () => number };

function timeToMs(
  time?: { seconds?: string | number | Long | null; nanos?: number | null } | null,
): number {
  if (!time) return 0;
  let seconds = 0;
  if (typeof time.seconds === "string") {
    seconds = Number.parseInt(time.seconds, 10);
  } else if (typeof time.seconds === "number") {
    seconds = time.seconds;
  } else if (time.seconds && typeof (time.seconds as Long).toNumber === "function") {
    seconds = (time.seconds as Long).toNumber();
  }
  const nanos = time.nanos ?? 0;
  return seconds * 1000 + Math.round(nanos / 1_000_000);
}

function avgConfidence(words: Array<{ confidence: number }>): number {
  if (words.length === 0) return 0;
  return words.reduce((sum, w) => sum + w.confidence, 0) / words.length;
}

/**
 * Builds a GCS URI from bucket name and path.
 */
export function gcsUri(gcsPath: string): string {
  return `gs://${env.GCS_BUCKET_NAME}/${gcsPath}`;
}

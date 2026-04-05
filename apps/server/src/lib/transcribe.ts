import OpenAI from "openai";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });
  }
  return _client;
}

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
 * Transcribe a WAV audio chunk using OpenAI Whisper.
 * Supports multi-language detection automatically.
 *
 * @param audioBuffer - WAV audio data as Buffer
 * @param participantName - Name of the speaker (from session participant)
 * @param languageHint - Optional language hint (e.g. "en", "hi", "es")
 */
export async function transcribeChunk(
  audioBuffer: Buffer,
  _participantName: string = "Speaker",
  languageHint?: string,
): Promise<TranscriptionResult> {
  const client = getClient();

  // Create a File object from buffer for the API
  const blob = new Blob([audioBuffer as unknown as BlobPart], { type: "audio/wav" });
  const file = new File([blob], "audio.wav", { type: "audio/wav" });

  const response = await client.audio.transcriptions.create({
    model: "whisper-1",
    file,
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
    ...(languageHint ? { language: languageHint.split("-")[0] } : {}),
  });

  const fullText = response.text ?? "";
  const responseAny = response as unknown as Record<string, unknown>;
  const detectedLanguage = (responseAny.language as string) ?? languageHint ?? "en";

  // Build speaker segments from Whisper segments
  const segments: SpeakerSegment[] = [];
  const whisperSegments = responseAny.segments as
    | Array<{
        start: number;
        end: number;
        text: string;
        avg_logprob?: number;
      }>
    | undefined;

  if (whisperSegments && whisperSegments.length > 0) {
    for (const seg of whisperSegments) {
      segments.push({
        speakerTag: 0,
        text: seg.text.trim(),
        startTimeMs: Math.round(seg.start * 1000),
        endTimeMs: Math.round(seg.end * 1000),
        languageCode: detectedLanguage,
        confidence: seg.avg_logprob ? Math.exp(seg.avg_logprob) : 0.9,
        words: [],
      });
    }
  } else if (fullText) {
    // Fallback: single segment for entire chunk
    segments.push({
      speakerTag: 0,
      text: fullText,
      startTimeMs: 0,
      endTimeMs: 5000,
      languageCode: detectedLanguage,
      confidence: 0.9,
      words: [],
    });
  }

  return {
    fullText,
    languageCode: detectedLanguage,
    confidence:
      segments.length > 0
        ? segments.reduce((s, seg) => s + seg.confidence, 0) / segments.length
        : 0,
    speakers: segments,
  };
}

/**
 * No longer needed — Vercel Blob uses URLs, not GCS URIs.
 */
export function gcsUri(_path: string): string {
  return _path;
}

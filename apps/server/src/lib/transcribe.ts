import Groq from "groq-sdk";

let _client: Groq | null = null;

function getClient(): Groq {
  if (!_client) {
    _client = new Groq({ apiKey: process.env.GROQ_API_KEY ?? "" });
  }
  return _client;
}

export interface TranscriptionResult {
  fullText: string;
  languageCode: string;
  confidence: number;
}

// Queue to limit concurrent transcriptions (Groq rate limits)
const MAX_CONCURRENT = 2;
let activeCount = 0;
const pendingQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    pendingQueue.push(() => {
      activeCount++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeCount--;
  const next = pendingQueue.shift();
  if (next) next();
}

/**
 * Transcribe a WAV audio chunk using Groq Whisper (free).
 * Model: whisper-large-v3-turbo
 */
export async function transcribeChunk(
  audioBuffer: Buffer,
  language: string = "en",
): Promise<TranscriptionResult> {
  await acquireSlot();

  try {
    const client = getClient();

    // Groq expects a File object
    const file = new File(
      [new Uint8Array(audioBuffer) as unknown as Uint8Array<ArrayBuffer>],
      "audio.wav",
      { type: "audio/wav" },
    );

    const transcription = await client.audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
      language: language.split("-")[0] ?? "en",
      response_format: "json",
      temperature: 0,
    });

    const text = transcription.text ?? "";

    return {
      fullText: text,
      languageCode: language,
      confidence: 0.95,
    };
  } finally {
    releaseSlot();
  }
}

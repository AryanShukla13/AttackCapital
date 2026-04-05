"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Copy,
  Download,
  Globe,
  Loader2,
  MessageSquare,
  Mic,
  Pause,
  Play,
  Square,
  Trash2,
} from "lucide-react";

import { Button } from "@my-better-t-app/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { useRecorder, type WavChunk } from "@/hooks/use-recorder";
import * as api from "@/lib/api";
import { computeChecksum } from "@/lib/checksum";

const LANGUAGE_OPTIONS = [
  { code: "en-US", label: "English (US)" },
  { code: "hi-IN", label: "Hindi" },
  { code: "es-ES", label: "Spanish" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "zh-CN", label: "Chinese" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ko-KR", label: "Korean" },
  { code: "ar-SA", label: "Arabic" },
  { code: "pt-BR", label: "Portuguese" },
  { code: "ru-RU", label: "Russian" },
  { code: "it-IT", label: "Italian" },
  { code: "bn-IN", label: "Bengali" },
  { code: "ta-IN", label: "Tamil" },
];

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`;
}

export default function RecorderPage() {
  const { status, start, stop, pause, resume, chunks, elapsed, stream, clearChunks } = useRecorder({
    chunkDuration: 5,
  });

  const [selectedLanguage, setSelectedLanguage] = useState("en-US");
  const [hasRecorded, setHasRecorded] = useState(false);

  // Server state
  const recordingIdRef = useRef<string | null>(null);
  const chunkIndexRef = useRef(0);
  const processedChunkIdsRef = useRef<Set<string>>(new Set());

  // Transcript state
  const [transcripts, setTranscripts] = useState<Map<number, string>>(new Map());
  const [processingCount, setProcessingCount] = useState(0);

  const isRecording = status === "recording";
  const isPaused = status === "paused";
  const isActive = isRecording || isPaused;

  // Upload and transcribe a single chunk
  const uploadChunk = useCallback(async (chunk: WavChunk, index: number, recId: string) => {
    setProcessingCount((c) => c + 1);
    try {
      const checksum = await computeChecksum(chunk.blob);
      const durationMs = Math.round(chunk.duration * 1000);
      const result = await api.uploadChunk(recId, index, chunk.blob, durationMs, checksum);

      // Get transcript from response
      const resultAny = result as unknown as Record<string, unknown>;
      const text = resultAny.transcriptionText as string | undefined;
      if (text) {
        setTranscripts((prev) => new Map(prev).set(index, text));
      }

      // Acknowledge
      await api.acknowledgeChunk(result.id).catch(() => {});
    } catch (err) {
      console.error(`Chunk ${index} failed:`, err);
    } finally {
      setProcessingCount((c) => c - 1);
    }
  }, []);

  // Watch for new chunks and upload them
  useEffect(() => {
    if (!recordingIdRef.current) return;

    for (const chunk of chunks) {
      if (processedChunkIdsRef.current.has(chunk.id)) continue;
      processedChunkIdsRef.current.add(chunk.id);

      const index = chunkIndexRef.current++;
      uploadChunk(chunk, index, recordingIdRef.current);
    }
  }, [chunks, uploadChunk]);

  const handleRecord = useCallback(async () => {
    if (isActive) {
      stop();
      if (recordingIdRef.current) {
        api.completeRecording(recordingIdRef.current).catch(() => {});
      }
    } else {
      // Reset state
      setHasRecorded(true);
      setTranscripts(new Map());
      setProcessingCount(0);
      chunkIndexRef.current = 0;
      processedChunkIdsRef.current.clear();
      recordingIdRef.current = null;

      // Start recording FIRST (microphone access)
      start();

      // Create server session in background
      api
        .createRecording(1, [selectedLanguage])
        .then((rec) => {
          recordingIdRef.current = rec.id;
        })
        .catch(() => {
          // Server unavailable — recording still works locally
        });
    }
  }, [isActive, stop, start, selectedLanguage]);

  // Full transcript
  const fullTranscript = Array.from(transcripts.entries())
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .join(" ");

  return (
    <div className="container mx-auto flex max-w-2xl flex-col items-center gap-6 px-4 py-8">
      {/* Language selector — before first recording */}
      {!hasRecorded && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4" />
              Language
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {LANGUAGE_OPTIONS.map((lang) => (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() => setSelectedLanguage(lang.code)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    selectedLanguage === lang.code
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recorder */}
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Recorder</CardTitle>
          <CardDescription>Chunked every 5s — transcribed by Groq Whisper (free)</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="overflow-hidden rounded-sm border border-border/50 bg-muted/20 text-foreground">
            <LiveWaveform
              active={isRecording}
              processing={isPaused}
              stream={stream}
              height={80}
              barWidth={3}
              barGap={1}
              barRadius={2}
              sensitivity={1.8}
              smoothingTimeConstant={0.85}
              fadeEdges
              fadeWidth={32}
              mode="static"
            />
          </div>

          <div className="text-center font-mono text-3xl tabular-nums tracking-tight">
            {formatTime(elapsed)}
          </div>

          {hasRecorded && (
            <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground">
              <span>{chunks.length} chunk(s)</span>
              <span className="text-green-500">{transcripts.size} transcribed</span>
              {processingCount > 0 && (
                <span className="flex items-center gap-1 text-yellow-500">
                  <Loader2 className="size-3 animate-spin" />
                  {processingCount} processing
                </span>
              )}
            </div>
          )}

          <div className="flex items-center justify-center gap-3">
            <Button
              size="lg"
              variant={isActive ? "destructive" : "default"}
              className="gap-2 px-5"
              onClick={handleRecord}
              disabled={status === "requesting"}
            >
              {isActive ? (
                <>
                  <Square className="size-4" />
                  Stop
                </>
              ) : (
                <>
                  <Mic className="size-4" />
                  {status === "requesting" ? "Requesting..." : "Record"}
                </>
              )}
            </Button>
            {isActive && (
              <Button
                size="lg"
                variant="outline"
                className="gap-2"
                onClick={isPaused ? resume : pause}
              >
                {isPaused ? (
                  <>
                    <Play className="size-4" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="size-4" />
                    Pause
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Chunks with inline transcripts */}
      {chunks.length > 0 && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Chunks</CardTitle>
            <CardDescription>
              {transcripts.size}/{chunks.length} transcribed
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {chunks.map((chunk, i) => (
              <ChunkItem key={chunk.id} chunk={chunk} index={i} transcript={transcripts.get(i)} />
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 gap-1.5 self-end text-destructive"
              onClick={() => {
                clearChunks();
                setTranscripts(new Map());
              }}
            >
              <Trash2 className="size-3" />
              Clear all
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Full Transcript */}
      {fullTranscript && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="size-4" />
              Full Transcript
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-sm border border-border/50 bg-muted/10 p-4">
              <p className="text-sm leading-relaxed">{fullTranscript}</p>
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => navigator.clipboard.writeText(fullTranscript)}
              >
                <Copy className="size-3" />
                Copy
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ChunkItem({
  chunk,
  index,
  transcript,
}: {
  chunk: WavChunk;
  index: number;
  transcript?: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  return (
    <div className="rounded-sm border border-border/50 bg-muted/30 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <audio
          ref={audioRef}
          src={chunk.url}
          onEnded={() => setPlaying(false)}
          preload="none"
        />
        <span className="text-xs font-medium text-muted-foreground tabular-nums">#{index + 1}</span>
        <span className="text-xs tabular-nums">{chunk.duration.toFixed(1)}s</span>
        {transcript ? (
          <span className="text-[10px] text-green-500">transcribed</span>
        ) : (
          <Loader2 className="size-3 animate-spin text-yellow-500" />
        )}
        <div className="ml-auto flex gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              const el = audioRef.current;
              if (!el) return;
              if (playing) {
                el.pause();
                el.currentTime = 0;
                setPlaying(false);
              } else {
                el.play();
                setPlaying(true);
              }
            }}
          >
            {playing ? <Square className="size-3" /> : <Play className="size-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              const a = document.createElement("a");
              a.href = chunk.url;
              a.download = `chunk-${index + 1}.wav`;
              a.click();
            }}
          >
            <Download className="size-3" />
          </Button>
        </div>
      </div>
      {transcript && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{transcript}</p>
      )}
    </div>
  );
}

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
  Users,
} from "lucide-react";

import { Button } from "@my-better-t-app/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card";
import { Input } from "@my-better-t-app/ui/components/input";
import { Label } from "@my-better-t-app/ui/components/label";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { useRecorder, type WavChunk } from "@/hooks/use-recorder";
import { useUploadPipeline } from "@/hooks/use-upload-pipeline";

const LANGUAGE_OPTIONS = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "hi-IN", label: "Hindi" },
  { code: "es-ES", label: "Spanish" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "zh-CN", label: "Chinese (Mandarin)" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ko-KR", label: "Korean" },
  { code: "ar-SA", label: "Arabic" },
  { code: "pt-BR", label: "Portuguese (BR)" },
  { code: "ru-RU", label: "Russian" },
  { code: "it-IT", label: "Italian" },
  { code: "bn-IN", label: "Bengali" },
  { code: "ta-IN", label: "Tamil" },
  { code: "te-IN", label: "Telugu" },
  { code: "mr-IN", label: "Marathi" },
  { code: "gu-IN", label: "Gujarati" },
];

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`;
}

function formatDuration(seconds: number) {
  return `${seconds.toFixed(1)}s`;
}

function ChunkRow({
  chunk,
  index,
  transcript,
  isTranscribing,
}: {
  chunk: WavChunk;
  index: number;
  transcript?: string;
  isTranscribing?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  const toggle = () => {
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
  };

  const download = () => {
    const a = document.createElement("a");
    a.href = chunk.url;
    a.download = `chunk-${index + 1}.wav`;
    a.click();
  };

  return (
    <div className="rounded-sm border border-border/50 bg-muted/30 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <audio ref={audioRef} src={chunk.url} onEnded={() => setPlaying(false)} preload="none" />
        <span className="text-xs font-medium text-muted-foreground tabular-nums">#{index + 1}</span>
        <span className="text-xs tabular-nums">{formatDuration(chunk.duration)}</span>
        {isTranscribing && <Loader2 className="size-3 animate-spin text-yellow-500" />}
        {transcript && !isTranscribing && (
          <span className="text-[10px] text-green-500">transcribed</span>
        )}
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon-xs" onClick={toggle}>
            {playing ? <Square className="size-3" /> : <Play className="size-3" />}
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={download}>
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

export default function RecorderPage() {
  const [deviceId] = useState<string | undefined>();
  const { status, start, stop, pause, resume, chunks, elapsed, stream, clearChunks } = useRecorder({
    chunkDuration: 5,
    deviceId,
  });

  const pipeline = useUploadPipeline();
  const prevChunkCountRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  // Config
  const [speakerCount, setSpeakerCount] = useState(2);
  const [selectedLanguage, setSelectedLanguage] = useState("en-US");
  const [hasRecorded, setHasRecorded] = useState(false);

  // Transcripts from server (Groq Whisper)
  const [transcripts, setTranscripts] = useState<Map<number, string>>(new Map());
  const [transcribingChunks, setTranscribingChunks] = useState<Set<number>>(new Set());

  const isRecording = status === "recording";
  const isPaused = status === "paused";
  const isActive = isRecording || isPaused;

  // Auto-upload new chunks and get transcription back
  useEffect(() => {
    if (chunks.length > prevChunkCountRef.current && sessionIdRef.current) {
      const newChunks = chunks.slice(prevChunkCountRef.current);
      for (const chunk of newChunks) {
        const chunkIndex = prevChunkCountRef.current + newChunks.indexOf(chunk);

        // Mark as transcribing
        setTranscribingChunks((prev) => new Set(prev).add(chunkIndex));

        // Upload + transcribe
        pipeline.processChunk(chunk, sessionIdRef.current).then(() => {
          // Get the transcript from the tracked chunk
          const tracked = pipeline.trackedChunks.find((tc) => tc.localId === chunk.id);
          if (tracked) {
            const txText = (tracked as unknown as Record<string, unknown>).transcriptionText as
              | string
              | undefined;
            if (txText) {
              setTranscripts((prev) => new Map(prev).set(chunkIndex, txText));
            }
          }
          setTranscribingChunks((prev) => {
            const next = new Set(prev);
            next.delete(chunkIndex);
            return next;
          });
        });
      }
    }
    prevChunkCountRef.current = chunks.length;
  }, [chunks, pipeline]);

  // Poll server for transcripts (catches any we missed)
  useEffect(() => {
    if (!pipeline.recordingId || !hasRecorded) return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/transcriptions/${pipeline.recordingId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.transcriptions) {
          const newMap = new Map(transcripts);
          for (const txn of data.transcriptions as Array<{
            chunkId: string;
            fullText: string;
            status: string;
          }>) {
            if (txn.status === "completed" && txn.fullText) {
              // Find chunk index by chunkId
              const chunkRecord = pipeline.trackedChunks.find(
                (tc) => tc.serverChunkId === txn.chunkId,
              );
              if (chunkRecord) {
                newMap.set(chunkRecord.index, txn.fullText);
              }
            }
          }
          if (newMap.size > transcripts.size) {
            setTranscripts(newMap);
          }
        }
      } catch {
        // ignore
      }
    };

    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [pipeline.recordingId, pipeline.trackedChunks, hasRecorded, transcripts]);

  const handlePrimary = useCallback(async () => {
    if (isActive) {
      stop();
      pipeline.completeSession().catch(() => {});
    } else {
      setHasRecorded(true);
      setTranscripts(new Map());
      setTranscribingChunks(new Set());
      prevChunkCountRef.current = 0;

      // Start recording immediately
      start();

      // Create server session in background
      try {
        const sessionId = await pipeline.startSession(speakerCount, [selectedLanguage]);
        sessionIdRef.current = sessionId;
      } catch {
        sessionIdRef.current = null;
      }
    }
  }, [isActive, stop, start, pipeline, speakerCount, selectedLanguage]);

  // Build full transcript from all chunks in order
  const fullTranscript = Array.from(transcripts.entries())
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .join(" ");

  const transcribedCount = transcripts.size;
  const totalChunks = chunks.length;

  return (
    <div className="container mx-auto flex max-w-2xl flex-col items-center gap-6 px-4 py-8">
      {/* Config */}
      {!isActive && !hasRecorded && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" />
              Recording Setup
            </CardTitle>
            <CardDescription>Configure before recording</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="speakers" className="flex items-center gap-1.5 text-sm">
                <Users className="size-3.5" />
                Speakers (1-10)
              </Label>
              <Input
                id="speakers"
                type="number"
                min={1}
                max={10}
                value={speakerCount}
                onChange={(e) => setSpeakerCount(Math.max(1, Math.min(10, Number(e.target.value))))}
                className="w-24"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label className="flex items-center gap-1.5 text-sm">
                <Globe className="size-3.5" />
                Language
              </Label>
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
              <span>{totalChunks} chunk(s)</span>
              <span className="text-green-500">{transcribedCount} transcribed</span>
              {transcribingChunks.size > 0 && (
                <span className="flex items-center gap-1 text-yellow-500">
                  <Loader2 className="size-3 animate-spin" />
                  {transcribingChunks.size} processing
                </span>
              )}
            </div>
          )}

          <div className="flex items-center justify-center gap-3">
            <Button
              size="lg"
              variant={isActive ? "destructive" : "default"}
              className="gap-2 px-5"
              onClick={handlePrimary}
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

      {/* Chunks with per-chunk transcripts */}
      {chunks.length > 0 && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Chunks</CardTitle>
            <CardDescription>
              {chunks.length} recorded — {transcribedCount}/{totalChunks} transcribed
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {chunks.map((chunk, i) => (
              <ChunkRow
                key={chunk.id}
                chunk={chunk}
                index={i}
                transcript={transcripts.get(i)}
                isTranscribing={transcribingChunks.has(i)}
              />
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
            <CardDescription>
              {transcribedCount}/{totalChunks} chunks transcribed
              {transcribingChunks.size > 0 && " — more coming..."}
            </CardDescription>
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
                Copy transcript
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

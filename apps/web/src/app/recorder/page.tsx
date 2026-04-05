"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Cloud,
  CloudOff,
  Download,
  Globe,
  Loader2,
  MessageSquare,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Upload,
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
import { useUploadPipeline, type TrackedChunk } from "@/hooks/use-upload-pipeline";
import * as api from "@/lib/api";

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

function statusIcon(uploadStatus: TrackedChunk["uploadStatus"]) {
  switch (uploadStatus) {
    case "pending":
      return <Cloud className="size-3 text-muted-foreground" />;
    case "saving":
      return <Loader2 className="size-3 animate-spin text-blue-500" />;
    case "uploading":
      return <Upload className="size-3 animate-pulse text-yellow-500" />;
    case "acknowledged":
      return <Check className="size-3 text-green-500" />;
    case "failed":
      return <AlertTriangle className="size-3 text-red-500" />;
  }
}

function ChunkRow({
  chunk,
  index,
  tracked,
  onRetry,
}: {
  chunk: WavChunk;
  index: number;
  tracked?: TrackedChunk;
  onRetry?: () => void;
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
    <div className="flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-muted/30 px-3 py-2">
      <audio ref={audioRef} src={chunk.url} onEnded={() => setPlaying(false)} preload="none" />
      <span className="text-xs font-medium text-muted-foreground tabular-nums">#{index + 1}</span>
      <span className="text-xs tabular-nums">{formatDuration(chunk.duration)}</span>
      <span className="text-[10px] text-muted-foreground">16kHz PCM</span>

      {tracked && (
        <div className="flex items-center gap-1">
          {statusIcon(tracked.uploadStatus)}
          <span className="text-[10px] text-muted-foreground">{tracked.uploadStatus}</span>
          {tracked.retryCount > 0 && (
            <span className="text-[10px] text-muted-foreground">(retry {tracked.retryCount})</span>
          )}
        </div>
      )}

      <div className="ml-auto flex gap-1">
        {tracked?.uploadStatus === "failed" && onRetry && (
          <Button variant="ghost" size="icon-xs" onClick={onRetry} title="Retry upload">
            <RefreshCw className="size-3" />
          </Button>
        )}
        <Button variant="ghost" size="icon-xs" onClick={toggle}>
          {playing ? <Square className="size-3" /> : <Play className="size-3" />}
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={download}>
          <Download className="size-3" />
        </Button>
      </div>
    </div>
  );
}

function speakerColor(tag: number): string {
  const colors = [
    "text-blue-400",
    "text-green-400",
    "text-purple-400",
    "text-orange-400",
    "text-pink-400",
    "text-cyan-400",
    "text-yellow-400",
    "text-red-400",
    "text-indigo-400",
    "text-emerald-400",
  ];
  return colors[tag % colors.length] ?? "text-muted-foreground";
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

  // Config state
  const [speakerCount, setSpeakerCount] = useState(2);
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>(["en-US"]);

  // Transcription state
  const [transcription, setTranscription] = useState<api.TranscriptionResponse | null>(null);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [hasRecorded, setHasRecorded] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRecording = status === "recording";
  const isPaused = status === "paused";
  const isActive = isRecording || isPaused;

  // Auto-upload new chunks as they appear
  useEffect(() => {
    if (chunks.length > prevChunkCountRef.current && sessionIdRef.current) {
      const newChunks = chunks.slice(prevChunkCountRef.current);
      for (const chunk of newChunks) {
        pipeline.processChunk(chunk, sessionIdRef.current);
      }
    }
    prevChunkCountRef.current = chunks.length;
  }, [chunks, pipeline]);

  // Poll transcription while recording or shortly after
  useEffect(() => {
    if (
      pipeline.recordingId &&
      pipeline.trackedChunks.some((tc) => tc.uploadStatus === "acknowledged")
    ) {
      const poll = () => {
        api
          .getTranscriptions(pipeline.recordingId!)
          .then(setTranscription)
          .catch(() => {});
      };
      poll();
      pollRef.current = setInterval(poll, 2000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [pipeline.recordingId, pipeline.trackedChunks]);

  const handlePrimary = useCallback(async () => {
    if (isActive) {
      stop();
      // Try to complete session on server (best-effort)
      pipeline.completeSession().catch(() => {});
      // Final transcript fetch
      if (pipeline.recordingId) {
        setIsLoadingTranscript(true);
        setTimeout(async () => {
          try {
            const txn = await api.getTranscriptions(pipeline.recordingId!);
            setTranscription(txn);
          } catch {
            // API not available — that's okay
          } finally {
            setIsLoadingTranscript(false);
          }
        }, 3000);
      }
    } else {
      // ALWAYS start recording immediately — don't let API failures block it
      setTranscription(null);
      setApiError(null);
      setHasRecorded(true);
      prevChunkCountRef.current = 0;
      start();

      // Try to create a server session in background (for upload + transcription)
      try {
        const sessionId = await pipeline.startSession(speakerCount, selectedLanguages);
        sessionIdRef.current = sessionId;
      } catch (err) {
        sessionIdRef.current = null;
        setApiError(
          err instanceof Error
            ? err.message
            : "Could not connect to server. Recording locally — transcription unavailable.",
        );
      }
    }
  }, [isActive, stop, start, pipeline, speakerCount, selectedLanguages]);

  const toggleLanguage = (code: string) => {
    setSelectedLanguages((prev) =>
      prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code],
    );
  };

  const failedCount = pipeline.trackedChunks.filter((tc) => tc.uploadStatus === "failed").length;
  const ackedCount = pipeline.trackedChunks.filter(
    (tc) => tc.uploadStatus === "acknowledged",
  ).length;

  return (
    <div className="container mx-auto flex max-w-2xl flex-col items-center gap-6 px-4 py-8">
      {/* Recording Config — shown before first recording */}
      {!isActive && !hasRecorded && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" />
              Recording Setup
            </CardTitle>
            <CardDescription>Configure speakers and languages before recording</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="speakers" className="flex items-center gap-1.5 text-sm">
                <Users className="size-3.5" />
                Expected speakers (1-10)
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
                Languages spoken (select all that apply)
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {LANGUAGE_OPTIONS.map((lang) => (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => toggleLanguage(lang.code)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      selectedLanguages.includes(lang.code)
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
              {selectedLanguages.length === 0 && (
                <p className="text-xs text-red-500">Select at least one language</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recorder */}
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Recorder</CardTitle>
          <CardDescription>
            16 kHz / 16-bit PCM WAV — chunked every 5 s — {speakerCount} speaker(s),{" "}
            {selectedLanguages.length} language(s)
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          {/* API Error Banner */}
          {apiError && (
            <div className="flex items-center gap-2 rounded-sm border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-600 dark:text-yellow-400">
              <CloudOff className="size-4 shrink-0" />
              <span>{apiError}</span>
            </div>
          )}

          {/* Waveform */}
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

          {/* Timer */}
          <div className="text-center font-mono text-3xl tabular-nums tracking-tight">
            {formatTime(elapsed)}
          </div>

          {/* Upload status summary */}
          {pipeline.trackedChunks.length > 0 && (
            <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Check className="size-3 text-green-500" />
                {ackedCount} uploaded
              </span>
              {failedCount > 0 && (
                <span className="flex items-center gap-1">
                  <AlertTriangle className="size-3 text-red-500" />
                  {failedCount} failed
                </span>
              )}
              {transcription && (
                <span className="flex items-center gap-1">
                  <MessageSquare className="size-3 text-blue-500" />
                  {transcription.status.completed} transcribed
                </span>
              )}
              {pipeline.recordingId && (
                <span className="text-[10px] font-mono">{pipeline.recordingId.slice(0, 8)}...</span>
              )}
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center justify-center gap-3">
            <Button
              size="lg"
              variant={isActive ? "destructive" : "default"}
              className="gap-2 px-5"
              onClick={handlePrimary}
              disabled={status === "requesting" || selectedLanguages.length === 0}
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

            {!isActive && pipeline.recordingId && failedCount > 0 && (
              <Button
                size="lg"
                variant="outline"
                className="gap-2"
                onClick={pipeline.reconcile}
                disabled={pipeline.isReconciling}
              >
                <RefreshCw className={`size-4 ${pipeline.isReconciling ? "animate-spin" : ""}`} />
                Reconcile
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Chunks */}
      {chunks.length > 0 && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Chunks</CardTitle>
            <CardDescription>{chunks.length} recorded</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {chunks.map((chunk, i) => {
              const tracked = pipeline.trackedChunks.find((tc) => tc.localId === chunk.id);
              return (
                <ChunkRow
                  key={chunk.id}
                  chunk={chunk}
                  index={i}
                  tracked={tracked}
                  onRetry={() => pipeline.retryChunk(chunk.id)}
                />
              );
            })}
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 gap-1.5 self-end text-destructive"
              onClick={clearChunks}
            >
              <Trash2 className="size-3" />
              Clear all
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Transcription — always visible once recording has started */}
      {hasRecorded && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="size-4" />
              Transcription
              {isLoadingTranscript && <Loader2 className="size-4 animate-spin" />}
            </CardTitle>
            {transcription ? (
              <CardDescription>
                {transcription.speakers.length} speaker(s) detected —{" "}
                {transcription.status.completed}/{transcription.status.total} chunks transcribed
                {transcription.status.processing > 0 &&
                  ` (${transcription.status.processing} processing)`}
              </CardDescription>
            ) : (
              <CardDescription>
                {apiError
                  ? "Server connection required for transcription"
                  : isActive
                    ? "Transcription will appear as chunks are uploaded..."
                    : "Waiting for transcription results..."}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {transcription && transcription.segments.length > 0 ? (
              <div className="flex max-h-96 flex-col gap-3 overflow-y-auto rounded-sm border border-border/50 bg-muted/10 p-4">
                {transcription.segments.map((seg) => (
                  <div key={seg.id} className="flex gap-3">
                    <div className="flex min-w-[80px] flex-col items-end">
                      <span className={`text-xs font-semibold ${speakerColor(seg.speakerTag)}`}>
                        {seg.speakerLabel ?? `Speaker ${seg.speakerTag}`}
                      </span>
                      {seg.languageCode && (
                        <span className="text-[10px] text-muted-foreground">
                          {seg.languageCode}
                        </span>
                      )}
                    </div>
                    <p className="flex-1 text-sm leading-relaxed">{seg.text}</p>
                    {seg.confidence != null && (
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {(seg.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : apiError ? (
              <div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
                <CloudOff className="size-8 text-yellow-500/50" />
                <p className="text-center">
                  Cannot transcribe without a server connection.
                  <br />
                  Audio is still being recorded and saved locally.
                </p>
              </div>
            ) : transcription && transcription.status.processing > 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Transcribing audio...
              </div>
            ) : pipeline.trackedChunks.some((tc) => tc.transcriptionError) ? (
              <div className="flex flex-col items-center gap-3 py-8 text-sm">
                <AlertTriangle className="size-8 text-red-500/50" />
                <p className="text-center text-red-400">
                  {pipeline.trackedChunks.find((tc) => tc.transcriptionError)?.transcriptionError}
                </p>
                {pipeline.trackedChunks[0]?.transcriptionError?.includes("quota") && (
                  <p className="text-center text-xs text-muted-foreground">
                    Add billing at{" "}
                    <a
                      href="https://platform.openai.com/settings/organization/billing"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      platform.openai.com/billing
                    </a>
                  </p>
                )}
              </div>
            ) : isActive ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Recording... transcript will appear after chunks are processed
              </div>
            ) : ackedCount > 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Processing transcription...
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Start recording to see transcription
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

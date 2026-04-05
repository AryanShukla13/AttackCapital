"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Cloud,
  Download,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Upload,
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
import { useUploadPipeline, type TrackedChunk } from "@/hooks/use-upload-pipeline";

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`;
}

function formatDuration(seconds: number) {
  return `${seconds.toFixed(1)}s`;
}

function statusIcon(status: TrackedChunk["uploadStatus"]) {
  switch (status) {
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

      {/* Upload status */}
      {tracked && (
        <div className="flex items-center gap-1">
          {statusIcon(tracked.uploadStatus)}
          <span className="text-[10px] text-muted-foreground">{tracked.uploadStatus}</span>
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

export default function RecorderPage() {
  const [deviceId] = useState<string | undefined>();
  const { status, start, stop, pause, resume, chunks, elapsed, stream, clearChunks } = useRecorder({
    chunkDuration: 5,
    deviceId,
  });

  const pipeline = useUploadPipeline();
  const prevChunkCountRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

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

  const handlePrimary = useCallback(async () => {
    if (isActive) {
      stop();
      // Complete the recording session on server
      await pipeline.completeSession();
    } else {
      // Start a new server session, then start recording
      const sessionId = await pipeline.startSession();
      sessionIdRef.current = sessionId;
      prevChunkCountRef.current = 0;
      start();
    }
  }, [isActive, stop, start, pipeline]);

  const failedCount = pipeline.trackedChunks.filter((tc) => tc.uploadStatus === "failed").length;
  const ackedCount = pipeline.trackedChunks.filter(
    (tc) => tc.uploadStatus === "acknowledged",
  ).length;

  return (
    <div className="container mx-auto flex max-w-lg flex-col items-center gap-6 px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Recorder</CardTitle>
          <CardDescription>16 kHz / 16-bit PCM WAV — chunked every 5 s</CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
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

            {/* Reconcile button */}
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
    </div>
  );
}

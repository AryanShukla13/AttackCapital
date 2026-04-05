"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  Globe,
  Mic,
  MicOff,
  MessageSquare,
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
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";

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

function ChunkRow({ chunk, index }: { chunk: WavChunk; index: number }) {
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
      <div className="ml-auto flex gap-1">
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

function speakerColor(index: number): string {
  const colors = [
    "text-blue-400",
    "text-green-400",
    "text-purple-400",
    "text-orange-400",
    "text-pink-400",
  ];
  return colors[index % colors.length] ?? "text-muted-foreground";
}

export default function RecorderPage() {
  const [deviceId] = useState<string | undefined>();
  const { status, start, stop, pause, resume, chunks, elapsed, stream, clearChunks } = useRecorder({
    chunkDuration: 5,
    deviceId,
  });

  // Config state
  const [speakerCount, setSpeakerCount] = useState(2);
  const [selectedLanguage, setSelectedLanguage] = useState("en-US");
  const [hasRecorded, setHasRecorded] = useState(false);

  // Real-time speech recognition (free, browser-based)
  const speech = useSpeechRecognition({
    language: selectedLanguage,
    speakerLabel: "Speaker",
  });

  const isRecording = status === "recording";
  const isPaused = status === "paused";
  const isActive = isRecording || isPaused;

  const handlePrimary = useCallback(() => {
    if (isActive) {
      stop();
      speech.stopListening();
    } else {
      setHasRecorded(true);
      speech.clearTranscript();
      start();
      speech.startListening();
    }
  }, [isActive, stop, start, speech]);

  const handlePause = useCallback(() => {
    if (isPaused) {
      resume();
      speech.startListening();
    } else {
      pause();
      speech.stopListening();
    }
  }, [isPaused, resume, pause, speech]);

  return (
    <div className="container mx-auto flex max-w-2xl flex-col items-center gap-6 px-4 py-8">
      {/* Recording Config */}
      {!isActive && !hasRecorded && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" />
              Recording Setup
            </CardTitle>
            <CardDescription>Configure language before recording</CardDescription>
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

            {!speech.isSupported && (
              <div className="flex items-center gap-2 rounded-sm border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-600 dark:text-yellow-400">
                <AlertTriangle className="size-4 shrink-0" />
                Speech recognition not supported. Use Chrome or Edge for live transcription.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Recorder */}
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Recorder</CardTitle>
          <CardDescription>
            16 kHz / 16-bit PCM WAV — chunked every 5 s —{" "}
            {LANGUAGE_OPTIONS.find((l) => l.code === selectedLanguage)?.label ?? selectedLanguage}
          </CardDescription>
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

          {/* Timer + live status */}
          <div className="flex flex-col items-center gap-1">
            <div className="text-center font-mono text-3xl tabular-nums tracking-tight">
              {formatTime(elapsed)}
            </div>
            {speech.isListening && (
              <div className="flex items-center gap-1.5 text-xs text-green-500">
                <Mic className="size-3 animate-pulse" />
                Transcribing live...
              </div>
            )}
          </div>

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
              <Button size="lg" variant="outline" className="gap-2" onClick={handlePause}>
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

      {/* Live Transcription — real-time, free, browser-based */}
      {hasRecorded && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="size-4" />
              Live Transcription
              {speech.isListening && (
                <span className="flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-normal text-green-500">
                  <span className="size-1.5 animate-pulse rounded-full bg-green-500" />
                  LIVE
                </span>
              )}
            </CardTitle>
            <CardDescription>
              {speech.segments.length} segment(s) — powered by browser Speech Recognition (free)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {speech.error ? (
              <div className="flex items-center gap-2 rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-400">
                <MicOff className="size-4 shrink-0" />
                {speech.error}
              </div>
            ) : speech.segments.length > 0 || speech.interimText ? (
              <div className="flex max-h-96 flex-col gap-2 overflow-y-auto rounded-sm border border-border/50 bg-muted/10 p-4">
                {speech.segments.map((seg, i) => (
                  <div key={seg.id} className="flex gap-3">
                    <span
                      className={`min-w-[60px] text-right text-xs font-semibold ${speakerColor(0)}`}
                    >
                      {seg.speakerLabel}
                    </span>
                    <p className="flex-1 text-sm leading-relaxed">{seg.text}</p>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {new Date(seg.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                  </div>
                ))}
                {/* Interim (not-yet-final) text */}
                {speech.interimText && (
                  <div className="flex gap-3 opacity-50">
                    <span
                      className={`min-w-[60px] text-right text-xs font-semibold ${speakerColor(0)}`}
                    >
                      ...
                    </span>
                    <p className="flex-1 text-sm italic leading-relaxed">{speech.interimText}</p>
                  </div>
                )}
              </div>
            ) : isActive ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Speak now — transcription appears in real-time...
              </p>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Press Record and start speaking
              </p>
            )}

            {/* Full transcript summary (shown after stop) */}
            {!isActive && speech.fullText && (
              <div className="mt-4 border-t border-border/50 pt-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-muted-foreground">Full Transcript</h4>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1 text-xs"
                    onClick={() => navigator.clipboard.writeText(speech.fullText)}
                  >
                    Copy
                  </Button>
                </div>
                <p className="mt-2 text-sm leading-relaxed">{speech.fullText}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Chunks */}
      {chunks.length > 0 && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Audio Chunks</CardTitle>
            <CardDescription>
              {chunks.length} recorded — available for playback & download
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {chunks.map((chunk, i) => (
              <ChunkRow key={chunk.id} chunk={chunk} index={i} />
            ))}
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

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Copy,
  Globe,
  Loader2,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  Pause,
  Play,
  Square,
  Users,
  Wifi,
  WifiOff,
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
import { useRecorder } from "@/hooks/use-recorder";
import { useUploadPipeline } from "@/hooks/use-upload-pipeline";
import { useSessionWs } from "@/hooks/use-session-ws";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import * as api from "@/lib/api";

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
  { code: "te-IN", label: "Telugu" },
];

function speakerColor(index: number): string {
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
  return colors[index % colors.length] ?? "text-muted-foreground";
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`;
}

type Mode = "lobby" | "recording";

export default function SessionPage() {
  // Lobby state
  const [mode, setMode] = useState<Mode>("lobby");
  const [tab, setTab] = useState<"create" | "join">("create");
  const [userName, setUserName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState("en-US");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Session state
  const [session, setSession] = useState<api.Session | null>(null);
  const [participant, setParticipant] = useState<api.Participant | null>(null);
  const [sessionParticipants, setSessionParticipants] = useState<api.Participant[]>([]);

  // Recorder + pipeline
  const { status, start, stop, pause, resume, elapsed, stream } = useRecorder({ chunkDuration: 5 });
  const pipeline = useUploadPipeline();

  // WebSocket
  const { messages, isConnected } = useSessionWs(session?.id ?? null, participant?.id ?? null);

  // Real-time speech recognition (free, browser-based)
  const speech = useSpeechRecognition({
    language: selectedLanguage,
    speakerLabel: userName || "You",
  });

  const isRecording = status === "recording";
  const isPaused = status === "paused";
  const isActive = isRecording || isPaused;

  // Handle WebSocket messages — update participant list
  useEffect(() => {
    if (!session?.id) return;
    for (const msg of messages) {
      if (msg.type === "participant_connected" || msg.type === "participant_disconnected") {
        api
          .getSession(session.id)
          .then((s) => setSessionParticipants(s.participants))
          .catch(() => {});
      }
    }
  }, [messages, session?.id]);

  const getDeviceId = useCallback((): string => {
    let id = localStorage.getItem("swades-device-id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("swades-device-id", id);
    }
    return id;
  }, []);

  const handleCreate = async () => {
    if (!userName.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      const sess = await api.createSession(sessionName || undefined, [selectedLanguage]);
      const result = await api.joinSession(sess.code, userName, getDeviceId());
      setSession(result.session);
      setParticipant(result.participant);
      setSessionParticipants([result.participant]);
      pipeline.startFromSession(result.recording.id, result.participant.id, result.session.id);
      setMode("recording");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("fetch") || msg.includes("network") || msg.includes("500")) {
        setError("Server is not available. Make sure the database is configured (DATABASE_URL).");
      } else {
        setError(msg);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleJoin = async () => {
    if (!userName.trim() || !joinCode.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await api.joinSession(joinCode, userName, getDeviceId());
      setSession(result.session);
      setParticipant(result.participant);
      pipeline.startFromSession(result.recording.id, result.participant.id, result.session.id);
      const sess = await api.getSession(result.session.id);
      setSessionParticipants(sess.participants);
      setMode("recording");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("fetch") || msg.includes("network") || msg.includes("500")) {
        setError("Server is not available. Make sure the database is configured.");
      } else {
        setError(msg);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleRecord = useCallback(() => {
    if (isActive) {
      stop();
      speech.stopListening();
    } else {
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

  const handleLeave = async () => {
    if (isActive) {
      stop();
      speech.stopListening();
    }
    if (participant) await api.leaveSession(participant.id).catch(() => {});
    setMode("lobby");
    setSession(null);
    setParticipant(null);
  };

  const copyCode = () => {
    if (session?.code) navigator.clipboard.writeText(session.code);
  };

  // ======= LOBBY =======
  if (mode === "lobby") {
    return (
      <div className="container mx-auto flex max-w-lg flex-col items-center gap-6 px-4 py-8">
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-5" />
              Multi-Speaker Session
            </CardTitle>
            <CardDescription>
              Create a room or join with a code. Each participant records from their own device.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex gap-2">
              <Button
                variant={tab === "create" ? "default" : "outline"}
                size="sm"
                onClick={() => setTab("create")}
              >
                Create Room
              </Button>
              <Button
                variant={tab === "join" ? "default" : "outline"}
                size="sm"
                onClick={() => setTab("join")}
              >
                Join Room
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Your name</Label>
              <Input
                id="name"
                placeholder="e.g. Alice"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
              />
            </div>

            {tab === "create" ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="session-name">Session name (optional)</Label>
                  <Input
                    id="session-name"
                    placeholder="e.g. Team Standup"
                    value={sessionName}
                    onChange={(e) => setSessionName(e.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label className="flex items-center gap-1.5">
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

                <Button
                  onClick={handleCreate}
                  disabled={isLoading || !userName.trim()}
                  className="gap-2"
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Users className="size-4" />
                  )}
                  Create & Join
                </Button>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="code">Room code</Label>
                  <Input
                    id="code"
                    placeholder="e.g. ABC-1234"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    className="font-mono tracking-wider"
                  />
                </div>

                <Button
                  onClick={handleJoin}
                  disabled={isLoading || !userName.trim() || !joinCode.trim()}
                  className="gap-2"
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Users className="size-4" />
                  )}
                  Join Room
                </Button>
              </>
            )}

            {error && (
              <p className="flex items-center gap-1.5 text-sm text-red-500">
                <AlertTriangle className="size-3.5" />
                {error}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // ======= RECORDING MODE =======
  return (
    <div className="container mx-auto flex max-w-2xl flex-col items-center gap-6 px-4 py-8">
      {/* Session info */}
      <Card className="w-full">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                {session?.name ?? "Session"}
                {isConnected ? (
                  <Wifi className="size-4 text-green-500" />
                ) : (
                  <WifiOff className="size-4 text-red-500" />
                )}
              </CardTitle>
              <CardDescription className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={copyCode}
                  className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono text-sm tracking-wider hover:bg-muted/80"
                >
                  {session?.code}
                  <Copy className="size-3" />
                </button>
                <span>
                  {sessionParticipants.filter((p) => p.isActive).length} participant(s) active
                </span>
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleLeave}>
              <LogOut className="size-3.5" />
              Leave
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {sessionParticipants.map((p, i) => (
              <div
                key={p.id}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                  p.isActive ? "border-green-500/30 bg-green-500/10" : "border-border opacity-50"
                }`}
              >
                <span className={`font-semibold ${speakerColor(i)}`}>{p.name}</span>
                {p.id === participant?.id && (
                  <span className="text-[10px] text-muted-foreground">(you)</span>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Recorder */}
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Recording as {participant?.name}</CardTitle>
          <CardDescription>
            Live transcription powered by browser Speech Recognition (free)
          </CardDescription>
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

      {/* Live Transcription */}
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="size-4" />
            Live Transcript
            {speech.isListening && (
              <span className="flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-normal text-green-500">
                <span className="size-1.5 animate-pulse rounded-full bg-green-500" />
                LIVE
              </span>
            )}
          </CardTitle>
          <CardDescription>
            {speech.segments.length} segment(s) from {participant?.name ?? "you"}
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
              {speech.segments.map((seg) => (
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
    </div>
  );
}

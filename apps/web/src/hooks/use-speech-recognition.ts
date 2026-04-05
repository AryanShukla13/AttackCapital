"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface TranscriptSegment {
  id: string;
  text: string;
  isFinal: boolean;
  timestamp: number;
  languageCode: string;
  speakerLabel: string;
}

interface UseSpeechRecognitionOptions {
  language?: string;
  speakerLabel?: string;
}

interface SpeechRecognitionType {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionType;

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as Record<string, unknown>).SpeechRecognition ??
    (window as unknown as Record<string, unknown>)
      .webkitSpeechRecognition) as SpeechRecognitionConstructor | null;
}

export function useSpeechRecognition(options: UseSpeechRecognitionOptions = {}) {
  const { language = "en-US", speakerLabel = "You" } = options;

  // Use refs for segments to avoid stale closures in callbacks
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interimText, setInterimText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionType | null>(null);
  const shouldBeListeningRef = useRef(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const languageRef = useRef(language);
  const speakerLabelRef = useRef(speakerLabel);

  // Keep refs in sync
  languageRef.current = language;
  speakerLabelRef.current = speakerLabel;

  useEffect(() => {
    setIsSupported(!!getSpeechRecognition());
  }, []);

  const addSegment = useCallback((text: string) => {
    const segment: TranscriptSegment = {
      id: crypto.randomUUID(),
      text,
      isFinal: true,
      timestamp: Date.now(),
      languageCode: languageRef.current,
      speakerLabel: speakerLabelRef.current,
    };
    segmentsRef.current = [...segmentsRef.current, segment];
    setSegments(segmentsRef.current);
  }, []);

  const createRecognition = useCallback(() => {
    const SpeechRecognitionClass = getSpeechRecognition();
    if (!SpeechRecognitionClass) return null;

    const recognition = new SpeechRecognitionClass();
    recognition.lang = languageRef.current;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
      setError(null);
    };

    recognition.onresult = (event) => {
      let interim = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result?.[0]) continue;
        const transcript = result[0].transcript;

        if (result.isFinal && transcript.trim()) {
          addSegment(transcript.trim());
          setInterimText("");
        } else {
          interim += transcript;
        }
      }

      if (interim) {
        setInterimText(interim);
      }
    };

    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are normal during restarts
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed") {
        setError("Microphone access denied. Allow microphone to enable transcription.");
        shouldBeListeningRef.current = false;
        return;
      }
      console.error("Speech recognition error:", event.error);
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterimText("");

      // CRITICAL: restart immediately to avoid gaps in transcription
      // Web Speech API stops after ~60s or on silence — we must restart
      if (shouldBeListeningRef.current) {
        restartTimeoutRef.current = setTimeout(() => {
          if (shouldBeListeningRef.current) {
            const newRecognition = createRecognition();
            if (newRecognition) {
              recognitionRef.current = newRecognition;
              try {
                newRecognition.start();
              } catch {
                // retry once more after a short delay
                setTimeout(() => {
                  if (shouldBeListeningRef.current) {
                    try {
                      newRecognition.start();
                    } catch {
                      setError("Speech recognition stopped unexpectedly. Click Record to restart.");
                    }
                  }
                }, 500);
              }
            }
          }
        }, 50); // 50ms gap — minimal loss
      }
    };

    return recognition;
  }, [addSegment]);

  const startListening = useCallback(() => {
    if (!getSpeechRecognition()) {
      setError("Speech recognition not supported. Use Chrome or Edge.");
      return;
    }

    // Stop existing
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
    }
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
    }

    shouldBeListeningRef.current = true;
    const recognition = createRecognition();
    if (recognition) {
      recognitionRef.current = recognition;
      try {
        recognition.start();
      } catch {
        setError("Failed to start speech recognition.");
      }
    }
  }, [createRecognition]);

  const stopListening = useCallback(() => {
    shouldBeListeningRef.current = false;
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
    setInterimText("");
  }, []);

  const clearTranscript = useCallback(() => {
    segmentsRef.current = [];
    setSegments([]);
    setInterimText("");
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      shouldBeListeningRef.current = false;
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const fullText = segments.map((s) => s.text).join(". ");

  return {
    segments,
    interimText,
    fullText,
    isListening,
    isSupported,
    error,
    startListening,
    stopListening,
    clearTranscript,
  };
}

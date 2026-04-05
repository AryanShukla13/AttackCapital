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

/**
 * Dual-instance speech recognition for zero-gap transcription.
 *
 * The Web Speech API drops audio during restarts (~200-500ms gap).
 * To fix this, we run TWO recognition instances in overlap:
 * - Instance A is the primary listener
 * - When A ends (silence/timeout), Instance B is ALREADY running
 * - B becomes primary, A restarts in background
 * - This ensures there's always at least one instance listening
 */
export function useSpeechRecognition(options: UseSpeechRecognitionOptions = {}) {
  const { language = "en-US", speakerLabel = "You" } = options;

  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interimText, setInterimText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Two instances for overlap
  const instanceARef = useRef<SpeechRecognitionType | null>(null);
  const instanceBRef = useRef<SpeechRecognitionType | null>(null);
  const shouldBeListeningRef = useRef(false);
  const languageRef = useRef(language);
  const speakerLabelRef = useRef(speakerLabel);

  // Dedup: track recently added text to avoid duplicates from overlapping instances
  const recentTextsRef = useRef<Set<string>>(new Set());
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  languageRef.current = language;
  speakerLabelRef.current = speakerLabel;

  useEffect(() => {
    setIsSupported(!!getSpeechRecognition());
  }, []);

  const addSegment = useCallback((text: string) => {
    // Dedup: skip if we just added this exact text in the last 3 seconds
    const normalized = text.toLowerCase().trim();
    if (recentTextsRef.current.has(normalized)) return;

    recentTextsRef.current.add(normalized);
    setTimeout(() => recentTextsRef.current.delete(normalized), 3000);

    const segment: TranscriptSegment = {
      id: crypto.randomUUID(),
      text,
      isFinal: true,
      timestamp: Date.now(),
      languageCode: languageRef.current,
      speakerLabel: speakerLabelRef.current,
    };
    segmentsRef.current = [...segmentsRef.current, segment];
    setSegments([...segmentsRef.current]);
  }, []);

  const createInstance = useCallback(
    (label: string): SpeechRecognitionType | null => {
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
        if (interim) setInterimText(interim);
      };

      recognition.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") return;
        if (event.error === "not-allowed") {
          setError("Microphone access denied. Allow microphone to enable transcription.");
          shouldBeListeningRef.current = false;
          return;
        }
      };

      recognition.onend = () => {
        if (!shouldBeListeningRef.current) {
          setIsListening(false);
          return;
        }

        // Immediately restart this instance — the OTHER instance covers the gap
        setTimeout(() => {
          if (!shouldBeListeningRef.current) return;
          try {
            const newInstance = createInstance(label);
            if (newInstance) {
              if (label === "A") {
                instanceARef.current = newInstance;
              } else {
                instanceBRef.current = newInstance;
              }
              newInstance.start();
            }
          } catch {
            // Will retry on next end cycle
          }
        }, 0);
      };

      return recognition;
    },
    [addSegment],
  );

  const startListening = useCallback(() => {
    if (!getSpeechRecognition()) {
      setError("Speech recognition not supported. Use Chrome or Edge.");
      return;
    }

    // Stop existing
    [instanceARef, instanceBRef].forEach((ref) => {
      if (ref.current) {
        try {
          ref.current.abort();
        } catch {}
        ref.current = null;
      }
    });

    shouldBeListeningRef.current = true;

    // Start instance A immediately
    const a = createInstance("A");
    if (a) {
      instanceARef.current = a;
      try {
        a.start();
      } catch {}
    }

    // Start instance B after 500ms delay (offset so they overlap)
    setTimeout(() => {
      if (!shouldBeListeningRef.current) return;
      const b = createInstance("B");
      if (b) {
        instanceBRef.current = b;
        try {
          b.start();
        } catch {}
      }
    }, 500);
  }, [createInstance]);

  const stopListening = useCallback(() => {
    shouldBeListeningRef.current = false;
    [instanceARef, instanceBRef].forEach((ref) => {
      if (ref.current) {
        try {
          ref.current.stop();
        } catch {}
        ref.current = null;
      }
    });
    setIsListening(false);
    setInterimText("");
  }, []);

  const clearTranscript = useCallback(() => {
    segmentsRef.current = [];
    setSegments([]);
    setInterimText("");
    recentTextsRef.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      shouldBeListeningRef.current = false;
      [instanceARef, instanceBRef].forEach((ref) => {
        if (ref.current) {
          try {
            ref.current.abort();
          } catch {}
        }
      });
      if (cleanupTimerRef.current) clearTimeout(cleanupTimerRef.current);
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

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

  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interimText, setInterimText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionType | null>(null);
  const shouldBeListeningRef = useRef(false);
  const languageRef = useRef(language);
  const speakerLabelRef = useRef(speakerLabel);

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
    setSegments([...segmentsRef.current]);
  }, []);

  const startRecognition = useCallback(() => {
    const SpeechRecognitionClass = getSpeechRecognition();
    if (!SpeechRecognitionClass || !shouldBeListeningRef.current) return;

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
        setError("Microphone access denied.");
        shouldBeListeningRef.current = false;
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      // Restart immediately if we should still be listening
      if (shouldBeListeningRef.current) {
        startRecognition();
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // Retry after a tick
      setTimeout(() => {
        if (shouldBeListeningRef.current) startRecognition();
      }, 100);
    }
  }, [addSegment]);

  const startListening = useCallback(() => {
    if (!getSpeechRecognition()) {
      setError("Speech recognition not supported. Use Chrome or Edge.");
      return;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {}
    }
    shouldBeListeningRef.current = true;
    startRecognition();
  }, [startRecognition]);

  const stopListening = useCallback(() => {
    shouldBeListeningRef.current = false;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
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

  useEffect(() => {
    return () => {
      shouldBeListeningRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
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

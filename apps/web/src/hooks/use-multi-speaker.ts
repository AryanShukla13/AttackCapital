"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useSpeechRecognition, type TranscriptSegment } from "./use-speech-recognition";

export interface SpeakerSegmentLabeled extends TranscriptSegment {
  speakerIndex: number;
}

interface UseMultiSpeakerOptions {
  language?: string;
  speakerCount?: number;
  /** Silence gap (ms) to assume speaker change. Default: 2000 */
  silenceThresholdMs?: number;
}

/**
 * Multi-speaker transcription using Web Speech API.
 * Detects speaker changes based on silence gaps between segments.
 * When there's a gap longer than the threshold, the next segment is
 * assigned to the next speaker (round-robin through speakerCount).
 */
export function useMultiSpeaker(options: UseMultiSpeakerOptions = {}) {
  const { language = "en-US", speakerCount = 2, silenceThresholdMs = 2000 } = options;

  const [currentSpeaker, setCurrentSpeaker] = useState(0);
  const lastTimestampRef = useRef(0);
  const speakerMapRef = useRef(new Map<string, number>());

  const speech = useSpeechRecognition({
    language,
    speakerLabel: `Speaker 1`,
  });

  // Assign speaker indices based on silence gaps
  const labeledSegments: SpeakerSegmentLabeled[] = useMemo(() => {
    let speaker = 0;
    let lastTs = 0;

    return speech.segments.map((seg) => {
      // If gap between this segment and the last is > threshold, switch speaker
      if (lastTs > 0 && seg.timestamp - lastTs > silenceThresholdMs) {
        speaker = (speaker + 1) % speakerCount;
      }
      lastTs = seg.timestamp;

      return {
        ...seg,
        speakerIndex: speaker,
        speakerLabel: `Speaker ${speaker + 1}`,
      };
    });
  }, [speech.segments, speakerCount, silenceThresholdMs]);

  const clearTranscript = useCallback(() => {
    speech.clearTranscript();
    setCurrentSpeaker(0);
    lastTimestampRef.current = 0;
    speakerMapRef.current.clear();
  }, [speech]);

  // Build per-speaker transcripts
  const speakerTranscripts = useMemo(() => {
    const result: Array<{ speaker: number; label: string; text: string; segmentCount: number }> =
      [];
    for (let i = 0; i < speakerCount; i++) {
      const segs = labeledSegments.filter((s) => s.speakerIndex === i);
      result.push({
        speaker: i,
        label: `Speaker ${i + 1}`,
        text: segs.map((s) => s.text).join(". "),
        segmentCount: segs.length,
      });
    }
    return result.filter((s) => s.segmentCount > 0);
  }, [labeledSegments, speakerCount]);

  const fullText = labeledSegments.map((s) => `[${s.speakerLabel}]: ${s.text}`).join("\n");

  return {
    segments: labeledSegments,
    interimText: speech.interimText,
    fullText,
    speakerTranscripts,
    isListening: speech.isListening,
    isSupported: speech.isSupported,
    error: speech.error,
    startListening: speech.startListening,
    stopListening: speech.stopListening,
    clearTranscript,
  };
}

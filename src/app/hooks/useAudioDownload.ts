import { useCallback, useRef } from "react";
import { convertWebMBlobToWav } from "../lib/audioUtils";

type StartRecordingOptions = {
  chunkDurationMs?: number;
  chunkHopMs?: number;
  includeMic?: boolean;
  onChunk?: (blob: Blob, chunkIndex: number) => void | Promise<void>;
};

function useAudioDownload() {
  // Ref to store the MediaRecorder instance.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  // Ref to collect all recorded Blob chunks.
  const recordedChunksRef = useRef<Blob[]>([]);
  const chunkIndexRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const currentRecorderRef = useRef<MediaRecorder | null>(null);
  const currentSegmentChunksRef = useRef<Blob[]>([]);
  const chunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSegmentingRef = useRef(false);

  /**
   * Starts recording by combining the provided remote stream with
   * the microphone audio.
   * @param remoteStream - The remote MediaStream (e.g., from the audio element).
   */
  const startRecording = useCallback(
    async (remoteStream: MediaStream, options: StartRecordingOptions = {}) => {
      const includeMic = options.includeMic ?? true;

      let micStream: MediaStream = new MediaStream();
      if (includeMic) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
          console.error("Error getting microphone stream:", err);
          // Fallback to an empty MediaStream if microphone access fails.
          micStream = new MediaStream();
        }
      }

      // Mix remote + mic with channel separation to help diarisation.
      let combinedStream: MediaStream | null = null;
      try {
        const remoteRate = remoteStream.getAudioTracks()[0]?.getSettings().sampleRate;
        const micRate = micStream.getAudioTracks()[0]?.getSettings().sampleRate;
        const targetSampleRate = remoteRate || micRate;
        const audioContext = targetSampleRate
          ? new AudioContext({ sampleRate: targetSampleRate })
          : new AudioContext();
        audioContextRef.current = audioContext;

        const destination = audioContext.createMediaStreamDestination();
        const merger = audioContext.createChannelMerger(2);

        // Remote → left channel (0)
        try {
          const remoteSource = audioContext.createMediaStreamSource(remoteStream);
          remoteSource.channelCountMode = "explicit";
          remoteSource.channelInterpretation = "discrete";
          remoteSource.connect(merger, 0, 0);
        } catch (err) {
          console.error("Error connecting remote stream to the audio context:", err);
        }

        // Mic → right channel (1) if present
        if (micStream.getAudioTracks().length > 0) {
          try {
            const micSource = audioContext.createMediaStreamSource(micStream);
            micSource.channelCountMode = "explicit";
            micSource.channelInterpretation = "discrete";
            micSource.connect(merger, 0, 1);
          } catch (err) {
            console.error("Error connecting microphone stream to the audio context:", err);
          }
        }

        merger.connect(destination);
        combinedStream = destination.stream;
      } catch (err) {
        console.error("AudioContext mix failed", err);
      }

      const recorderOptions: MediaRecorderOptions = {
        mimeType: "audio/webm;codecs=opus",
        audioBitsPerSecond: 64000,
      };

      const startSegmentRecorder = () => {
        try {
          currentSegmentChunksRef.current = [];
          const mediaRecorder = new MediaRecorder(combinedStream, recorderOptions);
          currentRecorderRef.current = mediaRecorder;
          chunkIndexRef.current = chunkIndexRef.current; // no-op to avoid linter

          mediaRecorder.ondataavailable = (event: BlobEvent) => {
            if (event.data && event.data.size > 0) {
              const blob =
                event.data.type && event.data.type !== 'application/octet-stream'
                  ? event.data
                  : new Blob([event.data], { type: 'audio/webm' });
              currentSegmentChunksRef.current.push(blob);
              recordedChunksRef.current.push(blob);
            }
          };

          mediaRecorder.onstop = () => {
            const segmentBlob = new Blob(currentSegmentChunksRef.current, {
              type: "audio/webm",
            });
            if (options.onChunk && segmentBlob.size > 0) {
              const currentIndex = chunkIndexRef.current++;
              console.debug("Recorder chunk captured", {
                chunkIndex: currentIndex,
                bytes: segmentBlob.size,
                type: segmentBlob.type,
              });
              Promise.resolve(options.onChunk(segmentBlob, currentIndex)).catch(
                () => {}
              );
            }
            if (isSegmentingRef.current) {
              scheduleNextSegment();
            }
          };

          mediaRecorder.start();

          const hopMs = options.chunkHopMs || options.chunkDurationMs;
          if (hopMs) {
            chunkTimerRef.current = setTimeout(() => {
              if (mediaRecorder.state === "recording") {
                mediaRecorder.requestData();
                mediaRecorder.stop();
              }
            }, hopMs);
          }
        } catch (err) {
          console.error("Error starting MediaRecorder with combined stream:", err);
        }
      };

      const scheduleNextSegment = () => {
        if (chunkTimerRef.current) {
          clearTimeout(chunkTimerRef.current);
          chunkTimerRef.current = null;
        }
        startSegmentRecorder();
      };

      isSegmentingRef.current = true;
      startSegmentRecorder();
      mediaRecorderRef.current = currentRecorderRef.current;
    },
    [],
  );

  /**
   * Stops the MediaRecorder, if active.
   */
  const stopRecording = useCallback(() => {
    isSegmentingRef.current = false;
    if (chunkTimerRef.current) {
      clearTimeout(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
    if (currentRecorderRef.current) {
      if (currentRecorderRef.current.state === "recording") {
        try {
          currentRecorderRef.current.requestData();
        } catch {
          // Swallow if already inactive.
        }
        currentRecorderRef.current.stop();
      }
      currentRecorderRef.current = null;
    }
    if (mediaRecorderRef.current) {
      // Request any final data before stopping.
      if (mediaRecorderRef.current.state === "recording") {
        try {
          mediaRecorderRef.current.requestData();
        } catch {
          // ignore
        }
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch (err) {
        console.warn("Failed to close audio context", err);
      }
      audioContextRef.current = null;
    }
  }, []);

  /**
   * Initiates download of the recording after converting from WebM to WAV.
   * If the recorder is still active, we request its latest data before downloading.
   */
  const downloadRecording = useCallback(async () => {
    // If recording is still active, request the latest chunk.
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      // Request the current data.
      mediaRecorderRef.current.requestData();
      // Allow a short delay for ondataavailable to fire.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (recordedChunksRef.current.length === 0) {
      console.warn("No recorded chunks found to download.");
      return;
    }
    
    // Combine the recorded chunks into a single WebM blob.
    const webmBlob = new Blob(recordedChunksRef.current, { type: "audio/webm" });

    try {
      // Convert the WebM blob into a WAV blob.
      const wavBlob = await convertWebMBlobToWav(webmBlob);
      const url = URL.createObjectURL(wavBlob);

      // Generate a formatted datetime string (replace characters not allowed in filenames).
      const now = new Date().toISOString().replace(/[:.]/g, "-");

      // Create an invisible anchor element and trigger the download.
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = url;
      a.download = `realtime_agents_audio_${now}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Clean up the blob URL after a short delay.
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (err) {
      console.error("Error converting recording to WAV:", err);
    }
  }, []);

  return { startRecording, stopRecording, downloadRecording };
}

export default useAudioDownload; 

import {
  initialize,
  AudioClip,
  AudioTrack,
} from "@ableton-extensions/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  decodeAudioFile,
  type AudioData,
} from "./wav.js";
import {
  clampSourceBpm,
  estimateOnsetBpm,
  getWarpedMarkerTiming,
  parseTimingFromName,
  safePositiveDuration,
  snapDurationBeats,
  type WarpedMarkerTiming,
} from "./timing.js";
import {
  MAX_SLICES,
  SLICE_MODES,
  sliceCountForDuration,
  sliceModeLabel,
} from "../shared/slice-modes.js";

export type SourceTimingKind =
  | "warped-live-playback"
  | "filename"
  | "onsets"
  | "song-tempo-fallback";

export interface SourceModel {
  sourceWarping: boolean;
  sourceTempo: number;
  sourceDurationSeconds: number;
  sourceDurationBeats: number;
  timingKind: SourceTimingKind;
}

// Resolves the AudioTrack that owns a supported Arrangement clip.
export function getAudioClipTrack(clip: AudioClip<"1.0.0">): AudioTrack<"1.0.0"> {
  const parent = clip.parent;

  if (parent instanceof AudioTrack) {
    return parent;
  }

  throw new Error("x2k Loop Mutator currently supports Arrangement audio clips only.");
}

// ---------------------------------------------------------------------------
// Source lookup and source model construction
// ---------------------------------------------------------------------------


// Builds the source timing model used by the editor and export paths. Warped
// Arrangement clips use the duration of audio rendered from Live's timeline;
// unwarped clips prefer filename timing, then onset estimation, then song tempo
// as a last-resort model.
export function getSourceModel(
  clip: AudioClip<"1.0.0">,
  audio: AudioData,
  songTempo: number,
  filePath: string,
): SourceModel {
  if (clip.warping) {
    const sourceDurationSeconds = safePositiveDuration(
      getAudioDurationSeconds(audio),
      1,
      "warped Arrangement rendered audio duration seconds",
    );
    const sourceTempo = safePositiveDuration(
      songTempo,
      120,
      "warped Arrangement song tempo",
    );

    return {
      sourceWarping: true,
      sourceTempo,
      sourceDurationSeconds,
      sourceDurationBeats: snapDurationBeats(sourceDurationSeconds * sourceTempo / 60),
      timingKind: "warped-live-playback",
    };
  }

  const durationSeconds = safePositiveDuration(
    getAudioDurationSeconds(audio),
    1,
    "unwarped source audio duration seconds",
  );
  const timingFromName = parseTimingFromName(`${clip.name || ""} ${path.basename(filePath || "")}`);

  if (timingFromName.bpm !== null) {
    const sourceTempo = safePositiveDuration(timingFromName.bpm, 120, "filename source tempo");
    return {
      sourceWarping: false,
      sourceTempo,
      sourceDurationSeconds: durationSeconds,
      sourceDurationBeats: snapDurationBeats(durationSeconds * sourceTempo / 60),
      timingKind: "filename",
    };
  }

  if (timingFromName.bars !== null) {
    const durationBeats = timingFromName.bars * 4;
    return {
      sourceWarping: false,
      sourceTempo: clampSourceBpm(durationBeats * 60 / durationSeconds),
      sourceDurationSeconds: durationSeconds,
      sourceDurationBeats: safePositiveDuration(durationBeats, 1, "filename source duration beats"),
      timingKind: "filename",
    };
  }

  const onsetBpm = estimateOnsetBpm(audio.left, audio.right, audio.sampleRate);

  if (onsetBpm !== null) {
    const sourceTempo = safePositiveDuration(onsetBpm, 120, "onset source tempo");
    return {
      sourceWarping: false,
      sourceTempo,
      sourceDurationSeconds: durationSeconds,
      sourceDurationBeats: snapDurationBeats(durationSeconds * sourceTempo / 60),
      timingKind: "onsets",
    };
  }

  console.warn("[x2k Loop Mutator] Falling back to song tempo for unwarped audio timing.");
  const sourceTempo = safePositiveDuration(songTempo, 120, "song tempo fallback source tempo");
  return {
    sourceWarping: false,
    sourceTempo,
    sourceDurationSeconds: durationSeconds,
    sourceDurationBeats: snapDurationBeats(durationSeconds * sourceTempo / 60),
    timingKind: "song-tempo-fallback",
  };
}

// Returns the audible Arrangement timeline span. Clip View loop/marker values
// are deliberately excluded because they can be shorter than the placed clip.
export function getArrangementClipDurationBeats(clip: AudioClip<"1.0.0">): number {
  const clipDuration = safePositiveDuration(
    clip.duration,
    1,
    "Arrangement clip duration fallback",
  );
  const timelineDuration = safePositiveDuration(
    clip.endTime - clip.startTime,
    clipDuration,
    "Arrangement clip timeline duration",
  );

  return snapDurationBeats(timelineDuration);
}

// Returns the selected warped beat bounds used consistently for duration,
// marker timing, source-file extraction, slicing, and export loop settings.
function getWarpedClipBeatBounds(
  clip: AudioClip<"1.0.0">,
): { startBeat: number; endBeat: number } {
  if (
    clip.looping &&
    Number.isFinite(clip.loopStart) &&
    Number.isFinite(clip.loopEnd) &&
    clip.loopEnd > clip.loopStart
  ) {
    return { startBeat: clip.loopStart, endBeat: clip.loopEnd };
  }

  if (
    Number.isFinite(clip.startMarker) &&
    Number.isFinite(clip.endMarker) &&
    clip.endMarker > clip.startMarker
  ) {
    return { startBeat: clip.startMarker, endBeat: clip.endMarker };
  }

  return {
    startBeat: 0,
    endBeat: safePositiveDuration(clip.duration, 1, "warped clip beat bounds duration"),
  };
}

function getWarpedClipMarkerTiming(
  clip: AudioClip<"1.0.0">,
): WarpedMarkerTiming | null {
  const bounds = getWarpedClipBeatBounds(clip);
  return getWarpedMarkerTiming(clip.warpMarkers, bounds.startBeat, bounds.endBeat);
}

// Converts decoded sample length to physical seconds.
function getAudioDurationSeconds(audio: AudioData): number {
  return audio.left.length / audio.sampleRate;
}

// Logs the resolved source model so source timing decisions are auditable.
export function logSourceModel(
  clip: AudioClip<"1.0.0">,
  sourceModel: SourceModel,
  songTempo: number,
  arrangementDurationBeats: number,
  renderedAudio: AudioData,
): void {
  const markerTiming = sourceModel.sourceWarping
    ? getWarpedClipMarkerTiming(clip)
    : null;
  const sliceModes = SLICE_MODES.map((mode) => {
    const sliceCount = sliceCountForDuration(mode, sourceModel.sourceDurationBeats);
    return { mode: sliceModeLabel(mode), sliceCount, enabled: sliceCount <= MAX_SLICES };
  });

  console.info("[x2k Loop Mutator] Source timing:", {
    sourceKind: "Arrangement",
    sourceWarping: sourceModel.sourceWarping,
    clipWarping: clip.warping,
    clipDuration: safePositiveDuration(clip.duration, sourceModel.sourceDurationBeats, "source model clip duration"),
    looping: clip.looping,
    loopStart: clip.loopStart,
    loopEnd: clip.loopEnd,
    startMarker: clip.startMarker,
    endMarker: clip.endMarker,
    warpMarkers: clip.warpMarkers,
    timingKind: sourceModel.timingKind,
    timingResolution: sourceModel.sourceWarping
      ? "live-playback-song-tempo"
      : sourceModel.timingKind,
    rawSourceMarkerTiming: markerTiming,
    rawSourceTempo: markerTiming?.tempo ?? null,
    songTempo,
    chosenWorkingTempo: sourceModel.sourceTempo,
    chosenWorkingDurationSeconds: sourceModel.sourceDurationSeconds,
    renderedAudioDurationSeconds: getAudioDurationSeconds(renderedAudio),
    arrangementDurationBeats,
    sourceDurationBeats: sourceModel.sourceDurationBeats,
    sliceModes,
    title: clip.name || "Selected audio clip",
  });
}

// ---------------------------------------------------------------------------
// Arrangement source rendering
// ---------------------------------------------------------------------------

type RenderedClipSourceOutcome =
  | { kind: "decoded"; audio: AudioData; tempDirectory: string }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: unknown };

// Renders the selected Arrangement clip directly from its timeline region and
// decodes the result while the progress dialog is still visible. Returns null
// when the user cancels the dialog so callers can exit silently instead of
// reporting a misleading render failure.
export async function renderAudioClipSource(
  context: ReturnType<typeof initialize>,
  clip: AudioClip<"1.0.0">,
): Promise<{ audio: AudioData; tempDirectory: string | null } | null> {
  const parent = clip.parent;

  if (!(parent instanceof AudioTrack)) {
    throw new Error("x2k Loop Mutator currently supports Arrangement audio clips only.");
  }

  let outcome: RenderedClipSourceOutcome | undefined;

  await context.ui.withinProgressDialog(
    "Preparing x2k Loop Mutator...",
    { progress: 0 },
    async (update, signal) => {
      try {
        await update(`Rendering ${clip.name || "selected clip"}...`, 10);
        if (signal.aborted) {
          outcome = { kind: "cancelled" };
          return;
        }

        const renderedPath = await context.resources.renderPreFxAudio(
          parent,
          clip.startTime,
          clip.endTime,
        );
        if (signal.aborted) {
          outcome = { kind: "cancelled" };
          return;
        }

        await update("Reading rendered audio...", 70);
        // Reading and decoding happen inside the dialog because a full 4-bar
        // stereo capture can take noticeable time to decode.
        const audio = decodeAudioFile(await fs.readFile(renderedPath));
        await update("Preparing editor...", 95);

        outcome = { kind: "decoded", audio, tempDirectory: path.dirname(renderedPath) };
      } catch (error) {
        // The SDK signals cancellation through the AbortSignal; a rejection
        // raised after cancellation belongs to the cancelled operation, not a
        // genuine failure.
        outcome = signal.aborted ? { kind: "cancelled" } : { kind: "failed", reason: error };
      }
    },
  );

  if (!outcome || outcome.kind === "cancelled") return null;

  if (outcome.kind === "failed") {
    throw outcome.reason instanceof Error
      ? outcome.reason
      : new Error("x2k Loop Mutator could not render the selected Arrangement clip.");
  }

  return { audio: outcome.audio, tempDirectory: outcome.tempDirectory };
}

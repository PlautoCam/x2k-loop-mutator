import {
  initialize,
  AudioClip,
  AudioTrack,
} from "@ableton-extensions/sdk";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type { SourceModel } from "./clip-source.js";
import {
  ENABLE_WARPED_METADATA_POLICY_MATRIX,
  encodeWavStereo24WithMetadata,
  getExportMetadataPolicies,
  summarizeWavValidation,
  validateExportWavMetadata,
  type ExportWavMetadata,
  type WavMetadataPolicy,
} from "./export-wav.js";
import { safePositiveDuration } from "./timing.js";
import { int16Base64ToFloat } from "./wav.js";
import type {
  ExportRender,
  ExportResult,
} from "../shared/types.js";

const SAMPLE_RATE = 48_000;
const DEBUG_LOGGING = false;

type AudioTrackCreateAudioClipArgs = Parameters<AudioTrack<"1.0.0">["createAudioClip"]>[0];

export interface ExportTarget {
  startBeat: number;
  sourceTrack: AudioTrack<"1.0.0">;
  originalSourceBaseName: string;
  sourceModel: SourceModel;
}

interface PreparedExportRender {
  render: ExportRender;
  projectPath: string;
  exportedFilename: string;
  durationBeats: number;
  musicalDurationBeats: number;
  renderedSeconds: number;
  placementDurationBeats: number;
  metadataPolicy: WavMetadataPolicy;
  tempValidation: ReturnType<typeof summarizeWavValidation>;
  projectValidation: ReturnType<typeof summarizeWavValidation> | null;
}

function debugLog(message: string, data?: unknown): void {
  if (!DEBUG_LOGGING) return;

  if (data === undefined) {
    console.log(message);
    return;
  }

  console.log(message, data);
}

// ---------------------------------------------------------------------------
// Export preparation and dispatch
// ---------------------------------------------------------------------------

// Converts browser-rendered audio into WAV files, imports them into the Live
// project, duplicates/clears a destination track, then creates Arrangement
// clips. Audio samples, metadata formulas, filenames, and randomization results
// are not changed here; this function only packages and places rendered data.
export async function exportMutatedLoop(
  context: ReturnType<typeof initialize>,
  result: ExportResult,
  tempDirectory: string,
  target: ExportTarget,
): Promise<void> {
  if (!result.renders.length) {
    throw new Error("No x2k Loop Mutator renders were provided for export.");
  }

  const metadataPolicies = getExportMetadataPolicies(
    target.sourceModel.sourceWarping,
  );
  const prepared = await Promise.all(
    result.renders.flatMap((render) => metadataPolicies.map(async (metadataPolicy) => {
      const left = int16Base64ToFloat(render.leftBase64);
      const right = int16Base64ToFloat(render.rightBase64);
      const sampleRate = render.sampleRate || SAMPLE_RATE;
      const songTempo = safePositiveDuration(
        context.application.song.tempo,
        120,
        "export song tempo",
      );
      const musicalDurationBeats = getOutputBeats(
        render,
        target.sourceModel.sourceDurationBeats,
      );

      if (!left.length || left.length !== right.length) {
        throw new Error("Mutated loop export buffer is invalid.");
      }

      const renderedSeconds = safePositiveDuration(
        left.length / sampleRate,
        musicalDurationBeats * 60 / songTempo,
        "export rendered seconds",
      );
      const placementDurationBeats = !target.sourceModel.sourceWarping
        ? safePositiveDuration(
          renderedSeconds * songTempo / 60,
          musicalDurationBeats,
          "unwarped Arrangement placement duration beats",
        )
        : musicalDurationBeats;
      const intendedBpm = renderedSeconds > 0 && Number.isFinite(renderedSeconds)
        ? musicalDurationBeats * 60 / renderedSeconds
        : songTempo;
      const bars = musicalDurationBeats / 4;
      const metadataRenderLabel =
        target.sourceModel.sourceWarping && ENABLE_WARPED_METADATA_POLICY_MATRIX
        ? `${render.label}-${metadataPolicy.id}`
        : render.label;
      const exportedFilename = makeExportWavFilename({
        originalSourceBaseName: target.originalSourceBaseName,
        intendedBpm,
        bars,
        renderLabel: metadataRenderLabel,
      });
      const metadata: ExportWavMetadata = {
        exportedFilename,
        intendedBpm,
        durationBeats: musicalDurationBeats,
        bars,
        sampleFrames: left.length,
        originalSourceBaseName: target.originalSourceBaseName,
        renderLabel: metadataRenderLabel,
      };

      const wavBuffer = encodeWavStereo24WithMetadata(
        left,
        right,
        sampleRate,
        metadata,
        metadataPolicy,
      );
      const wavValidation = validateExportWavMetadata(
        wavBuffer,
        metadata,
        metadataPolicy,
      );

      if (!wavValidation.valid) {
        console.warn("[x2k Loop Mutator] Exported WAV metadata validation warning:", wavValidation);
      }

      const expectedBeatsAtSourceTempo =
        renderedSeconds * target.sourceModel.sourceTempo / 60;
      const expectedBeatsAtSongTempo = renderedSeconds * songTempo / 60;
      const exportTimingDiagnostic = {
        sourceKind: "Arrangement",
        sourceWarping: target.sourceModel.sourceWarping,
        songTempo,
        intendedSourceTempo: target.sourceModel.sourceTempo,
        exportedFilename,
        originalSourceBaseName: target.originalSourceBaseName,
        intendedBpm,
        intendedDurationBeats: musicalDurationBeats,
        bars,
        renderedAudioDurationSeconds: renderedSeconds,
        expectedBeatsAtSourceTempo,
        expectedBeatsAtSongTempo,
        placementDurationBeats,
        sampleFrames: left.length,
        metadataPolicyId: metadataPolicy.id,
        wavMetadataChunkOrder: metadataPolicy.chunkOrder,
        acidFlagsMode: metadataPolicy.acidFlagsMode,
        wroteInfoMetadata: wavValidation.hasInfo,
        wroteSmplMetadata: wavValidation.hasSmpl,
        wroteAcidMetadata: wavValidation.valid && wavValidation.hasAcid,
        ...(wavValidation.valid && wavValidation.hasAcid ? {
          acidFlags: wavValidation.acidFlags,
          acidRootNote: wavValidation.acidRootNote,
          acidBeats: wavValidation.acidBeats,
          acidMeterNumerator: wavValidation.acidMeterNumerator,
          acidMeterDenominator: wavValidation.acidMeterDenominator,
          acidTempo: wavValidation.acidTempo,
        } : {}),
      };

      if (target.sourceModel.sourceWarping) {
        console.info("[x2k Loop Mutator] Warped export WAV before import:", {
          ...exportTimingDiagnostic,
          validation: summarizeWavValidation(wavValidation),
        });
      } else {
        debugLog("[x2k Loop Mutator] Preparing exported WAV:", exportTimingDiagnostic);
      }

      const wavPath = path.join(tempDirectory, exportedFilename);
      await fs.writeFile(wavPath, wavBuffer);
      const tempValidation = summarizeWavValidation(wavValidation);
      const projectPath = await context.resources.importIntoProject(wavPath);
      let projectValidation: ReturnType<typeof summarizeWavValidation> | null = null;

      try {
        projectValidation = summarizeWavValidation(
          validateExportWavMetadata(
            await fs.readFile(projectPath),
            metadata,
            metadataPolicy,
          ),
        );
      } catch (error) {
        console.warn("[x2k Loop Mutator] Could not read imported project WAV for metadata validation.", {
          projectPath,
          error,
        });
      }

      const importDiagnostic = {
        metadataPolicyId: metadataPolicy.id,
        originalTempWavPath: wavPath,
        importedProjectPath: projectPath,
        tempValidation,
        projectValidation,
      };

      if (target.sourceModel.sourceWarping) {
        console.info("[x2k Loop Mutator] Warped export WAV after import:", importDiagnostic);
      } else {
        debugLog("[x2k Loop Mutator] Exported WAV metadata validation:", importDiagnostic);
      }

      return {
        render,
        projectPath,
        exportedFilename,
        durationBeats: musicalDurationBeats,
        musicalDurationBeats,
        renderedSeconds,
        placementDurationBeats,
        metadataPolicy,
        tempValidation,
        projectValidation,
      };
    })),
  );

  // The Extensions SDK requires the withinTransaction callback to run
  // synchronously and to return the promise whose settlement closes the undo
  // group ("the callback must be synchronous - you cannot await inside it").
  // The whole mutation sequence is therefore started inside this synchronous
  // call and sequenced via the returned promise.
  await context.withinTransaction(() =>
    placeMutatedClipsOnDuplicatedTrack(context, target, prepared),
  );
}

// Duplicates the source track, clears the duplicate, then creates one
// Arrangement clip per prepared render, laid out sequentially from the source
// clip's start position.
async function placeMutatedClipsOnDuplicatedTrack(
  context: ReturnType<typeof initialize>,
  target: ExportTarget,
  prepared: PreparedExportRender[],
): Promise<void> {
  const duplicated = await context.application.song.duplicateTrack(target.sourceTrack);
  const destinationTrack = duplicated instanceof AudioTrack
    ? duplicated
    : context.getObjectFromHandle(duplicated.handle, AudioTrack);
  destinationTrack.name = "x2k Loop Mutator";
  await clearDuplicatedDestinationTrack(destinationTrack);

  const songTempo = safePositiveDuration(
    context.application.song.tempo,
    120,
    "Arrangement export song tempo",
  );
  let startBeat = target.startBeat;

  for (const item of prepared) {
    const placementDurationBeats = target.sourceModel.sourceWarping
      ? item.musicalDurationBeats
      : item.placementDurationBeats;
    const isWarpedForExportClip = target.sourceModel.sourceWarping;
    const createArgs: AudioTrackCreateAudioClipArgs = target.sourceModel.sourceWarping
      ? {
        filePath: item.projectPath,
        startTime: startBeat,
        isWarped: true,
      }
      : {
        filePath: item.projectPath,
        startTime: startBeat,
        duration: placementDurationBeats,
        isWarped: false,
      };

    debugLog("[x2k Loop Mutator] Creating exported Arrangement clip:", {
      sourceWarping: target.sourceModel.sourceWarping,
      sourceTempo: target.sourceModel.sourceTempo,
      sourceDurationSeconds: target.sourceModel.sourceDurationSeconds,
      sourceDurationBeats: target.sourceModel.sourceDurationBeats,
      timingKind: target.sourceModel.timingKind,
      songTempo,
      musicalDurationBeats: item.durationBeats,
      renderedSeconds: item.renderedSeconds,
      placementDurationBeats,
      isWarpedForExportClip,
    });

    const clip = await destinationTrack.createAudioClip(createArgs);

    clip.name = makeClipName(item);
    if (target.sourceModel.sourceWarping) {
      logNaturalWarpedImportBeforeLooping(
        clip,
        item,
        item.projectPath,
        songTempo,
      );
      clip.looping = true;
      logCreatedWarpedExportClip(
        clip,
        item,
        item.projectPath,
        songTempo,
      );
    }
    startBeat += placementDurationBeats;
  }
}

// Clears clips from the duplicated destination track before mutated exports are
// inserted, preserving the source track while avoiding overlapping leftovers.
async function clearDuplicatedDestinationTrack(
  destinationTrack: AudioTrack<"1.0.0">,
): Promise<void> {
  await Promise.all(
    destinationTrack.arrangementClips.map((clip) => destinationTrack.deleteClip(clip)),
  );

  await Promise.all(
    destinationTrack.clipSlots.map((slot) => slot.clip ? slot.deleteClip() : Promise.resolve()),
  );
}

// Produces filesystem-safe filename segments without changing semantic labels.
function sanitizeFilenamePart(text: string, fallback: string, maxLength = 80): string {
  const sanitized = String(text || "")
    .replace(/[\s]+/g, "_")
    .replace(/[\/\\:"*?<>|]+/g, "_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/[_-]{2,}/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, maxLength)
    .replace(/[._-]+$/g, "");

  return sanitized || fallback;
}

// Formats BPM in filenames while keeping integer BPMs tidy.
function formatBpmForFilename(bpm: number): string {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const value = Math.abs(safeBpm - Math.round(safeBpm)) < 0.05
    ? String(Math.round(safeBpm))
    : safeBpm.toFixed(1).replace(".", "p");
  return `${value}bpm`;
}

// Formats bar count in filenames using the existing naming convention.
function formatBarsForFilename(bars: number): string {
  const safeBars = Number.isFinite(bars) && bars > 0 ? bars : 1;
  const value = Math.abs(safeBars - Math.round(safeBars)) < 0.05
    ? String(Math.round(safeBars))
    : safeBars.toFixed(1).replace(".", "p");
  return `${value}bars`;
}

// Builds the exported WAV filename; UUID suffixes avoid collisions in temp and
// imported project locations.
function makeExportWavFilename(args: {
  originalSourceBaseName: string;
  intendedBpm: number;
  bars: number;
  renderLabel: string;
}): string {
  const source = sanitizeFilenamePart(args.originalSourceBaseName, "source", 60);
  const label = sanitizeFilenamePart(args.renderLabel.toLowerCase(), "render", 32);
  const shortUuid = randomUUID().slice(0, 8);

  return [
    source,
    "X2KLM",
    formatBpmForFilename(args.intendedBpm),
    formatBarsForFilename(args.bars),
    label,
    shortUuid,
  ].join("-") + ".wav";
}

function logNaturalWarpedImportBeforeLooping(
  clip: AudioClip<"1.0.0">,
  item: PreparedExportRender,
  filePathUsed: string,
  songTempo: number,
): void {
  console.info("[x2k Loop Mutator] Natural warped import before looping:", {
    sourceKind: "Arrangement",
    songTempo,
    intendedSourceTempo: item.durationBeats * 60 / item.renderedSeconds,
    intendedDurationBeats: item.durationBeats,
    renderedAudioDurationSeconds: item.renderedSeconds,
    metadataPolicyId: item.metadataPolicy.id,
    filePathUsed,
    createdClipWarping: clip.warping,
    createdClipLooping: clip.looping,
    createdClipDuration: clip.duration,
    createdClipLoopStart: clip.loopStart,
    createdClipLoopEnd: clip.loopEnd,
    createdClipStartMarker: clip.startMarker,
    createdClipEndMarker: clip.endMarker,
    createdClipWarpMarkers: clip.warpMarkers,
  });
}

function logCreatedWarpedExportClip(
  clip: AudioClip<"1.0.0">,
  item: PreparedExportRender,
  filePathUsed: string,
  songTempo: number,
): void {
  const intendedSourceTempo = item.renderedSeconds > 0
    ? item.durationBeats * 60 / item.renderedSeconds
    : songTempo;

  console.info("[x2k Loop Mutator] Created warped export clip:", {
    sourceKind: "Arrangement",
    sourceWarping: true,
    songTempo,
    intendedSourceTempo,
    intendedDurationBeats: item.durationBeats,
    renderedAudioDurationSeconds: item.renderedSeconds,
    expectedBeatsAtSourceTempo: item.renderedSeconds * intendedSourceTempo / 60,
    expectedBeatsAtSongTempo: item.renderedSeconds * songTempo / 60,
    metadataPolicyId: item.metadataPolicy.id,
    wavMetadataChunkOrder: item.metadataPolicy.chunkOrder,
    acidFlagsMode: item.metadataPolicy.acidFlagsMode,
    validationBeforeImport: item.tempValidation,
    validationAfterImport: item.projectValidation,
    filePathUsed,
    createdClipWarping: clip.warping,
    createdClipDuration: clip.duration,
    createdClipLoopStart: clip.loopStart,
    createdClipLoopEnd: clip.loopEnd,
    createdClipStartMarker: clip.startMarker,
    createdClipEndMarker: clip.endMarker,
    createdClipWarpMarkers: clip.warpMarkers,
  });
}

// Resolves whether a render should keep source length or use an explicit bar
// count selected in the editor.
function getOutputBeats(render: ExportRender, fallbackBeats: number): number {
  const safeFallbackBeats = safePositiveDuration(fallbackBeats, 1, "export fallback duration beats");

  if (render.settings.outputMode === "source") {
    return safeFallbackBeats;
  }

  const bars = clampInteger(render.settings.outputBars, 1, 8, 1);
  return safePositiveDuration(bars * 4, safeFallbackBeats, "export output duration beats");
}

// Keeps generated Live clip names stable and based on editor settings.
function makeClipName(item: PreparedExportRender): string {
  return path.basename(item.exportedFilename, path.extname(item.exportedFilename));
}
// Clamps UI/editor numeric values to integer ranges with fallback repair.
function clampInteger(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}

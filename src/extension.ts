/*
 * x2k Loop Mutator opens an Arrangement audio clip in a modal editor, renders the
 * selected source into a small browser-side loop lab, and exports mutated WAVs
 * back into Live. This entry point owns activation and modal orchestration;
 * source preparation and export placement live in dedicated host modules.
 */

import {
  initialize,
  AudioClip,
  AudioTrack,
  type ActivationContext,
  type ArrangementSelection,
} from "@ableton-extensions/sdk";

import * as path from "node:path";
import { buildEditorHtml } from "./editor/editor-html.js";
import type {
  EditorSource,
  ExportResult,
} from "./shared/types.js";
import {
  floatToInt16Base64,
  hasAudibleAudio,
} from "./host/wav.js";
import { safePositiveDuration } from "./host/timing.js";
import {
  getAudioClipTrack,
  getArrangementClipDurationBeats,
  getSourceModel,
  logSourceModel,
  renderAudioClipSource,
} from "./host/clip-source.js";
import { exportMutatedLoop, type ExportTarget } from "./host/export.js";
import {
  ARRANGEMENT_CONTEXT_MENU_SCOPE,
  isArrangementSelection,
} from "./host/arrangement-support.js";
import { showNoticeDialog } from "./host/notices.js";
import {
  loadUserPresets,
  replaceUserPresets,
} from "./host/presets.js";
import { startPresetPersistenceServer } from "./host/preset-server.js";
import { FACTORY_PRESETS } from "./shared/presets.js";
import { parseEditorDialogResultJson } from "./shared/validation.js";

const MAX_SOURCE_BEATS = 16;
const MAX_SOURCE_BEATS_TOLERANCE = 0.001;

// ---------------------------------------------------------------------------
// Ableton activation and command registration
// ---------------------------------------------------------------------------

// Registers only on Arrangement audio-track selections. The generic AudioClip
// scope also appears for Session clips, so it must not be used while Session
// rendering is unsupported by the SDK.
export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  context.commands.registerCommand("x2kLoopMutator.openClip", async (arg: unknown) => {
    try {
      if (!isArrangementSelection(arg)) {
        console.error("x2k Loop Mutator requires an Arrangement audio selection.");
        return;
      }

      const clips = collectSelectedArrangementAudioClips(context, arg);

      // Give visible feedback for the two ambiguous-selection cases instead of
      // failing silently; the context menu is available on any Arrangement
      // selection, including ones that hold no usable single audio clip.
      if (clips.length === 0) {
        await showNoticeDialog(context, {
          heading: "No Arrangement audio clip found",
          paragraphs: [
            "The current selection does not overlap an audio clip.",
            "Right-click an audio clip in the Arrangement and choose Mutate Loop again.",
          ],
        });
        return;
      }

      if (clips.length > 1) {
        await showNoticeDialog(context, {
          heading: `Multiple clips selected (${clips.length})`,
          paragraphs: [
            "x2k Loop Mutator edits one audio clip at a time.",
            "Narrow the time selection or select fewer tracks so exactly one audio clip overlaps it, then try again.",
          ],
        });
        return;
      }

      await openMutatorForAudioClip(context, clips[0]!);
    } catch (error) {
      console.error("x2k Loop Mutator crashed:", error);
    }
  });

  context.ui.registerContextMenuAction(
    ARRANGEMENT_CONTEXT_MENU_SCOPE,
    "Mutate Loop",
    "x2kLoopMutator.openClip",
  );
}

// Collects every Arrangement AudioClip that overlaps the selection's time
// range across all selected lanes.
function collectSelectedArrangementAudioClips(
  context: ReturnType<typeof initialize>,
  selection: ArrangementSelection,
): AudioClip<"1.0.0">[] {
  const start = Math.min(selection.time_selection_start, selection.time_selection_end);
  const end = Math.max(selection.time_selection_start, selection.time_selection_end);
  const clips: AudioClip<"1.0.0">[] = [];

  for (const laneHandle of selection.selected_lanes) {
    let track: AudioTrack<"1.0.0">;
    try {
      track = context.getObjectFromHandle(laneHandle, AudioTrack);
    } catch {
      continue;
    }

    for (const candidate of track.arrangementClips) {
      if (
        candidate instanceof AudioClip &&
        candidate.endTime > start &&
        candidate.startTime < end
      ) {
        clips.push(candidate);
      }
    }
  }

  return clips;
}

// Orchestrates the full command flow for a selected audio clip: validate the
// handle, derive the source timing model, render source audio for the editor,
// open the modal, and pass the returned renders to the export pipeline.
// Timing assumption: warped clips are measured in musical beats; unwarped clips
// are measured in physical seconds first and only converted to beats for editor
// slicing/export metadata.
async function openMutatorForAudioClip(
  context: ReturnType<typeof initialize>,
  clip: AudioClip<"1.0.0">,
): Promise<void> {
  if (!(clip.parent instanceof AudioTrack)) {
    console.error("x2k Loop Mutator currently supports Arrangement audio clips only.");
    return;
  }

  const filePath = clip.filePath;
  const originalSourceBaseName = filePath
    ? path.basename(filePath, path.extname(filePath))
    : clip.name || "source";
  const sourceTrack = getAudioClipTrack(clip);
  const arrangementDurationBeats = clip.warping
    ? getArrangementClipDurationBeats(clip)
    : safePositiveDuration(clip.duration, 1, "unwarped live clip duration");

  if (
    clip.warping &&
    arrangementDurationBeats > MAX_SOURCE_BEATS + MAX_SOURCE_BEATS_TOLERANCE
  ) {
    await showTooLongWarning(context, {
      title: clip.name || "Selected audio clip",
      durationBeats: arrangementDurationBeats,
    });
    return;
  }

  const renderedAudio = await renderAudioClipSource(context, clip);

  // The user cancelled the preparation progress dialog; exit without noise.
  if (!renderedAudio) return;

  const renderedSourceAudio = renderedAudio.audio;

  if (!hasAudibleAudio(renderedSourceAudio)) {
    console.error("x2k Loop Mutator did not find audible audio in the selected clip.");
    return;
  }

  const songTempo = context.application.song.tempo;
  const sourceModel = getSourceModel(clip, renderedSourceAudio, songTempo, filePath);
  const audio = renderedSourceAudio;
  logSourceModel(
    clip,
    sourceModel,
    songTempo,
    arrangementDurationBeats,
    audio,
  );

  if (sourceModel.sourceDurationBeats > MAX_SOURCE_BEATS + MAX_SOURCE_BEATS_TOLERANCE) {
    console.warn("[x2k Loop Mutator] Estimated source duration exceeds supported length.", {
      sourceDurationBeats: sourceModel.sourceDurationBeats,
      maxSourceBeats: MAX_SOURCE_BEATS,
    });
    await showTooLongWarning(context, {
      title: clip.name || "Selected audio clip",
      durationBeats: sourceModel.sourceDurationBeats,
    });
    return;
  }

  const result = await showEditor(context, {
    kind: "arrangement",
    title: clip.name || "Selected audio clip",
    tempo: sourceModel.sourceTempo,
    startBeat: clip.startTime,
    durationBeats: sourceModel.sourceDurationBeats,
    timingKind: sourceModel.timingKind,
    sampleRate: audio.sampleRate,
    leftBase64: floatToInt16Base64(audio.left),
    rightBase64: floatToInt16Base64(audio.right),
  });

  if (!result) return;

  const tempDirectory =
    context.environment.tempDirectory ??
    renderedAudio.tempDirectory ??
    (filePath ? path.dirname(filePath) : undefined);

  if (!tempDirectory) {
    throw new Error("No writable temporary directory available.");
  }

  await exportMutatedLoop(context, result, tempDirectory, {
    startBeat: clip.startTime,
    sourceTrack,
    originalSourceBaseName,
    sourceModel,
  });
}

// ---------------------------------------------------------------------------
// Modal editor creation
// ---------------------------------------------------------------------------

// Opens the fixed-size modal editor and parses the bridge result returned by
// the embedded browser script.
async function showEditor(
  context: ReturnType<typeof initialize>,
  source: EditorSource,
): Promise<ExportResult | null> {
  const storageDirectory = context.environment.storageDirectory;
  const loaded = await loadUserPresets(storageDirectory);
  let persistenceServer: Awaited<ReturnType<typeof startPresetPersistenceServer>> = null;
  try {
    persistenceServer = await startPresetPersistenceServer(storageDirectory);
  } catch (error) {
    console.warn("[x2k Loop Mutator] Immediate preset persistence is unavailable; using close-time persistence.", error);
  }
  const html = buildEditorHtml(source, {
    presets: [...FACTORY_PRESETS, ...loaded.presets],
    persistenceApi: persistenceServer
      ? {
        presetsUrl: persistenceServer.presetsUrl,
        exportUrl: persistenceServer.exportUrl,
        revealUrl: persistenceServer.revealUrl,
        authHeaderName: persistenceServer.auth.name,
        authToken: persistenceServer.auth.value,
      }
      : undefined,
    notice: loaded.notice,
  });
  let result: string;
  try {
    result = await context.ui.showModalDialog(
      `data:text/html,${encodeURIComponent(html)}`,
      1246,
      800,
    );
  } finally {
    await persistenceServer?.close();
  }

  if (!result || result === "__cancel__") return null;

  const editorResult = parseEditorDialogResultJson(result);

  try {
    await replaceUserPresets(storageDirectory, editorResult.userPresetsJson);
  } catch (error) {
    console.error("[x2k Loop Mutator] Could not persist user presets.", error);
  }

  return editorResult.action === "export" ? editorResult : null;
}

// Presents a fixed-size warning when the source exceeds the supported editor
// length. The HTML is intentionally self-contained and keeps existing labels.
async function showTooLongWarning(
  context: ReturnType<typeof initialize>,
  source: { title: string; durationBeats: number },
): Promise<void> {
  const bars = source.durationBeats / 4;
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x2k Loop Mutator</title>
<style>
*,*::before,*::after{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{margin:0;background:#c0c0c0;color:#333333;font-family:Arial,sans-serif;font-size:12px}.wrap{height:100%;display:grid;grid-template-rows:45px minmax(0,1fr)48px;overflow:hidden}.top{background:#c0c0c0;color:#333333;padding:7px 18px;border-top:1px solid #333333;border-bottom:1px solid #333333;display:flex;align-items:center}.title{font-size:20px;font-weight:900;line-height:1}.body{min-height:0;padding:18px 22px 10px;line-height:1.32;overflow:hidden}.clip-name{display:block;margin:4px 0 10px;color:#1b1b1b;font-weight:900;overflow:hidden;text-overflow:ellipsis;white-space:normal;overflow-wrap:anywhere}.warning{font-size:13px;font-weight:900;margin-bottom:12px}.meta{margin:10px 0;color:#777777}.footer{border-top:1px solid #333333;background:#c0c0c0;padding:9px 18px;display:flex;justify-content:flex-end;align-items:center}.button{height:30px;border-radius:0px;border:1px solid #333333;background:#aaaaaa;color:#333333;font-weight:900;padding:0 18px;cursor:pointer;box-shadow:inset 0 1px 0 rgba(238,238,238,.35)}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><div class="title">x2k Loop Mutator</div></div>
  <div class="body">
    <div class="warning">x2k Loop Mutator supports clips up to 4 bars.</div>
    <div>Selected clip:</div>
    <strong class="clip-name">${escapeHtml(source.title)}</strong>
    <div class="meta">Length:<br>${source.durationBeats.toFixed(2)} beats / ${bars.toFixed(2)} bars</div>
    <div>Please crop or consolidate this clip to 4 bars or less, then try again.</div>
  </div>
  <div class="footer"><button id="closeButton" class="button">Close</button></div>
</div>
<script>
function closeDialog() { var message = { method: "close_and_send", params: ["__cancel__"] }; if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live) { window.webkit.messageHandlers.live.postMessage(message); return; } if (window.chrome && window.chrome.webview) { window.chrome.webview.postMessage(message); return; } window.close(); }
document.getElementById("closeButton").onclick = closeDialog;
</script>
</body>
</html>`;
  await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(html)}`,
    520,
    280,
  );
}

// Escapes source names before interpolating them into the warning dialog HTML.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

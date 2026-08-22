import type {
  EditorCloseResult,
  EditorDialogResult,
  EditorSessionState,
  ExportRender,
  ExportResult,
  PatternRandomSettings,
  PatternSettings,
  PatternValue,
} from "./types.js";
import {
  MAX_PRESET_NAME_LENGTH,
  PATTERN_LANE_KEYS,
  SNAPSHOT_SLOTS,
  laneRandomBounds,
  normalizePresetName,
} from "./presets.js";

const PATTERN_LANE_KEY_SET = new Set<string>(PATTERN_LANE_KEYS);
const DIGIT_LANES = new Set(["stutter", "tape", "filter", "flanger", "bitcrush", "reverb"]);

export interface ParsedPresetEntry {
  id?: string;
  name: string;
  settings: PatternSettings;
}

export interface ParsedPresetFile {
  presets: ParsedPresetEntry[];
  errors: string[];
}

// Parses the modal bridge payload and returns it only after runtime validation.
export function parseEditorDialogResultJson(json: string): EditorDialogResult {
  const parsed = parseJson(json, "Invalid x2k Loop Mutator editor result: invalid JSON");

  if (!isRecord(parsed)) editorInvalid("result must be an object");
  if (parsed.action === "export") {
    validateExportResult(parsed);
    return parsed;
  }
  if (parsed.action === "close") {
    validateEditorCloseResult(parsed);
    return parsed;
  }

  return editorInvalid("invalid action");
}

function validateEditorCloseResult(value: unknown): asserts value is EditorCloseResult {
  if (!isRecord(value)) editorInvalid("close result must be an object");
  if (value.action !== "close") editorInvalid("invalid close action");
  validateUserPresetJsonField(value.userPresetsJson);
}

// Validates a readable, versioned preset file while allowing valid entries to
// be imported when individual neighbors are malformed.
export function parseUserPresetFileJson(json: string): ParsedPresetFile {
  const parsed = parseJson(json, "Invalid preset JSON.");
  if (!isRecord(parsed)) presetFileInvalid("top level must be an object");
  if (parsed.version !== 1) presetFileInvalid("version must be 1");
  if (!Array.isArray(parsed.presets)) presetFileInvalid("presets must be an array");

  const presets: ParsedPresetEntry[] = [];
  const errors: string[] = [];

  parsed.presets.forEach((entry, index) => {
    try {
      presets.push(validatePresetEntry(entry, index));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Preset ${index + 1} is invalid.`);
    }
  });

  return { presets, errors };
}

// Validates the top-level action returned by the editor webview.
function validateExportResult(value: unknown): asserts value is ExportResult {
  if (!isRecord(value)) exportInvalid("result must be an object");
  if (value.action !== "export") exportInvalid("invalid action");
  if (value.mode !== "current" && value.mode !== "queue") exportInvalid("invalid mode");
  if (!Array.isArray(value.renders)) exportInvalid("missing renders");
  if (!value.renders.length) exportInvalid("renders must not be empty");
  validateUserPresetJsonField(value.userPresetsJson);

  value.renders.forEach((render, index) => validateExportRender(render, index));
}

function validateUserPresetJsonField(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 2_000_000) {
    editorInvalid("invalid user preset JSON");
  }
  parseUserPresetFileJson(value);
}

function validateExportRender(value: unknown, index: number): asserts value is ExportRender {
  if (!isRecord(value)) exportInvalid(`render ${index} must be an object`);
  if (typeof value.label !== "string") exportInvalid(`invalid label in render ${index}`);
  if (!isPositiveFiniteNumber(value.sampleRate)) exportInvalid(`invalid sampleRate in render ${index}`);
  if (typeof value.leftBase64 !== "string") exportInvalid(`invalid leftBase64 in render ${index}`);
  if (typeof value.rightBase64 !== "string") exportInvalid(`invalid rightBase64 in render ${index}`);

  validatePatternSettings(value.settings, `render ${index}`, false, exportInvalid);
}

function validateEditorSession(value: unknown): asserts value is EditorSessionState {
  if (!isRecord(value)) editorInvalid("missing editor session");
  validatePatternSettings(value.settings, "editor session", true, editorInvalid);
  if (!Array.isArray(value.snapshots) || value.snapshots.length !== SNAPSHOT_SLOTS) editorInvalid("invalid snapshots");
  value.snapshots.forEach((snapshot, index) => {
    if (snapshot === null) return;
    if (!isRecord(snapshot) || typeof snapshot.label !== "string") editorInvalid(`invalid snapshot ${index + 1}`);
    validatePatternSettings(snapshot.settings, `snapshot ${index + 1}`, true, editorInvalid);
  });
  if (!Number.isInteger(value.selectedSnapshotIndex) || (value.selectedSnapshotIndex as number) < 0 || (value.selectedSnapshotIndex as number) >= SNAPSHOT_SLOTS) {
    editorInvalid("invalid selected snapshot");
  }
  if (!Array.isArray(value.queuedSnapshots) || value.queuedSnapshots.some((index) => !Number.isInteger(index) || index < 0 || index >= SNAPSHOT_SLOTS)) {
    editorInvalid("invalid snapshot queue");
  }
  if (!isRecord(value.randomizeAllLocks) || Object.values(value.randomizeAllLocks).some((locked) => typeof locked !== "boolean")) {
    editorInvalid("invalid randomize-all locks");
  }
  if (value.selectedPresetId !== null && typeof value.selectedPresetId !== "string") editorInvalid("invalid selected preset");
  if (typeof value.hadResult !== "boolean") editorInvalid("invalid rendered-result state");
}

function validatePresetEntry(value: unknown, index: number): ParsedPresetEntry {
  const label = `Preset ${index + 1}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (value.id !== undefined && (typeof value.id !== "string" || !value.id.trim() || value.id.length > 100)) {
    throw new Error(`${label} has an invalid id.`);
  }
  if (typeof value.name !== "string") throw new Error(`${label} has no valid name.`);
  const name = normalizePresetName(value.name);
  if (!name) throw new Error(`${label} has an empty name.`);
  if (value.name.trim().length > MAX_PRESET_NAME_LENGTH) {
    throw new Error(`${label} name exceeds ${MAX_PRESET_NAME_LENGTH} characters.`);
  }

  validatePatternSettings(value.settings, label, true, (reason) => {
    throw new Error(`${label}: ${reason}.`);
  });

  return {
    id: typeof value.id === "string" ? value.id : undefined,
    name,
    settings: value.settings,
  };
}

function validatePatternSettings(
  value: unknown,
  path: string,
  strictPreset: boolean,
  fail: (reason: string) => never,
): asserts value is PatternSettings {
  if (!isRecord(value)) fail(`missing settings in ${path}`);
  if (strictPreset) {
    const allowed = new Set([
      "sliceMode", "outputMode", "outputBars", "filterType", "filterCutoff",
      "filterResonance", "filterDrive", "filterAttack", "filterDecay",
      "filterEnvDirection", "sequences", "randomSettings",
    ]);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) fail(`unknown settings field ${unknown} in ${path}`);
  }
  if (strictPreset) {
    if (value.sliceMode !== "half" && value.sliceMode !== "quarter" && value.sliceMode !== "eighth") fail(`invalid sliceMode in ${path}`);
  } else if (typeof value.sliceMode !== "string") fail(`invalid sliceMode in ${path}`);
  if (value.outputMode !== "source" && value.outputMode !== "bars") fail(`invalid outputMode in ${path}`);
  if (!isFiniteNumber(value.outputBars) || (strictPreset && ![1, 2, 4, 8].includes(value.outputBars))) fail(`invalid outputBars in ${path}`);
  if (!isFilterType(value.filterType)) fail(`invalid filterType in ${path}`);
  if (!isFiniteNumber(value.filterCutoff) || (strictPreset && (value.filterCutoff < 80 || value.filterCutoff > 6000))) fail(`invalid filterCutoff in ${path}`);
  for (const key of ["filterResonance", "filterDrive", "filterAttack", "filterDecay"] as const) {
    if (!isFiniteNumber(value[key]) || (strictPreset && (value[key] < 0 || value[key] > 1))) fail(`invalid ${key} in ${path}`);
  }
  if (value.filterEnvDirection !== "UP" && value.filterEnvDirection !== "DOWN") fail(`invalid filterEnvDirection in ${path}`);
  if (!isRecord(value.sequences)) fail(`invalid sequences in ${path}`);

  for (const [key, sequence] of Object.entries(value.sequences)) {
    if (strictPreset && !PATTERN_LANE_KEY_SET.has(key)) fail(`unknown sequence ${key} in ${path}`);
    if (!Array.isArray(sequence) || (strictPreset && sequence.length > 16)) fail(`invalid sequence ${key} in ${path}`);
    sequence.forEach((patternValue, valueIndex) => {
      if (!isPatternValue(patternValue) || (strictPreset && !isValidLaneValue(key, patternValue))) {
        fail(`invalid sequence value at ${path}, ${key}[${valueIndex}]`);
      }
    });
  }

  if (strictPreset) {
    for (const key of PATTERN_LANE_KEYS) {
      if (!Array.isArray(value.sequences[key])) fail(`missing sequence ${key} in ${path}`);
    }
  }

  if (value.randomSettings !== undefined) {
    if (!isRecord(value.randomSettings)) fail(`invalid randomSettings in ${path}`);
    for (const [key, settings] of Object.entries(value.randomSettings)) {
      if (strictPreset && !PATTERN_LANE_KEY_SET.has(key)) fail(`unknown randomSettings ${key} in ${path}`);
      validatePatternRandomSettings(settings, `${path}, ${key}`, key, strictPreset, fail);
    }
  }
}

function validatePatternRandomSettings(
  value: unknown,
  path: string,
  laneKey: string,
  strictPreset: boolean,
  fail: (reason: string) => never,
): asserts value is PatternRandomSettings {
  if (!isRecord(value)) fail(`invalid randomSettings at ${path}`);
  if (!isFiniteNumber(value.min)) fail(`invalid randomSettings min at ${path}`);
  if (!isFiniteNumber(value.max)) fail(`invalid randomSettings max at ${path}`);
  if (!isFiniteNumber(value.freq) || (strictPreset && (!Number.isInteger(value.freq) || value.freq < 0 || value.freq > 16))) {
    fail(`invalid randomSettings freq at ${path}`);
  }
  if (strictPreset) {
    if (Object.keys(value).some((key) => key !== "min" && key !== "max" && key !== "freq")) {
      fail(`unknown randomSettings field at ${path}`);
    }
    if (!Number.isInteger(value.min) || !Number.isInteger(value.max) || value.min > value.max) {
      fail(`invalid randomSettings range at ${path}`);
    }
    const bounds = laneRandomBounds(laneKey);
    if (value.min < bounds[0] || value.max > bounds[1]) fail(`randomSettings range is out of bounds at ${path}`);
  }
}

// Single authority for per-lane pattern-value legality; shared with the
// editor's preset import validation.
export function isValidLaneValue(key: string, value: PatternValue): boolean {
  if (key === "order") return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 16;
  if (key === "reverse") return value === "F" || value === "R";
  if (key === "pitch") return typeof value === "number" && Number.isInteger(value) && value >= -12 && value <= 12;
  if (key === "filterTypeLane") return value === "-" || value === "LP" || value === "BP" || value === "HP" || value === "NT" || value === "NOTCH";
  if (key === "filterEnvDirLane") return value === "-" || value === "UP" || value === "DN" || value === "DOWN";
  if (DIGIT_LANES.has(key)) return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 9;
  return false;
}

function isPatternValue(value: unknown): value is PatternValue {
  return isFiniteNumber(value) ||
    value === "F" || value === "R" || value === "-" ||
    value === "LP" || value === "BP" || value === "HP" ||
    value === "NT" || value === "NOTCH" ||
    value === "UP" || value === "DN" || value === "DOWN";
}

function isFilterType(value: unknown): value is PatternSettings["filterType"] {
  return value === "LP" || value === "BP" || value === "HP" || value === "NOTCH";
}

function parseJson(json: string, message: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function exportInvalid(reason: string): never {
  throw new Error(`Invalid x2k Loop Mutator export result: ${reason}`);
}

function editorInvalid(reason: string): never {
  throw new Error(`Invalid x2k Loop Mutator editor result: ${reason}`);
}

function presetFileInvalid(reason: string): never {
  throw new Error(`Invalid preset file: ${reason}.`);
}

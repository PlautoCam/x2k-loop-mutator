/*
 * x2k Loop Mutator editor runtime entry point.
 *
 * Ported 1:1 from the former inline <script> template string so the DOM glue,
 * state management, and event wiring are type-checked at build time. Pure
 * logic lives in core.ts; this module owns state, rendering, playback, preset
 * persistence, and the modal bridge back to the extension host.
 *
 * The host injects two globals before this bundle executes:
 *   window.__X2KLM_EDITOR_PAYLOAD__    - EditorSource for the opened clip
 *   window.__X2KLM_PRESET_BOOTSTRAP__  - EditorPresetBootstrap (presets/session)
 */
import {
  EFFECT_DEFS,
  MAX_SLICES,
  applyBitcrushSegment,
  applyFlanger,
  applyGatedReverb,
  applyPatternFilter,
  applyStutter,
  applyTapeStop,
  buildRandomLanePattern,
  buildSliceSegment,
  choosePatternReverbSettings,
  clamp01,
  clampToRange,
  createRng,
  decodeInt16Base64,
  defaultPatternText as defaultPatternTextForSliceCount,
  defaultRandomSettings,
  edgeFade,
  encodeInt16Base64,
  ensureValidSliceModeValue,
  formatFilterEnvDirLaneToken,
  formatFilterTypeLaneToken,
  formatPitchPattern,
  formatReversePattern,
  formatSliceModeLabel,
  getSliceBeatsForMode,
  getSliceCountForMode,
  hashString,
  isSliceModeAvailable,
  makeRandomFilterEnvDirValuesForCurrentFilterEnv,
  normalizeFilterEnvDirLaneValue,
  normalizeFilterTypeLaneValue,
  normalizePair,
  offsetReverbSettings,
  parsePatternForEffect,
  patternToText,
  patternToTextForEffect,
  pitchShiftDurationLocked,
  resizePatternValuesForSliceCount,
  sanitizeRandomSettings,
  validatePatternForEffect,
  validFilterEnvDirection,
  validFilterType,
} from "./core.js";
import type {
  EffectDef,
  FilterControlSettings,
  LaneKey,
  PatternValidationResult,
  RandomSettings,
  Rng,
} from "./core.js";
import type {
  EditorPresetBootstrap,
  EditorSnapshotState,
  EditorSource,
  PatternPreset,
  PatternSettings,
  PatternValue,
} from "../../shared/types.js";
import { MAX_USER_PRESETS, SNAPSHOT_SLOTS, laneRandomBounds } from "../../shared/presets.js";
import { isValidLaneValue } from "../../shared/validation.js";

declare global {
  interface Window {
    __X2KLM_EDITOR_PAYLOAD__?: unknown;
    __X2KLM_PRESET_BOOTSTRAP__?: unknown;
    webkit?: { messageHandlers?: { live?: { postMessage(message: unknown): void } } };
    chrome?: { webview?: { postMessage(message: unknown): void } };
    webkitAudioContext?: typeof AudioContext;
  }
}

type FilterType = "LP" | "BP" | "HP" | "NOTCH";
type EnvDirection = "UP" | "DOWN";

interface Slice {
  start: number;
  end: number;
}

interface RenderResult {
  left: Float32Array;
  right: Float32Array;
}

interface ResultMarker {
  position: number;
  label: string;
}

interface CollectedEditorSession {
  settings: PatternSettings;
  snapshots: Array<EditorSnapshotState | null>;
  selectedSnapshotIndex: number;
  queuedSnapshots: number[];
  randomizeAllLocks: Record<string, boolean>;
  selectedPresetId: string | null;
  hadResult: boolean;
}

// State and decoded source audio passed from the extension host.
const DEBUG_LOGGING = false;
const payload = window.__X2KLM_EDITOR_PAYLOAD__ as EditorSource;
const presetBootstrap = window.__X2KLM_PRESET_BOOTSTRAP__ as EditorPresetBootstrap;
let presets: PatternPreset[] = Array.isArray(presetBootstrap.presets) ? presetBootstrap.presets : [];
const effectDefs: readonly EffectDef[] = EFFECT_DEFS;
const source = {
  sampleRate: payload.sampleRate,
  left: decodeInt16Base64(payload.leftBase64),
  right: decodeInt16Base64(payload.rightBase64),
};

let state = {
  sliceMode: "quarter",
  outputMode: "source",
  outputBars: 1,
  filterType: "LP" as FilterType,
  filterCutoff: 500,
  filterResonance: 0.35,
  filterDrive: 0,
  filterAttack: 0,
  filterDecay: 0.45,
  filterEnvDirection: "UP" as EnvDirection,
  sequences: {} as Record<string, PatternValue[]>,
  randomSettings: {} as Record<string, RandomSettings>,
};
let randomizeAllLocks: Record<string, boolean> = {};
let snapshots: Array<EditorSnapshotState | null> = new Array(SNAPSHOT_SLOTS).fill(null);
let selectedSnapshotIndex = 0;
let queuedSnapshots: number[] = [];
let slices: Slice[] = [];
let result: RenderResult | null = null;
let resultMarkers: ResultMarker[] = [];
let audioContext: AudioContext | null = null;
let sourcePreviewBuffer: AudioBuffer | null = null;
let resultPreviewBuffer: AudioBuffer | null = null;
let activePreviewSource: AudioBufferSourceNode | null = null;
let activePreviewKind: "source" | "result" | null = null;
let playStartTime = 0;
let animationFrame = 0;
let currentStatus = "Ready";
const patternValidation: Record<string, PatternValidationResult> = {};
let selectedPresetId: string | null = presetBootstrap.session && typeof presetBootstrap.session.selectedPresetId === "string"
  ? presetBootstrap.session.selectedPresetId
  : null;
let presetDialogMode: string | null = null;
let presetPersistenceQueue: Promise<void> = Promise.resolve();
let exportedPresetPath: string | null = null;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error("x2k Loop Mutator editor is missing element #" + id);
  return el as T;
}

// Initial UI state synchronization.
effectDefs.forEach(function (def) { state.sequences[def.key] = []; });
ensureRandomSettings();
byId("sourceMeta").textContent = payload.title + " - Arrangement - " + payload.durationBeats.toFixed(2) + " beats @ " + payload.tempo.toFixed(1) + " BPM";
(byId("filterCutoff") as HTMLInputElement).value = String(state.filterCutoff);
(byId("filterResonance") as HTMLInputElement).value = String(state.filterResonance);
(byId("filterDrive") as HTMLInputElement).value = String(state.filterDrive);
(byId("filterAttack") as HTMLInputElement).value = String(state.filterAttack);
(byId("filterDecay") as HTMLInputElement).value = String(state.filterDecay);
updateFilterButtons();
updateFilterEnvDirectionButtons();
updateFilterValues();

function debugLog(message: string, data?: unknown): void {
  if (!DEBUG_LOGGING) return;
  if (typeof data === "undefined") {
    console.log(message);
    return;
  }
  console.log(message, data);
}

// ---------------------------------------------------------------------------
// Pattern text helpers bridging to core
// ---------------------------------------------------------------------------

function defaultPatternText(key: LaneKey): string {
  return defaultPatternTextForSliceCount(key, Math.max(1, slices.length));
}

function patternInputForKey(key: LaneKey): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-pattern="' + key + '"]');
}

function patternEditorForKey(key: LaneKey): Element | null {
  const input = patternInputForKey(key);
  return input ? input.closest(".pattern-editor") : null;
}

function patternChipsForKey(key: LaneKey): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-pattern-chips="' + key + '"]');
}

function formatPatternChipValue(key: LaneKey, value: PatternValue): string {
  if (key === "pitch") return formatPitchPattern([value]);
  if (key === "reverse") return String(value).toUpperCase() === "R" ? "R" : "F";
  if (key === "filterTypeLane") return formatFilterTypeLaneToken(value);
  if (key === "filterEnvDirLane") return formatFilterEnvDirLaneToken(value);
  return String(value);
}

function renderPatternChips(key: LaneKey): void {
  const chips = patternChipsForKey(key);
  if (!chips) return;
  const validation = validatePatternInput(key);
  chips.innerHTML = "";
  if (!validation.valid) return;
  validation.values.forEach(function (value) {
    const chip = document.createElement("span");
    chip.className = "pattern-chip";
    chip.textContent = formatPatternChipValue(key, value);
    chips.appendChild(chip);
  });
  chips.title = validation.normalizedText;
}

function renderAllPatternChips(): void {
  effectDefs.forEach(function (def) { renderPatternChips(def.key); });
}

function enterPatternEditMode(key: LaneKey): void {
  const editor = patternEditorForKey(key);
  const input = patternInputForKey(key);
  if (!editor || !input) return;
  input.dataset.previousValue = input.value;
  editor.classList.add("editing");
  input.focus();
  input.select();
}

function leavePatternEditMode(key: LaneKey): void {
  const editor = patternEditorForKey(key);
  const input = patternInputForKey(key);
  if (!editor || !input) return;

  const previousValue = input.dataset.previousValue || patternToTextForEffect(key, state.sequences[key] ?? []);
  const validation = validatePatternInput(key);

  if (validation.valid) {
    setPatternInputValue(key, validation.normalizedText);
    syncPattern(key);
    editor.classList.remove("editing");
    editor.classList.remove("invalid");
    renderPatternChips(key);
    return;
  }

  setPatternInputValue(key, previousValue);
  syncPattern(key);
  editor.classList.remove("editing");
  editor.classList.remove("invalid");
  renderPatternChips(key);
}

function setPatternInputValue(key: LaneKey, text: string): void {
  const input = patternInputForKey(key);
  if (!input) return;
  input.value = text;
  input.classList.remove("invalid");
  input.scrollLeft = 0;
  const editor = patternEditorForKey(key);
  if (editor) {
    editor.classList.remove("editing");
    editor.classList.remove("invalid");
  }
  renderPatternChips(key);
}

function validatePatternInput(key: LaneKey): PatternValidationResult {
  const input = patternInputForKey(key);
  const result = validatePatternForEffect(
    key,
    input ? input.value : defaultPatternText(key),
    Math.max(1, slices.length),
    Math.max(1, slices.length),
  );
  patternValidation[key] = result;
  setPatternInputInvalid(key, !result.valid);
  return result;
}

function validateAllPatternInputs(): Record<string, PatternValidationResult> {
  effectDefs.forEach(function (def) { validatePatternInput(def.key); });
  return patternValidation;
}

function setPatternInputInvalid(key: LaneKey, isInvalid: boolean): void {
  const input = patternInputForKey(key);
  if (input) input.classList.toggle("invalid", !!isInvalid);
  const editor = patternEditorForKey(key);
  if (editor) {
    editor.classList.toggle("invalid", !!isInvalid);
    if (isInvalid) editor.classList.add("editing");
  }
}

function safePatternValues(key: LaneKey): PatternValue[] {
  const validation = patternValidation[key] || validatePatternInput(key);
  return validation.values;
}

function isPatternValid(key: LaneKey): boolean {
  const validation = patternValidation[key] || validatePatternInput(key);
  return !!validation.valid;
}

function syncPattern(key: LaneKey): void {
  const validation = validatePatternInput(key);
  state.sequences[key] = validation.values;
  renderPatternChips(key);
}

function syncAllPatterns(): void {
  effectDefs.forEach(function (def) { syncPattern(def.key); });
  renderAllPatternChips();
}

// ---------------------------------------------------------------------------
// Randomization controls
// ---------------------------------------------------------------------------

function ensureRandomSettings(): void {
  if (!state.randomSettings || typeof state.randomSettings !== "object") state.randomSettings = {};
  effectDefs.forEach(function (def) {
    const defaults = defaultRandomSettings(def.key);
    const incoming = (state.randomSettings[def.key] ?? {}) as Partial<RandomSettings>;
    state.randomSettings[def.key] = {
      min: Number.isFinite(Number(incoming.min)) ? Number(incoming.min) : defaults.min,
      max: Number.isFinite(Number(incoming.max)) ? Number(incoming.max) : defaults.max,
      freq: Number.isFinite(Number(incoming.freq)) ? Number(incoming.freq) : defaults.freq,
    };
  });
}

function readRandomField(key: LaneKey, field: "min" | "max" | "freq", fallback: number, emptyFallback: number): number {
  const input = document.querySelector<HTMLInputElement>('[data-random-' + field + '="' + key + '"]');
  if (!input || input.disabled) return fallback;
  const text = String(input.value ?? "").trim();
  if (!text) return emptyFallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : emptyFallback;
}

function activeStepLimit(): number {
  return slices.length ? Math.max(1, slices.length) : MAX_SLICES;
}

function getRandomSettings(key: LaneKey): RandomSettings {
  ensureRandomSettings();
  const defaults = defaultRandomSettings(key);
  const stored = state.randomSettings[key] || defaults;
  const withInputs = {
    min: readRandomField(key, "min", stored.min, defaults.min),
    max: readRandomField(key, "max", stored.max, defaults.max),
    freq: readRandomField(key, "freq", stored.freq, 0),
  };
  const normalized = sanitizeRandomSettings(key, withInputs, activeStepLimit());
  state.randomSettings[key] = normalized;
  return normalized;
}

function syncRandomSettingsInput(key: LaneKey): void {
  ensureRandomSettings();
  const settings = sanitizeRandomSettings(key, state.randomSettings[key], activeStepLimit());
  state.randomSettings[key] = settings;
  (["min", "max", "freq"] as const).forEach(function (field) {
    const input = document.querySelector<HTMLInputElement>('[data-random-' + field + '="' + key + '"]');
    if (!input) return;
    if (input.disabled) {
      input.value = "";
      return;
    }
    input.value = String(settings[field]);
  });
}

function updateRandomSettingsInputs(): void {
  effectDefs.forEach(function (def) { syncRandomSettingsInput(def.key); });
}

function stepRandomField(key: LaneKey, field: "min" | "max" | "freq", delta: number): void {
  const input = document.querySelector<HTMLInputElement>('[data-random-' + field + '="' + key + '"]');
  if (!input || input.disabled) return;
  const defaults = defaultRandomSettings(key);
  let current = Number(String(input.value ?? "").trim());
  if (!Number.isFinite(current)) current = defaults[field];
  input.value = String(current + delta);
  getRandomSettings(key);
  syncRandomSettingsInput(key);
}

function currentFilterSequence(): PatternValue[] {
  return state.sequences.filter && state.sequences.filter.length
    ? state.sequences.filter
    : safePatternValues("filter");
}

function applyRandomPatternValues(key: LaneKey, values: PatternValue[]): void {
  state.sequences[key] = values;
  setPatternInputValue(key, patternToTextForEffect(key, values));
  syncPattern(key);
  syncRandomSettingsInput(key);
}

function syncRandomFilterEnvDirAfterFilter(rng: Rng, count: number): void {
  if (randomizeAllLocks.filterEnvDirLane === true) return;
  if (!effectDefs.some(function (def) { return def.key === "filterEnvDirLane"; })) return;
  applyRandomPatternValues(
    "filterEnvDirLane",
    makeRandomFilterEnvDirValuesForCurrentFilterEnv(rng, count, null, currentFilterSequence()),
  );
}

function randomPattern(key: LaneKey): void {
  const rng = createRng(Date.now() ^ hashString(key + patternToTextForEffect(key, state.sequences[key] ?? [])));
  const count = Math.max(1, slices.length);
  const settings = getRandomSettings(key);
  const out = buildRandomLanePattern(key, rng, count, settings, currentFilterSequence());
  applyRandomPatternValues(key, out);
  if (key === "filter") syncRandomFilterEnvDirAfterFilter(rng, count);
}

function toggleRandomizeAllLock(key: LaneKey): void {
  randomizeAllLocks[key] = !randomizeAllLocks[key];
  syncRandomizeAllLockButton(key);
}

function syncRandomizeAllLockButton(key: LaneKey): void {
  const button = document.querySelector<HTMLButtonElement>('[data-randomize-all-lock="' + key + '"]');
  if (!button) return;
  const locked = randomizeAllLocks[key] === true;
  button.classList.toggle("active", locked);
  button.title = locked ? "Include in Randomize All" : "Exclude from Randomize All";
  button.setAttribute("aria-label", locked ? "Include in Randomize All" : "Exclude from Randomize All");
}

function resetPattern(key: LaneKey): void {
  const values = parsePatternForEffect(key, defaultPatternText(key), Math.max(1, slices.length), Math.max(1, slices.length));
  setPatternInputValue(key, patternToTextForEffect(key, values));
  syncPattern(key);
  if (result) renderMutation("Reset " + key + " pattern.");
}

function randomizeAll(): void {
  if (!slices.length) sliceAudio();
  stopAllPlayback();
  effectDefs.forEach(function (def) {
    if (randomizeAllLocks[def.key] === true) return;
    randomPattern(def.key);
  });
  renderMutationAndAutoPlay("Randomized all pattern sequences.");
}

// ---------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------

function getSliceBeats(): number {
  return getSliceBeatsForMode(state.sliceMode);
}

function getSliceCountForCurrentMode(mode: string): number {
  return getSliceCountForMode(mode, payload.durationBeats);
}

function isSliceModeAvailableForPayload(mode: string): boolean {
  return isSliceModeAvailable(mode, payload.durationBeats);
}

function ensureValidSliceMode(): void {
  state.sliceMode = ensureValidSliceModeValue(state.sliceMode, payload.durationBeats);
}

function sliceAudio(): void {
  const expectedSlices = getSliceCountForCurrentMode(state.sliceMode);
  if (expectedSlices > MAX_SLICES) {
    slices = [];
    setStatus(formatSliceModeLabel(state.sliceMode) + " would create " + expectedSlices + " slices. Max is " + MAX_SLICES + ". Choose a longer slice length.");
    return;
  }
  updateSliceButtons();
  const sliceBeats = getSliceBeats();
  const useMusicalSliceCount = payload.timingKind === "warped-live-playback";
  const sliceSamples = useMusicalSliceCount
    ? Math.max(1, Math.round(source.left.length / Math.max(1, expectedSlices)))
    : Math.max(1, Math.round(((sliceBeats * 60) / payload.tempo) * source.sampleRate));
  slices = [];
  if (useMusicalSliceCount) {
    for (let sliceIndex = 0; sliceIndex < expectedSlices; sliceIndex++) {
      const sliceStart = Math.round((sliceIndex / expectedSlices) * source.left.length);
      const sliceEnd = Math.round(((sliceIndex + 1) / expectedSlices) * source.left.length);
      if (sliceEnd - sliceStart > 16) slices.push({ start: sliceStart, end: sliceEnd });
    }
  } else {
    for (let start = 0; start < source.left.length; start += sliceSamples) {
      const end = Math.min(source.left.length, start + sliceSamples);
      if (end - start > 16) slices.push({ start: start, end: end });
    }
  }
  debugLog("[x2k Loop Mutator] Source slice timing:", {
    warping: useMusicalSliceCount,
    timingKind: payload.timingKind,
    durationSeconds: source.left.length / source.sampleRate,
    sourceTempo: payload.tempo,
    sourceDurationBeats: payload.durationBeats,
    sliceLengthBeats: sliceBeats,
    sliceCount: slices.length,
  });
  effectDefs.forEach(function (def) {
    const input = patternInputForKey(def.key);
    const existingValidation = patternValidation[def.key];
    if (existingValidation && !existingValidation.valid) {
      const invalidText = input ? input.value || defaultPatternText(def.key) : defaultPatternText(def.key);
      const invalidValidation = validatePatternForEffect(def.key, invalidText, Math.max(1, slices.length), Math.max(1, slices.length));
      if (!invalidValidation.valid) {
        patternValidation[def.key] = invalidValidation;
        state.sequences[def.key] = invalidValidation.values;
        setPatternInputInvalid(def.key, true);
        renderPatternChips(def.key);
        return;
      }
      setPatternInputValue(def.key, invalidValidation.normalizedText);
      syncPattern(def.key);
      return;
    }
    const sourceValues = existingValidation && existingValidation.valid ? existingValidation.values : state.sequences[def.key];
    const values = resizePatternValuesForSliceCount(def.key, sourceValues ?? [], Math.max(1, slices.length), Math.max(1, slices.length));
    state.sequences[def.key] = values;
    setPatternInputValue(def.key, patternToTextForEffect(def.key, values));
    syncPattern(def.key);
  });
  byId("sliceCount").textContent = slices.length + " slices";
  drawSource();
  setStatus("Sliced source into " + slices.length + " " + formatSliceModeLabel(state.sliceMode) + " slices.");
}

function getOutputBeatsFromState(): number {
  return state.outputMode === "source" ? Math.max(1, payload.durationBeats) : Math.max(1, state.outputBars * 4);
}

// ---------------------------------------------------------------------------
// Mutation rendering
// ---------------------------------------------------------------------------

function renderMutation(message?: string): RenderResult | null {
  if (!slices.length) sliceAudio();
  if (!slices.length) { setStatus("No slices available."); return null; }
  stopAllPlayback();
  syncUiToState();
  syncAllPatterns();
  const outputSamples = Math.max(1, Math.round(((getOutputBeatsFromState() * 60) / payload.tempo) * source.sampleRate));
  const left = new Float32Array(outputSamples);
  const right = new Float32Array(outputSamples);
  let position = 0;
  let step = 0;
  resultMarkers = [];
  while (position < outputSamples && step < 20000) {
    const sourceIndex = Math.max(0, Math.min(slices.length - 1, Number(valueAt("order", step)) - 1));
    resultMarkers.push({ position: position, label: String(sourceIndex + 1) });
    const slice = slices[sourceIndex]!;
    const sliceLength = Math.max(1, slice.end - slice.start);
    const length = Math.min(sliceLength, outputSamples - position);
    const reverse = valueAt("reverse", step) === "R";
    let segL = buildSliceSegment(source.left, slice.start, slice.end, 0, length, reverse);
    let segR = buildSliceSegment(source.right, slice.start, slice.end, 0, length, reverse);
    const stutter = Number(valueAt("stutter", step));
    if (stutter > 0) {
      segL = applyStutter(segL, stutter);
      segR = applyStutter(segR, stutter);
    }

    const pitch = Number(valueAt("pitch", step));
    if (pitch !== 0) {
      const ratio = Math.pow(2, pitch / 12);
      segL = pitchShiftDurationLocked(segL, ratio);
      segR = pitchShiftDurationLocked(segR, ratio);
    }

    const tape = Number(valueAt("tape", step));
    if (tape > 0) {
      segL = applyTapeStop(segL, tape);
      segR = applyTapeStop(segR, tape);
    }

    const filter = Number(valueAt("filter", step));
    if (filter > 0) {
      const filterTypeForStep = resolveFilterTypeForStep(step);
      const filterEnvDirectionForStep = resolveFilterEnvDirectionForStep(step);
      const filterControls: FilterControlSettings = {
        cutoff: state.filterCutoff,
        resonance: state.filterResonance,
        drive: state.filterDrive,
        attack: state.filterAttack,
        decay: state.filterDecay,
      };
      segL = applyPatternFilter(segL, filter, filterTypeForStep, filterEnvDirectionForStep, filterControls, source.sampleRate);
      segR = applyPatternFilter(segR, filter, filterTypeForStep, filterEnvDirectionForStep, filterControls, source.sampleRate);
    }

    const flanger = Number(valueAt("flanger", step));
    if (flanger > 0) {
      segL = applyFlanger(segL, flanger, step, source.sampleRate);
      segR = applyFlanger(segR, flanger, step + 17, source.sampleRate);
    }

    const crush = Number(valueAt("bitcrush", step));
    if (crush > 0) {
      segL = applyBitcrushSegment(segL, crush);
      segR = applyBitcrushSegment(segR, crush);
    }

    const reverb = Number(valueAt("reverb", step));
    if (reverb > 0) {
      const reverbPatternSeed = patternToText(state.sequences.reverb ?? []);
      const reverbSettings = choosePatternReverbSettings(reverb, step, reverbPatternSeed);
      segL = applyGatedReverb(segL, reverbSettings, source.sampleRate);
      segR = applyGatedReverb(segR, offsetReverbSettings(reverbSettings, createRng(hashString("reverb-right:" + step + ":" + reverb + ":" + reverbPatternSeed))), source.sampleRate);
    }

    for (let i = 0; i < length && position < outputSamples; i++) {
      const fade = edgeFade(i, length);
      left[position] = (segL[i] ?? 0) * fade;
      right[position] = (segR[i] ?? 0) * fade;
      position++;
    }
    step++;
  }
  normalizePair(left, right);
  result = { left: left, right: right };
  resultPreviewBuffer = createPreviewBuffer(result);
  drawResult();
  byId<HTMLButtonElement>("exportCurrentButton").disabled = false;
  byId("resultMeta").textContent = (outputSamples / source.sampleRate).toFixed(2) + " seconds - pattern controlled";
  setStatus(message || "Rendered visible pattern sequences.");
  return result;
}

function renderMutationAndAutoPlay(message?: string): RenderResult | null {
  const audio = renderMutation(message);
  if (!audio && !result) return audio;

  // Let renderMutation finish updating result/resultPreviewBuffer/UI first.
  setTimeout(function () {
    playResult();
  }, 0);

  return audio;
}

function valueAt(key: LaneKey, step: number): PatternValue {
  const p = safePatternValues(key) || state.sequences[key] || [0];
  return p[step % p.length] ?? 0;
}

function resolveFilterTypeForStep(step: number): FilterType {
  const lane = state.sequences && state.sequences.filterTypeLane;
  const laneValue = lane && lane.length ? lane[step % lane.length] : null;
  const forcedType = normalizeFilterTypeLaneValue(laneValue);
  if (forcedType) return forcedType as FilterType;
  return validFilterType(state.filterType) ? state.filterType : "LP";
}

function resolveFilterEnvDirectionForStep(step: number): EnvDirection {
  const lane = state.sequences && state.sequences.filterEnvDirLane;
  const laneValue = lane && lane.length ? lane[step % lane.length] : null;
  const forcedDirection = normalizeFilterEnvDirLaneValue(laneValue);
  if (forcedDirection) return forcedDirection as EnvDirection;
  return validFilterEnvDirection(state.filterEnvDirection) ? state.filterEnvDirection : "UP";
}

// ---------------------------------------------------------------------------
// Waveform drawing
// ---------------------------------------------------------------------------

function drawWave(canvas: HTMLCanvasElement, left: Float32Array, right: Float32Array, markers: Array<ResultMarker | number>): void {
  const palette = CANVAS_PALETTES[currentTheme];
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scale));
  canvas.height = Math.max(1, Math.floor(rect.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, rect.width, rect.height);

  const mid = rect.height / 2;
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let guide = 1; guide < 8; guide++) {
    const guideX = (guide / 8) * rect.width;
    ctx.moveTo(guideX, 0);
    ctx.lineTo(guideX, rect.height);
  }
  for (let level = 1; level < 4; level++) {
    const guideY = (level / 4) * rect.height;
    ctx.moveTo(0, guideY);
    ctx.lineTo(rect.width, guideY);
  }
  ctx.stroke();

  ctx.strokeStyle = palette.mid;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(rect.width, mid);
  ctx.stroke();

  ctx.strokeStyle = palette.wave;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < rect.width; x++) {
    const start = Math.floor((x / rect.width) * left.length);
    const end = Math.max(start + 1, Math.floor(((x + 1) / rect.width) * left.length));
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i++) {
      const v = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(x, mid + min * mid * 0.88);
    ctx.lineTo(x, mid + max * mid * 0.88);
  }
  ctx.stroke();

  if (markers && markers.length) {
    const markerColor = palette.marker;
    ctx.font = "9px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    markers.forEach(function (marker) {
      const markerPosition = typeof marker === "number" ? marker : marker.position;
      const label = typeof marker === "number" ? null : marker.label;
      const mx = (markerPosition / Math.max(1, left.length)) * rect.width;
      ctx.strokeStyle = markerColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, rect.height);
      ctx.stroke();
      if (label !== null && label !== undefined) {
        const text = String(label);
        const boxWidth = Math.max(12, ctx.measureText(text).width + 6);
        const boxHeight = 11;
        const boxX = Math.max(0, Math.min(rect.width - boxWidth, mx));
        ctx.fillStyle = markerColor;
        ctx.fillRect(boxX, 0, boxWidth, boxHeight);
        ctx.fillStyle = palette.markerText;
        ctx.fillText(text, boxX + boxWidth / 2, boxHeight / 2 + 0.5);
      }
    });
  }
}

function drawSource(): void {
  drawWave(byId<HTMLCanvasElement>("sourceCanvas"), source.left, source.right, slices.map(function (s, i) {
    return { position: s.start, label: String(i + 1) };
  }));
}

function drawResult(): void {
  const emptyState = document.getElementById("resultEmptyState");
  if (emptyState) emptyState.style.display = result ? "none" : "flex";
  if (!result) drawWave(byId<HTMLCanvasElement>("resultCanvas"), new Float32Array(1), new Float32Array(1), []);
  else drawWave(byId<HTMLCanvasElement>("resultCanvas"), result.left, result.right, resultMarkers);
}

// ---------------------------------------------------------------------------
// Playback preview
// ---------------------------------------------------------------------------

function getAudioContext(): AudioContext {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext!)({ sampleRate: source.sampleRate });
  return audioContext;
}

function createPreviewBuffer(audioResult: RenderResult): AudioBuffer {
  const ctx = getAudioContext();
  const buffer = ctx.createBuffer(2, audioResult.left.length, source.sampleRate);
  const leftData = audioResult.left as unknown as Float32Array<ArrayBuffer>;
  const rightData = audioResult.right as unknown as Float32Array<ArrayBuffer>;
  buffer.copyToChannel(leftData, 0);
  buffer.copyToChannel(rightData, 1);
  return buffer;
}

function playResult(): void {
  if (!result) renderMutation();
  if (!result) return;
  resultPreviewBuffer = resultPreviewBuffer || createPreviewBuffer(result);
  startPreview("result", resultPreviewBuffer);
  setStatus("Mutated result preview playing.");
}

function playSource(): void {
  sourcePreviewBuffer = sourcePreviewBuffer || createPreviewBuffer(source as unknown as RenderResult);
  startPreview("source", sourcePreviewBuffer);
  setStatus("Source preview playing.");
}

function startPreview(kind: "source" | "result", buffer: AudioBuffer): void {
  stopAllPlayback();
  const ctx = getAudioContext();
  activePreviewSource = ctx.createBufferSource();
  activePreviewKind = kind;
  activePreviewSource.buffer = buffer;
  activePreviewSource.loop = true;
  activePreviewSource.connect(ctx.destination);
  activePreviewSource.start();
  playStartTime = ctx.currentTime;
  getActivePlayheadElement().style.display = "block";
  animatePlayhead();
}

function stopAllPlayback(): void {
  if (activePreviewSource) {
    try { activePreviewSource.stop(); } catch (error) {}
    activePreviewSource.disconnect();
    activePreviewSource = null;
  }
  activePreviewKind = null;
  cancelAnimationFrame(animationFrame);
  resetPlayhead("sourcePlayhead");
  resetPlayhead("resultPlayhead");
}

function animatePlayhead(): void {
  const buffer = activePreviewKind === "source" ? sourcePreviewBuffer : resultPreviewBuffer;
  if (!activePreviewSource || !buffer || !audioContext) return;
  const x = (((audioContext.currentTime - playStartTime) % buffer.duration) / buffer.duration) * 100;
  getActivePlayheadElement().style.left = x + "%";
  animationFrame = requestAnimationFrame(animatePlayhead);
}

function getActivePlayheadElement(): HTMLElement {
  return byId(activePreviewKind === "source" ? "sourcePlayhead" : "resultPlayhead");
}

function resetPlayhead(id: string): void {
  const el = byId(id);
  el.style.display = "none";
  el.style.left = "0%";
}

// ---------------------------------------------------------------------------
// Settings collection and application
// ---------------------------------------------------------------------------

function syncUiToState(): void {
  state.filterCutoff = Math.round(clampToRange(parseFloat((byId("filterCutoff") as HTMLInputElement).value), 80, 6000));
  state.filterResonance = clamp01(parseFloat((byId("filterResonance") as HTMLInputElement).value));
  state.filterDrive = clamp01(parseFloat((byId("filterDrive") as HTMLInputElement).value));
  state.filterAttack = clamp01(parseFloat((byId("filterAttack") as HTMLInputElement).value));
  state.filterDecay = clamp01(parseFloat((byId("filterDecay") as HTMLInputElement).value));
  ensureRandomSettings();
  effectDefs.forEach(function (def) { getRandomSettings(def.key); });
  updateFilterValues();
}

function collectSettings(): PatternSettings {
  syncUiToState();
  syncAllPatterns();
  return JSON.parse(JSON.stringify(state)) as PatternSettings;
}

function applySettings(settings: unknown): void {
  const previousSliceMode = state.sliceMode;
  const incoming = JSON.parse(JSON.stringify(settings ?? {})) as Partial<PatternSettings>;
  const filterSettings = normalizeFilterSettings(incoming);
  state = {
    sliceMode: String(incoming.sliceMode ?? ""),
    outputMode: incoming.outputMode === "bars" ? "bars" : String(incoming.outputMode ?? ""),
    outputBars: Number(incoming.outputBars),
    sequences: (incoming.sequences ?? {}) as Record<string, PatternValue[]>,
    randomSettings: (incoming.randomSettings ?? {}) as Record<string, RandomSettings>,
  } as typeof state;
  ensureRandomSettings();
  if ((state.sliceMode as string) === "sixteenth") state.sliceMode = "eighth";
  if (!state.outputMode) state.outputMode = "bars";
  ensureValidSliceMode();
  applyFilterSettings(filterSettings);
  updateSliceButtons();
  updateOutputButtons();
  updateFilterButtons();
  updateFilterEnvDirectionButtons();
  updateFilterInputs();
  updateRandomSettingsInputs();
  if (state.sliceMode !== previousSliceMode) sliceAudio();
  effectDefs.forEach(function (def) {
    setPatternInputValue(def.key, patternToTextForEffect(def.key, parsePatternForEffect(
      def.key,
      patternToTextForEffect(def.key, state.sequences[def.key] ?? []),
      Math.max(1, slices.length),
      Math.max(1, slices.length),
    )));
    syncPattern(def.key);
  });
}

function normalizeFilterSettings(settings: Partial<PatternSettings>): {
  filterType: FilterType;
  filterCutoff: number;
  filterResonance: number;
  filterDrive: number;
  filterAttack: number;
  filterDecay: number;
  filterEnvDirection: EnvDirection;
} {
  return {
    filterType: validFilterType(settings.filterType) ? settings.filterType : "LP",
    filterCutoff: Number.isFinite(Number(settings.filterCutoff)) ? clampToRange(Math.round(Number(settings.filterCutoff)), 80, 6000) : 500,
    filterResonance: clamp01(Number(settings.filterResonance == null ? 0.35 : settings.filterResonance)),
    filterDrive: clamp01(Number(settings.filterDrive == null ? 0 : settings.filterDrive)),
    filterAttack: clamp01(Number(settings.filterAttack == null ? 0 : settings.filterAttack)),
    filterDecay: clamp01(Number(settings.filterDecay == null ? 0.45 : settings.filterDecay)),
    filterEnvDirection: settings.filterEnvDirection === "DOWN" ? "DOWN" : "UP",
  };
}

function applyFilterSettings(settings: ReturnType<typeof normalizeFilterSettings>): void {
  state.filterType = settings.filterType;
  state.filterCutoff = settings.filterCutoff;
  state.filterResonance = settings.filterResonance;
  state.filterDrive = settings.filterDrive;
  state.filterAttack = settings.filterAttack;
  state.filterDecay = settings.filterDecay;
  state.filterEnvDirection = settings.filterEnvDirection;
}

function setFilterType(type: string, shouldRender: boolean): void {
  state.filterType = validFilterType(type) ? type : "LP";
  updateFilterButtons();
  if (shouldRender && result) renderMutation("Selected " + state.filterType + " filter.");
}

function setFilterEnvDirection(direction: string, shouldRender: boolean): void {
  state.filterEnvDirection = direction === "DOWN" ? "DOWN" : "UP";
  updateFilterEnvDirectionButtons();
  if (shouldRender && result) renderMutation("Selected " + state.filterEnvDirection.toLowerCase() + " filter envelope.");
}

// ---------------------------------------------------------------------------
// Control UI updates
// ---------------------------------------------------------------------------

function updateSliceButtons(): void {
  ensureValidSliceMode();
  document.querySelectorAll("[data-slice]").forEach(function (element) {
    const button = element as HTMLButtonElement;
    const mode = button.getAttribute("data-slice")!;
    const count = getSliceCountForCurrentMode(mode);
    const available = count <= MAX_SLICES;
    button.disabled = !available;
    button.classList.toggle("active", available && mode === state.sliceMode);
    button.title = available
      ? formatSliceModeLabel(mode) + " slice length."
      : formatSliceModeLabel(mode) + " would create " + count + " slices. Max is " + MAX_SLICES + ".";
  });
}

function updateOutputButtons(): void {
  document.querySelectorAll("[data-output-mode],[data-output-bars]").forEach(function (button) {
    const isSource = button.getAttribute("data-output-mode") === "source";
    const bars = parseInt(button.getAttribute("data-output-bars") ?? "0", 10);
    button.classList.toggle("active", isSource ? state.outputMode === "source" : state.outputMode === "bars" && state.outputBars === bars);
  });
}

function updateFilterButtons(): void {
  document.querySelectorAll("[data-filter]").forEach(function (button) {
    button.classList.toggle("active", button.getAttribute("data-filter") === state.filterType);
  });
}

function updateFilterEnvDirectionButtons(): void {
  document.querySelectorAll("[data-filter-env-direction]").forEach(function (button) {
    button.classList.toggle("active", button.getAttribute("data-filter-env-direction") === state.filterEnvDirection);
  });
}

function updateFilterInputs(): void {
  (byId("filterCutoff") as HTMLInputElement).value = String(state.filterCutoff);
  (byId("filterResonance") as HTMLInputElement).value = String(state.filterResonance);
  (byId("filterDrive") as HTMLInputElement).value = String(state.filterDrive);
  (byId("filterAttack") as HTMLInputElement).value = String(state.filterAttack);
  (byId("filterDecay") as HTMLInputElement).value = String(state.filterDecay);
  updateFilterValues();
}

function updateFilterValues(): void {
  byId("filterCutoffValue").textContent = formatCutoff(state.filterCutoff);
  byId("filterResonanceValue").textContent = state.filterResonance.toFixed(2);
  byId("filterDriveValue").textContent = state.filterDrive.toFixed(2);
  byId("filterAttackValue").textContent = state.filterAttack.toFixed(2);
  byId("filterDecayValue").textContent = state.filterDecay.toFixed(2);
}

function formatCutoff(value: number): string {
  return value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 0 : 1) + "kHz" : Math.round(value) + "Hz";
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findPresetById(id: string | null): PatternPreset | null {
  return presets.find(function (preset) { return preset.id === id; }) ?? null;
}

function selectedPreset(): PatternPreset | null {
  return findPresetById(selectedPresetId);
}

function currentUserPresets(): PatternPreset[] {
  return presets.filter(function (preset) { return preset.kind === "user"; });
}

function updatePresetActionButtons(): void {
  const selected = selectedPreset();
  byId<HTMLButtonElement>("presetDeleteButton").disabled = !selected || selected.kind !== "user";
  byId<HTMLButtonElement>("presetExportButton").disabled = !presets.some(function (preset) { return preset.kind === "user"; });
}

function renderPresetOptions(): void {
  const select = byId<HTMLSelectElement>("presetSelect");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select preset…";
  select.appendChild(placeholder);
  (["factory", "user"] as const).forEach(function (kind) {
    const matching = presets.filter(function (preset) { return preset.kind === kind; });
    if (!matching.length) return;
    const group = document.createElement("optgroup");
    group.label = kind === "factory" ? "Factory Presets" : "User Presets";
    matching.forEach(function (preset) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.name;
      group.appendChild(option);
    });
    select.appendChild(group);
  });
  if (!findPresetById(selectedPresetId)) selectedPresetId = null;
  select.value = selectedPresetId ?? "";
  select.disabled = presets.length === 0;
  byId<HTMLButtonElement>("presetPreviousButton").disabled = presets.length < 2;
  byId<HTMLButtonElement>("presetNextButton").disabled = presets.length < 2;
  updatePresetActionButtons();
}

function applySelectedPreset(id: string): void {
  const preset = findPresetById(id);
  if (!preset) return;
  stopAllPlayback();
  selectedPresetId = preset.id;
  byId<HTMLSelectElement>("presetSelect").value = preset.id;
  applySettings(preset.settings);
  renderMutationAndAutoPlay("Applied preset “" + preset.name + "”.");
  updatePresetActionButtons();
}

function cyclePreset(delta: number): void {
  if (!presets.length) return;
  const currentIndex = presets.findIndex(function (preset) { return preset.id === selectedPresetId; });
  if (currentIndex < 0) {
    applySelectedPreset(presets[delta < 0 ? presets.length - 1 : 0]!.id);
    return;
  }
  const next = (currentIndex + delta + presets.length) % presets.length;
  applySelectedPreset(presets[next]!.id);
}

function collectEditorSession(): CollectedEditorSession {
  return {
    settings: collectSettings(),
    snapshots: cloneJson(snapshots),
    selectedSnapshotIndex: selectedSnapshotIndex,
    queuedSnapshots: queuedSnapshots.slice(),
    randomizeAllLocks: cloneJson(randomizeAllLocks),
    selectedPresetId: selectedPresetId,
    hadResult: !!result,
  };
}

function serializeCurrentUserPresets(): string {
  return JSON.stringify({
    version: 1,
    presets: currentUserPresets().map(function (preset) { return { name: preset.name, settings: preset.settings }; }),
  }, null, 2) + "\n";
}

function hostAuthHeaders(withJsonContentType: boolean): Record<string, string> {
  const api = presetBootstrap.persistenceApi;
  if (!api) return withJsonContentType ? { "Content-Type": "application/json" } : {};
  return {
    ...(withJsonContentType ? { "Content-Type": "application/json" } : {}),
    [api.authHeaderName]: api.authToken,
  };
}

function persistUserPresets(statusMessage: string): void {
  const api = presetBootstrap.persistenceApi;
  const url = api?.presetsUrl;
  const json = serializeCurrentUserPresets();
  if (!url || typeof fetch !== "function") {
    setStatus(statusMessage + " It will be persisted when the editor closes.");
    return;
  }
  setStatus(statusMessage + " Saving…");
  presetPersistenceQueue = presetPersistenceQueue.catch(function () {}).then(async function () {
    const response = await fetch(url, {
      method: "POST",
      headers: hostAuthHeaders(true),
      body: json,
      cache: "no-store",
    });
    let reply: { ok?: boolean; message?: string } | null = null;
    try { reply = await response.json(); } catch (error) {}
    if (!response.ok || !reply || reply.ok !== true) throw new Error(reply && reply.message ? reply.message : "Host rejected preset data.");
    setStatus(statusMessage);
  }).catch(function (error) {
    debugLog("Immediate preset persistence failed.", error);
    setStatus(statusMessage + " Could not save to disk; it will retry when the editor closes.");
  });
}

function uniqueUserPresetName(requested: string): string {
  const base = String(requested ?? "").trim().slice(0, 40) || "Imported Preset";
  const names = currentUserPresets().map(function (preset) { return preset.name.toLowerCase(); });
  if (names.indexOf(base.toLowerCase()) < 0) return base;
  for (let suffix = 2; suffix < 10000; suffix++) {
    const suffixText = " " + suffix;
    const candidate = base.slice(0, 40 - suffixText.length).trimEnd() + suffixText;
    if (names.indexOf(candidate.toLowerCase()) < 0) return candidate;
  }
  return base.slice(0, 31) + " " + String(Date.now()).slice(-8);
}

function makeLocalUserPreset(name: string, settings: unknown): PatternPreset {
  return {
    id: "user:local:" + Date.now() + ":" + Math.floor(Math.random() * 1000000),
    name: name,
    kind: "user",
    settings: cloneJson(settings) as PatternSettings,
  };
}

function saveCurrentAsPreset(): void {
  if (currentUserPresets().length >= MAX_USER_PRESETS) {
    setStatus("User preset limit reached (" + MAX_USER_PRESETS + ").");
    return;
  }
  presetDialogMode = "save";
  byId("presetDialogTitle").textContent = "Save User Preset";
  byId("presetDialogLabel").hidden = false;
  byId<HTMLInputElement>("presetNameInput").hidden = false;
  byId("presetDialogMessage").hidden = true;
  byId<HTMLButtonElement>("presetDialogConfirmButton").textContent = "Save";
  byId("presetDialog").hidden = false;
  const input = byId<HTMLInputElement>("presetNameInput");
  input.value = "New Preset";
  setTimeout(function () { input.focus(); input.select(); }, 0);
}

function closePresetDialog(): void {
  const dialog = byId("presetDialog");
  dialog.hidden = true;
  dialog.classList.remove("dragging");
  byId<HTMLButtonElement>("presetDialogSecondaryButton").hidden = true;
  byId<HTMLButtonElement>("presetDialogCancelButton").hidden = false;
  byId<HTMLButtonElement>("presetDialogCancelButton").textContent = "Cancel";
  byId<HTMLInputElement>("presetNameInput").readOnly = false;
  byId("presetDialogLabel").textContent = "Preset name";
  const importInput = byId<HTMLTextAreaElement>("presetImportJsonInput");
  importInput.hidden = true;
  importInput.value = "";
  exportedPresetPath = null;
  presetDialogMode = null;
  byId<HTMLButtonElement>("presetSaveButton").focus();
}

function confirmPresetDialog(): void {
  if (presetDialogMode === "export") { revealPresetExport(); return; }
  if (presetDialogMode === "import") {
    const json = String(byId<HTMLTextAreaElement>("presetImportJsonInput").value ?? "").trim();
    if (!json) { setStatus("Paste preset JSON or drop a JSON file into the import window."); return; }
    closePresetDialog();
    importPresetJson(json);
    return;
  }
  if (presetDialogMode === "delete") {
    const preset = selectedPreset();
    if (!preset || preset.kind !== "user") { closePresetDialog(); setStatus("Factory presets are read-only."); return; }
    presets = presets.filter(function (item) { return item.id !== preset.id; });
    selectedPresetId = null;
    closePresetDialog();
    renderPresetOptions();
    persistUserPresets("Deleted user preset “" + preset.name + "”.");
    return;
  }
  if (presetDialogMode !== "save") return;
  const name = String(byId<HTMLInputElement>("presetNameInput").value ?? "").trim().slice(0, 40);
  if (!name) { setStatus("Preset name cannot be empty."); byId<HTMLInputElement>("presetNameInput").focus(); return; }
  const uniqueName = uniqueUserPresetName(name);
  const savedPreset = makeLocalUserPreset(uniqueName, collectSettings());
  presets.push(savedPreset);
  selectedPresetId = savedPreset.id;
  closePresetDialog();
  renderPresetOptions();
  byId<HTMLSelectElement>("presetSelect").value = savedPreset.id;
  persistUserPresets("Saved user preset “" + uniqueName + "”.");
}

function deleteSelectedPreset(): void {
  const preset = selectedPreset();
  if (!preset || preset.kind !== "user") { setStatus("Factory presets are read-only."); return; }
  presetDialogMode = "delete";
  byId("presetDialogTitle").textContent = "Delete User Preset";
  byId("presetDialogLabel").hidden = true;
  byId<HTMLInputElement>("presetNameInput").hidden = true;
  const message = byId("presetDialogMessage");
  message.textContent = "Delete “" + preset.name + "”?";
  message.hidden = false;
  byId<HTMLButtonElement>("presetDialogConfirmButton").textContent = "Delete";
  byId("presetDialog").hidden = false;
  setTimeout(function () { byId<HTMLButtonElement>("presetDialogConfirmButton").focus(); }, 0);
}

function openPresetImportDialog(): void {
  presetDialogMode = "import";
  byId("presetDialogTitle").textContent = "Import User Presets";
  byId("presetDialogLabel").hidden = true;
  byId<HTMLInputElement>("presetNameInput").hidden = true;
  const message = byId("presetDialogMessage");
  message.textContent = "Drop a preset JSON file here to import it, or paste JSON below.";
  message.hidden = false;
  const importInput = byId<HTMLTextAreaElement>("presetImportJsonInput");
  importInput.hidden = false;
  importInput.value = "";
  byId<HTMLButtonElement>("presetDialogSecondaryButton").hidden = true;
  byId<HTMLButtonElement>("presetDialogCancelButton").textContent = "Cancel";
  byId<HTMLButtonElement>("presetDialogCancelButton").hidden = false;
  byId<HTMLButtonElement>("presetDialogConfirmButton").textContent = "Import";
  byId("presetDialog").hidden = false;
  setTimeout(function () { importInput.focus(); }, 0);
}

// ---------------------------------------------------------------------------
// Preset import validation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validImportedLaneValue(key: string, value: unknown): boolean {
  return isValidLaneValue(key, value as PatternValue);
}

function importedSettingsError(settings: unknown): string {
  if (!isPlainObject(settings)) return "settings must be an object";
  const allowedSettings = ["sliceMode", "outputMode", "outputBars", "filterType", "filterCutoff", "filterResonance", "filterDrive", "filterAttack", "filterDecay", "filterEnvDirection", "sequences", "randomSettings"];
  const unknownSetting = Object.keys(settings).find(function (key) { return allowedSettings.indexOf(key) < 0; });
  if (unknownSetting) return "unknown settings field " + unknownSetting;
  if (["half", "quarter", "eighth"].indexOf(settings.sliceMode as string) < 0) return "invalid slice mode";
  if (settings.outputMode !== "source" && settings.outputMode !== "bars") return "invalid output mode";
  if ([1, 2, 4, 8].indexOf(settings.outputBars as number) < 0) return "invalid output bars";
  if (!validFilterType(settings.filterType)) return "invalid filter type";
  if (!Number.isFinite(settings.filterCutoff) || (settings.filterCutoff as number) < 80 || (settings.filterCutoff as number) > 6000) return "invalid filter cutoff";
  const unitFields = ["filterResonance", "filterDrive", "filterAttack", "filterDecay"];
  if (unitFields.some(function (key) {
    const unitValue = settings[key];
    return !Number.isFinite(unitValue) || (unitValue as number) < 0 || (unitValue as number) > 1;
  })) return "invalid filter control";
  if (settings.filterEnvDirection !== "UP" && settings.filterEnvDirection !== "DOWN") return "invalid filter envelope direction";
  if (!isPlainObject(settings.sequences)) return "sequences must be an object";
  const laneKeys = effectDefs.map(function (def) { return def.key; });
  const sequences = settings.sequences as Record<string, unknown>;
  const unknownLane = Object.keys(sequences).find(function (key) { return laneKeys.indexOf(key as LaneKey) < 0; });
  if (unknownLane) return "unknown sequence " + unknownLane;
  for (let laneIndex = 0; laneIndex < laneKeys.length; laneIndex++) {
    const laneKey = laneKeys[laneIndex]!;
    const sequence = sequences[laneKey];
    if (!Array.isArray(sequence) || sequence.length > 16) return "invalid sequence " + laneKey;
    if (sequence.some(function (value) { return !validImportedLaneValue(laneKey, value); })) return "invalid value in sequence " + laneKey;
  }
  if (settings.randomSettings !== undefined) {
    if (!isPlainObject(settings.randomSettings)) return "random settings must be an object";
    const randomSettings = settings.randomSettings as Record<string, unknown>;
    const unknownRandomLane = Object.keys(randomSettings).find(function (key) { return laneKeys.indexOf(key as LaneKey) < 0; });
    if (unknownRandomLane) return "unknown random settings " + unknownRandomLane;
    for (const randomKey in randomSettings) {
      const random = randomSettings[randomKey];
      if (!isPlainObject(random) || Object.keys(random).some(function (key) { return key !== "min" && key !== "max" && key !== "freq"; })) return "invalid random settings " + randomKey;
      if (![random.min, random.max, random.freq].every(function (value) { return Number.isFinite(value) && Number.isInteger(value); })) return "invalid random settings " + randomKey;
      if ((random.min as number) > (random.max as number) || (random.freq as number) < 0 || (random.freq as number) > 16) return "invalid random settings " + randomKey;
      const bounds = laneRandomBounds(randomKey);
      if ((random.min as number) < bounds[0] || (random.max as number) > bounds[1]) return "random settings out of bounds " + randomKey;
    }
  }
  return "";
}

function importPresetJson(json: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (error) {
    setStatus("Invalid preset JSON.");
    return;
  }
  if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.presets)) {
    setStatus("Invalid preset file: expected version 1 with a presets array.");
    return;
  }
  let imported = 0;
  const invalidMessages: string[] = [];
  let limited = 0;
  parsed.presets.forEach(function (entry, index) {
    if (!isPlainObject(entry) || typeof entry.name !== "string") { invalidMessages.push("Preset " + (index + 1) + " has no valid name."); return; }
    const trimmedName = entry.name.trim();
    if (!trimmedName || trimmedName.length > 40) { invalidMessages.push("Preset " + (index + 1) + " has an invalid name."); return; }
    const settingsError = importedSettingsError(entry.settings);
    if (settingsError) { invalidMessages.push("Preset " + (index + 1) + ": " + settingsError + "."); return; }
    if (currentUserPresets().length >= MAX_USER_PRESETS) { limited++; return; }
    presets.push(makeLocalUserPreset(uniqueUserPresetName(trimmedName), entry.settings));
    imported++;
  });
  renderPresetOptions();
  let message = "Imported " + imported + " user preset" + (imported === 1 ? "." : "s.");
  if (invalidMessages.length) message += " Ignored " + invalidMessages.length + " invalid " + (invalidMessages.length === 1 ? "entry: " : "entries: ") + invalidMessages.slice(0, 2).join(" ");
  if (limited) message += ` Skipped ${limited} because the ${MAX_USER_PRESETS}-preset limit was reached.`;
  if (imported) persistUserPresets(message);
  else setStatus(message);
}

function stagePresetImportFile(file: File): void {
  if (!file) return;
  if (file.size > 2000000) {
    byId("presetDialogMessage").textContent = "That preset file is too large. Maximum size is 2 MB.";
    return;
  }
  const reader = new FileReader();
  reader.onerror = function () { byId("presetDialogMessage").textContent = "Could not read that preset JSON file."; };
  reader.onload = function () {
    if (typeof reader.result !== "string") { byId("presetDialogMessage").textContent = "Could not read that preset JSON file."; return; }
    byId<HTMLTextAreaElement>("presetImportJsonInput").value = reader.result;
    byId("presetDialogMessage").textContent = "Loaded “" + (file.name || "preset JSON") + "”. Review it below, then click Import.";
    byId<HTMLButtonElement>("presetDialogConfirmButton").focus();
  };
  reader.readAsText(file);
}

function exportUserPresets(): void {
  const api = presetBootstrap.persistenceApi;
  const url = api?.exportUrl;
  if (!url || typeof fetch !== "function") {
    setStatus("Preset export is unavailable because host storage is not connected.");
    return;
  }
  setStatus("Exporting user presets…");
  fetch(url, {
    method: "POST",
    headers: hostAuthHeaders(true),
    body: serializeCurrentUserPresets(),
    cache: "no-store",
  }).then(async function (response) {
    let reply: { ok?: boolean; path?: string; message?: string } | null = null;
    try { reply = await response.json(); } catch (error) {}
    if (!response.ok || !reply || reply.ok !== true || typeof reply.path !== "string") throw new Error(reply && reply.message ? reply.message : "Host could not export presets.");
    showPresetExportLocation(reply.path);
  }).catch(function (error) {
    debugLog("Preset export failed.", error);
    setStatus("Preset export failed: " + (error && error.message ? error.message : "unknown error"));
  });
}

function showPresetExportLocation(filePath: string): void {
  presetDialogMode = "export";
  exportedPresetPath = filePath;
  byId("presetDialogTitle").textContent = "User Presets Exported";
  const label = byId("presetDialogLabel");
  label.textContent = "File location";
  label.hidden = false;
  const input = byId<HTMLInputElement>("presetNameInput");
  input.hidden = false;
  input.readOnly = true;
  input.value = filePath;
  byId("presetDialogMessage").hidden = true;
  const secondary = byId<HTMLButtonElement>("presetDialogSecondaryButton");
  secondary.textContent = "Copy Path";
  secondary.hidden = false;
  byId<HTMLButtonElement>("presetDialogCancelButton").textContent = "Close";
  byId<HTMLButtonElement>("presetDialogCancelButton").hidden = false;
  byId<HTMLButtonElement>("presetDialogConfirmButton").textContent = "Open Folder";
  byId("presetDialog").hidden = false;
  setStatus("Exported user presets to " + filePath);
  setTimeout(function () { input.focus(); input.select(); }, 0);
}

async function copyPresetExportPath(): Promise<void> {
  if (!exportedPresetPath) return;
  const input = byId<HTMLInputElement>("presetNameInput");
  input.focus();
  input.select();
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(exportedPresetPath);
      copied = true;
    }
  } catch (error) {}
  if (!copied) {
    try { copied = document.execCommand("copy"); } catch (error) {}
  }
  setStatus(copied ? "Copied preset export path." : "Path selected. Press Ctrl+C or Cmd+C to copy it.");
}

function revealPresetExport(): void {
  const api = presetBootstrap.persistenceApi;
  const url = api?.revealUrl;
  if (!url || typeof fetch !== "function") {
    setStatus("Opening the export folder is unavailable in this host.");
    return;
  }
  setStatus("Opening preset export folder…");
  fetch(url, { method: "POST", headers: hostAuthHeaders(false), cache: "no-store" }).then(async function (response) {
    let reply: { ok?: boolean; message?: string } | null = null;
    try { reply = await response.json(); } catch (error) {}
    if (!response.ok || !reply || reply.ok !== true) throw new Error(reply && reply.message ? reply.message : "Host could not open the folder.");
    setStatus("Opened preset export folder.");
  }).catch(function (error) {
    debugLog("Could not reveal preset export.", error);
    setStatus("Could not open the export folder: " + (error && error.message ? error.message : "unknown error"));
  });
}

// ---------------------------------------------------------------------------
// Session restore, bridge, exports, snapshots
// ---------------------------------------------------------------------------

function restoreEditorSession(): boolean {
  const session = presetBootstrap.session;
  if (!session) return false;
  applySettings(session.settings);
  snapshots = cloneJson(session.snapshots);
  selectedSnapshotIndex = session.selectedSnapshotIndex;
  queuedSnapshots = session.queuedSnapshots.slice();
  randomizeAllLocks = cloneJson(session.randomizeAllLocks);
  selectedPresetId = session.selectedPresetId;
  effectDefs.forEach(function (def) { syncRandomizeAllLockButton(def.key); });
  return !!session.hadResult;
}

function makeRender(label: string, audio: RenderResult): { label: string; sampleRate: number; leftBase64: string; rightBase64: string; settings: PatternSettings } {
  const settings = collectSettings();
  return {
    label: label,
    sampleRate: source.sampleRate,
    leftBase64: encodeInt16Base64(audio.left),
    rightBase64: encodeInt16Base64(audio.right),
    settings: settings,
  };
}

function closeWithResult(resultText: string): void {
  const message = { method: "close_and_send", params: [resultText] };
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live) {
    window.webkit.messageHandlers.live.postMessage(message);
    return;
  }
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.postMessage(message);
    return;
  }
  alert("Ableton dialog bridge not found.");
}

function exportCurrent(): void {
  if (!result) renderMutation();
  if (!result) return;
  stopAllPlayback();
  closeWithResult(JSON.stringify({
    action: "export",
    mode: "current",
    renders: [makeRender("Current", result)],
    userPresetsJson: serializeCurrentUserPresets(),
  }));
}

function exportQueuedSnapshots(): void {
  if (!queuedSnapshots.length) return;
  stopAllPlayback();
  const original = collectSettings();
  const renders: Array<ReturnType<typeof makeRender>> = [];
  queuedSnapshots.forEach(function (slotIndex) {
    const snap = snapshots[slotIndex];
    if (!snap) return;
    applySettings(snap.settings);
    const audio = renderMutation("Rendered " + snap.label + " for export queue.");
    if (audio) renders.push(makeRender(snap.label, audio));
  });
  applySettings(original);
  if (renders.length) {
    closeWithResult(JSON.stringify({
      action: "export",
      mode: "queue",
      renders: renders,
      userPresetsJson: serializeCurrentUserPresets(),
    }));
  } else {
    // Nothing was exportable and the dialog stays open: re-render so the
    // waveform reflects the restored original settings instead of whichever
    // queued snapshot was rendered last.
    renderMutation("No queued snapshots could be rendered.");
  }
}

function renderSnapshots(): void {
  const root = byId("snapshotSlots");
  root.innerHTML = "";

  for (let i = 0; i < SNAPSHOT_SLOTS; i++) {
    (function (index: number) {
      const snap = snapshots[index];
      const slot = document.createElement("button");
      slot.className = "button snapshot-slot" +
        (index === selectedSnapshotIndex ? " active" : "") +
        (snap ? "" : " empty") +
        (queuedSnapshots.indexOf(index) >= 0 ? " queued" : "");
      slot.textContent = String(index + 1);
      slot.title = snap ? snap.label : "Empty Snapshot " + (index + 1);
      slot.onclick = function () {
        selectedSnapshotIndex = index;
        renderSnapshots();
        setStatus("Selected Snapshot " + (index + 1) + ".");
      };
      root.appendChild(slot);
    })(i);
  }

  const selectedSnapshot = snapshots[selectedSnapshotIndex];
  const saveButton = byId<HTMLButtonElement>("snapshotSaveButton");
  const loadButton = byId<HTMLButtonElement>("snapshotLoadButton");
  const queueButton = byId<HTMLButtonElement>("snapshotQueueButton");
  const isQueued = queuedSnapshots.indexOf(selectedSnapshotIndex) >= 0;

  saveButton.onclick = function () {
    snapshots[selectedSnapshotIndex] = {
      label: "Snapshot " + (selectedSnapshotIndex + 1),
      settings: collectSettings(),
    };
    renderSnapshots();
    setStatus("Saved Snapshot " + (selectedSnapshotIndex + 1) + ".");
  };

  loadButton.disabled = !selectedSnapshot;
  loadButton.onclick = function () {
    const snap = snapshots[selectedSnapshotIndex];
    if (!snap) return;
    stopAllPlayback();
    applySettings(snap.settings);
    renderMutation("Loaded " + snap.label + ".");
  };

  queueButton.disabled = !selectedSnapshot;
  queueButton.classList.toggle("active", isQueued);
  queueButton.onclick = function () {
    if (!snapshots[selectedSnapshotIndex]) return;
    const at = queuedSnapshots.indexOf(selectedSnapshotIndex);
    if (at >= 0) queuedSnapshots.splice(at, 1);
    else queuedSnapshots.push(selectedSnapshotIndex);
    byId<HTMLButtonElement>("exportQueueButton").disabled = queuedSnapshots.length === 0;
    renderSnapshots();
  };

  byId<HTMLButtonElement>("exportQueueButton").disabled = queuedSnapshots.length === 0;
}

function setStatus(text: string): void {
  currentStatus = text;
  byId("status").textContent = text;
}

// ---------------------------------------------------------------------------
// Color themes
// ---------------------------------------------------------------------------

// Canvas colors cannot come from CSS variables, so each theme carries the
// waveform palette here; DOM styling is driven entirely by editor.css tokens.
const CANVAS_PALETTES = {
  green: {
    bg: "#000000",
    grid: "#004000",
    mid: "#006600",
    wave: "#00ff00",
    marker: "rgba(0, 204, 0, 0.72)",
    markerText: "#000000",
  },
  classic: {
    bg: "#1b1b1b",
    grid: "#333333",
    mid: "#aaaaaa",
    wave: "#eeeeee",
    marker: "rgba(170, 170, 170, 0.72)",
    markerText: "#1b1b1b",
  },
} as const;

type ThemeName = keyof typeof CANVAS_PALETTES;

let currentTheme: ThemeName = "green";

function applyTheme(theme: ThemeName): void {
  currentTheme = theme;
  if (theme === "classic") document.documentElement.dataset.theme = "classic";
  else delete document.documentElement.dataset.theme;
  // Waveforms are painted from the JS palette, so repaint both after a swap.
  drawSource();
  drawResult();
}

function toggleTheme(): void {
  applyTheme(currentTheme === "green" ? "classic" : "green");
}

// ---------------------------------------------------------------------------
// Pattern row construction
// ---------------------------------------------------------------------------

function buildPatternRows(): void {
  const root = byId("patterns");
  function randomStepper(def: EffectDef, field: "min" | "max" | "freq", disabled: boolean): string {
    const fieldLabel = field === "freq" ? "frequency" : field;
    const disabledAttr = disabled ? " disabled" : "";
    return '<div class="random-stepper"><button class="random-step-button" type="button" data-random-step-key="' + def.key + '" data-random-step-field="' + field + '" data-random-step-delta="-1" aria-label="Decrease ' + def.label + ' random ' + fieldLabel + '"' + disabledAttr + '>−</button><input class="random-field" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" data-random-' + field + '="' + def.key + '" title="Random ' + fieldLabel + '" aria-label="' + def.label + ' random ' + fieldLabel + '"' + disabledAttr + '><button class="random-step-button" type="button" data-random-step-key="' + def.key + '" data-random-step-field="' + field + '" data-random-step-delta="1" aria-label="Increase ' + def.label + ' random ' + fieldLabel + '"' + disabledAttr + '>+</button></div>';
  }
  effectDefs.forEach(function (def) {
    const row = document.createElement("div");
    row.className = "pattern-row";
    const nameClass = def.key === "filterEnvDirLane" ? " pattern-name-full" : "";
    const disableMinMax = def.key === "order" || def.key === "reverse" || def.key === "filterTypeLane" || def.key === "filterEnvDirLane";
    const disableFreq = def.key === "order";
    row.innerHTML = '<div class="pattern-name' + nameClass + '">' + def.label + '</div><div class="pattern-editor" data-pattern-editor="' + def.key + '"><input class="pattern-input" type="text" data-pattern="' + def.key + '" value="' + defaultPatternText(def.key) + '"><div class="pattern-chip-list" data-pattern-chips="' + def.key + '" tabindex="0" role="button" aria-label="Edit ' + def.label + ' pattern"></div></div>' +
      randomStepper(def, "min", disableMinMax) +
      randomStepper(def, "max", disableMinMax) +
      randomStepper(def, "freq", disableFreq) +
      '<button class="button" data-random="' + def.key + '">Randomize</button><button class="button" data-reset="' + def.key + '" title="Reset this pattern">↺</button><button class="button randomize-all-lock" type="button" data-randomize-all-lock="' + def.key + '" title="Exclude from Randomize All" aria-label="Exclude from Randomize All">L</button>';
    root.appendChild(row);
    syncRandomSettingsInput(def.key);
    syncRandomizeAllLockButton(def.key);
    const input = row.querySelector<HTMLInputElement>("[data-pattern]")!;
    const chips = row.querySelector<HTMLElement>("[data-pattern-chips]")!;
    input.oninput = function () { syncPattern(def.key); };
    input.onchange = function () {
      syncPattern(def.key);
      if (isPatternValid(def.key)) setPatternInputValue(def.key, patternValidation[def.key]?.normalizedText ?? "");
    };
    input.onblur = function () { leavePatternEditMode(def.key); };
    input.onkeydown = function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    };
    chips.onclick = function () { enterPatternEditMode(def.key); };
    chips.onkeydown = function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        enterPatternEditMode(def.key);
      }
    };
    (["min", "max", "freq"] as const).forEach(function (field) {
      const randomInput = row.querySelector<HTMLInputElement>('[data-random-' + field + ']');
      if (!randomInput || randomInput.disabled) return;
      randomInput.oninput = function () { getRandomSettings(def.key); };
      randomInput.onchange = function () { syncRandomSettingsInput(def.key); };
    });
    row.querySelectorAll("[data-random-step-key]").forEach(function (element) {
      const button = element as HTMLElement;
      button.onclick = function () {
        const key = button.getAttribute("data-random-step-key");
        const field = button.getAttribute("data-random-step-field") as "min" | "max" | "freq" | null;
        const delta = Number(button.getAttribute("data-random-step-delta"));
        if (!key || !field || !Number.isFinite(delta)) return;
        stepRandomField(key as LaneKey, field, delta);
      };
    });
    (row.querySelector('[data-random="' + def.key + '"]') as HTMLButtonElement | null)!.onclick = function () {
      if (!slices.length) sliceAudio();
      stopAllPlayback();
      randomPattern(def.key);
      renderMutationAndAutoPlay("Randomized " + def.label + " sequence.");
    };
    (row.querySelector('[data-reset="' + def.key + '"]') as HTMLButtonElement | null)!.onclick = function () {
      resetPattern(def.key);
    };
    (row.querySelector('[data-randomize-all-lock="' + def.key + '"]') as HTMLButtonElement | null)!.onclick = function () {
      toggleRandomizeAllLock(def.key);
    };
  });
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

document.querySelectorAll("[data-slice]").forEach(function (button) {
  (button as HTMLElement).onclick = function () {
    const mode = (button as HTMLElement).getAttribute("data-slice")!;
    const count = getSliceCountForCurrentMode(mode);
    if (!isSliceModeAvailableForPayload(mode)) {
      setStatus(formatSliceModeLabel(mode) + " would create " + count + " slices. Max is " + MAX_SLICES + ".");
      updateSliceButtons();
      return;
    }
    state.sliceMode = mode;
    updateSliceButtons();
    result = null;
    resultPreviewBuffer = null;
    sliceAudio();
    drawResult();
    byId<HTMLButtonElement>("exportCurrentButton").disabled = true;
  };
});
document.querySelectorAll("[data-filter]").forEach(function (button) {
  (button as HTMLElement).onclick = function () {
    setFilterType((button as HTMLElement).getAttribute("data-filter")!, true);
  };
});
document.querySelectorAll("[data-filter-env-direction]").forEach(function (button) {
  (button as HTMLElement).onclick = function () {
    setFilterEnvDirection((button as HTMLElement).getAttribute("data-filter-env-direction")!, true);
  };
});
document.querySelectorAll("[data-output-mode],[data-output-bars]").forEach(function (button) {
  (button as HTMLElement).onclick = function () {
    if ((button as HTMLElement).getAttribute("data-output-mode") === "source") {
      state.outputMode = "source";
    } else {
      state.outputMode = "bars";
      state.outputBars = parseInt((button as HTMLElement).getAttribute("data-output-bars")!, 10);
    }
    updateOutputButtons();
    result = null;
    resultPreviewBuffer = null;
    drawResult();
    byId<HTMLButtonElement>("exportCurrentButton").disabled = true;
    byId("resultMeta").textContent = "Not rendered";
    setStatus("Output length set to " + (state.outputMode === "source" ? "source length." : state.outputBars + " bar" + (state.outputBars === 1 ? "." : "s.")));
  };
});
// Filter slider drags fire an input event per pixel step; a full mutation
// render can take tens of milliseconds, so coalesce renders to at most one
// per animation frame while still updating readouts immediately.
let pendingFilterRenderFrame = 0;

function handleFilterSliderInput(): void {
  syncUiToState();
  if (!result || pendingFilterRenderFrame) return;
  pendingFilterRenderFrame = requestAnimationFrame(function () {
    pendingFilterRenderFrame = 0;
    if (result) renderMutation("Updated filter controls.");
  });
}

(["filterCutoff", "filterResonance", "filterDrive", "filterAttack", "filterDecay"] as const).forEach(function (id) {
  byId<HTMLInputElement>(id).oninput = handleFilterSliderInput;
});
byId<HTMLSelectElement>("presetSelect").onchange = function (event) { applySelectedPreset((event.target as HTMLSelectElement).value); };
byId<HTMLButtonElement>("presetPreviousButton").onclick = function () { cyclePreset(-1); };
byId<HTMLButtonElement>("presetNextButton").onclick = function () { cyclePreset(1); };
byId<HTMLButtonElement>("presetSaveButton").onclick = saveCurrentAsPreset;
byId<HTMLButtonElement>("presetDeleteButton").onclick = deleteSelectedPreset;
byId<HTMLButtonElement>("presetImportButton").onclick = openPresetImportDialog;
byId<HTMLButtonElement>("presetExportButton").onclick = exportUserPresets;
byId<HTMLButtonElement>("themeToggleButton").onclick = toggleTheme;
byId<HTMLButtonElement>("presetDialogSecondaryButton").onclick = function () { void copyPresetExportPath(); };
byId<HTMLButtonElement>("presetDialogCancelButton").onclick = closePresetDialog;
byId<HTMLButtonElement>("presetDialogConfirmButton").onclick = confirmPresetDialog;
byId("presetDialog").onkeydown = function (event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closePresetDialog();
  } else if (event.key === "Enter") {
    if (presetDialogMode === "import" && (event.target as HTMLElement).id === "presetImportJsonInput" && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    confirmPresetDialog();
  }
};
byId("presetDialog").ondragover = function (event) {
  if (presetDialogMode !== "import") return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = "copy";
  (event.currentTarget as HTMLElement).classList.add("dragging");
};
byId("presetDialog").ondragleave = function (event) {
  if (presetDialogMode === "import") (event.currentTarget as HTMLElement).classList.remove("dragging");
};
byId("presetDialog").ondrop = function (event) {
  if (presetDialogMode !== "import") return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).classList.remove("dragging");
  const file = event.dataTransfer!.files && event.dataTransfer!.files[0];
  if (!file) {
    setStatus("No preset JSON file was dropped.");
    return;
  }
  stagePresetImportFile(file);
};
byId<HTMLButtonElement>("randomizeAllButton").onclick = randomizeAll;
byId<HTMLButtonElement>("applyButton").onclick = function () { renderMutation(); };
byId<HTMLButtonElement>("playSourceButton").onclick = playSource;
byId<HTMLButtonElement>("playResultButton").onclick = playResult;
byId<HTMLButtonElement>("stopButton").onclick = function () { stopAllPlayback(); setStatus("Preview stopped."); };
byId<HTMLButtonElement>("exportCurrentButton").onclick = exportCurrent;
byId<HTMLButtonElement>("exportQueueButton").onclick = exportQueuedSnapshots;
byId<HTMLButtonElement>("cancelButton").onclick = function () {
  stopAllPlayback();
  closeWithResult(JSON.stringify({ action: "close", userPresetsJson: serializeCurrentUserPresets() }));
};
byId<HTMLButtonElement>("resetButton").onclick = function () {
  stopAllPlayback();
  result = null;
  resultPreviewBuffer = null;
  effectDefs.forEach(function (def) {
    const values = parsePatternForEffect(def.key, defaultPatternText(def.key), Math.max(1, slices.length), Math.max(1, slices.length));
    state.sequences[def.key] = values;
    setPatternInputValue(def.key, patternToTextForEffect(def.key, values));
  });
  drawResult();
  byId<HTMLButtonElement>("exportCurrentButton").disabled = true;
  byId("resultMeta").textContent = "Not rendered";
  setStatus("Reset patterns.");
};
window.onresize = function () { drawSource(); drawResult(); };

// ---------------------------------------------------------------------------
// Startup sequence
// ---------------------------------------------------------------------------

buildPatternRows();
ensureValidSliceMode();
updateSliceButtons();
updateOutputButtons();
sliceAudio();
const restoredHadResult = restoreEditorSession();
renderSnapshots();
renderPresetOptions();
if (restoredHadResult) renderMutation("Restored editor state.");
else drawResult();
if (presetBootstrap.notice) setStatus(presetBootstrap.notice);

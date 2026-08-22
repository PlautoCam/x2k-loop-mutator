/*
 * Pure editor-runtime logic: pattern parsing/validation/formatting,
 * randomization, slice math, and the mutation DSP pipeline.
 *
 * Ported 1:1 from the former inline <script> template string in
 * editor-runtime.ts so the logic is type-checked and unit-testable. Functions
 * that previously closed over editor state (source.sampleRate, slices.length,
 * state.sequences.*, state.filter*) now receive those values as parameters;
 * behavior is otherwise unchanged.
 */
import type { PatternValue } from "../../shared/types.js";
import {
  MAX_SLICES,
  sliceCountForDuration,
  sliceLengthBeats,
  sliceModeLabel,
} from "../../shared/slice-modes.js";
import { laneDefaultRandomSettings } from "../../shared/presets.js";

export { decodeInt16Base64, encodeInt16Base64 } from "../../shared/int16-codec.js";

export { MAX_SLICES };

export type LaneKey =
  | "order"
  | "reverse"
  | "stutter"
  | "pitch"
  | "tape"
  | "filter"
  | "filterEnvDirLane"
  | "filterTypeLane"
  | "flanger"
  | "bitcrush"
  | "reverb";

export interface EffectDef {
  key: LaneKey;
  label: string;
}

export const EFFECT_DEFS: readonly EffectDef[] = [
  { key: "order", label: "Slice Order" },
  { key: "reverse", label: "Reverse" },
  { key: "stutter", label: "Stutter" },
  { key: "pitch", label: "Pitch" },
  { key: "tape", label: "Tape Stop" },
  { key: "filter", label: "Filter Env" },
  { key: "filterEnvDirLane", label: "Filter Env Dir" },
  { key: "filterTypeLane", label: "Filter Type" },
  { key: "flanger", label: "Flanger" },
  { key: "bitcrush", label: "Bitcrush" },
  { key: "reverb", label: "Gated Reverb" },
];

export interface PatternValidationResult {
  valid: boolean;
  values: PatternValue[];
  normalizedText: string;
  error: string;
}

export interface RandomSettings {
  min: number;
  max: number;
  freq: number;
}

export type Rng = () => number;

export type SliceMode = "half" | "quarter" | "eighth";

// ---------------------------------------------------------------------------
// Deterministic random helpers
// ---------------------------------------------------------------------------

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Numeric clamps
// ---------------------------------------------------------------------------

export function clampIntegerValue(value: unknown, min: number, max: number, fallback: number): number {
  let number = Number(value);
  if (!Number.isFinite(number)) number = fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function clampToRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function clampSample(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// Pattern text formatting
// ---------------------------------------------------------------------------

export function patternToText(values: PatternValue[]): string {
  return values.join("-");
}

export function formatPitchPattern(values: PatternValue[]): string {
  return values.map(function (value) {
    const semitone = clampIntegerValue(value, -12, 12, 0);
    return semitone > 0 ? "+" + semitone : String(semitone);
  }).join(",");
}

export function formatReversePattern(values: PatternValue[]): string {
  return values.map(function (value) {
    return String(value).toUpperCase() === "R" ? "R" : "F";
  }).join("-");
}

export function formatFilterTypeLaneToken(value: unknown): string {
  return normalizeFilterTypeLaneToken(value) || "-";
}

export function formatFilterTypeLanePattern(values: PatternValue[]): string {
  return values.map(function (value) {
    return formatFilterTypeLaneToken(value);
  }).join(",");
}

export function formatFilterEnvDirLaneToken(value: unknown): string {
  return normalizeFilterEnvDirLaneToken(value);
}

export function formatFilterEnvDirLanePattern(values: PatternValue[]): string {
  return values.map(function (value) {
    return formatFilterEnvDirLaneToken(value);
  }).join(",");
}

export function patternToTextForEffect(key: LaneKey, values: PatternValue[]): string {
  if (key === "pitch") return formatPitchPattern(values);
  if (key === "reverse") return formatReversePattern(values);
  if (key === "filterTypeLane") return formatFilterTypeLanePattern(values);
  if (key === "filterEnvDirLane") return formatFilterEnvDirLanePattern(values);
  return values.join("-");
}

export function makeDefaultSliceOrder(count: number): PatternValue[] {
  const out: PatternValue[] = [];
  for (let i = 0; i < count; i++) out.push(i + 1);
  return out;
}

export function defaultPatternText(key: LaneKey, sliceCount: number): string {
  if (key === "order") return patternToText(makeDefaultSliceOrder(Math.max(1, sliceCount)));
  if (key === "reverse") return "F";
  if (key === "filterTypeLane" || key === "filterEnvDirLane") return "-";
  return "0";
}

// ---------------------------------------------------------------------------
// Token normalization
// ---------------------------------------------------------------------------

export function normalizeFilterTypeLaneToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const token = String(value).trim().toUpperCase();
  if (!token || token === "-" || token === "0") return "-";
  if (token === "LP" || token === "BP" || token === "HP") return token;
  if (token === "NT" || token === "NOTCH") return "NT";
  return null;
}

export function normalizeFilterEnvDirLaneToken(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const token = String(value).trim().toUpperCase();
  if (!token || token === "-" || token === "0") return "-";
  if (token === "UP") return "UP";
  if (token === "DN" || token === "DOWN") return "DN";
  return "-";
}

export function validFilterType(type: unknown): type is "LP" | "BP" | "HP" | "NOTCH" {
  return type === "LP" || type === "BP" || type === "HP" || type === "NOTCH";
}

export function normalizeFilterTypeLaneValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const token = String(value).trim().toUpperCase();
  if (token === "LP" || token === "BP" || token === "HP") return token;
  if (token === "NT" || token === "NOTCH") return "NOTCH";
  return null;
}

export function normalizeFilterEnvDirLaneValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const token = String(value).trim().toUpperCase();
  if (token === "UP") return "UP";
  if (token === "DN" || token === "DOWN") return "DOWN";
  return null;
}

export function validFilterEnvDirection(direction: unknown): direction is "UP" | "DOWN" {
  return direction === "UP" || direction === "DOWN";
}

// ---------------------------------------------------------------------------
// Pattern parsing and validation
// ---------------------------------------------------------------------------

function validationResult(
  valid: boolean,
  values: PatternValue[],
  normalizedText: string,
  error: string,
): PatternValidationResult {
  return { valid, values, normalizedText, error };
}

export function repeatPatternValues(raw: PatternValue[], count: number): PatternValue[] {
  const sourceValues = raw.length ? raw : [0];
  const out: PatternValue[] = [];
  for (let i = 0; i < count; i++) out.push(sourceValues[i % sourceValues.length]!);
  return out.slice(0, count);
}

export function fallbackPatternValues(key: LaneKey | "digit", count: number, sliceCount: number): PatternValue[] {
  const out: PatternValue[] = [];
  if (key === "order") {
    for (let i = 0; i < count; i++) out.push(i % Math.max(1, sliceCount) + 1);
    return out;
  }
  if (key === "reverse") {
    for (let r = 0; r < count; r++) out.push("F");
    return out;
  }
  if (key === "filterTypeLane" || key === "filterEnvDirLane") {
    for (let f = 0; f < count; f++) out.push("-");
    return out;
  }
  for (let j = 0; j < count; j++) out.push(0);
  return out;
}

export function validateSliceOrderPattern(text: unknown, count: number, sliceCount: number): PatternValidationResult {
  const source = String(text ?? "").trim();
  const fallback = fallbackPatternValues("order", count, sliceCount);
  if (!source) return validationResult(true, fallback, patternToText(fallback), "");
  const raw: number[] = [];
  if (/[,\s/\-]/.test(source)) {
    const tokens = source.split(/[,\s/\-]+/).filter(function (token) { return token.length; });
    if (!tokens.length) return validationResult(false, fallback, patternToText(fallback), "Invalid Slice Order.");
    for (let t = 0; t < tokens.length; t++) {
      if (!/^\d+$/.test(tokens[t]!)) return validationResult(false, fallback, patternToText(fallback), "Invalid Slice Order.");
      raw.push(parseInt(tokens[t]!, 10));
    }
  } else {
    if (!/^\d+$/.test(source) || sliceCount >= 10) return validationResult(false, fallback, patternToText(fallback), "Invalid Slice Order.");
    for (let c = 0; c < source.length; c++) raw.push(parseInt(source.charAt(c), 10));
  }
  const check = raw.slice(0, count);
  for (let i = 0; i < check.length; i++) {
    if (check[i]! < 1 || check[i]! > sliceCount) return validationResult(false, fallback, patternToText(fallback), "Invalid Slice Order.");
  }
  const values = repeatPatternValues(raw, count);
  return validationResult(true, values, patternToText(values), "");
}

export function validateReversePattern(text: unknown, count: number): PatternValidationResult {
  const source = String(text ?? "").trim();
  const fallback = fallbackPatternValues("reverse", count, 1);
  if (!source) return validationResult(true, fallback, formatReversePattern(fallback), "");
  const raw: string[] = [];
  if (/[,\s/\-]/.test(source)) {
    const tokens = source.split(/[,\s/\-]+/).filter(function (token) { return token.length; });
    if (!tokens.length) return validationResult(false, fallback, formatReversePattern(fallback), "Invalid Reverse pattern.");
    for (let t = 0; t < tokens.length; t++) {
      if (!/^[FRfr]$/.test(tokens[t]!)) return validationResult(false, fallback, formatReversePattern(fallback), "Invalid Reverse pattern.");
      raw.push(tokens[t]!.toUpperCase());
    }
  } else {
    for (let i = 0; i < source.length; i++) {
      const ch = source.charAt(i);
      if (!/^[FRfr]$/.test(ch)) return validationResult(false, fallback, formatReversePattern(fallback), "Invalid Reverse pattern.");
      raw.push(ch.toUpperCase());
    }
  }
  const values = repeatPatternValues(raw as PatternValue[], count);
  return validationResult(true, values, formatReversePattern(values), "");
}

export function validatePitchPattern(text: unknown, count: number): PatternValidationResult {
  const source = String(text ?? "").trim();
  const fallback = fallbackPatternValues("pitch", count, 1);
  if (!source) return validationResult(true, fallback, formatPitchPattern(fallback), "");
  let tokens: string[];
  if (/[,\s\/]/.test(source)) {
    tokens = source.split(/[,\s\/]+/).filter(function (token) { return token.length; });
  } else if (source.indexOf("-") > 0) {
    if (!/^\d+(?:-\d+)*$/.test(source)) return validationResult(false, fallback, formatPitchPattern(fallback), "Invalid Pitch pattern.");
    tokens = source.split("-");
  } else {
    tokens = [source];
  }
  if (!tokens.length) return validationResult(false, fallback, formatPitchPattern(fallback), "Invalid Pitch pattern.");
  const raw: number[] = [];
  for (let t = 0; t < tokens.length; t++) {
    if (!/^[+-]?\d+$/.test(tokens[t]!)) return validationResult(false, fallback, formatPitchPattern(fallback), "Invalid Pitch pattern.");
    raw.push(parseInt(tokens[t]!, 10));
  }
  const check = raw.slice(0, count);
  for (let i = 0; i < check.length; i++) {
    if (check[i]! < -12 || check[i]! > 12) return validationResult(false, fallback, formatPitchPattern(fallback), "Invalid Pitch pattern.");
  }
  const values = repeatPatternValues(raw, count);
  return validationResult(true, values, formatPitchPattern(values), "");
}

export function validateFilterTypeLanePattern(text: unknown, count: number): PatternValidationResult {
  const source = String(text ?? "").trim();
  const fallback = fallbackPatternValues("filterTypeLane", count, 1);
  if (!source) return validationResult(true, fallback, formatFilterTypeLanePattern(fallback), "");
  const tokens = source.indexOf(",") >= 0
    ? source.split(",").map(function (token) { return token.trim(); })
    : source.split(/[\s\/]+/).filter(function (token) { return token.length; });
  if (!tokens.length) return validationResult(true, fallback, formatFilterTypeLanePattern(fallback), "");
  const raw: string[] = [];
  for (let t = 0; t < tokens.length; t++) {
    const normalized = normalizeFilterTypeLaneToken(tokens[t]);
    if (!normalized) return validationResult(false, fallback, formatFilterTypeLanePattern(fallback), "Invalid Filter Type pattern.");
    raw.push(normalized);
  }
  const values = repeatPatternValues(raw as PatternValue[], count);
  return validationResult(true, values, formatFilterTypeLanePattern(values), "");
}

export function validateFilterEnvDirLanePattern(text: unknown, count: number): PatternValidationResult {
  const source = String(text ?? "").trim();
  const fallback = fallbackPatternValues("filterEnvDirLane", count, 1);
  if (!source) return validationResult(true, fallback, formatFilterEnvDirLanePattern(fallback), "");
  const tokens = source.indexOf(",") >= 0
    ? source.split(",").map(function (token) { return token.trim(); })
    : source.split(/[\s\/]+/).filter(function (token) { return token.length; });
  if (!tokens.length) return validationResult(true, fallback, formatFilterEnvDirLanePattern(fallback), "");
  const raw: string[] = [];
  for (let t = 0; t < tokens.length; t++) raw.push(normalizeFilterEnvDirLaneToken(tokens[t]));
  const values = repeatPatternValues(raw as PatternValue[], count);
  return validationResult(true, values, formatFilterEnvDirLanePattern(values), "");
}

export function validateDigitPattern(text: unknown, count: number, key: string): PatternValidationResult {
  const source = String(text ?? "").trim();
  const fallback = fallbackPatternValues((key || "digit") as LaneKey | "digit", count, 1);
  if (!source) return validationResult(true, fallback, patternToText(fallback), "");
  const raw: number[] = [];
  if (/[,\s/\-]/.test(source)) {
    const tokens = source.split(/[,\s/\-]+/).filter(function (token) { return token.length; });
    if (!tokens.length) return validationResult(false, fallback, patternToText(fallback), "Invalid pattern.");
    for (let t = 0; t < tokens.length; t++) {
      if (!/^[0-9]$/.test(tokens[t]!)) return validationResult(false, fallback, patternToText(fallback), "Invalid pattern.");
      raw.push(parseInt(tokens[t]!, 10));
    }
  } else {
    if (source === "10" || !/^[0-9]+$/.test(source)) return validationResult(false, fallback, patternToText(fallback), "Invalid pattern.");
    for (let c = 0; c < source.length; c++) raw.push(parseInt(source.charAt(c), 10));
  }
  const values = repeatPatternValues(raw, count);
  return validationResult(true, values, patternToText(values), "");
}

// totalSliceCount is the live slice count used to bound Slice Order values.
export function validatePatternForEffect(
  key: LaneKey,
  text: unknown,
  count: number,
  totalSliceCount: number,
): PatternValidationResult {
  const activeCount = Math.max(1, count);
  if (key === "order") return validateSliceOrderPattern(text, activeCount, Math.max(1, totalSliceCount));
  if (key === "pitch") return validatePitchPattern(text, activeCount);
  if (key === "reverse") return validateReversePattern(text, activeCount);
  if (key === "filterTypeLane") return validateFilterTypeLanePattern(text, activeCount);
  if (key === "filterEnvDirLane") return validateFilterEnvDirLanePattern(text, activeCount);
  return validateDigitPattern(text, activeCount, key);
}

export function parsePatternForEffect(key: LaneKey, text: unknown, count: number, totalSliceCount: number): PatternValue[] {
  return validatePatternForEffect(key, text, count, totalSliceCount).values;
}

export function isDefaultSliceOrder(values: PatternValue[] | undefined | null): boolean {
  if (!values || !values.length) return false;
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== i + 1) return false;
  }
  return true;
}

export function resizePatternValuesForSliceCount(
  key: LaneKey,
  values: PatternValue[],
  count: number,
  sliceCount: number,
): PatternValue[] {
  const targetCount = Math.max(1, count);
  const sourceValues = values && values.length ? values : fallbackPatternValues(key, targetCount, Math.max(1, sliceCount));

  if (key === "order") {
    if (isDefaultSliceOrder(sourceValues)) {
      return makeDefaultSliceOrder(targetCount);
    }

    const resizedOrder = repeatPatternValues(sourceValues, targetCount);
    for (let i = 0; i < resizedOrder.length; i++) {
      if (typeof resizedOrder[i] !== "number" ||
        (resizedOrder[i] as number) < 1 ||
        (resizedOrder[i] as number) > targetCount) {
        return makeDefaultSliceOrder(targetCount);
      }
    }
    return resizedOrder;
  }

  return repeatPatternValues(sourceValues, targetCount);
}

// ---------------------------------------------------------------------------
// Slice mode helpers
// ---------------------------------------------------------------------------

export function getSliceBeatsForMode(mode: string): number {
  return sliceLengthBeats(mode);
}

export function getSliceCountForMode(mode: string, durationBeats: number): number {
  return sliceCountForDuration(mode, durationBeats);
}

export function isSliceModeAvailable(mode: string, durationBeats: number): boolean {
  return getSliceCountForMode(mode, durationBeats) <= MAX_SLICES;
}

export function ensureValidSliceModeValue(mode: string, durationBeats: number): SliceMode {
  if (isSliceModeAvailable(mode, durationBeats)) return mode as SliceMode;
  const modes: SliceMode[] = ["eighth", "quarter", "half"];
  for (const candidate of modes) {
    if (isSliceModeAvailable(candidate, durationBeats)) return candidate;
  }
  return "half";
}

export function formatSliceModeLabel(mode: string): string {
  return sliceModeLabel(mode);
}

// ---------------------------------------------------------------------------
// Randomization
// ---------------------------------------------------------------------------

export function defaultRandomSettings(key: LaneKey): RandomSettings {
  return laneDefaultRandomSettings(key);
}

// stepLimit replaces the former activeStepLimit() closure over slices.length.
export function sanitizeRandomSettings(
  key: LaneKey,
  settings: Partial<RandomSettings> | undefined,
  stepLimit: number,
): RandomSettings {
  const defaults = defaultRandomSettings(key);
  const sourceSettings = settings ?? {};
  let min = Number.isFinite(Number(sourceSettings.min)) ? Number(sourceSettings.min) : defaults.min;
  let max = Number.isFinite(Number(sourceSettings.max)) ? Number(sourceSettings.max) : defaults.max;
  let freq = Number.isFinite(Number(sourceSettings.freq)) ? Number(sourceSettings.freq) : defaults.freq;
  if (key === "pitch") {
    min = clampIntegerValue(min, -12, 12, defaults.min);
    max = clampIntegerValue(max, -12, 12, defaults.max);
  } else if (key === "order") {
    min = clampIntegerValue(min, 1, MAX_SLICES, defaults.min);
    max = clampIntegerValue(max, 1, MAX_SLICES, defaults.max);
  } else if (key === "reverse" || key === "filterTypeLane" || key === "filterEnvDirLane") {
    min = 0;
    max = 1;
  } else {
    min = clampIntegerValue(min, 0, 9, defaults.min);
    max = clampIntegerValue(max, 0, 9, defaults.max);
  }
  if (min > max) {
    const temp = min;
    min = max;
    max = temp;
  }
  freq = clampIntegerValue(freq, 0, stepLimit, defaults.freq);
  return { min, max, freq };
}

export function pickActiveSteps(rng: Rng, count: number, freq: number): number[] {
  const limit = clampIntegerValue(freq, 0, count, 0);
  const indexes: number[] = [];
  for (let i = 0; i < count; i++) indexes.push(i);
  for (let j = indexes.length - 1; j > 0; j--) {
    const swap = Math.floor(rng() * (j + 1));
    const temp = indexes[j]!;
    indexes[j] = indexes[swap]!;
    indexes[swap] = temp;
  }
  return indexes.slice(0, limit);
}

export function pickFromIndexes(rng: Rng, indexes: number[], freq: number): number[] {
  const limit = clampIntegerValue(freq, 0, indexes.length, 0);
  const shuffled = indexes.slice();
  for (let j = shuffled.length - 1; j > 0; j--) {
    const swap = Math.floor(rng() * (j + 1));
    const temp = shuffled[j]!;
    shuffled[j] = shuffled[swap]!;
    shuffled[swap] = temp;
  }
  return shuffled.slice(0, limit);
}

export function randomIntegerBetween(rng: Rng, min: number, max: number): number {
  let low = Math.round(Number(min));
  let high = Math.round(Number(max));
  if (!Number.isFinite(low)) low = 0;
  if (!Number.isFinite(high)) high = low;
  if (low > high) {
    const temp = low;
    low = high;
    high = temp;
  }
  return low + Math.floor(rng() * (high - low + 1));
}

export function shuffledSliceOrder(rng: Rng, count: number, sliceCount: number): PatternValue[] {
  let out: PatternValue[] = [];
  while (out.length < count) {
    const cycle = makeDefaultSliceOrder(Math.max(1, sliceCount));
    for (let i = cycle.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const temp = cycle[i]!;
      cycle[i] = cycle[j]!;
      cycle[j] = temp;
    }
    out = out.concat(cycle);
  }
  return out.slice(0, count);
}

// filterValues replaces the former read of state.sequences.filter.
export function isFilterEnvActiveAtStep(filterValues: PatternValue[], step: number): boolean {
  const value = filterValues && filterValues.length ? filterValues[step % filterValues.length] : 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

// settings=null keeps the legacy behavior of randomizing every active step.
export function makeRandomFilterEnvDirValuesForCurrentFilterEnv(
  rng: Rng,
  count: number,
  settings: RandomSettings | null,
  filterValues: PatternValue[],
): PatternValue[] {
  const out: PatternValue[] = [];
  const candidates: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push("-");
    if (isFilterEnvActiveAtStep(filterValues, i)) candidates.push(i);
  }
  const selected = settings && settings.freq > 0 ? pickFromIndexes(rng, candidates, settings.freq) : candidates;
  selected.forEach(function (index) {
    out[index] = rng() < 0.5 ? "UP" : "DN";
  });
  return out;
}

// The per-lane branch logic formerly inside randomPattern(), minus rng
// creation and state application which stay in the UI layer.
export function buildRandomLanePattern(
  key: LaneKey,
  rng: Rng,
  count: number,
  settings: RandomSettings,
  filterValues: PatternValue[],
): PatternValue[] {
  const out: PatternValue[] = [];
  if (key === "order") {
    return shuffledSliceOrder(rng, count, count);
  }
  if (key === "reverse") {
    if (settings.freq > 0) {
      for (let rr = 0; rr < count; rr++) out.push("F");
      pickActiveSteps(rng, count, settings.freq).forEach(function (index) {
        out[index] = "R";
      });
    } else {
      for (let r = 0; r < count; r++) out.push(rng() < 0.28 ? "R" : "F");
    }
    return out;
  }
  if (key === "filterTypeLane") {
    const filterTypeChoices: PatternValue[] = ["LP", "BP", "HP", "NT"];
    for (let ft = 0; ft < count; ft++) out.push("-");
    const selectedSteps = settings.freq > 0
      ? pickActiveSteps(rng, count, settings.freq)
      : (function () {
        const indexes: number[] = [];
        for (let ii = 0; ii < count; ii++) indexes.push(ii);
        return indexes;
      })();
    selectedSteps.forEach(function (index) {
      out[index] = filterTypeChoices[Math.floor(rng() * filterTypeChoices.length)]!;
    });
    return out;
  }
  if (key === "filterEnvDirLane") {
    return makeRandomFilterEnvDirValuesForCurrentFilterEnv(rng, count, settings, filterValues);
  }
  if (key === "pitch") {
    if (settings.freq > 0) {
      for (let pp = 0; pp < count; pp++) out.push(0);
      pickActiveSteps(rng, count, settings.freq).forEach(function (index) {
        out[index] = randomIntegerBetween(rng, settings.min, settings.max);
      });
    } else {
      for (let p = 0; p < count; p++) {
        if (settings.min <= 0 && settings.max >= 0 && rng() < 0.33) {
          out.push(0);
        } else {
          out.push(randomIntegerBetween(rng, settings.min, settings.max));
        }
      }
    }
    return out;
  }
  if (key === "stutter") {
    if (settings.freq > 0) {
      for (let ss = 0; ss < count; ss++) out.push(0);
      pickActiveSteps(rng, count, settings.freq).forEach(function (index) {
        out[index] = randomIntegerBetween(rng, settings.min, settings.max);
      });
    } else {
      for (let s = 0; s < count; s++) {
        const roll = rng();
        out.push(roll < 0.68 ? 0 : clampIntegerValue(
          roll < 0.95 ? 1 + Math.floor(rng() * 5) : 6 + Math.floor(rng() * 4),
          settings.min,
          settings.max,
          0,
        ));
      }
    }
    return out;
  }
  if (settings.freq > 0) {
    for (let iii = 0; iii < count; iii++) out.push(0);
    pickActiveSteps(rng, count, settings.freq).forEach(function (index) {
      out[index] = randomIntegerBetween(rng, settings.min, settings.max);
    });
  } else {
    for (let i = 0; i < count; i++) {
      const dryBias = 0.55;
      out.push(rng() < dryBias ? 0 : randomIntegerBetween(rng, settings.min, settings.max));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutation DSP pipeline (pure transforms)
// ---------------------------------------------------------------------------

export function buildSliceSegment(
  channel: Float32Array,
  sliceStart: number,
  sliceEnd: number,
  offset: number,
  length: number,
  reverse: boolean,
): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = readSliceSample(channel, sliceStart, sliceEnd, offset + i, reverse);
  return out;
}

export function readSliceSample(
  channel: Float32Array,
  sliceStart: number,
  sliceEnd: number,
  local: number,
  reverse: boolean,
): number {
  const sliceLength = sliceEnd - sliceStart;
  if (sliceLength <= 1) return 0;
  const clampedLocal = Math.max(0, Math.min(sliceLength - 1, local));
  const pos = reverse ? sliceEnd - 1 - clampedLocal : sliceStart + clampedLocal;
  return channel[Math.max(0, Math.min(channel.length - 1, Math.round(pos)))] ?? 0;
}

export function applyStutter(input: Float32Array, value: unknown): Float32Array {
  const stutterValue = Math.max(0, Math.min(9, Math.round(Number(value) || 0)));
  if (stutterValue <= 0) return input;
  const repeatMap = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];
  const repeats = repeatMap[stutterValue]!;
  const grain = Math.max(16, Math.floor(input.length / repeats));
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) output[i] = (input[i % grain] ?? 0) * stutterFade(i, grain);
  return output;
}

function stutterFade(index: number, grain: number): number {
  const fade = Math.min(32, Math.floor(grain / 4));
  if (fade <= 1) return 1;
  const local = index % grain;
  if (local < fade) return local / fade;
  if (local >= grain - fade) return Math.max(0, (grain - 1 - local) / fade);
  return 1;
}

export function applyTapeStop(input: Float32Array, value: unknown): Float32Array {
  const output = new Float32Array(input.length);
  let read = 0;
  const endSpeed = 0.35 - Number(value) * 0.035;
  for (let i = 0; i < input.length; i++) {
    const t = i / Math.max(1, input.length - 1);
    const speed = endSpeed + (1 - endSpeed) * Math.pow(1 - t, 1.2 + Number(value) * 0.22);
    const gain = t > 0.72 ? Math.pow(1 - (t - 0.72) / 0.28, 0.7 + Number(value) / 9) : 1;
    output[i] = readInterpolatedClamped(input, read) * Math.max(0, gain);
    read = Math.min(input.length - 1, read + speed);
  }
  return output;
}

export interface FilterControlSettings {
  cutoff: number;
  resonance: number;
  drive: number;
  attack: number;
  decay: number;
}

export function applyPatternFilter(
  input: Float32Array,
  value: unknown,
  typeOverride: unknown,
  directionOverride: unknown,
  filterSettings: FilterControlSettings,
  sampleRate: number,
): Float32Array {
  const filterValue = Math.max(0, Math.min(9, Math.round(Number(value) || 0)));
  if (filterValue <= 0) return input;
  const output = new Float32Array(input.length);
  const type = validFilterType(typeOverride) ? typeOverride : "LP";
  const envDirection = validFilterEnvDirection(directionOverride) ? directionOverride : "UP";
  const minCutoff = 35;
  const maxCutoff = sampleRate * 0.42;
  const base = clampToRange(Number(filterSettings.cutoff) || 500, minCutoff, Math.min(6000, maxCutoff));
  const envAmount = filterValue / 9;
  const res = clamp01(Number(filterSettings.resonance));
  const q = type === "NOTCH" ? 0.45 + (1 - res) * 2.5 : 0.707 + res * 7.0;
  const drive = 1 + clamp01(Number(filterSettings.drive)) * 8;
  const attack = clamp01(Number(filterSettings.attack));
  const decay = clamp01(Number(filterSettings.decay));
  const availableOctavesUp = Math.max(0, Math.log(maxCutoff / base) / Math.log(2));
  const availableOctavesDown = Math.max(0, Math.log(base / minCutoff) / Math.log(2));
  const svf1 = { ic1eq: 0, ic2eq: 0 };
  for (let i = 0; i < input.length; i++) {
    const t = i / Math.max(1, input.length - 1);
    const env = filterEnvelope(t, attack, decay);
    let cutoff = envDirection === "DOWN"
      ? base / Math.pow(2, availableOctavesDown * envAmount * env)
      : base * Math.pow(2, availableOctavesUp * envAmount * env);
    cutoff = clampToRange(cutoff, minCutoff, maxCutoff);
    let x = input[i] ?? 0;
    if (drive > 1) x = Math.tanh(x * drive) / Math.tanh(drive);
    const first = processSvfSample(x, cutoff, q, sampleRate, svf1);
    const y = selectFilterOutput(first, type);
    const safeY = Number.isFinite(y) ? y : 0;
    output[i] = Math.max(-1.5, Math.min(1.5, safeY));
  }
  return output;
}

function filterEnvelope(t: number, attackControl: number, decayControl: number): number {
  const attackTime = 0.002 + clamp01(attackControl) * 0.45;
  const decayShape = 0.15 + clamp01(decayControl) * 5.5;
  const attackPhase = attackTime <= 0 ? 1 : Math.min(1, t / attackTime);
  const attack = attackPhase * attackPhase * (3 - 2 * attackPhase);
  const decayStart = Math.max(0, t - attackTime);
  const decay = Math.exp(-decayStart * decayShape);
  const env = attack * decay;
  if (!Number.isFinite(env)) return 0;
  return clamp01(env);
}

interface SvfState {
  ic1eq: number;
  ic2eq: number;
}

interface SvfOutputs {
  lp: number;
  bp: number;
  hp: number;
  notch: number;
}

function processSvfSample(x: number, cutoffInput: number, qInput: number, sampleRate: number, svfState: SvfState): SvfOutputs {
  const cutoff = clampToRange(Number(cutoffInput) || 35, 1, sampleRate * 0.49);
  const q = Math.max(0.001, Number(qInput) || 0.707);
  let g = Math.tan(Math.PI * cutoff / sampleRate);
  if (!Number.isFinite(g)) g = 1;
  const k = 1 / q;
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  const a3 = g * a2;
  const v3 = x - svfState.ic2eq;
  const v1 = a1 * svfState.ic1eq + a2 * v3;
  const v2 = svfState.ic2eq + a2 * svfState.ic1eq + a3 * v3;
  svfState.ic1eq = 2 * v1 - svfState.ic1eq;
  svfState.ic2eq = 2 * v2 - svfState.ic2eq;
  if (!Number.isFinite(svfState.ic1eq)) svfState.ic1eq = 0;
  if (!Number.isFinite(svfState.ic2eq)) svfState.ic2eq = 0;
  const lp = v2;
  const bp = v1;
  const hp = x - k * v1 - v2;
  return { lp, bp, hp, notch: hp + lp };
}

function selectFilterOutput(svfOutput: SvfOutputs, type: string): number {
  if (type === "BP") return svfOutput.bp;
  if (type === "HP") return svfOutput.hp;
  if (type === "NOTCH") return svfOutput.notch;
  return svfOutput.lp;
}

export function applyFlanger(input: Float32Array, value: number, seed: number, sampleRate: number): Float32Array {
  const output = new Float32Array(input.length);
  const maxDelay = Math.round(sampleRate * (0.002 + value * 0.00055));
  const buffer = new Float32Array(maxDelay + 4);
  let write = 0;
  const feedback = 0.18 + value * 0.055;
  const mix = 0.22 + value * 0.055;
  const phase = (seed % 31) / 31 * Math.PI * 2;
  for (let i = 0; i < input.length; i++) {
    const t = i / Math.max(1, input.length - 1);
    const delay = 1 + Math.floor((0.5 + 0.5 * Math.sin(phase + t * Math.PI * (1 + value / 2))) * maxDelay);
    const read = (write - delay + buffer.length) % buffer.length;
    const delayed = buffer[read] ?? 0;
    const x = input[i] ?? 0;
    buffer[write] = clampSample(x + delayed * feedback);
    write = (write + 1) % buffer.length;
    output[i] = clampSample(x * (1 - mix) + delayed * mix);
  }
  return output;
}

export function applyBitcrushSegment(input: Float32Array, value: number): Float32Array {
  const output = new Float32Array(input.length);
  const bits = Math.max(2, 13 - value);
  const hold = 1 + value * 2;
  const levels = Math.pow(2, bits);
  let held = 0;
  for (let i = 0; i < input.length; i++) {
    if (i % hold === 0) held = Math.round((input[i] ?? 0) * levels) / levels;
    output[i] = held;
  }
  return output;
}

export interface ReverbSettings {
  wet: number;
  dry: number;
  roomFeedback: number;
  damping: number;
  preDelayMs: number;
  gateHold: number;
  gateFade: number;
  stereoOffsetMs: number;
}

// reverbPatternText seeds the deterministic variation exactly like the former
// closure over state.sequences.reverb.
export function choosePatternReverbSettings(value: number, step: number, reverbPatternText: string): ReverbSettings {
  const reverbValue = Math.max(0, Math.min(9, Math.round(Number(value) || 0)));
  const intensity = reverbValue / 9;

  const rng = createRng(hashString("reverb:" + step + ":" + reverbValue + ":" + reverbPatternText));

  // Small deterministic variation, but value 1-9 remains the main control.
  const variation = function (amount: number) {
    return (rng() - 0.5) * amount;
  };

  return {
    // Value 1 should be audible but not huge.
    // Value 9 should be very wet and dramatic.
    wet: clamp01(0.28 + intensity * 0.68 + variation(0.04)),

    // Dry signal decreases as value increases.
    dry: clamp01(0.88 - intensity * 0.62 + variation(0.04)),

    // Reverb size/feedback grows strongly with value.
    roomFeedback: clamp01(0.42 + intensity * 0.46 + variation(0.04)),

    // Lower damping at high values gives a brighter/larger splash.
    damping: clamp01(0.42 - intensity * 0.20 + variation(0.03)),

    // Higher values get more obvious gated-reverb pre-delay.
    preDelayMs: Math.max(1, Math.round(3 + intensity * 24 + rng() * 4)),

    // Gate opens longer at high values.
    gateHold: clamp01(0.24 + intensity * 0.54 + variation(0.04)),

    // Gate tail gets a bit longer at high values.
    gateFade: clamp01(0.035 + intensity * 0.17 + variation(0.025)),

    // Wider stereo spread at high values.
    stereoOffsetMs: Math.max(0.5, 0.8 + intensity * 2.4 + rng() * 0.6),
  };
}

export function offsetReverbSettings(settings: ReverbSettings, rng: Rng): ReverbSettings {
  return {
    wet: settings.wet,
    dry: settings.dry,
    roomFeedback: Math.min(0.88, settings.roomFeedback + rng() * 0.03),
    damping: Math.min(0.38, settings.damping + rng() * 0.04),
    preDelayMs: settings.preDelayMs + settings.stereoOffsetMs,
    gateHold: settings.gateHold,
    gateFade: settings.gateFade,
    stereoOffsetMs: settings.stereoOffsetMs + 0.7,
  };
}

export function applyGatedReverb(input: Float32Array, settings: ReverbSettings, sampleRate: number): Float32Array {
  const length = input.length;
  const wet = processSchroederReverbTank(input, settings, sampleRate);
  const output = new Float32Array(length);
  const wetMix = settings.wet || 0.5;
  const dryMix = settings.dry || 0.45;
  for (let i = 0; i < length; i++) {
    const gate = gatedEnvelope(i, length, settings.gateHold, settings.gateFade);
    const sample = (input[i] ?? 0) * dryMix + (wet[i] ?? 0) * wetMix * gate;
    output[i] = clampSample(sample);
  }
  normalizeMono(output);
  return output;
}

function processSchroederReverbTank(input: Float32Array, settings: ReverbSettings, sampleRate: number): Float32Array {
  const length = input.length;
  const combDelays = scaleReverbDelays([29.7, 31.1, 33.8, 36.2, 39.7, 42.9], length, sampleRate, settings.stereoOffsetMs || 0);
  const allpassDelays = scaleReverbDelays([5.0, 7.7, 10.0], length, sampleRate, (settings.stereoOffsetMs || 0) * 0.5);
  const combs = combDelays.map(function (delay) {
    return { buffer: new Float32Array(Math.max(2, delay)), index: 0, filtered: 0 };
  });
  const preDelaySamples = Math.min(Math.max(0, Math.round(settings.preDelayMs / 1000 * sampleRate)), Math.max(0, length - 1));
  const preDelay = new Float32Array(Math.max(1, preDelaySamples + 1));
  let preIndex = 0;
  let wet: Float32Array = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const inputSample = input[i] ?? 0;
    let tankInput = inputSample;
    if (preDelaySamples > 0) {
      tankInput = preDelay[preIndex] ?? 0;
      preDelay[preIndex] = inputSample;
      preIndex = (preIndex + 1) % preDelay.length;
    }
    let combSum = 0;
    for (let c = 0; c < combs.length; c++) {
      const comb = combs[c]!;
      const combOut = comb.buffer[comb.index] ?? 0;
      comb.filtered = combOut * (1 - settings.damping) + comb.filtered * settings.damping;
      comb.buffer[comb.index] = clampSample(tankInput + comb.filtered * settings.roomFeedback);
      comb.index = (comb.index + 1) % comb.buffer.length;
      combSum += combOut;
    }
    wet[i] = combSum / Math.max(1, combs.length) * 1.85;
  }
  for (let a = 0; a < allpassDelays.length; a++) {
    wet = applyReverbAllpass(wet, allpassDelays[a]!, 0.5);
  }
  normalizeMono(wet);
  return wet;
}

function scaleReverbDelays(delaysMs: number[], sliceLength: number, sampleRate: number, offsetMs: number): number[] {
  const maxDelaySamples = Math.max(2, Math.floor(sliceLength * 0.72));
  const delays = delaysMs.map(function (ms) {
    return Math.max(2, Math.round((ms + offsetMs) / 1000 * sampleRate));
  });
  const largest = Math.max.apply(null, delays);
  const scale = largest > maxDelaySamples ? maxDelaySamples / largest : 1;
  return delays.map(function (delay, index) {
    return Math.max(2, Math.round(delay * scale) + index);
  });
}

function applyReverbAllpass(input: Float32Array, delay: number, feedback: number): Float32Array {
  const output = new Float32Array(input.length);
  const buffer = new Float32Array(Math.max(2, delay));
  let index = 0;
  for (let i = 0; i < input.length; i++) {
    const value = input[i] ?? 0;
    const buffered = buffer[index] ?? 0;
    const out = -value + buffered;
    buffer[index] = value + buffered * feedback;
    output[i] = out;
    index = (index + 1) % buffer.length;
  }
  return output;
}

function gatedEnvelope(i: number, length: number, hold: number, fade: number): number {
  const pos = i / Math.max(1, length - 1);
  if (pos < hold) return 1;
  const fadePos = (pos - hold) / Math.max(0.001, fade);
  if (fadePos >= 1) return 0;
  return Math.pow(1 - fadePos, 0.25);
}

export function pitchShiftDurationLocked(input: Float32Array, ratio: number): Float32Array {
  if (!input.length || Math.abs(ratio - 1) < 0.000001) return copyFloatArray(input);
  const stretchedLength = Math.max(1, Math.round(input.length * ratio));
  const stretched = timeStretchSola(input, stretchedLength);
  return resampleArray(stretched, input.length);
}

function timeStretchSola(input: Float32Array, outputLength: number): Float32Array {
  if (outputLength === input.length) return copyFloatArray(input);
  if (input.length < 128 || outputLength < 128) return resampleArray(input, outputLength);
  const ratio = outputLength / input.length;
  const windowSize = Math.min(2048, Math.max(256, Math.floor(input.length / 4)));
  const overlap = Math.floor(windowSize / 2);
  const synthesisHop = Math.max(32, windowSize - overlap);
  const analysisHop = synthesisHop / ratio;
  const output = new Float32Array(outputLength + windowSize);
  const weights = new Float32Array(output.length);
  for (let outputStart = 0; outputStart < outputLength; outputStart += synthesisHop) {
    const expectedInputStart = Math.round((outputStart / synthesisHop) * analysisHop);
    const inputStart = outputStart === 0 ? 0 : findBestSolaOffset(input, output, outputStart, expectedInputStart, windowSize, overlap);
    const available = Math.min(windowSize, input.length - inputStart, output.length - outputStart);
    for (let i = 0; i < available; i++) {
      const phase = i / Math.max(1, available - 1);
      const windowValue = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
      output[outputStart + i] = (output[outputStart + i] ?? 0) + (input[inputStart + i] ?? 0) * windowValue;
      weights[outputStart + i] = (weights[outputStart + i] ?? 0) + windowValue;
    }
  }
  const normalized = new Float32Array(outputLength);
  for (let j = 0; j < outputLength; j++) normalized[j] = weights[j]! > 0 ? output[j]! / weights[j]! : 0;
  return normalized;
}

function findBestSolaOffset(
  input: Float32Array,
  output: Float32Array,
  outputStart: number,
  expectedInputStart: number,
  windowSize: number,
  overlap: number,
): number {
  const maxInputStart = Math.max(0, input.length - windowSize);
  const searchRadius = Math.min(overlap, 1024);
  const searchStep = 32;
  const compareStep = 8;
  let bestOffset = Math.max(0, Math.min(maxInputStart, expectedInputStart));
  let bestScore = Number.POSITIVE_INFINITY;
  const from = Math.max(0, bestOffset - searchRadius);
  const to = Math.min(maxInputStart, bestOffset + searchRadius);
  for (let candidate = from; candidate <= to; candidate += searchStep) {
    let score = 0;
    let count = 0;
    for (let i = 0; i < overlap; i += compareStep) {
      const existing = output[outputStart + i] ?? 0;
      const incoming = input[candidate + i] ?? 0;
      const diff = existing - incoming;
      score += diff * diff;
      count++;
    }
    if (count > 0 && score < bestScore) {
      bestScore = score;
      bestOffset = candidate;
    }
  }
  return bestOffset;
}

export function resampleArray(input: Float32Array, outputLength: number): Float32Array {
  const output = new Float32Array(outputLength);
  if (!input.length || outputLength <= 0) return output;
  if (outputLength === 1) {
    output[0] = input[0] ?? 0;
    return output;
  }
  const scale = (input.length - 1) / (outputLength - 1);
  for (let i = 0; i < outputLength; i++) {
    const position = i * scale;
    const indexA = Math.floor(position);
    const indexB = Math.min(input.length - 1, indexA + 1);
    const t = position - indexA;
    output[i] = (input[indexA] ?? 0) + ((input[indexB] ?? 0) - (input[indexA] ?? 0)) * t;
  }
  return output;
}

export function readInterpolatedClamped(buffer: Float32Array, position: number): number {
  if (!buffer.length) return 0;
  if (position <= 0) return buffer[0] ?? 0;
  if (position >= buffer.length - 1) return buffer[buffer.length - 1] ?? 0;
  const a = Math.floor(position);
  const b = a + 1;
  const t = position - a;
  return (buffer[a] ?? 0) * (1 - t) + (buffer[b] ?? 0) * t;
}

export function copyFloatArray(input: Float32Array): Float32Array {
  const output = new Float32Array(input.length);
  output.set(input);
  return output;
}

export function edgeFade(index: number, length: number): number {
  const fadeLength = Math.min(96, Math.floor(length / 2));
  if (fadeLength <= 0) return 1;
  if (index < fadeLength) return index / fadeLength;
  if (index >= length - fadeLength) return (length - 1 - index) / fadeLength;
  return 1;
}

export function normalizePair(left: Float32Array, right: Float32Array): void {
  let peak = 0;
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i] ?? 0), Math.abs(right[i] ?? 0));
  if (peak <= 0.95 || peak === 0) return;
  const gain = 0.95 / peak;
  for (let j = 0; j < left.length; j++) {
    left[j] = (left[j] ?? 0) * gain;
    right[j] = (right[j] ?? 0) * gain;
  }
}

export function normalizeMono(samples: Float32Array): void {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i] ?? 0));
  }
  if (peak <= 0.98 || peak === 0) return;
  const gain = 0.98 / peak;
  for (let j = 0; j < samples.length; j++) {
    samples[j] = (samples[j] ?? 0) * gain;
  }
}

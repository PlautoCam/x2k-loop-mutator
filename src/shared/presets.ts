import type {
  PatternPreset,
  PatternRandomSettings,
  PatternSettings,
  PatternValue,
} from "./types.js";
import { MAX_SLICES } from "./slice-modes.js";

export const MAX_USER_PRESETS = 64;
export const MAX_PRESET_NAME_LENGTH = 40;
// Number of editor snapshot slots; shared by the editor UI and result validation.
export const SNAPSHOT_SLOTS = 8;
export const USER_PRESET_FILENAME = "user-presets.json";
export const PRESET_EXPORT_FILENAME = "x2k-loop-mutator-user-presets.json";

export const PATTERN_LANE_KEYS = [
  "order",
  "reverse",
  "stutter",
  "pitch",
  "tape",
  "filter",
  "filterEnvDirLane",
  "filterTypeLane",
  "flanger",
  "bitcrush",
  "reverb",
] as const;

type LaneKey = (typeof PATTERN_LANE_KEYS)[number];
type SequenceOverrides = Partial<Record<LaneKey, PatternValue[]>>;

// Per-lane randomization defaults applied when a lane has no stored settings.
// This is the single authority used by persistence defaults, host-side
// validation bounds, and the editor runtime's randomizer.
export function laneDefaultRandomSettings(laneKey: string): PatternRandomSettings {
  if (laneKey === "pitch") return { min: -12, max: 12, freq: 0 };
  if (laneKey === "reverse" || laneKey === "filterTypeLane" || laneKey === "filterEnvDirLane") {
    return { min: 0, max: 1, freq: 0 };
  }
  if (laneKey === "order") return { min: 1, max: MAX_SLICES, freq: 0 };
  return { min: 1, max: 9, freq: 0 };
}

// Inclusive [min, max] bounds a lane's randomization range may span. Used both
// to validate persisted presets and to clamp editor input.
export function laneRandomBounds(laneKey: string): readonly [number, number] {
  if (laneKey === "pitch") return [-12, 12];
  if (laneKey === "order") return [1, MAX_SLICES];
  if (laneKey === "reverse" || laneKey === "filterTypeLane" || laneKey === "filterEnvDirLane") return [0, 1];
  return [0, 9];
}

const DEFAULT_RANDOM_SETTINGS: Record<LaneKey, PatternRandomSettings> =
  Object.fromEntries(
    PATTERN_LANE_KEYS.map((key) => [key, laneDefaultRandomSettings(key)]),
  ) as Record<LaneKey, PatternRandomSettings>;

function makeFactorySettings(
  sequences: SequenceOverrides,
  filter: Partial<Pick<
    PatternSettings,
    | "filterType"
    | "filterCutoff"
    | "filterResonance"
    | "filterDrive"
    | "filterAttack"
    | "filterDecay"
    | "filterEnvDirection"
  >> = {},
): PatternSettings {
  const defaults: Record<LaneKey, PatternValue[]> = {
    order: [],
    reverse: ["F"],
    stutter: [0],
    pitch: [0],
    tape: [0],
    filter: [0],
    filterEnvDirLane: ["-"],
    filterTypeLane: ["-"],
    flanger: [0],
    bitcrush: [0],
    reverb: [0],
  };

  return {
    sliceMode: "quarter",
    outputMode: "source",
    outputBars: 1,
    filterType: filter.filterType ?? "LP",
    filterCutoff: filter.filterCutoff ?? 500,
    filterResonance: filter.filterResonance ?? 0.35,
    filterDrive: filter.filterDrive ?? 0,
    filterAttack: filter.filterAttack ?? 0,
    filterDecay: filter.filterDecay ?? 0.45,
    filterEnvDirection: filter.filterEnvDirection ?? "UP",
    sequences: { ...defaults, ...sequences },
    randomSettings: Object.fromEntries(
      PATTERN_LANE_KEYS.map((key) => [key, { ...DEFAULT_RANDOM_SETTINGS[key] }]),
    ),
  };
}

function factory(id: string, name: string, settings: PatternSettings): PatternPreset {
  return { id: `factory:${id}`, name, kind: "factory", settings };
}

export const FACTORY_PRESETS: PatternPreset[] = [
  factory("subtle-shuffle", "Subtle Shuffle", makeFactorySettings({
    stutter: [0, 0, 1, 0],
  })),
  factory("reverse-touch", "Reverse Touch", makeFactorySettings({
    reverse: ["F", "F", "R", "F"],
  })),
  factory("offbeat-stutter", "Offbeat Stutter", makeFactorySettings({
    stutter: [0, 1, 0, 3],
  })),
  factory("stutter-build-up", "Stutter Build Up", makeFactorySettings({
    stutter: [0, 1, 2, 3, 4, 5, 6, 8],
  })),
  factory("pitch-flicker", "Pitch Flicker", makeFactorySettings({
    pitch: [0, 1, 0, -2],
  })),
  factory("downpitch-drag", "Downpitch Drag", makeFactorySettings({
    pitch: [0, -3, -7, -12],
    tape: [0, 0, 2, 5],
  })),
  factory("filter-pulse", "Filter Pulse", makeFactorySettings({
    filter: [8, 0, 6, 0, 4, 0, 2, 0],
    filterEnvDirLane: ["UP", "-", "UP", "-", "UP", "-", "UP", "-"],
  }, {
    filterCutoff: 650,
    filterResonance: 0.5,
    filterAttack: 0.08,
    filterDecay: 0.55,
  })),
  factory("bitcrush-sparks", "Bitcrush Sparks", makeFactorySettings({
    bitcrush: [0, 0, 3, 0, 0, 6, 0, 2],
  })),
  factory("glitch-steps", "Glitch Steps", makeFactorySettings({
    reverse: ["F", "R", "F", "F"],
    stutter: [0, 2, 0, 5],
    pitch: [0, 0, 3, -3],
    flanger: [0, 2, 0, 0],
  })),
  factory("full-mutation", "Full Mutation", makeFactorySettings({
    reverse: ["F", "R", "F", "R"],
    stutter: [0, 4, 2, 6],
    pitch: [0, 5, -5, -12],
    tape: [0, 0, 3, 6],
    filter: [3, 6, 0, 8],
    filterEnvDirLane: ["UP", "DN", "-", "UP"],
    filterTypeLane: ["LP", "BP", "-", "HP"],
    flanger: [0, 3, 5, 0],
    bitcrush: [0, 2, 0, 7],
    reverb: [0, 3, 0, 7],
  }, {
    filterCutoff: 850,
    filterResonance: 0.62,
    filterDrive: 0.18,
    filterAttack: 0.04,
    filterDecay: 0.62,
  })),
];

export function normalizePresetName(value: string): string {
  return value.trim().slice(0, MAX_PRESET_NAME_LENGTH);
}

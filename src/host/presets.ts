import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { PatternPreset, PatternSettings, UserPresetFile } from "../shared/types.js";
import {
  MAX_PRESET_NAME_LENGTH,
  MAX_USER_PRESETS,
  PRESET_EXPORT_FILENAME,
  USER_PRESET_FILENAME,
  normalizePresetName,
} from "../shared/presets.js";
import { parseUserPresetFileJson } from "../shared/validation.js";

export interface LoadedUserPresets {
  presets: PatternPreset[];
  notice?: string;
}

// Result of replacing the persisted user-preset collection.
export interface ReplaceUserPresetsResult {
  presets: PatternPreset[];
  notice: string;
}

export async function loadUserPresets(storageDirectory: string | undefined): Promise<LoadedUserPresets> {
  if (!storageDirectory) {
    return { presets: [], notice: "Persistent preset storage is unavailable." };
  }

  try {
    const json = await fs.readFile(path.join(storageDirectory, USER_PRESET_FILENAME), "utf8");
    const parsed = parseUserPresetFileJson(json);
    const ids = new Set<string>();
    const presets = parsed.presets.slice(0, MAX_USER_PRESETS).map((entry) => {
      let id = entry.id && !ids.has(entry.id) ? entry.id : `user:${randomUUID()}`;
      if (!id.startsWith("user:")) id = `user:${id}`;
      while (ids.has(id)) id = `user:${randomUUID()}`;
      ids.add(id);
      return { id, name: entry.name, kind: "user" as const, settings: entry.settings };
    });
    const skipped = parsed.errors.length + Math.max(0, parsed.presets.length - MAX_USER_PRESETS);
    return {
      presets,
      notice: skipped ? `Loaded user presets; ignored ${skipped} invalid or excess entr${skipped === 1 ? "y" : "ies"}.` : undefined,
    };
  } catch (error) {
    // A missing file is the normal first-run state and must load silently.
    if (errCodeOf(error) === "ENOENT") return { presets: [] };
    console.warn("[x2k Loop Mutator] Could not load user presets.", error);
    return { presets: [], notice: "User presets could not be loaded; the preset file is invalid or unreadable." };
  }
}

// Replaces the persisted collection with the editor's validated in-memory user
// presets when the editor naturally closes or exports audio.
export async function replaceUserPresets(
  storageDirectory: string | undefined,
  json: string,
): Promise<ReplaceUserPresetsResult> {
  requireStorageDirectory(storageDirectory);
  const parsed = parseUserPresetFileJson(json);
  const presets: PatternPreset[] = [];

  for (const entry of parsed.presets.slice(0, MAX_USER_PRESETS)) {
    presets.push({
      id: `user:${randomUUID()}`,
      name: makeUniqueName(entry.name, presets),
      kind: "user",
      settings: entry.settings,
    });
  }

  await writeUserPresets(storageDirectory, presets);
  const skipped = parsed.errors.length + Math.max(0, parsed.presets.length - MAX_USER_PRESETS);
  return {
    presets,
    notice: skipped
      ? `Saved ${presets.length} user presets and ignored ${skipped} invalid or excess entries.`
      : `Saved ${presets.length} user preset${presets.length === 1 ? "" : "s"}.`,
  };
}


export async function exportUserPresetsToStorage(
  storageDirectory: string | undefined,
  json: string,
): Promise<string> {
  requireStorageDirectory(storageDirectory);
  const parsed = parseUserPresetFileJson(json);
  if (parsed.errors.length) {
    throw new Error(`Preset export contains ${parsed.errors.length} invalid entr${parsed.errors.length === 1 ? "y" : "ies"}.`);
  }
  if (parsed.presets.length > MAX_USER_PRESETS) {
    throw new Error(`Preset export exceeds the ${MAX_USER_PRESETS}-preset limit.`);
  }

  const file: UserPresetFile = {
    version: 1,
    presets: parsed.presets.map((entry) => ({
      name: entry.name,
      settings: entry.settings,
    })),
  };
  await fs.mkdir(storageDirectory, { recursive: true });
  const exportPath = path.join(storageDirectory, PRESET_EXPORT_FILENAME);
  await fs.writeFile(exportPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  return exportPath;
}

async function writeUserPresets(storageDirectory: string, presets: PatternPreset[]): Promise<void> {
  await fs.mkdir(storageDirectory, { recursive: true });
  const file: UserPresetFile = {
    version: 1,
    presets: presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      settings: preset.settings,
    })),
  };
  await fs.writeFile(path.join(storageDirectory, USER_PRESET_FILENAME), `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function makeUniqueName(requestedName: string, presets: PatternPreset[]): string {
  const existing = new Set(presets.map((preset) => preset.name.toLocaleLowerCase()));
  const base = normalizePresetName(requestedName) || "Imported Preset";
  if (!existing.has(base.toLocaleLowerCase())) return base;

  for (let suffix = 2; suffix < 10_000; suffix++) {
    const suffixText = ` ${suffix}`;
    const candidate = `${base.slice(0, MAX_PRESET_NAME_LENGTH - suffixText.length).trimEnd()}${suffixText}`;
    if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${base.slice(0, MAX_PRESET_NAME_LENGTH - 9)} ${randomUUID().slice(0, 8)}`;
}

function requireStorageDirectory(storageDirectory: string | undefined): asserts storageDirectory is string {
  if (!storageDirectory) throw new Error("Persistent preset storage is unavailable.");
}

// Live's Extension Host serves node:fs through its own layer, and thrown
// errors can originate in a different module realm where `instanceof Error`
// is unreliable (a plain first-run ENOENT was misclassified this way).
// Detect errno codes by shape instead of prototype.
export function errCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

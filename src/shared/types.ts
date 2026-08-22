export type SourceKind = "arrangement";

export type PatternValue =
  | number
  | "F"
  | "R"
  | "-"
  | "LP"
  | "BP"
  | "HP"
  | "NT"
  | "NOTCH"
  | "UP"
  | "DN"
  | "DOWN";

export interface PatternRandomSettings {
  min: number;
  max: number;
  freq: number;
}

export interface PatternSettings {
  sliceMode: string;
  outputMode: "source" | "bars";
  outputBars: number;
  filterType: "LP" | "BP" | "HP" | "NOTCH";
  filterCutoff: number;
  filterResonance: number;
  filterDrive: number;
  filterAttack: number;
  filterDecay: number;
  filterEnvDirection: "UP" | "DOWN";
  sequences: Record<string, PatternValue[]>;
  randomSettings?: Record<string, PatternRandomSettings>;
}

export type PresetKind = "factory" | "user";

export interface PatternPreset {
  id: string;
  name: string;
  kind: PresetKind;
  settings: PatternSettings;
}

export interface UserPresetFile {
  version: 1;
  presets: Array<{
    id?: string;
    name: string;
    settings: PatternSettings;
  }>;
}

export interface EditorSnapshotState {
  label: string;
  settings: PatternSettings;
}

export interface EditorSessionState {
  settings: PatternSettings;
  snapshots: Array<EditorSnapshotState | null>;
  selectedSnapshotIndex: number;
  queuedSnapshots: number[];
  randomizeAllLocks: Record<string, boolean>;
  selectedPresetId: string | null;
  hadResult: boolean;
}

// Loopback endpoints exposed by the host for immediate preset persistence.
// Requests must send the per-dialog secret via authHeaderName/authToken; the
// header (not the URL) carries the credential so cross-site requests cannot
// bypass CORS preflight.
export interface EditorPersistenceApi {
  presetsUrl: string;
  exportUrl: string;
  revealUrl: string;
  authHeaderName: string;
  authToken: string;
}

export interface EditorPresetBootstrap {
  presets: PatternPreset[];
  persistenceApi?: EditorPersistenceApi;
  session?: EditorSessionState;
  notice?: string;
}

export interface ExportRender {
  label: string;
  sampleRate: number;
  leftBase64: string;
  rightBase64: string;
  settings: PatternSettings;
}

export type EditorDialogResult = ExportResult | EditorCloseResult;

export interface ExportResult {
  action: "export";
  mode: "current" | "queue";
  renders: ExportRender[];
  userPresetsJson: string;
}

export interface EditorCloseResult {
  action: "close";
  userPresetsJson: string;
}

export interface EditorSource {
  kind: SourceKind;
  title: string;
  tempo: number;
  startBeat: number;
  durationBeats: number;
  timingKind:
    | "warped-live-playback"
    | "filename"
    | "onsets"
    | "song-tempo-fallback";
  sampleRate: number;
  leftBase64: string;
  rightBase64: string;
}

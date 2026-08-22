import type { ArrangementSelection } from "@ableton-extensions/sdk";

export const ARRANGEMENT_CONTEXT_MENU_SCOPE = "AudioTrack.ArrangementSelection" as const;

export function isArrangementSelection(value: unknown): value is ArrangementSelection {
  if (typeof value !== "object" || value === null) return false;
  const selection = value as Partial<ArrangementSelection>;
  return Number.isFinite(selection.time_selection_start) &&
    Number.isFinite(selection.time_selection_end) &&
    Array.isArray(selection.selected_lanes);
}

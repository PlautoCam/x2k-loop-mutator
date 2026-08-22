/*
 * Slice-grid constants shared by the extension host (source model logging,
 * export placement) and the editor runtime (slicing UI).
 */

// Upper bound on generated slices; also drives which slice-length options
// are enabled for a given clip duration.
export const MAX_SLICES = 16;

export type SliceModeName = "half" | "quarter" | "eighth";

export const SLICE_MODES: readonly SliceModeName[] = ["half", "quarter", "eighth"];

export function sliceLengthBeats(sliceMode: string): number {
  if (sliceMode === "half") return 2;
  if (sliceMode === "quarter") return 1;
  if (sliceMode === "eighth") return 0.5;
  return 1;
}

export function sliceCountForDuration(sliceMode: string, durationBeats: number): number {
  return Math.ceil(durationBeats / sliceLengthBeats(sliceMode));
}

export function sliceModeLabel(sliceMode: string): string {
  if (sliceMode === "half") return "1/2";
  if (sliceMode === "quarter") return "1/4";
  return "1/8";
}

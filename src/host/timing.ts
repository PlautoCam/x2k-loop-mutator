const MIN_SOURCE_BPM = 40;
const MAX_SOURCE_BPM = 240;

export interface BeatSampleMarker {
  sampleTime: number;
  beatTime: number;
}

export interface WarpedMarkerTiming {
  startSampleTime: number;
  endSampleTime: number;
  durationSeconds: number;
  tempo: number;
}

export function safePositiveDuration(value: number, fallback: number, label: string): number {
  const safeFallback = Number.isFinite(fallback) && fallback > 0 ? fallback : 1;

  if (Number.isFinite(value) && value > 0) {
    return value;
  }

  console.warn("[x2k Loop Mutator] Invalid duration; using fallback.", {
    label,
    invalidDurationWasFinite: Number.isFinite(value),
    fallbackDuration: safeFallback,
  });

  return safeFallback;
}

// Pulls optional BPM/bar hints from filenames and clip names for unwarped audio.
export function parseTimingFromName(text: string): { bpm: number | null; bars: number | null } {
  const lower = String(text || "").toLowerCase();
  const explicitBpmMatch = lower.match(/([0-9]+(?:\.[0-9]+)?)\s*bpm/);
  const implicitBpmMatch = lower.match(
    /(?:^|[^0-9])([6-9][0-9](?:\.[0-9]+)?|1[0-9][0-9](?:\.[0-9]+)?|2[0-3][0-9](?:\.[0-9]+)?)(?:[^0-9.]|$)/,
  );
  const barsMatch = lower.match(/(?:^|[^0-9])([1248])\s*[-_ ]?\s*(?:bar|bars)(?:[^a-z]|$)/);
  const bpm = explicitBpmMatch
    ? clampSourceBpm(Number(explicitBpmMatch[1]))
    : implicitBpmMatch
      ? clampSourceBpm(Number(implicitBpmMatch[1]))
      : null;

  return {
    bpm,
    bars: barsMatch ? parseInt(barsMatch[1]!, 10) : null,
  };
}

// Snaps near-common loop lengths to stable beat counts for editor ergonomics.
export function snapDurationBeats(beats: number): number {
  const clamped = safePositiveDuration(beats, 1, "source duration beats");
  const targets = [1, 2, 4, 8, 16, 32];

  for (const target of targets) {
    if (Math.abs(clamped - target) <= 0.25) return target;
  }

  return clamped;
}

// Maps a clip beat position into source-file seconds using the SDK warp-marker
// pairs. Boundary positions outside the marker range use the closest segment,
// matching Live's linear continuation at the edge of a warp map.
export function interpolateSampleTimeAtBeat(
  markers: readonly BeatSampleMarker[],
  beatTime: number,
): number | null {
  const sorted = markers
    .filter((marker) => Number.isFinite(marker.beatTime) && Number.isFinite(marker.sampleTime))
    .slice()
    .sort((a, b) => a.beatTime - b.beatTime);

  if (sorted.length < 2 || !Number.isFinite(beatTime)) return null;

  let left = sorted[0]!;
  let right = sorted[1]!;

  if (beatTime >= sorted[sorted.length - 1]!.beatTime) {
    left = sorted[sorted.length - 2]!;
    right = sorted[sorted.length - 1]!;
  } else if (beatTime > left.beatTime) {
    for (let index = 1; index < sorted.length; index++) {
      right = sorted[index]!;
      if (beatTime <= right.beatTime) {
        left = sorted[index - 1]!;
        break;
      }
    }
  }

  const beatSpan = right.beatTime - left.beatTime;
  const sampleSpan = right.sampleTime - left.sampleTime;
  if (!Number.isFinite(beatSpan) || beatSpan <= 0 || !Number.isFinite(sampleSpan)) return null;

  return left.sampleTime + (beatTime - left.beatTime) * sampleSpan / beatSpan;
}

// Resolves the physical duration and average source tempo of a selected warped
// beat interval. This is the closest SDK-exposed equivalent to Clip View's
// Sample/Seg. BPM and deliberately does not consult the song tempo.
export function getWarpedMarkerTiming(
  markers: readonly BeatSampleMarker[],
  startBeat: number,
  endBeat: number,
): WarpedMarkerTiming | null {
  const durationBeats = endBeat - startBeat;
  if (!Number.isFinite(durationBeats) || durationBeats <= 0) return null;

  const startSampleTime = interpolateSampleTimeAtBeat(markers, startBeat);
  const endSampleTime = interpolateSampleTimeAtBeat(markers, endBeat);
  if (startSampleTime === null || endSampleTime === null) return null;

  const durationSeconds = endSampleTime - startSampleTime;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;

  return {
    startSampleTime,
    endSampleTime,
    durationSeconds,
    tempo: clampSourceBpm(durationBeats * 60 / durationSeconds),
  };
}

// Estimates tempo from simple onset spacing when no filename timing exists.
// This is intentionally lightweight and does not alter audio output.
export function estimateOnsetBpm(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): number | null {
  const hop = 512;
  const frame = 1024;
  const env: number[] = [];

  for (let pos = 0; pos + frame < left.length; pos += hop) {
    let sum = 0;
    for (let i = 0; i < frame; i += 4) {
      const l = left[pos + i] || 0;
      const r = right[pos + i] || l;
      sum += Math.abs(l) + Math.abs(r);
    }
    env.push(sum / (frame / 4));
  }

  if (env.length < 8) return null;

  const flux: number[] = [];
  for (let i = 1; i < env.length; i++) {
    flux.push(Math.max(0, env[i]! - env[i - 1]!));
  }

  const mean = flux.reduce((total, value) => total + value, 0) / flux.length;
  const variance = flux.reduce((total, value) => {
    const difference = value - mean;
    return total + difference * difference;
  }, 0) / flux.length;
  const threshold = mean + Math.sqrt(variance) * 1.25;
  const minGap = Math.round(0.11 * sampleRate / hop);
  const peaks: number[] = [];
  let lastPeak = -9999;

  for (let i = 1; i < flux.length - 1; i++) {
    if (
      flux[i]! > threshold &&
      flux[i]! >= flux[i - 1]! &&
      flux[i]! >= flux[i + 1]! &&
      i - lastPeak >= minGap
    ) {
      peaks.push(i * hop / sampleRate);
      lastPeak = i;
    }
  }

  if (peaks.length < 4) return null;

  const intervals: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    const gap = peaks[i]! - peaks[i - 1]!;
    if (gap > 0.12 && gap < 1.2) intervals.push(gap);
  }

  if (intervals.length < 3) return null;

  intervals.sort((a, b) => a - b);
  return clampSourceBpm(normalizeEstimatedBpm(60 / intervals[Math.floor(intervals.length / 2)]!));
}

// Folds extreme onset-derived tempos into a practical loop BPM range.
export function normalizeEstimatedBpm(bpm: number): number {
  let normalized = bpm;
  while (normalized < 70) normalized *= 2;
  while (normalized > 180) normalized /= 2;
  return normalized;
}

// Clamps source BPM to the supported editor timing range.
export function clampSourceBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 120;
  return Math.max(MIN_SOURCE_BPM, Math.min(MAX_SOURCE_BPM, Math.round(bpm * 10) / 10));
}

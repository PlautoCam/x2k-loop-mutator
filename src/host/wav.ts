export interface AudioData {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

const SAMPLE_RATE = 48_000;
const AUDIBLE_RMS_THRESHOLD = 0.003;

// Bridge codecs are shared with the editor runtime; see shared/int16-codec.ts.
export { decodeInt16Base64 as int16Base64ToFloat } from "../shared/int16-codec.js";
export { encodeInt16Base64 as floatToInt16Base64 } from "../shared/int16-codec.js";

// Dispatches supported audio containers to the appropriate decoder.
export function decodeAudioFile(buffer: Buffer): AudioData {
  const header = buffer.toString("ascii", 0, 12);

  if (header.startsWith("RIFF") && header.slice(8, 12) === "WAVE") {
    return decodeWav(buffer);
  }

  if (
    header.startsWith("FORM") &&
    (header.slice(8, 12) === "AIFF" || header.slice(8, 12) === "AIFC")
  ) {
    return decodeAiff(buffer);
  }

  throw new Error(`Unsupported audio format. Header=${header}`);
}

// Decodes PCM/float WAV data and resamples to the internal 48 kHz rate.
function decodeWav(buffer: Buffer): AudioData {
  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (id === "fmt ") {
      audioFormat = buffer.readUInt16LE(chunkStart);
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    }

    if (id === "data") {
      dataOffset = chunkStart;
      dataSize = size;
      break;
    }

    offset = chunkStart + size + (size % 2);
  }

  if (dataOffset < 0 || channels < 1) {
    throw new Error("Invalid WAV file.");
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (channels * bytesPerSample));
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    const l = readWavSample(buffer, dataOffset, i, 0, channels, bytesPerSample, audioFormat, bitsPerSample);
    const r = channels > 1
      ? readWavSample(buffer, dataOffset, i, 1, channels, bytesPerSample, audioFormat, bitsPerSample)
      : l;
    left[i] = l;
    right[i] = r;
  }

  if (sampleRate === SAMPLE_RATE) {
    return { sampleRate, left, right };
  }

  return resampleTo48k({ sampleRate, left, right });
}

// Decodes AIFF/AIFC data, including Ableton's ambiguous AIFC compression tag,
// then resamples to the internal 48 kHz rate when needed.
function decodeAiff(buffer: Buffer): AudioData {
  const formType = buffer.toString("ascii", 8, 12);
  let offset = 12;
  let channels = 0;
  let sampleFrames = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let compressionType = "NONE";
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32BE(offset + 4);
    const chunkStart = offset + 8;

    if (id === "COMM") {
      if (size < 18) {
        throw new Error("Invalid AIFF COMM chunk.");
      }

      channels = buffer.readUInt16BE(chunkStart);
      sampleFrames = buffer.readUInt32BE(chunkStart + 2);
      bitsPerSample = buffer.readUInt16BE(chunkStart + 6);
      sampleRate = readExtended80(buffer, chunkStart + 8);

      if (formType === "AIFC" && size >= 22) {
        compressionType = buffer.toString("ascii", chunkStart + 18, chunkStart + 22);
      }
    }

    if (id === "SSND") {
      if (size < 8) {
        throw new Error("Invalid AIFF SSND chunk.");
      }

      const soundOffset = buffer.readUInt32BE(chunkStart);
      const sampleDataSize = Math.max(0, size - 8);

      dataOffset = chunkStart + 8 + Math.min(soundOffset, sampleDataSize);
      dataSize = Math.max(0, sampleDataSize - soundOffset);
    }

    offset = chunkStart + size + (size % 2);
  }

  if (dataOffset < 0 || channels < 1 || sampleRate <= 0) {
    throw new Error("Invalid AIFF file.");
  }

  const normalizedCompression = normalizeAiffCompression(compressionType);
  const bytesPerSample = getAiffBytesPerSample(bitsPerSample, normalizedCompression);
  const availableFrameCount = Math.floor(dataSize / (channels * bytesPerSample));
  const frameCount = sampleFrames > 0
    ? Math.min(sampleFrames, availableFrameCount)
    : availableFrameCount;

  if (frameCount <= 0) {
    throw new Error("AIFF file contains no readable sample frames.");
  }

  const resolvedCompression =
    normalizedCompression === "auto-able"
      ? resolveAbleAifcCompression(
          buffer,
          dataOffset,
          channels,
          bytesPerSample,
          bitsPerSample,
          frameCount,
        )
      : normalizedCompression;

  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    const l = readAiffSample(buffer, dataOffset, i, 0, channels, bytesPerSample, bitsPerSample, resolvedCompression);
    const r = channels > 1
      ? readAiffSample(buffer, dataOffset, i, 1, channels, bytesPerSample, bitsPerSample, resolvedCompression)
      : l;
    left[i] = l;
    right[i] = r;
  }

  if (sampleRate === SAMPLE_RATE) {
    return { sampleRate, left, right };
  }

  return resampleTo48k({ sampleRate, left, right });
}

// ---------------------------------------------------------------------------
// WAV/AIFF parsing
// ---------------------------------------------------------------------------

// Normalizes AIFF/AIFC compression tags into decoder modes.
function normalizeAiffCompression(compressionType: string): string {
  if (compressionType === "NONE" || compressionType === "twos" || compressionType === "\0\0\0\0") {
    return "pcm-be";
  }

  if (compressionType === "sowt") {
    return "pcm-le";
  }

  if (compressionType === "able") {
    return "auto-able";
  }

  if (compressionType === "fl32" || compressionType === "FL32") {
    return "float32-be";
  }

  if (compressionType === "fl64" || compressionType === "FL64") {
    return "float64-be";
  }

  throw new Error(`Unsupported AIFF/AIFC compression: ${compressionType}`);
}

// Computes bytes per sample for supported AIFF sample formats.
function getAiffBytesPerSample(bitsPerSample: number, compressionType: string): number {
  if (compressionType === "float32-be" || compressionType === "float32-le") {
    return 4;
  }

  if (compressionType === "float64-be" || compressionType === "float64-le") {
    return 8;
  }

  if (![8, 16, 24, 32, 64].includes(bitsPerSample)) {
    throw new Error(`Unsupported AIFF bit depth: ${bitsPerSample}`);
  }

  return Math.ceil(bitsPerSample / 8);
}

// Resolves Ableton AIFC "able" payload endianness/format by scoring candidates.
function resolveAbleAifcCompression(
  buffer: Buffer,
  dataOffset: number,
  channels: number,
  bytesPerSample: number,
  bitsPerSample: number,
  frameCount: number,
): string {
  const candidates =
    bitsPerSample === 32
      ? ["float32-le", "float32-be", "pcm-le", "pcm-be"]
      : bitsPerSample === 64
        ? ["float64-le", "float64-be"]
        : ["pcm-le", "pcm-be"];

  let best = candidates[0]!;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const score = scoreAiffCandidate(
      buffer,
      dataOffset,
      channels,
      bytesPerSample,
      bitsPerSample,
      frameCount,
      candidate,
    );

    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

// Scores a possible AIFF sample interpretation using plausibility metrics.
function scoreAiffCandidate(
  buffer: Buffer,
  dataOffset: number,
  channels: number,
  bytesPerSample: number,
  bitsPerSample: number,
  frameCount: number,
  compressionType: string,
): number {
  const stride = Math.max(1, Math.floor(frameCount / 4096));
  let previous = 0;
  let peak = 0;
  let sumSquares = 0;
  let sumDelta = 0;
  let count = 0;
  let invalid = 0;

  for (let frame = 0; frame < frameCount; frame += stride) {
    let sample = 0;

    try {
      sample = readAiffSample(
        buffer,
        dataOffset,
        frame,
        0,
        channels,
        bytesPerSample,
        bitsPerSample,
        compressionType,
      );
    } catch {
      return Number.POSITIVE_INFINITY;
    }

    if (!Number.isFinite(sample)) {
      invalid++;
      continue;
    }

    const abs = Math.abs(sample);
    peak = Math.max(peak, abs);
    sumSquares += sample * sample;

    if (count > 0) {
      sumDelta += Math.abs(sample - previous);
    }

    previous = sample;
    count++;
  }

  if (!count) {
    return Number.POSITIVE_INFINITY;
  }

  const rms = Math.sqrt(sumSquares / count);
  const averageDelta = sumDelta / Math.max(1, count - 1);
  const peakPenalty = peak > 1.05 ? peak * 100 : 0;
  const silencePenalty = peak < 0.000001 ? 10 : 0;

  return invalid * 1000 + peakPenalty + silencePenalty + rms * 0.2 + averageDelta;
}

// Reads the 80-bit extended sample-rate number used by AIFF COMM chunks.
export function readExtended80(buffer: Buffer, offset: number): number {
  const exponent = buffer.readUInt16BE(offset);
  const hiMantissa = buffer.readUInt32BE(offset + 2);
  const loMantissa = buffer.readUInt32BE(offset + 6);

  if (exponent === 0 && hiMantissa === 0 && loMantissa === 0) {
    return 0;
  }

  const sign = exponent & 0x8000 ? -1 : 1;
  const exp = (exponent & 0x7fff) - 16383;
  const mantissa = hiMantissa * Math.pow(2, -31) + loMantissa * Math.pow(2, -63);

  return Math.round(sign * mantissa * Math.pow(2, exp));
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Reads one WAV sample in the supported PCM/float formats.
function readWavSample(
  buffer: Buffer,
  dataOffset: number,
  frame: number,
  channel: number,
  channels: number,
  bytesPerSample: number,
  audioFormat: number,
  bitsPerSample: number,
): number {
  const pos = dataOffset + (frame * channels + channel) * bytesPerSample;

  if (audioFormat === 1 && bitsPerSample === 16) {
    return buffer.readInt16LE(pos) / 32768;
  }

  if (audioFormat === 1 && bitsPerSample === 24) {
    const raw = buffer[pos]! | (buffer[pos + 1]! << 8) | (buffer[pos + 2]! << 16);
    const signed = raw & 0x800000 ? raw | 0xff000000 : raw;
    return signed / 8_388_608;
  }

  if (audioFormat === 3 && bitsPerSample === 32) {
    return buffer.readFloatLE(pos);
  }

  throw new Error(`Unsupported WAV format. audioFormat=${audioFormat}, bitsPerSample=${bitsPerSample}`);
}

// Reads one AIFF/AIFC sample in the resolved sample format.
function readAiffSample(
  buffer: Buffer,
  dataOffset: number,
  frame: number,
  channel: number,
  channels: number,
  bytesPerSample: number,
  bitsPerSample: number,
  compressionType: string,
): number {
  const pos = dataOffset + (frame * channels + channel) * bytesPerSample;
  const littleEndian = compressionType === "pcm-le";

  if (compressionType === "float32-be" || compressionType === "float32-le") {
    return clamp(compressionType === "float32-le" ? buffer.readFloatLE(pos) : buffer.readFloatBE(pos));
  }

  if (compressionType === "float64-be" || compressionType === "float64-le") {
    return clamp(compressionType === "float64-le" ? buffer.readDoubleLE(pos) : buffer.readDoubleBE(pos));
  }

  if (bitsPerSample === 8) {
    return buffer.readInt8(pos) / 128;
  }

  if (bitsPerSample === 16) {
    return littleEndian ? buffer.readInt16LE(pos) / 32768 : buffer.readInt16BE(pos) / 32768;
  }

  if (bitsPerSample === 24) {
    const raw = littleEndian
      ? buffer[pos]! | (buffer[pos + 1]! << 8) | (buffer[pos + 2]! << 16)
      : (buffer[pos]! << 16) | (buffer[pos + 1]! << 8) | buffer[pos + 2]!;
    const signed = raw & 0x800000 ? raw | 0xff000000 : raw;
    return signed / 8_388_608;
  }

  if (bitsPerSample === 32) {
    return littleEndian ? buffer.readInt32LE(pos) / 2_147_483_648 : buffer.readInt32BE(pos) / 2_147_483_648;
  }

  throw new Error(`Unsupported AIFF format. compression=${compressionType}, bitsPerSample=${bitsPerSample}`);
}

// Resamples decoded audio to the internal rate with linear interpolation.
function resampleTo48k(audio: AudioData): AudioData {
  const ratio = SAMPLE_RATE / audio.sampleRate;
  const outputLength = Math.max(1, Math.floor(audio.left.length * ratio));
  const left = new Float32Array(outputLength);
  const right = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i / ratio;
    const indexA = Math.floor(sourceIndex);
    const indexB = Math.min(indexA + 1, audio.left.length - 1);
    const t = sourceIndex - indexA;

    left[i] = lerp(audio.left[indexA] ?? 0, audio.left[indexB] ?? 0, t);
    right[i] = lerp(audio.right[indexA] ?? 0, audio.right[indexB] ?? 0, t);
  }

  return { sampleRate: SAMPLE_RATE, left, right };
}

// Rejects silent or near-silent source captures before opening the editor.
export function hasAudibleAudio(audio: AudioData): boolean {
  return getRms(audio.left, audio.right) > AUDIBLE_RMS_THRESHOLD;
}

// Calculates RMS from a sparse sample scan for fast audibility checks.
function getRms(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  let count = 0;

  for (let i = 0; i < left.length; i += 16) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    sum += l * l + r * r;
    count += 2;
  }

  return count ? Math.sqrt(sum / count) : 0;
}

// ---------------------------------------------------------------------------


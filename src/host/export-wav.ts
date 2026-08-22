export type WavMetadataChunkOrder = "metadata-before-data" | "metadata-after-data";
export type AcidFlagsMode = "stretch-root-acidizer" | "root-acidizer" | "acidizer-only";

export interface WavMetadataPolicy {
  id: string;
  chunkOrder: WavMetadataChunkOrder;
  acidFlagsMode: AcidFlagsMode;
}

// Ordered diagnostic matrix for warped exports. The leading candidate comes
// first; the current production policy remains last as the control.
export const WARPED_EXPORT_METADATA_POLICIES: readonly WavMetadataPolicy[] = [
  {
    id: "before-stretch-root",
    chunkOrder: "metadata-before-data",
    acidFlagsMode: "stretch-root-acidizer",
  },
  {
    id: "before-root",
    chunkOrder: "metadata-before-data",
    acidFlagsMode: "root-acidizer",
  },
  {
    id: "before-acidizer",
    chunkOrder: "metadata-before-data",
    acidFlagsMode: "acidizer-only",
  },
  {
    id: "after-stretch-root",
    chunkOrder: "metadata-after-data",
    acidFlagsMode: "stretch-root-acidizer",
  },
  {
    id: "control-after-acidizer",
    chunkOrder: "metadata-after-data",
    acidFlagsMode: "acidizer-only",
  },
];

// Normal export always uses one policy. Set this internal diagnostic switch to
// true only for a deliberate local Live metadata comparison build.
export const ENABLE_WARPED_METADATA_POLICY_MATRIX = false;
export const WARPED_EXPORT_METADATA_POLICY = WARPED_EXPORT_METADATA_POLICIES[0]!;

// Preserve the existing policy for all non-diagnostic/unwarped callers until
// Live verification identifies a working warped-import policy.
export const DEFAULT_WAV_METADATA_POLICY =
  WARPED_EXPORT_METADATA_POLICIES[WARPED_EXPORT_METADATA_POLICIES.length - 1]!;
export const WAV_METADATA_CHUNK_ORDER = DEFAULT_WAV_METADATA_POLICY.chunkOrder;
export const ACID_FLAGS_MODE = DEFAULT_WAV_METADATA_POLICY.acidFlagsMode;

export function getExportMetadataPolicies(
  sourceWarping: boolean,
): readonly WavMetadataPolicy[] {
  if (sourceWarping && ENABLE_WARPED_METADATA_POLICY_MATRIX) {
    return WARPED_EXPORT_METADATA_POLICIES;
  }

  return [
    sourceWarping
      ? WARPED_EXPORT_METADATA_POLICY
      : DEFAULT_WAV_METADATA_POLICY,
  ];
}

export interface ExportWavMetadata {
  exportedFilename: string;
  intendedBpm: number;
  durationBeats: number;
  bars: number;
  sampleFrames: number;
  originalSourceBaseName: string;
  renderLabel: string;
}

// Encodes stereo 24-bit WAV data and writes optional metadata chunks used by
// downstream loop-aware tools. Chunk order is controlled by the policy constant.
export function encodeWavStereo24WithMetadata(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  metadata?: ExportWavMetadata,
  policy: WavMetadataPolicy = DEFAULT_WAV_METADATA_POLICY,
): Buffer {
  const channels = 2;
  const bytesPerSample = 3;
  const bitsPerSample = 24;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = left.length * blockAlign;
  const formatData = Buffer.alloc(16);
  const audioData = Buffer.alloc(dataSize);

  for (let i = 0; i < left.length; i++) {
    writeInt24LE(audioData, clamp(left[i] ?? 0) * 8_388_607, i * 6);
    writeInt24LE(audioData, clamp(right[i] ?? 0) * 8_388_607, i * 6 + 3);
  }

  formatData.writeUInt16LE(1, 0);
  formatData.writeUInt16LE(channels, 2);
  formatData.writeUInt32LE(byteRate / blockAlign, 4);
  formatData.writeUInt32LE(byteRate, 8);
  formatData.writeUInt16LE(blockAlign, 12);
  formatData.writeUInt16LE(bitsPerSample, 14);

  const acidChunk = metadata ? makeAcidChunk(metadata, policy) : null;
  const metadataChunks = [
    ...(acidChunk ? [acidChunk] : []),
    ...(metadata ? [makeInfoListChunk(metadata), makeSmplChunk(metadata.sampleFrames, sampleRate)] : []),
  ];
  const formatChunk = makeRiffChunk("fmt ", formatData);
  const dataChunk = makeRiffChunk("data", audioData);
  const chunks = policy.chunkOrder === "metadata-after-data"
    ? [formatChunk, dataChunk, ...metadataChunks]
    : [formatChunk, ...metadataChunks, dataChunk];
  const riffSize = 4 + chunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = Buffer.alloc(12);

  header.write("RIFF", 0);
  header.writeUInt32LE(riffSize, 4);
  header.write("WAVE", 8);

  return Buffer.concat([header, ...chunks]);
}

// Writes an ACID chunk when the duration is an integer beat count.
function makeAcidChunk(
  metadata: ExportWavMetadata,
  policy: WavMetadataPolicy,
): Buffer | null {
  const beats = Math.round(metadata.durationBeats);
  const tempo = metadata.intendedBpm;
  const acidSettings = getAcidFlagSettings(policy.acidFlagsMode);

  if (!Number.isFinite(tempo) || tempo <= 0) return null;
  if (!Number.isFinite(metadata.durationBeats) || metadata.durationBeats <= 0) return null;
  if (Math.abs(metadata.durationBeats - beats) > 0.001) return null;

  const data = Buffer.alloc(24);

  data.writeUInt32LE(acidSettings.flags, 0);
  data.writeUInt16LE(acidSettings.rootNote, 4);
  data.writeUInt16LE(0x8000, 6);
  data.writeFloatLE(0.0, 8);
  data.writeUInt32LE(beats, 12);
  data.writeUInt16LE(4, 16);
  data.writeUInt16LE(4, 18);
  data.writeFloatLE(tempo, 20);

  return makeRiffChunk("acid", data);
}

// Selects the existing ACID flag/root-note variant without changing metadata behavior.
function getAcidFlagSettings(
  mode: AcidFlagsMode,
): { flags: number; rootNote: number } {
  if (mode === "stretch-root-acidizer") {
    return { flags: 0x16, rootNote: 60 };
  }

  if (mode === "acidizer-only") {
    return { flags: 0x10, rootNote: 0 };
  }

  return { flags: 0x12, rootNote: 60 };
}

// Creates a RIFF chunk with even-byte padding.
function makeRiffChunk(id: string, data: Buffer): Buffer {
  const padding = data.length % 2;
  const chunk = Buffer.alloc(8 + data.length + padding);

  chunk.write(id, 0);
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);

  return chunk;
}

// Writes INFO text metadata describing the render and its intended timing.
function makeInfoListChunk(metadata: ExportWavMetadata): Buffer {
  const infoData = Buffer.concat([
    Buffer.from("INFO", "ascii"),
    makeRiffChunk("INAM", makeInfoString(`${metadata.originalSourceBaseName} ${metadata.renderLabel}`)),
    makeRiffChunk("IART", makeInfoString("x2k Loop Mutator")),
    makeRiffChunk("ISFT", makeInfoString("x2k Loop Mutator")),
    makeRiffChunk(
      "ICMT",
      makeInfoString(
        `BPM=${formatMetadataNumber(metadata.intendedBpm)}; ` +
        `BEATS=${formatMetadataNumber(metadata.durationBeats)}; ` +
        `BARS=${formatMetadataNumber(metadata.bars)}; ` +
        `FRAMES=${metadata.sampleFrames}; ` +
        `SOURCE=${metadata.originalSourceBaseName}; ` +
        `LABEL=${metadata.renderLabel}`,
      ),
    ),
  ]);

  return makeRiffChunk("LIST", infoData);
}

// Encodes null-terminated INFO strings.
function makeInfoString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf8");
}

// Formats metadata numbers compactly while keeping enough timing precision.
function formatMetadataNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.abs(value - Math.round(value)) < 0.0001
    ? String(Math.round(value))
    : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

// Writes a WAV smpl chunk with a full-file inclusive sample loop.
function makeSmplChunk(sampleFrames: number, sampleRate: number): Buffer {
  const data = Buffer.alloc(60);
  const loopEnd = Math.max(0, sampleFrames - 1);

  data.writeUInt32LE(0, 0);
  data.writeUInt32LE(0, 4);
  data.writeUInt32LE(Math.max(1, Math.round(1_000_000_000 / sampleRate)), 8);
  data.writeUInt32LE(60, 12);
  data.writeUInt32LE(0, 16);
  data.writeUInt32LE(0, 20);
  data.writeUInt32LE(0, 24);
  data.writeUInt32LE(1, 28);
  data.writeUInt32LE(0, 32);
  data.writeUInt32LE(0, 36);
  data.writeUInt32LE(0, 40);
  data.writeUInt32LE(0, 44);
  // WAV smpl loop end is inclusive, so use the final sample frame.
  data.writeUInt32LE(loopEnd, 48);
  data.writeUInt32LE(0, 52);
  data.writeUInt32LE(0, 56);

  return makeRiffChunk("smpl", data);
}

// Validates that the freshly encoded/imported WAV still contains expected chunks.
export function validateExportWavMetadata(
  buffer: Buffer,
  metadata: ExportWavMetadata,
  policy: WavMetadataPolicy = DEFAULT_WAV_METADATA_POLICY,
) {
  const chunks = describeWavChunks(buffer);
  const acid = chunks.find((chunk) => chunk.id === "acid");
  const list = chunks.find((chunk) => chunk.id === "LIST");
  const smpl = chunks.find((chunk) => chunk.id === "smpl");
  const data = chunks.find((chunk) => chunk.id === "data");
  const expectedBeats = Math.round(metadata.durationBeats);
  const expectedAcidSettings = getAcidFlagSettings(policy.acidFlagsMode);
  const result = {
    valid: true,
    hasRiff: buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE",
    hasAcid: Boolean(acid),
    hasInfo: Boolean(list),
    hasSmpl: Boolean(smpl),
    hasData: Boolean(data),
    chunkOrder: chunks.map((chunk) => chunk.id),
    acidFlags: acid && acid.size === 24 ? buffer.readUInt32LE(acid.dataOffset) : undefined,
    acidRootNote: acid && acid.size === 24 ? buffer.readUInt16LE(acid.dataOffset + 4) : undefined,
    acidBeats: acid && acid.size === 24 ? buffer.readUInt32LE(acid.dataOffset + 12) : undefined,
    acidMeterDenominator: acid && acid.size === 24 ? buffer.readUInt16LE(acid.dataOffset + 16) : undefined,
    acidMeterNumerator: acid && acid.size === 24 ? buffer.readUInt16LE(acid.dataOffset + 18) : undefined,
    acidTempo: acid && acid.size === 24 ? buffer.readFloatLE(acid.dataOffset + 20) : undefined,
  };

  result.valid =
    result.hasRiff &&
    result.hasInfo &&
    result.hasSmpl &&
    result.hasData &&
    result.hasAcid &&
    acid?.size === 24 &&
    result.acidFlags === expectedAcidSettings.flags &&
    result.acidRootNote === expectedAcidSettings.rootNote &&
    result.acidBeats === expectedBeats &&
    Math.abs((result.acidTempo ?? 0) - metadata.intendedBpm) < 0.01;

  return result;
}

// Reduces verbose validation details to the fields useful in export logs.
export function summarizeWavValidation(validation: ReturnType<typeof validateExportWavMetadata>) {
  return {
    valid: validation.valid,
    hasAcid: validation.hasAcid,
    acidFlags: validation.acidFlags,
    acidBeats: validation.acidBeats,
    acidTempo: validation.acidTempo,
    hasInfo: validation.hasInfo,
    hasSmpl: validation.hasSmpl,
    hasData: validation.hasData,
    chunkOrder: validation.chunkOrder,
  };
}

// Lists top-level WAV chunks for metadata validation and diagnostics.
function describeWavChunks(buffer: Buffer): Array<{ id: string; size: number; dataOffset: number }> {
  const chunks: Array<{ id: string; size: number; dataOffset: number }> = [];

  if (
    buffer.length < 12 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return chunks;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;

    if (dataOffset + size > buffer.length) break;
    chunks.push({ id, size, dataOffset });
    offset = dataOffset + size + (size % 2);
  }

  return chunks;
}

// Writes one signed 24-bit little-endian sample.
function writeInt24LE(buffer: Buffer, value: number, offset: number) {
  let int = Math.round(value);

  if (int < 0) {
    int += 0x1000000;
  }

  buffer[offset] = int & 0xff;
  buffer[offset + 1] = (int >> 8) & 0xff;
  buffer[offset + 2] = (int >> 16) & 0xff;
}

// Clamps audio samples into the normalized range.
function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/*
 * Shared int16 <-> Float32 bridge codec used by both the extension host and
 * the editor runtime.
 *
 * Base64 conversion uses whichever primitive the current side provides:
 * Buffer inside Live's Extension Host, atob/btoa inside the editor webview.
 * Neither global exists on both sides - Live's host predates/excludes the
 * WHATWG base64 globals (packaged builds crashed with "btoa is not defined"),
 * and Buffer does not exist in a browser - so the choice must be dynamic.
 *
 * Note on symmetry: encoding scales by 32767 while WAV *file* decoding
 * elsewhere divides by 32768 per format convention (full-scale negative maps
 * to -32768). This codec's own round trip is exact.
 */

function bufferAvailable(): boolean {
  return typeof Buffer !== "undefined" && typeof Buffer.from === "function";
}

/** @internal Byte<->base64 primitive, exported for regression tests only. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (bufferAvailable()) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  // Webview path: build an 8-bit binary string in chunks so we never hold a
  // second multi-megabyte copy via Function.apply limits.
  const chunk = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const end = Math.min(bytes.length, offset + chunk);
    binary += String.fromCharCode(...Array.from(bytes.subarray(offset, end)));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  if (bufferAvailable()) {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function decodeInt16Base64(base64: string): Float32Array {
  const bytes = base64ToBytes(base64);
  const length = Math.floor(bytes.length / 2);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const lo = bytes[i * 2]!;
    const hi = bytes[i * 2 + 1]!;
    let value = lo | (hi << 8);
    if (value & 0x8000) value = value - 0x10000;
    out[i] = value / 32767;
  }
  return out;
}

export function encodeInt16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    let value = Math.round(sample * 32767);
    if (value < 0) value += 0x10000;
    bytes[i * 2] = value & 255;
    bytes[i * 2 + 1] = (value >> 8) & 255;
  }
  return bytesToBase64(bytes);
}

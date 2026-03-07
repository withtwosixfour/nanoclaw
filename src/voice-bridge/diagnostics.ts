export const voiceStreamDiagnosticsEnabled =
  process.env.VOICE_STREAM_DIAGNOSTICS === '1' ||
  process.env.VOICE_STREAM_DIAGNOSTICS === 'true';

export function estimatePcmDurationMs(
  byteLength: number,
  sampleRate: number,
  channels = 1,
): number | undefined {
  if (
    !Number.isFinite(byteLength) ||
    byteLength < 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(channels) ||
    channels <= 0
  ) {
    return undefined;
  }

  const bytesPerSecond = sampleRate * channels * 2;
  return Math.round((byteLength / bytesPerSecond) * 1000 * 100) / 100;
}

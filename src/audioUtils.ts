
const BIAS = 0x84; // 132
const MAX = 32635;

/**
 * Converts a 16-bit linear PCM audio buffer to an 8-bit µ-law buffer.
 * @param pcm16 - A Buffer or Int16Array of 16-bit linear PCM audio samples.
 * @returns A Buffer containing the 8-bit µ-law encoded audio.
 */
export function linear16ToMuLaw(pcm16: Buffer): Buffer {
    const muLawSamples = new Uint8Array(pcm16.length / 2);

    for (let i = 0; i < muLawSamples.length; i++) {
        const pcmSample = pcm16.readInt16LE(i * 2);

        let sign = (pcmSample >> 8) & 0x80;
        if (sign !== 0) {
            sign = 0;
        } else {
            sign = 0x80;
        }

        let sample = Math.abs(pcmSample);
        if (sample > MAX) {
            sample = MAX;
        }
        sample += BIAS;

        let exponent = 7;
        for (let expMask = 0x4000; (sample & expMask) === 0; exponent--) {
            expMask >>= 1;
        }

        const mantissa = (sample >> (exponent + 3)) & 0x0F;
        const muLawSample = sign | (exponent << 4) | mantissa;
        muLawSamples[i] = ~muLawSample;
    }

    return Buffer.from(muLawSamples);
}

/**
 * Downsamples a PCM audio buffer from an input rate to an output rate.
 * @param buffer - The input Buffer containing 16-bit LE PCM audio.
 * @param inputRate - The sample rate of the input buffer (e.g., 24000).
 * @param outputRate - The desired output sample rate (e.g., 8000).
 * @returns A new Buffer with the downsampled audio.
 */
export function downsampleBuffer(buffer: Buffer, inputRate = 24000, outputRate = 8000): Buffer {
  if (outputRate === inputRate) {
    return buffer;
  }

  const sampleRateRatio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / 2 / sampleRateRatio);
  const result = Buffer.alloc(newLength * 2);

  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult / 2 + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length / 2; i++) {
      accum += buffer.readInt16LE(i * 2);
      count++;
    }

    // Write the average sample value
    result.writeInt16LE(Math.round(accum / count), offsetResult);

    offsetResult += 2;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

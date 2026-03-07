import { describe, expect, it } from 'vitest';

import {
  pcmMonoToDiscordStereo48kForTest,
  pcmStereo48kToMono24kForTest,
} from './adapters/discord.js';

describe('discord voice audio conversion', () => {
  it('upsamples mono 24k PCM to stereo 48k Discord raw PCM', () => {
    const mono24 = Buffer.alloc(4);
    mono24.writeInt16LE(1000, 0);
    mono24.writeInt16LE(-1000, 2);

    const out = pcmMonoToDiscordStereo48kForTest(mono24, 24000);
    expect(out.length).toBe(16);
    expect(out.readInt16LE(0)).toBe(1000);
    expect(out.readInt16LE(2)).toBe(1000);
    expect(out.readInt16LE(4)).toBe(1000);
    expect(out.readInt16LE(6)).toBe(1000);
    expect(out.readInt16LE(8)).toBe(-1000);
    expect(out.readInt16LE(10)).toBe(-1000);
  });

  it('downmixes stereo 48k PCM to mono 24k PCM', () => {
    const stereo48 = Buffer.alloc(16);
    stereo48.writeInt16LE(1000, 0);
    stereo48.writeInt16LE(1000, 2);
    stereo48.writeInt16LE(2000, 4);
    stereo48.writeInt16LE(2000, 6);
    stereo48.writeInt16LE(-1000, 8);
    stereo48.writeInt16LE(-1000, 10);
    stereo48.writeInt16LE(-2000, 12);
    stereo48.writeInt16LE(-2000, 14);

    const out = pcmStereo48kToMono24kForTest(stereo48);
    expect(out.length).toBe(4);
    expect(out.readInt16LE(0)).toBe(1000);
    expect(out.readInt16LE(2)).toBe(-1000);
  });
});

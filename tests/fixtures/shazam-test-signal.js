/**
 * Deterministic 6 s, 16 kHz test signal (LCG noise + tone bursts) used to pin LyricWave's
 * Shazam fingerprint to the reference implementation (SongRec / shazamio).
 */
export function makeShazamTestSignal() {
  const n = 16000 * 6;
  const out = new Int16Array(n);
  let seed = 12345;
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  const tones = [];
  for (let k = 0; k < 24; k++) tones.push([200 + rand() * 4800, 300 + rand() * 3000, 0.05 + rand() * 0.15]);
  for (let i = 0; i < n; i++) {
    const seg = Math.floor((i / n) * 24);
    const t = i / 16000;
    const [f1, f2, amp] = tones[seg];
    let v = (rand() - 0.5) * 0.04 + Math.sin(2 * Math.PI * f1 * t) * amp + Math.sin(2 * Math.PI * f2 * t) * amp * 0.6;
    if (v > 1) v = 1;
    if (v < -1) v = -1;
    out[i] = Math.trunc(v * 32767);
  }
  return out;
}

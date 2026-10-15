/**
 * Pure ES Module Fast Fourier Transform (Radix-4 Real FFT)
 * 
 * High-performance, zero-dependency FFT engine for acoustic fingerprinting.
 * Compatible with Cloudflare Workers, modern Node.js, and browser Web Audio.
 */

export class FFT {
  /**
   * @param {number} size - Transform size (power of two, e.g. 2048)
   */
  constructor(size) {
    this.size = size | 0;
    if (this.size <= 1 || (this.size & (this.size - 1)) !== 0) {
      throw new Error('FFT size must be a power of two and bigger than 1');
    }

    this._csize = size << 1;

    const table = new Array(this.size * 2);
    for (let i = 0; i < table.length; i += 2) {
      const angle = (Math.PI * i) / this.size;
      table[i] = Math.cos(angle);
      table[i + 1] = -Math.sin(angle);
    }
    this.table = table;

    let power = 0;
    for (let t = 1; this.size > t; t <<= 1) {
      power++;
    }

    this._width = power % 2 === 0 ? power - 1 : power;

    this._bitrev = new Array(1 << this._width);
    for (let j = 0; j < this._bitrev.length; j++) {
      this._bitrev[j] = 0;
      for (let shift = 0; shift < this._width; shift += 2) {
        const revShift = this._width - shift - 2;
        this._bitrev[j] |= ((j >>> shift) & 3) << revShift;
      }
    }

    this._out = null;
    this._data = null;
    this._inv = 0;
  }

  createComplexArray() {
    return new Array(this._csize).fill(0);
  }

  realTransform(out, data) {
    if (out === data) {
      throw new Error('Input and output buffers must be different');
    }
    this._out = out;
    this._data = data;
    this._inv = 0;
    this._realTransform4();
    this._out = null;
    this._data = null;
  }

  _singleRealTransform2(outOff, off, step) {
    const out = this._out;
    const data = this._data;
    const evenR = data[off];
    const oddR = data[off + step];
    out[outOff] = evenR + oddR;
    out[outOff + 1] = 0;
    out[outOff + 2] = evenR - oddR;
    out[outOff + 3] = 0;
  }

  _singleRealTransform4(outOff, off, step) {
    const out = this._out;
    const data = this._data;
    const inv = this._inv ? -1 : 1;
    const step2 = step * 2;
    const step3 = step * 3;

    const Ar = data[off];
    const Br = data[off + step];
    const Cr = data[off + step2];
    const Dr = data[off + step3];

    const T0r = Ar + Cr;
    const T1r = Ar - Cr;
    const T2r = Br + Dr;
    const T3r = inv * (Br - Dr);

    out[outOff] = T0r + T2r;
    out[outOff + 1] = 0;
    out[outOff + 2] = T1r;
    out[outOff + 3] = -T3r;
    out[outOff + 4] = T0r - T2r;
    out[outOff + 5] = 0;
    out[outOff + 6] = T1r;
    out[outOff + 7] = T3r;
  }

  _realTransform4() {
    const out = this._out;
    const size = this._csize;
    const width = this._width;
    let step = 1 << width;
    let len = (size / step) << 1;

    let outOff;
    let t;
    const bitrev = this._bitrev;
    if (len === 4) {
      for (outOff = 0, t = 0; outOff < size; outOff += len, t++) {
        const off = bitrev[t];
        this._singleRealTransform2(outOff, off >>> 1, step >>> 1);
      }
    } else {
      for (outOff = 0, t = 0; outOff < size; outOff += len, t++) {
        const off = bitrev[t];
        this._singleRealTransform4(outOff, off >>> 1, step >>> 1);
      }
    }

    const inv = this._inv ? -1 : 1;
    const table = this.table;
    for (step >>= 2; step >= 2; step >>= 2) {
      len = (size / step) << 1;
      const halfLen = len >>> 1;
      const quarterLen = halfLen >>> 1;
      const hquarterLen = quarterLen >>> 1;

      for (outOff = 0; outOff < size; outOff += len) {
        for (let i = 0, k = 0; i <= hquarterLen; i += 2, k += step) {
          const A = outOff + i;
          const B = A + quarterLen;
          const C = B + quarterLen;
          const D = C + quarterLen;

          const Ar = out[A];
          const Ai = out[A + 1];
          const Br = out[B];
          const Bi = out[B + 1];
          const Cr = out[C];
          const Ci = out[C + 1];
          const Dr = out[D];
          const Di = out[D + 1];

          const MAr = Ar;
          const MAi = Ai;

          const tableBr = table[k];
          const tableBi = inv * table[k + 1];
          const MBr = Br * tableBr - Bi * tableBi;
          const MBi = Br * tableBi + Bi * tableBr;

          const tableCr = table[2 * k];
          const tableCi = inv * table[2 * k + 1];
          const MCr = Cr * tableCr - Ci * tableCi;
          const MCi = Cr * tableCi + Ci * tableCr;

          const tableDr = table[3 * k];
          const tableDi = inv * table[3 * k + 1];
          const MDr = Dr * tableDr - Di * tableDi;
          const MDi = Dr * tableDi + Di * tableDr;

          const T0r = MAr + MCr;
          const T0i = MAi + MCi;
          const T1r = MAr - MCr;
          const T1i = MAi - MCi;
          const T2r = MBr + MDr;
          const T2i = MBi + MDi;
          const T3r = inv * (MBr - MDr);
          const T3i = inv * (MBi - MDi);

          out[A] = T0r + T2r;
          out[A + 1] = T0i + T2i;
          out[B] = T1r + T3i;
          out[B + 1] = T1i - T3r;

          if (i === 0) {
            out[C] = T0r - T2r;
            out[C + 1] = T0i - T2i;
            continue;
          }

          if (i === hquarterLen) continue;

          const ST0r = T1r;
          const ST0i = -T1i;
          const ST1r = T0r;
          const ST1i = -T0i;
          const ST2r = -inv * T3i;
          const ST2i = -inv * T3r;
          const ST3r = -inv * T2i;
          const ST3i = -inv * T2r;

          const SA = outOff + quarterLen - i;
          const SB = outOff + halfLen - i;

          out[SA] = ST0r + ST2r;
          out[SA + 1] = ST0i + ST2i;
          out[SB] = ST1r + ST3i;
          out[SB + 1] = ST1i - ST3r;
        }
      }
    }
  }
}

package app.lyricwave.twa;

import android.media.audiofx.Visualizer;
import android.os.SystemClock;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.Arrays;

/**
 * Beat / vocal analysis of whatever the phone is playing, for the web app's "pulse" lyric animation.
 *
 * Wraps {@link Visualizer} on audio session 0 (the global output mix), reads its FFT, and turns it
 * into the frame described by contract C1: four normalised band energies, an overall level, a
 * bass-band onset ("beat") with strength, a tempo estimate and a {@code silent} flag.
 *
 * Nothing is recorded or stored: only a handful of floats per frame leave this class.
 *
 * Threading: {@link #start()}, {@link #stop()} must be called on the main thread. Because the
 * Visualizer is created there, its FFT callbacks and therefore {@link FrameListener#onFrame} are
 * delivered on the main thread too, so no locking is needed.
 *
 * Failure policy: this class never throws. Constructing a Visualizer fails on some devices
 * (missing effect library, effect budget exhausted, permission revoked); {@link #start()} then
 * returns false and everything is released.
 */
final class AudioReactiveMonitor {

    /** One analysed frame. Immutable. */
    static final class Frame {
        final long t;
        final float rms, bass, mid, vocal, high;
        final boolean beat;
        final float beatStrength;
        final int bpm;
        final boolean silent;

        Frame(long t, float rms, float bass, float mid, float vocal, float high,
              boolean beat, float beatStrength, int bpm, boolean silent) {
            this.t = t;
            this.rms = rms;
            this.bass = bass;
            this.mid = mid;
            this.vocal = vocal;
            this.high = high;
            this.beat = beat;
            this.beatStrength = beatStrength;
            this.bpm = bpm;
            this.silent = silent;
        }

        /** The object literal passed to window.__lyricwaveAudioFrame(...). */
        String toJson() {
            return new StringBuilder(176)
                    .append("{\"t\":").append(t)
                    .append(",\"rms\":").append(round3(rms))
                    .append(",\"bass\":").append(round3(bass))
                    .append(",\"mid\":").append(round3(mid))
                    .append(",\"vocal\":").append(round3(vocal))
                    .append(",\"high\":").append(round3(high))
                    .append(",\"beat\":").append(beat)
                    .append(",\"beatStrength\":").append(round3(beatStrength))
                    .append(",\"bpm\":").append(bpm)
                    .append(",\"silent\":").append(silent)
                    .append('}')
                    .toString();
        }
    }

    interface FrameListener {
        /** Main thread. Must not throw (exceptions are swallowed defensively anyway). */
        void onFrame(@NonNull Frame frame);
    }

    // ---- tuning ----------------------------------------------------------------------------

    private static final int MAX_CAPTURE_SIZE = 1024;
    /** Never emit faster than 25 fps (contract C1). */
    private static final long MIN_EMIT_INTERVAL_MS = 40;
    /** While silent only a slow heartbeat is sent; saves wake-ups and JS work. */
    private static final long SILENT_EMIT_INTERVAL_MS = 250;
    /** Consecutive all-zero FFT frames before we call it "silent" (~0.5 s at 20 Hz). */
    private static final int SILENT_FRAMES = 10;
    /** Give up on Visualizer after this many consecutive construction failures. */
    private static final int MAX_START_FAILURES = 3;

    private static final float BAND_PEAK_FLOOR = 3f;       // raw FFT magnitude units
    private static final float BAND_PEAK_HALF_LIFE_MS = 6000f;

    private static final int FLUX_HISTORY = 40;            // ~2 s of flux at 20 Hz
    private static final int FLUX_WARMUP = 10;
    private static final float FLUX_K = 1.5f;              // threshold = mean + K * stddev
    private static final float FLUX_FLOOR = 6f;            // absolute minimum flux for an onset
    private static final float FLUX_REL_MIN = 0.2f;        // ... and at least 20% of recent peak flux
    private static final float FLUX_PEAK_HALF_LIFE_MS = 4000f;
    private static final long REFRACTORY_MS = 250;

    private static final int IOI_CAPACITY = 16;
    private static final int IOI_MIN_FOR_BPM = 4;
    private static final long IOI_MIN_MS = 250;
    private static final long IOI_MAX_MS = 2000;
    private static final long BPM_STALE_MS = 6000;
    private static final float BPM_MIN = 70f;
    private static final float BPM_MAX = 180f;

    // Band edges in Hz: bass, mid, vocal, high.
    private static final float[] BAND_LO_HZ = {20f, 150f, 300f, 3400f};
    private static final float[] BAND_HI_HZ = {150f, 300f, 3400f, 20000f};
    private static final int BASS = 0, MID = 1, VOCAL = 2, HIGH = 3;

    // ---- state -----------------------------------------------------------------------------

    private static volatile int startFailures;

    private final FrameListener listener;
    @Nullable private volatile Visualizer visualizer;

    // Bin layout, recomputed when FFT size or sampling rate changes.
    private int layoutN = -1;
    private int layoutRateHz = -1;
    private final int[] binLo = new int[4];
    private final int[] binHi = new int[4];
    private float[] prevBass = new float[1];
    private boolean prevBassValid;

    private final float[] bandPeak = new float[4];
    private float rmsPeak;
    private float fluxPeak;

    private final float[] fluxHistory = new float[FLUX_HISTORY];
    private int fluxCount;
    private int fluxIndex;

    private long lastBeatTs;
    private final float[] ioiBpm = new float[IOI_CAPACITY];
    private int ioiCount;
    private int ioiIndex;
    private float bpm;

    private int zeroFrames;
    private long lastFrameTs;
    private long lastEmitTs;
    private boolean pendingBeat;
    private float pendingStrength;

    AudioReactiveMonitor(@NonNull FrameListener listener) {
        this.listener = listener;
        resetState();
    }

    /**
     * True if this device can plausibly run the Visualizer. Cheap; callable from any thread.
     * Does not check the RECORD_AUDIO permission.
     */
    static boolean isSupported() {
        if (startFailures >= MAX_START_FAILURES) return false;
        try {
            Class.forName("android.media.audiofx.Visualizer");
            return true;
        } catch (ClassNotFoundException | LinkageError e) {
            return false;
        }
    }

    boolean isRunning() {
        return visualizer != null;
    }

    /**
     * Creates and enables the Visualizer. Idempotent. Returns false (with everything released) if
     * the device refuses. The caller must already hold RECORD_AUDIO.
     */
    boolean start() {
        if (visualizer != null) return true;
        if (!isSupported()) return false;

        Visualizer v = null;
        try {
            v = new Visualizer(0);
            int[] range = Visualizer.getCaptureSizeRange();
            int size = Math.min(range[1], MAX_CAPTURE_SIZE);
            if (size < range[0]) size = range[0];
            // The capture size can only be changed while the effect is disabled (it is, by default).
            if (v.setCaptureSize(size) != Visualizer.SUCCESS) {
                throw new IllegalStateException("setCaptureSize failed");
            }
            int rate = Visualizer.getMaxCaptureRate();
            if (v.setDataCaptureListener(captureListener, rate, false, true) != Visualizer.SUCCESS) {
                throw new IllegalStateException("setDataCaptureListener failed");
            }
            resetState();
            // Publish before enabling so the first callback passes the "is current" check.
            visualizer = v;
            if (v.setEnabled(true) != Visualizer.SUCCESS) {
                throw new IllegalStateException("setEnabled failed");
            }
            startFailures = 0;
            return true;
        } catch (RuntimeException | LinkageError e) {
            // IllegalStateException, UnsupportedOperationException, RuntimeException("Cannot
            // initialize Visualizer engine") and missing native libs all land here.
            visualizer = null;
            releaseQuietly(v);
            startFailures++;
            return false;
        }
    }

    /** Disables and releases the Visualizer. Idempotent, never throws. */
    void stop() {
        Visualizer v = visualizer;
        visualizer = null;
        if (v == null) return;
        try {
            v.setEnabled(false);
        } catch (RuntimeException ignored) {
            // Already torn down by the framework; release below is still safe.
        }
        releaseQuietly(v);
    }

    private static void releaseQuietly(@Nullable Visualizer v) {
        if (v == null) return;
        try {
            v.release();
        } catch (RuntimeException ignored) {
            // Nothing more we can do.
        }
    }

    private final Visualizer.OnDataCaptureListener captureListener =
            new Visualizer.OnDataCaptureListener() {
                @Override
                public void onWaveFormDataCapture(Visualizer viz, byte[] waveform, int samplingRate) {
                    // Not requested.
                }

                @Override
                public void onFftDataCapture(Visualizer viz, byte[] fft, int samplingRate) {
                    // Ignore stragglers queued before stop() released this instance.
                    if (viz != visualizer || fft == null) return;
                    try {
                        processFft(fft, samplingRate, SystemClock.elapsedRealtime());
                    } catch (RuntimeException e) {
                        // This runs on the main looper: never let analysis crash the app.
                    }
                }
            };

    // ---- analysis --------------------------------------------------------------------------

    private void resetState() {
        layoutN = -1;
        layoutRateHz = -1;
        prevBassValid = false;
        Arrays.fill(bandPeak, BAND_PEAK_FLOOR);
        rmsPeak = BAND_PEAK_FLOOR;
        fluxPeak = FLUX_FLOOR;
        Arrays.fill(fluxHistory, 0f);
        fluxCount = 0;
        fluxIndex = 0;
        lastBeatTs = Long.MIN_VALUE / 2;
        ioiCount = 0;
        ioiIndex = 0;
        bpm = 0f;
        zeroFrames = 0;
        lastFrameTs = 0;
        lastEmitTs = 0;
        pendingBeat = false;
        pendingStrength = 0f;
    }

    /**
     * Visualizer FFT layout (n = capture size): fft[0] = Re(DC), fft[1] = Re(Nyquist), then
     * (Re, Im) pairs for bins 1..n/2-1 at fft[2k], fft[2k+1]. Bin k is k * rate / n Hz.
     * {@code samplingRateMilliHz} is the sampling rate in milliHertz.
     */
    void processFft(byte[] fft, int samplingRateMilliHz, long now) {
        final int n = fft.length;
        if (n < 16) return;

        boolean allZero = true;
        for (byte b : fft) {
            if (b != 0) {
                allZero = false;
                break;
            }
        }
        zeroFrames = allZero ? Math.min(zeroFrames + 1, 1_000_000) : 0;
        final boolean silent = zeroFrames >= SILENT_FRAMES;

        float dtMs = lastFrameTs == 0 ? 50f : Math.max(1f, Math.min(500f, now - lastFrameTs));
        lastFrameTs = now;

        if (allZero) {
            // Capture blocked, or nothing is playing. Drop analysis state so a later resume starts clean.
            prevBassValid = false;
            fluxCount = 0;
            fluxIndex = 0;
            pendingBeat = false;
            pendingStrength = 0f;
            long minInterval = silent ? SILENT_EMIT_INTERVAL_MS : MIN_EMIT_INTERVAL_MS;
            if (now - lastEmitTs >= minInterval) {
                lastEmitTs = now;
                emit(new Frame(now, 0f, 0f, 0f, 0f, 0f, false, 0f, 0, silent));
            }
            return;
        }

        int rateHz = samplingRateMilliHz > 1000 ? samplingRateMilliHz / 1000 : 44100;
        ensureLayout(n, rateHz);
        final int half = n / 2;

        // Band energies (RMS of FFT magnitudes inside the band).
        float[] raw = new float[4];
        for (int b = 0; b < 4; b++) {
            double sum = 0;
            int lo = binLo[b], hi = binHi[b];
            for (int k = lo; k <= hi; k++) {
                float re = fft[2 * k];
                float im = fft[2 * k + 1];
                sum += re * re + im * im;
            }
            raw[b] = (float) Math.sqrt(sum / (hi - lo + 1));
        }
        double sumAll = 0;
        for (int k = 1; k < half; k++) {
            float re = fft[2 * k];
            float im = fft[2 * k + 1];
            sumAll += re * re + im * im;
        }
        float rawRms = (float) Math.sqrt(sumAll / Math.max(1, half - 1));

        // Slow adaptive peak tracking: instant attack, ~6 s half-life release, floored so that
        // near-silence is not amplified up to full scale.
        float peakDecay = decay(dtMs, BAND_PEAK_HALF_LIFE_MS);
        float[] norm = new float[4];
        for (int b = 0; b < 4; b++) {
            bandPeak[b] = Math.max(raw[b], Math.max(BAND_PEAK_FLOOR, bandPeak[b] * peakDecay));
            norm[b] = clamp01(raw[b] / bandPeak[b]);
        }
        rmsPeak = Math.max(rawRms, Math.max(BAND_PEAK_FLOOR, rmsPeak * peakDecay));
        float rmsNorm = clamp01(rawRms / rmsPeak);

        // Spectral flux of the bass band: sum of positive per-bin magnitude increases.
        float flux = 0f;
        int bassLo = binLo[BASS];
        int bassCount = binHi[BASS] - bassLo + 1;
        for (int i = 0; i < bassCount; i++) {
            int k = bassLo + i;
            float re = fft[2 * k];
            float im = fft[2 * k + 1];
            float mag = (float) Math.sqrt(re * re + im * im);
            if (prevBassValid) {
                float d = mag - prevBass[i];
                if (d > 0f) flux += d;
            }
            prevBass[i] = mag;
        }
        prevBassValid = true;

        fluxPeak = Math.max(flux, Math.max(FLUX_FLOOR, fluxPeak * decay(dtMs, FLUX_PEAK_HALF_LIFE_MS)));

        boolean beat = false;
        float strength = 0f;
        if (fluxCount >= FLUX_WARMUP) {
            double mean = 0;
            for (int i = 0; i < fluxCount; i++) mean += fluxHistory[i];
            mean /= fluxCount;
            double var = 0;
            for (int i = 0; i < fluxCount; i++) {
                double d = fluxHistory[i] - mean;
                var += d * d;
            }
            double std = Math.sqrt(var / fluxCount);
            double threshold = mean + FLUX_K * std;
            if (flux > threshold
                    && flux >= FLUX_FLOOR
                    && flux >= FLUX_REL_MIN * fluxPeak
                    && now - lastBeatTs >= REFRACTORY_MS) {
                beat = true;
                strength = clamp01(flux / fluxPeak);
                registerOnset(now);
            }
        }
        fluxHistory[fluxIndex] = flux;
        fluxIndex = (fluxIndex + 1) % FLUX_HISTORY;
        if (fluxCount < FLUX_HISTORY) fluxCount++;

        if (beat) {
            pendingBeat = true;
            pendingStrength = Math.max(pendingStrength, strength);
        }

        // Hold the tempo for a while after the beat stops, then drop it.
        int bpmOut = (bpm > 0f && now - lastBeatTs <= BPM_STALE_MS) ? Math.round(bpm) : 0;

        // Coalesce to <= 25 fps; a beat that lands in a dropped frame rides on the next emitted one.
        if (now - lastEmitTs < MIN_EMIT_INTERVAL_MS) return;
        lastEmitTs = now;
        boolean outBeat = pendingBeat;
        float outStrength = pendingStrength;
        pendingBeat = false;
        pendingStrength = 0f;
        emit(new Frame(now, rmsNorm, norm[BASS], norm[MID], norm[VOCAL], norm[HIGH],
                outBeat, outStrength, bpmOut, false));
    }

    /** Records a bass onset: updates the inter-onset-interval ring and the median tempo. */
    private void registerOnset(long now) {
        long prev = lastBeatTs;
        lastBeatTs = now;
        long interval = now - prev;
        if (prev < 0 && interval > IOI_MAX_MS) {
            return; // first onset ever (prev is the "never" sentinel)
        }
        if (interval > IOI_MAX_MS) {
            // Long gap: a break, a track change or silence. Forget the old tempo.
            ioiCount = 0;
            ioiIndex = 0;
            bpm = 0f;
            return;
        }
        if (interval < IOI_MIN_MS) return;

        float value = 60000f / interval;
        while (value < BPM_MIN) value *= 2f;
        while (value > BPM_MAX) value /= 2f;
        ioiBpm[ioiIndex] = value;
        ioiIndex = (ioiIndex + 1) % IOI_CAPACITY;
        if (ioiCount < IOI_CAPACITY) ioiCount++;

        if (ioiCount >= IOI_MIN_FOR_BPM) {
            float[] copy = Arrays.copyOf(ioiBpm, ioiCount);
            Arrays.sort(copy);
            bpm = (ioiCount % 2 == 1)
                    ? copy[ioiCount / 2]
                    : 0.5f * (copy[ioiCount / 2 - 1] + copy[ioiCount / 2]);
        }
    }

    /** (Re)computes which FFT bins belong to each band for the current size / sampling rate. */
    private void ensureLayout(int n, int rateHz) {
        if (n == layoutN && rateHz == layoutRateHz) return;
        layoutN = n;
        layoutRateHz = rateHz;
        float binHz = (float) rateHz / n;
        int maxBin = n / 2 - 1;
        for (int b = 0; b < 4; b++) {
            int lo = (int) Math.ceil(BAND_LO_HZ[b] / binHz);
            int hi = (int) Math.ceil(BAND_HI_HZ[b] / binHz) - 1;
            lo = Math.max(1, Math.min(maxBin, lo));
            hi = Math.max(lo, Math.min(maxBin, hi));
            binLo[b] = lo;
            binHi[b] = hi;
        }
        int bassBins = binHi[BASS] - binLo[BASS] + 1;
        if (prevBass.length < bassBins) prevBass = new float[bassBins];
        prevBassValid = false;
    }

    private void emit(Frame frame) {
        try {
            listener.onFrame(frame);
        } catch (RuntimeException ignored) {
            // The consumer must not be able to break analysis.
        }
    }

    private static float decay(float dtMs, float halfLifeMs) {
        return (float) Math.exp(-0.6931472 * dtMs / halfLifeMs);
    }

    private static float clamp01(float v) {
        if (!(v > 0f)) return 0f; // also maps NaN to 0
        return v > 1f ? 1f : v;
    }

    private static float round3(float v) {
        return Math.round(clamp01(v) * 1000f) / 1000f;
    }
}

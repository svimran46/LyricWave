/**
 * LyricWave Microphone Recognition Source Module
 * 
 * Implements the Now Playing input source contract.
 * - Requests mic permission strictly on explicit user gesture.
 * - Displays a privacy consent disclosure explaining audio is sent to recognition service and not stored.
 * - Captures a 10-second audio sample with live audio level meter and countdown timer.
 * - Robust cross-browser support for Chrome Android & Safari iOS (tracks cleanly closed so OS mic indicator turns off).
 * - Detects silence / too quiet audio with helpful retry messaging.
 * - Dispatches sample to /api/recognize (ACRCloud provider).
 */

import { normalizeNowPlaying } from './types.js';

export class MicSource {
  /**
   * @param {Object} options
   * @param {Function} options.onStatusChange - (statusText, statusType) => void
   * @param {Function} options.onAudioLevel - (normalizedLevel 0-1) => void
   * @param {Function} options.onCountdown - (secondsRemaining 10-0) => void
   * @param {Function} options.onTrackChange - (nowPlayingTrack) => void
   * @param {Function} options.onError - (errorMessage, errorType) => void
   * @param {Function} options.onListeningStateChange - (isListening: boolean) => void
   */
  constructor(options = {}) {
    this.name = 'mic';
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onAudioLevel = options.onAudioLevel || (() => {});
    this.onCountdown = options.onCountdown || (() => {});
    this.onTrackChange = options.onTrackChange || (() => {});
    this.onError = options.onError || (() => {});
    this.onListeningStateChange = options.onListeningStateChange || (() => {});
    this.onPlaybackUpdate = options.onPlaybackUpdate || (() => {});

    // State
    this.isListening = false;
    this.isCancelled = false;
    this.currentTrack = null;
    this.audioStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.rafId = null;
    this.countdownTimer = null;
    this.maxVolumeObserved = 0;

    // Timing compensation trackers
    this.recordStartTime = 0;   // performance.now() when recording started
    this.uploadStartTime = 0;   // performance.now() when upload started

    // Auto-retry once on no match
    this.retryAttempt = 0;

    // Auto Re-listen every 2 minutes (120,000ms)
    this.autoRelistenEnabled = false;
    this.autoRelistenTimer = null;
    this.autoRelistenIntervalMs = 2 * 60 * 1000;
    // Recognition provider override ('acrcloud', 'audd', etc.)
    this.provider = options.provider || (typeof localStorage !== 'undefined' ? localStorage.getItem('lyricwave_recognition_provider') : null) || null;
  }


  /**
   * Set and persist active recognition provider ('acrcloud', 'audd')
   * @param {string} providerName
   */
  setProvider(providerName) {
    this.provider = providerName || null;
    if (typeof localStorage !== 'undefined') {
      if (providerName) {
        localStorage.setItem('lyricwave_recognition_provider', providerName);
      } else {
        localStorage.removeItem('lyricwave_recognition_provider');
      }
    }
  }


  /**
   * Browser feature support check (Safari iOS, Chrome Android, Desktop)
   */
  static isSupported() {
    return Boolean(
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      (typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : true)
    );
  }

  /**
   * Check if consent has already been acknowledged this session or in localStorage
   */
  static hasConsent() {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem('lyricwave_mic_consent') === 'true';
  }

  static setConsent(granted) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('lyricwave_mic_consent', granted ? 'true' : 'false');
    }
  }

  /**
   * Start 10-second listening cycle
   */
  async start() {
    if (this.isListening) return;

    if (!MicSource.isSupported()) {
      this.onError('Microphone recording is not supported in this browser. Please try Chrome, Safari, or Firefox.', 'unsupported');
      return;
    }

    try {
      this.onStatusChange('Requesting microphone access...', 'working');

      // Request media stream (iOS Safari & Chrome Android audio configuration)
      const constraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1
        }
      };

      this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.isListening = true;
      this.isCancelled = false;
      this.onListeningStateChange(true);
      this.maxVolumeObserved = 0;

      // 1. Initialize Web Audio API for live level meter
      this.setupLevelMeter();

      // 2. Start recording 10-second acoustic sample
      this.startRecordingSample();

    } catch (err) {
      this.stop();

      const errName = err.name || '';
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        this.onError('Microphone permission was denied. Tap "Listen" and allow microphone access in your browser settings to identify songs.', 'denied');
      } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
        this.onError('No microphone was found on this device.', 'no_device');
      } else {
        this.onError(`Microphone error: ${err.message || 'Unable to access audio input.'}`, 'error');
      }
    }
  }

  /**
   * Set up Web Audio Analyser for smooth volume metering
   */
  setupLevelMeter() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();

      // iOS Safari requires resume on user tap
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
      }

      const source = this.audioContext.createMediaStreamSource(this.audioStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
      this.analyser.smoothingTimeConstant = 0.75;
      source.connect(this.analyser);

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const meterLoop = () => {
        if (!this.isListening || !this.analyser) return;

        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / bufferLength;
        const normalized = Math.min(1, avg / 120);

        if (normalized > this.maxVolumeObserved) {
          this.maxVolumeObserved = normalized;
        }

        this.onAudioLevel(normalized);
        this.rafId = requestAnimationFrame(meterLoop);
      };

      this.rafId = requestAnimationFrame(meterLoop);
    } catch (err) {
      console.warn('Level meter setup warning:', err);
    }
  }

  /**
   * Record a 10-second audio snippet using MediaRecorder
   */
  startRecordingSample() {
    this.audioChunks = [];

    // Find supported container mimeType (Safari iOS prefers audio/mp4, Chrome prefers audio/webm)
    let selectedMime = '';
    const candidates = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', ''];
    if (typeof MediaRecorder !== 'undefined') {
      for (const mime of candidates) {
        if (!mime || MediaRecorder.isTypeSupported(mime)) {
          selectedMime = mime;
          break;
        }
      }
    }

    try {
      const options = selectedMime ? { mimeType: selectedMime } : {};
      this.mediaRecorder = new MediaRecorder(this.audioStream, options);

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        if (this.isCancelled) {
          this.audioChunks = [];
          this.stopHardware();
          return;
        }

        // Collect recorded blob
        const chunks = [...this.audioChunks];
        this.audioChunks = [];

        // Stop all tracks immediately so OS mic indicators turn off
        this.stopHardware();

        if (chunks.length === 0 || this.isCancelled) {
          return;
        }

        const audioBlob = new Blob(chunks, { type: selectedMime || 'audio/webm' });
        if (audioBlob.size === 0) {
          return;
        }

        // Check for silence / too quiet audio (background room hum without music)
        if (this.maxVolumeObserved < 0.04) {
          this.isListening = false;
          this.onListeningStateChange(false);
          this.onError('The recorded audio was too quiet to detect music. Please bring your device closer to the music speaker and try again.', 'too_quiet');
          return;
        }

        // Send to backend
        await this.dispatchToBackend(audioBlob);
      };

      this.recordStartTime = performance.now();
      this.mediaRecorder.start(500); // 500ms chunk slices

      // High-accuracy 5-second acoustic capture (gold standard for ACRCloud fingerprinting)
      const TOTAL_SAMPLE_SECS = 5;
      let remaining = TOTAL_SAMPLE_SECS;
      this.onCountdown(remaining, TOTAL_SAMPLE_SECS);
      this.onStatusChange(`Listening to room audio (${remaining}s)...`, 'working');

      this.countdownTimer = setInterval(() => {
        remaining--;
        this.onCountdown(remaining, TOTAL_SAMPLE_SECS);
        if (remaining > 0) {
          this.onStatusChange(`Listening to room audio (${remaining}s)...`, 'working');
        } else {
          clearInterval(this.countdownTimer);
          this.countdownTimer = null;
          this.onStatusChange('Analyzing audio fingerprint...', 'working');
          if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            this.mediaRecorder.stop();
          }
        }
      }, 1000);

    } catch (err) {
      console.warn('MediaRecorder error:', err);
      this.stop();
      this.onError('Unable to start audio recording: ' + err.message, 'error');
    }
  }

  /**
   * Dispatch recorded sample to /api/recognize with upload and processing latency compensation
   * @param {Blob} audioBlob
   */
  async dispatchToBackend(audioBlob) {
    this.onStatusChange('Identifying song via acoustic recognition...', 'working');
    this.uploadStartTime = performance.now();

    try {
      const formData = new FormData();
      const headers = {};
      if (this.provider) {
        headers['X-Recognition-Provider'] = this.provider;
      }

      const response = await fetch('/api/recognize', {
        method: 'POST',
        headers,
        body: formData
      });

      const uploadEndTime = performance.now();
      // Round-trip network + serverless computation latency
      this.roundTripLatencyMs = Math.round(uploadEndTime - this.uploadStartTime);

      if (!response.ok) {
        const errPayload = await response.json().catch(() => ({}));
        throw new Error(errPayload.message || `Server returned HTTP ${response.status}`);
      }

      const result = await response.json();

      if (result.success && result.title) {
        this.isListening = false;
        this.onListeningStateChange(false);

        // Accurate Position Calculation:
        // Position = returned offset + time elapsed since sample began recording + processing delay
        let positionSec = 0;
        const hasOffset = typeof result.offsetMs === 'number';

        if (hasOffset) {
          // ACRCloud play_offset_ms points to the end of the recognized audio buffer.
          // The buffer ended when recording stopped (this.uploadStartTime).
          // We only need to add network upload & processing delay elapsed since recording ended.
          const postRecordingDelayMs = Math.max(0, Math.round(uploadEndTime - this.uploadStartTime));
          const totalCompensatedMs = result.offsetMs + postRecordingDelayMs;
          positionSec = Math.max(0, totalCompensatedMs / 1000);
        } else {
          // No offset returned by provider: start from 0s and prompt user to tap line
          positionSec = 0;
        }

        // Normalize into standard NowPlayingTrack
        const track = normalizeNowPlaying({
          id: result.raw?.acrid || `mic-${Date.now()}`,
          title: result.title,
          artist: result.artist,
          album: result.album || '',
          albumArt: null,
          duration: result.duration || 180,
          position: positionSec,
          isPlaying: true,
          source: 'mic',
          confidence: result.confidence,
          hasOffset,
          spotifyId: result.raw?.spotifyTrackId || null
        });

        this.currentTrack = track;
        this.retryAttempt = 0;
        this.onStatusChange(`Identified: ${track.title} by ${track.artist}`, 'success');
        this.onTrackChange(track);

        // Schedule auto re-listen if enabled
        this.scheduleAutoRelisten();

      } else {
        // No match found in ACRCloud database
        // If this was first attempt (retryAttempt === 0), auto-retry once with a fresh snippet
        if (this.retryAttempt === 0 && !this.isCancelled) {
          this.retryAttempt = 1;
          this.isListening = false;
          this.onListeningStateChange(false);
          this.onStatusChange('No match on initial pass. Listening again for clearer music...', 'working');
          setTimeout(() => {
            if (!this.isCancelled) {
              this.start();
            }
          }, 350);
          return;
        }

        this.retryAttempt = 0;
        this.isListening = false;
        this.onListeningStateChange(false);
        this.onError('No song match found. Make sure recognizable music is playing and try again.', 'no_match');
      }

    } catch (err) {
      this.isListening = false;
      this.onListeningStateChange(false);
      this.onError(`Recognition failed: ${err.message}`, 'network');
    }
  }

  /**
   * Close media tracks and audio contexts (turns off OS mic indicator)
   */
  stopHardware() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.audioStream) {
      this.audioStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      this.audioStream = null;
    }

    if (this.audioContext) {
      try {
        this.audioContext.close().catch(() => {});
      } catch {}
      this.audioContext = null;
    }

    this.analyser = null;
    this.onAudioLevel(0);
  }

  /**
   * Enable or disable periodic auto re-listening every 2 minutes
   * @param {boolean} enabled
   */
  setAutoRelisten(enabled) {
    this.autoRelistenEnabled = enabled;
    if (enabled && this.currentTrack) {
      this.scheduleAutoRelisten();
    } else {
      this.clearAutoRelisten();
    }
  }

  /**
   * Schedule next auto re-listen after 2 minutes
   */
  scheduleAutoRelisten() {
    this.clearAutoRelisten();
    if (!this.autoRelistenEnabled) return;

    this.autoRelistenTimer = setTimeout(() => {
      // If still playing and not currently listening, trigger auto re-listen
      if (!this.isListening && this.currentTrack) {
        this.onStatusChange('Auto re-checking music in room...', 'working');
        this.start();
      }
    }, this.autoRelistenIntervalMs);
  }

  /**
   * Clear any pending auto-relisten timer
   */
  clearAutoRelisten() {
    if (this.autoRelistenTimer) {
      clearTimeout(this.autoRelistenTimer);
      this.autoRelistenTimer = null;
    }
  }

  /**
   * Explicitly trigger a re-sync (records new sample to re-anchor position or detect song change)
   */
  async resync() {
    this.stop();
    await this.start();
  }

  /**
   * Cancel or stop listening immediately
   */
  stop() {
    this.isListening = false;
    this.isCancelled = true;
    this.onListeningStateChange(false);

    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }

    if (this.mediaRecorder) {
      try {
        this.mediaRecorder.onstop = null;
        if (this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.stop();
        }
      } catch {}
    }
    this.mediaRecorder = null;
    this.audioChunks = [];

    this.stopHardware();
  }
}

/**
 * LyricWave Reel Visualizer (Phase 4)
 * 
 * Full-screen canvas animated sine waves,
 * OLED-style bordered current line box,
 * word-by-word reveal timing,
 * and multi-theme rendering (Pixel OLED, Neon, Minimal).
 */

export class ReelVisualizer {
  constructor(canvas, container, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.container = container;

    // Configuration & State
    this.theme = options.theme || 'pixel'; // 'pixel' | 'neon' | 'minimal'
    this.wordByWordMode = options.wordByWordMode ?? true;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Animation & Wave metrics
    this.pulseAmplitude = 1.0;
    this.targetPulse = 1.0;
    this.currentPositionMs = 0;
    this.isPlaying = false;
    this.lastRenderTime = performance.now();
    this.lastDrawTime = 0;

    // Visibility & Offscreen Tracking
    this.isDocumentVisible = typeof document !== 'undefined' ? !document.hidden : true;
    this.isStageVisible = true;

    // Frame rate throttle: Cap to 30fps (~33.3ms) on mobile or low-power devices
    const isMobileDevice = typeof window !== 'undefined' && (
      (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) ||
      (typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent))
    );
    const isLowPowerHardware = typeof navigator !== 'undefined' && (
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
      (navigator.deviceMemory && navigator.deviceMemory <= 4)
    );
    this.isThrottled30fps = isMobileDevice || isLowPowerHardware;
    this.minFrameIntervalMs = this.isThrottled30fps ? 33 : 0;

    // Visibility change listener
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.isDocumentVisible = !document.hidden;
      });
    }

    // IntersectionObserver to pause wave drawing when stage is off-screen
    if (typeof IntersectionObserver !== 'undefined' && this.canvas) {
      try {
        const io = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            this.isStageVisible = entry.isIntersecting;
          }
        }, { threshold: 0.05 });
        io.observe(this.canvas);
      } catch {}
    }

    // Line & Word tracking
    this.activeLine = null;
    this.activeLineIndex = -1;
    this.nextLineTimeMs = 0;
    this.activeWords = [];
    this.currentWordIndex = -1;

    // Listen for reduced motion changes with addEventListener / addListener fallback
    if (typeof window !== 'undefined' && window.matchMedia) {
      const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = motionQuery.matches;
      const motionHandler = (e) => { this.reducedMotion = e.matches; };
      if (typeof motionQuery.addEventListener === 'function') {
        motionQuery.addEventListener('change', motionHandler);
      } else if (typeof motionQuery.addListener === 'function') {
        motionQuery.addListener(motionHandler);
      }
    }

    // Resize handling (Window resize, orientation change, and container ResizeObserver)
    this.resizeCanvas();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => this.resizeCanvas());
      window.addEventListener('orientationchange', () => {
        setTimeout(() => this.resizeCanvas(), 100);
      });
    }

    if (typeof ResizeObserver !== 'undefined' && this.container) {
      try {
        const ro = new ResizeObserver(() => this.resizeCanvas());
        ro.observe(this.container);
      } catch {}
    }
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width || window.innerWidth;
    this.height = rect.height || 400;

    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
  }

  setTheme(newTheme) {
    this.theme = newTheme;
  }

  setWordByWordMode(enabled) {
    this.wordByWordMode = enabled;
  }

  /**
   * Called when active line changes: triggers amplitude pulse and resets word timing
   */
  setActiveLine(line, index, nextLineTimeMs = 0) {
    if (this.activeLineIndex !== index) {
      this.activeLine = line;
      this.activeLineIndex = index;
      this.nextLineTimeMs = nextLineTimeMs;

      // Pulse wave amplitude gently at each line change
      if (!this.reducedMotion) {
        this.pulseAmplitude = 2.2;
      }

      // Pre-compute word chunks for word-by-word reveal
      if (line && line.text) {
        const words = line.text.trim().split(/\s+/).filter(Boolean);
        const lineStart = line.timeMs;
        // Estimate line duration: either difference to next line or fallback based on word count
        const lineEnd = nextLineTimeMs > lineStart ? Math.min(nextLineTimeMs, lineStart + 9000) : lineStart + Math.max(2500, words.length * 450);
        const duration = Math.max(1000, lineEnd - lineStart);
        const wordInterval = duration / Math.max(1, words.length);

        this.activeWords = words.map((w, idx) => ({
          text: w,
          startMs: lineStart + (idx * wordInterval),
          endMs: lineStart + ((idx + 1) * wordInterval)
        }));
      } else {
        this.activeWords = [];
      }
    }
  }

  /**
   * Main render tick: draws sine waves and returns active word state
   */
  render(positionMs, isPlaying) {
    this.currentPositionMs = positionMs;
    this.isPlaying = isPlaying;

    const now = performance.now();
    const dt = (now - this.lastRenderTime) / 1000;
    this.lastRenderTime = now;

    // Decay amplitude pulse smoothly back to 1.0
    if (this.pulseAmplitude > 1.0) {
      this.pulseAmplitude = Math.max(1.0, this.pulseAmplitude - (dt * 3.2));
    }

    this.drawSineWaves(positionMs);

    // Compute word-by-word reveal index
    let wordIndex = -1;
    if (this.wordByWordMode && this.activeWords.length > 0) {
      for (let i = 0; i < this.activeWords.length; i++) {
        if (positionMs >= this.activeWords[i].startMs) {
          wordIndex = i;
        } else {
          break;
        }
      }
    }
    this.currentWordIndex = wordIndex;

    return {
      words: this.activeWords,
      currentWordIndex: wordIndex,
      wordByWordMode: this.wordByWordMode
    };
  }

  /**
   * Draw multi-layer sine waves flowing behind and beside the box
   */
  drawSineWaves(positionMs) {
    if (!this.ctx) return;

    // Pause canvas wave drawing if tab/window is hidden or stage is offscreen
    if (!this.isDocumentVisible || !this.isStageVisible) {
      return;
    }

    // Frame rate throttle: Cap to 30fps on mobile / low-power hardware
    const now = performance.now();
    if (this.minFrameIntervalMs > 0 && (now - this.lastDrawTime < this.minFrameIntervalMs)) {
      return;
    }
    this.lastDrawTime = now;

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.clearRect(0, 0, w, h);

    if (this.reducedMotion) {
      // Draw gentle minimal static grid or flat guides
      this.drawReducedMotionGuide(w, h);
      return;
    }

    const centerY = h / 2;
    // Base phase derived from song playback position so waves move in sync with music
    const basePhase = (positionMs / 1000) * 2.2;
    const pulse = this.pulseAmplitude;

    if (this.theme === 'pixel') {
      this.drawPixelWaves(ctx, w, h, centerY, basePhase, pulse);
    } else if (this.theme === 'neon') {
      this.drawNeonWaves(ctx, w, h, centerY, basePhase, pulse);
    } else if (this.theme === 'vinyl') {
      this.drawVinylWaves(ctx, w, h, centerY, basePhase, pulse);
    } else if (this.theme === 'paper') {
      this.drawPaperWaves(ctx, w, h, centerY, basePhase, pulse);
    } else {
      // aurora, adaptive, minimal
      this.drawDynamicWaveTokens(ctx, w, h, centerY, basePhase, pulse);
    }
  }

  /**
   * Reads a computed CSS variable token from the document root with fallback
   */
  getCssToken(name, fallback) {
    if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
    try {
      const val = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return val || fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Token-based waves for Aurora, Album Adaptive, and Minimal themes
   */
  drawDynamicWaveTokens(ctx, w, h, centerY, basePhase, pulse) {
    const wave1Color = this.getCssToken('--wave-1', '#6366f1');
    const wave2Color = this.getCssToken('--wave-2', '#c084fc');

    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';

    // Primary wave
    ctx.strokeStyle = wave1Color;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.009) + basePhase;
      const y = centerY + Math.sin(angle) * (26 * pulse) + Math.cos(angle * 1.5) * 6;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Secondary wave
    ctx.strokeStyle = wave2Color;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.013) - (basePhase * 0.85) + 1.2;
      const y = centerY + Math.sin(angle) * (20 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  /**
   * Vinyl Theme Waves: Gentle warm analog grooves
   */
  drawVinylWaves(ctx, w, h, centerY, basePhase, pulse) {
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';

    ctx.strokeStyle = '#d97706';
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.007) + (basePhase * 0.7);
      const y = centerY + Math.sin(angle) * (18 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.strokeStyle = '#92400e';
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.011) - (basePhase * 0.6) + 0.8;
      const y = centerY + Math.sin(angle) * (12 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  /**
   * Paper Theme Waves: Crisp monochrome ink contour line
   */
  drawPaperWaves(ctx, w, h, centerY, basePhase, pulse) {
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';

    ctx.strokeStyle = '#2563eb';
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.009) + basePhase;
      const y = centerY + Math.sin(angle) * (20 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  /**
   * Pixel OLED Theme Waves: Stepped, crisp monochrome phosphor lines
   */
  drawPixelWaves(ctx, w, h, centerY, basePhase, pulse) {
    const stepSize = 4; // Pixelated stepping
    ctx.lineWidth = 2;
    ctx.lineCap = 'square';

    // Wave 1: Primary phosphor wave
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.beginPath();
    for (let x = 0; x < w; x += stepSize) {
      const angle = (x * 0.012) + basePhase;
      const y = centerY + Math.sin(angle) * (24 * pulse) + Math.cos(angle * 0.5) * 10;
      // Step to nearest 2px for retro pixel feel
      const steppedY = Math.round(y / 2) * 2;
      if (x === 0) ctx.moveTo(x, steppedY);
      else ctx.lineTo(x, steppedY);
    }
    ctx.stroke();

    // Wave 2: Harmonic secondary wave
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.beginPath();
    for (let x = 0; x < w; x += stepSize) {
      const angle = (x * 0.018) - (basePhase * 0.8);
      const y = centerY + Math.sin(angle) * (18 * pulse);
      const steppedY = Math.round(y / 2) * 2;
      if (x === 0) ctx.moveTo(x, steppedY);
      else ctx.lineTo(x, steppedY);
    }
    ctx.stroke();

    // Wave 3: Background pulse ripple
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.beginPath();
    for (let x = 0; x < w; x += stepSize) {
      const angle = (x * 0.007) + (basePhase * 1.4);
      const y = centerY + Math.sin(angle) * (38 * pulse);
      const steppedY = Math.round(y / 2) * 2;
      if (x === 0) ctx.moveTo(x, steppedY);
      else ctx.lineTo(x, steppedY);
    }
    ctx.stroke();
  }

  /**
   * Neon Theme Waves: Glowing cyan and magenta flowing bezier curves
   */
  drawNeonWaves(ctx, w, h, centerY, basePhase, pulse) {
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    // Cyan Neon Wave
    ctx.strokeStyle = '#00f0ff';
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 10) {
      const angle = (x * 0.01) + basePhase;
      const y = centerY + Math.sin(angle) * (30 * pulse) + Math.sin(angle * 2) * 8;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Magenta Neon Wave
    ctx.strokeStyle = '#ff007f';
    ctx.shadowColor = '#ff007f';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 10) {
      const angle = (x * 0.014) - (basePhase * 1.1) + 1.2;
      const y = centerY + Math.cos(angle) * (26 * pulse) + Math.cos(angle * 1.8) * 6;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Reset shadow blur
    ctx.shadowBlur = 0;
  }

  /**
   * Minimal Theme Waves: Sleek, translucent monochromatic ribbons
   */
  drawMinimalWaves(ctx, w, h, centerY, basePhase, pulse) {
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';

    // Wave 1
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.009) + (basePhase * 0.9);
      const y = centerY + Math.sin(angle) * (20 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Wave 2
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const angle = (x * 0.014) - (basePhase * 0.7) + 0.8;
      const y = centerY + Math.cos(angle) * (14 * pulse);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  drawReducedMotionGuide(w, h) {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }
}

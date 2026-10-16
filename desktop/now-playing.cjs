/**
 * LyricWave Desktop — "Now Playing" from the operating system's media sessions.
 *
 * Gives the desktop app the same "Phone" source the Android app has: whatever Spotify, Apple
 * Music, YouTube in a browser, foobar2000, VLC... is playing is read from the OS, with its exact
 * playback position, so lyrics follow along without a login or the microphone.
 *
 *  Windows  Global System Media Transport Controls (SMTC) through one long-running Windows
 *           PowerShell 5.1 process (WinRT projection; no native module to compile).
 *  macOS    AppleScript/JXA against Spotify and Music (osascript), polled.
 *  Linux    MPRIS through `playerctl`, polled.
 *
 * Snapshots use the Android bridge's shape:
 *   { access, active, title, artist, album, package, durationMs, positionMs, isPlaying, artUri,
 *     capturedAt }   (positionMs is valid at capturedAt, a Date.now() timestamp)
 */

const { spawn, execFile } = require('node:child_process');

const POLL_MS = 1000;
const IDLE_STOP_MS = 15000; // stop watching when the renderer stops asking

const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1'
})[0]
function Await($op, [Type]$type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(-1)
  $task.Result
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$mgr = Await ($mgrType::RequestAsync()) $mgrType
while ($true) {
  $out = @{ access = $true; active = $false }
  try {
    $sessions = @($mgr.GetSessions())
    $session = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
    if (-not $session) { $session = $mgr.GetCurrentSession() }
    if ($session) {
      $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
      $tl = $session.GetTimelineProperties()
      $pb = $session.GetPlaybackInfo()
      $out.active = [bool]$props.Title
      $out.title = [string]$props.Title
      $out.artist = [string]$props.Artist
      if (-not $out.artist) { $out.artist = [string]$props.AlbumArtist }
      $out.album = [string]$props.AlbumTitle
      $out.package = [string]$session.SourceAppUserModelId
      $out.isPlaying = ($pb.PlaybackStatus -eq 'Playing')
      $out.durationMs = [long]($tl.EndTime - $tl.StartTime).TotalMilliseconds
      $out.positionMs = [long]$tl.Position.TotalMilliseconds
      $out.positionUpdatedAt = [long]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()
    }
  } catch {
    $out.error = $_.Exception.Message
  }
  $out.capturedAt = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${POLL_MS}
}
`;

function windowsControlScript(action, positionMs) {
  const op = action === 'play' ? '$s.TryPlayAsync()'
    : action === 'pause' ? '$s.TryPauseAsync()'
    : action === 'next' ? '$s.TrySkipNextAsync()'
    : action === 'previous' ? '$s.TrySkipPreviousAsync()'
    : `$s.TryChangePlaybackPositionAsync([long]${Math.max(0, Math.round(Number(positionMs) || 0)) * 10000})`;
  return String.raw`
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1'
})[0]
function Await($op, [Type]$type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$mgr = Await ($mgrType::RequestAsync()) $mgrType
$s = @($mgr.GetSessions()) | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
if (-not $s) { $s = $mgr.GetCurrentSession() }
if ($s) { $null = Await (${op}) ([bool]) }
`;
}

// JXA: Spotify first, then Apple Music. Durations: Spotify reports ms, Music reports seconds.
const MAC_SCRIPT = `
function snap(name, durationInMs) {
  const app = Application(name);
  if (!app.running()) return null;
  const state = String(app.playerState());
  if (state === 'stopped') return null;
  const t = app.currentTrack;
  const dur = Number(t.duration()) || 0;
  return JSON.stringify({
    access: true, active: true, title: String(t.name() || ''), artist: String(t.artist() || ''),
    album: String(t.album() || ''), package: name, isPlaying: state === 'playing',
    durationMs: Math.round(durationInMs ? dur : dur * 1000),
    positionMs: Math.round((Number(app.playerPosition()) || 0) * 1000)
  });
}
function run() {
  const out = [];
  try { const s = snap('Spotify', true); if (s) out.push(s); } catch (e) {}
  try { const s = snap('Music', false); if (s) out.push(s); } catch (e) {}
  const playing = out.find((s) => JSON.parse(s).isPlaying);
  return playing || out[0] || JSON.stringify({ access: true, active: false });
}
`;

/** Run a PowerShell script without a temp file: -EncodedCommand takes base64 UTF-16LE. */
function spawnPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

const LINUX_FORMAT = '{{status}}\u001f{{artist}}\u001f{{title}}\u001f{{album}}\u001f{{mpris:length}}\u001f{{position}}\u001f{{playerName}}';

/** Turn a raw platform snapshot into the bridge shape, extrapolating the position to `now`. */
function finalizeSnapshot(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return { access: true, active: false, capturedAt: now };
  const snap = { ...raw };
  snap.capturedAt = Number(snap.capturedAt) || now;
  let pos = Number(snap.positionMs);
  if (Number.isFinite(pos)) {
    // SMTC: the position was true at positionUpdatedAt, not at capture time.
    const anchor = Number(snap.positionUpdatedAt) || snap.capturedAt;
    if (snap.isPlaying) pos += Math.max(0, now - anchor);
    const dur = Number(snap.durationMs);
    if (dur > 0) pos = Math.min(pos, dur);
    snap.positionMs = Math.max(0, Math.round(pos));
  }
  snap.capturedAt = now;
  delete snap.positionUpdatedAt;
  return snap;
}

class NowPlayingWatcher {
  constructor({ platform = process.platform, onSnapshot = () => {} } = {}) {
    this.platform = platform;
    this.onSnapshot = onSnapshot;
    this.latest = null;
    this.child = null;
    this.timer = null;
    this.lastDemandAt = 0;
    this.idleTimer = null;
    this.buffer = '';
    this.failures = 0;
  }

  static isSupported(platform = process.platform) {
    return platform === 'win32' || platform === 'darwin' || platform === 'linux';
  }

  /** Called whenever the renderer asks for data; starts the watcher on demand. */
  touch() {
    this.lastDemandAt = Date.now();
    if (!this.running) this.start();
  }

  get running() {
    return Boolean(this.child || this.timer);
  }

  start() {
    if (this.running || !NowPlayingWatcher.isSupported(this.platform)) return;
    if (this.platform === 'win32') this.startWindows();
    else this.timer = setInterval(() => this.pollOnce(), POLL_MS * 2);
    if (this.platform !== 'win32') this.pollOnce();
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastDemandAt > IDLE_STOP_MS) this.stop();
    }, 5000);
  }

  stop() {
    if (this.child) {
      try { this.child.kill(); } catch {}
      this.child = null;
    }
    if (this.timer) clearInterval(this.timer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.timer = null;
    this.idleTimer = null;
  }

  startWindows() {
    const child = spawnPowerShell(WINDOWS_SCRIPT);
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          this.publish(JSON.parse(line));
          this.failures = 0;
        } catch {}
      }
    });
    child.stderr.on('data', () => {});
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      // Restart with backoff if we're still wanted (e.g. PowerShell crashed).
      if (Date.now() - this.lastDemandAt < IDLE_STOP_MS && ++this.failures < 5) {
        setTimeout(() => { if (!this.child && this.idleTimer) this.startWindows(); }, 1000 * this.failures);
      } else if (this.failures >= 5) {
        this.publish({ access: false, active: false, error: 'Windows media sessions are unavailable.' });
      }
    });
    child.on('error', () => {
      this.child = null;
      this.publish({ access: false, active: false, error: 'PowerShell is not available.' });
    });
  }

  pollOnce() {
    if (this.platform === 'darwin') {
      execFile('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT], { timeout: 4000 }, (err, stdout) => {
        if (err) return this.publish({ access: true, active: false });
        try { this.publish(JSON.parse(String(stdout).trim())); } catch { this.publish({ access: true, active: false }); }
      });
    } else if (this.platform === 'linux') {
      execFile('playerctl', ['metadata', '--format', LINUX_FORMAT], { timeout: 3000 }, (err, stdout) => {
        if (err) {
          // ENOENT: playerctl isn't installed; anything else: no player running.
          return this.publish(err.code === 'ENOENT'
            ? { access: false, active: false, error: 'Install "playerctl" to follow desktop music players.' }
            : { access: true, active: false });
        }
        const [status, artist, title, album, lengthUs, positionUs, player] = String(stdout).trim().split('\u001f');
        this.publish({
          access: true,
          active: Boolean(title) && status !== 'Stopped',
          title, artist, album,
          package: player || '',
          isPlaying: status === 'Playing',
          durationMs: Math.round((Number(lengthUs) || 0) / 1000),
          positionMs: Math.round((Number(positionUs) || 0) / 1000)
        });
      });
    }
  }

  publish(raw) {
    this.latest = { ...raw, capturedAt: Number(raw.capturedAt) || Date.now() };
    this.onSnapshot(this.snapshot());
  }

  /** Latest snapshot with the position extrapolated to now. */
  snapshot(now = Date.now()) {
    if (!this.latest) return { access: NowPlayingWatcher.isSupported(this.platform), active: false, pending: true };
    return finalizeSnapshot(this.latest, now);
  }

  /** play / pause / seek / next / previous on the session being followed. */
  control(action, positionMs = -1) {
    return new Promise((resolve) => {
      const done = () => resolve(true);
      if (this.platform === 'win32') {
        const child = spawnPowerShell(windowsControlScript(action, positionMs));
        child.on('exit', done);
        child.on('error', () => resolve(false));
      } else if (this.platform === 'darwin') {
        const app = (this.latest && this.latest.package) || 'Spotify';
        const safeApp = app === 'Music' ? 'Music' : 'Spotify';
        const cmd = action === 'play' ? 'play' : action === 'pause' ? 'pause'
          : action === 'next' ? 'next track' : action === 'previous' ? 'previous track'
          : `set player position to ${Math.max(0, Number(positionMs) || 0) / 1000}`;
        execFile('osascript', ['-e', `tell application "${safeApp}" to ${cmd}`], { timeout: 4000 }, done);
      } else if (this.platform === 'linux') {
        const args = action === 'seek' ? ['position', String(Math.max(0, Number(positionMs) || 0) / 1000)]
          : [action === 'next' ? 'next' : action === 'previous' ? 'previous' : action];
        execFile('playerctl', args, { timeout: 3000 }, done);
      } else {
        resolve(false);
      }
      setTimeout(() => { if (this.platform !== 'win32') this.pollOnce(); }, 300);
    });
  }
}

module.exports = { NowPlayingWatcher, finalizeSnapshot, WINDOWS_SCRIPT, windowsControlScript };

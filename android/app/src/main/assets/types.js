/**
 * Now Playing Track Data Interface & Contract
 * 
 * Every music source (Spotify, Microphone, Search, Last.fm, etc.)
 * must produce or emit track items implementing this interface:
 * 
 * @typedef {Object} NowPlayingTrack
 * @property {string} id - Unique identifier or hash for track
 * @property {string} title - Song title
 * @property {string} artist - Artist or performers
 * @property {string} album - Album name
 * @property {string} [albumArt] - URL to album artwork
 * @property {number} duration - Total song duration in SECONDS
 * @property {number} position - Current playback progress in SECONDS
 * @property {boolean} isPlaying - True if playing, false if paused
 * @property {string} [source] - Name of origin source (e.g. 'spotify', 'mic', 'search', 'lastfm')
 * @property {string} [playbackType] - 'track' | 'episode' | 'ad' | 'none'
 */

/**
 * Validates and normalizes an object to ensure it conforms to the NowPlaying interface.
 * Returns normalized object with duration and position in seconds.
 * 
 * @param {Object} data
 * @returns {NowPlayingTrack}
 */
export function normalizeNowPlaying(data) {
  if (!data) return null;

  // Support duration / position supplied either in seconds or milliseconds
  let durationSec = 0;
  if (typeof data.duration === 'number') {
    durationSec = data.duration;
  } else if (typeof data.durationMs === 'number') {
    durationSec = data.durationMs / 1000;
  } else if (typeof data.duration_ms === 'number') {
    durationSec = data.duration_ms / 1000;
  }

  let positionSec = 0;
  if (typeof data.position === 'number') {
    positionSec = data.position;
  } else if (typeof data.positionMs === 'number') {
    positionSec = data.positionMs / 1000;
  } else if (typeof data.progress_ms === 'number') {
    positionSec = data.progress_ms / 1000;
  }

  const res = {
    id: String(data.id || `${data.title || 'track'}__${data.artist || 'unknown'}`),
    title: String(data.title || 'Unknown Title'),
    artist: String(data.artist || data.artists || 'Unknown Artist'),
    album: String(data.album || ''),
    albumArt: String(data.albumArt || data.artwork || ''),
    duration: Math.max(0, Number(durationSec) || 0),
    position: Math.max(0, Number(positionSec) || 0),
    isPlaying: (data.isPlaying !== undefined || data.is_playing !== undefined)
      ? Boolean(data.isPlaying ?? data.is_playing)
      : true,
    source: String(data.source || 'unknown'),
    playbackType: String(data.playbackType || data.currently_playing_type || 'track')
  };

  if (typeof data.hasOffset === 'boolean') {
    res.hasOffset = data.hasOffset;
  }
  if (typeof data.durationEstimated === 'boolean') {
    res.durationEstimated = data.durationEstimated;
  }
  if (typeof data.isApproximate === 'boolean') {
    res.isApproximate = data.isApproximate;
  }
  if (typeof data.confidence === 'number') {
    res.confidence = data.confidence;
  }
  if (data.spotifyId) {
    res.spotifyId = String(data.spotifyId);
  }
  if (data.previewUrl) {
    res.previewUrl = String(data.previewUrl);
  }
  if (data.syncedLyrics) {
    res.syncedLyrics = data.syncedLyrics;
  }
  if (data.plainLyrics) {
    res.plainLyrics = data.plainLyrics;
  }
  if (Array.isArray(data.lookupCandidates) && data.lookupCandidates.length) {
    res.lookupCandidates = data.lookupCandidates
      .filter(c => c && c.title)
      .slice(0, 6)
      .map(c => ({ title: String(c.title), artist: String(c.artist || ''), duration: Number(c.duration) || 0 }));
  }
  if (data.lrclibId) {
    res.lrclibId = data.lrclibId;
  }

  return res;
}

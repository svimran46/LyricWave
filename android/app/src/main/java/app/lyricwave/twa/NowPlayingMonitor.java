package app.lyricwave.twa;

import android.content.ComponentName;
import android.content.Context;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.service.notification.NotificationListenerService;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;

/**
 * Follows whatever music app is playing on the phone (Spotify, YouTube Music, Apple Music...)
 * through Android media sessions, and reports title / artist / position to the web app.
 *
 * Requires notification access for {@link MediaListenerService}; without it every method is a
 * safe no-op. Only media-session metadata is read — never notification contents.
 */
final class NowPlayingMonitor {

    interface Listener {
        /** Called on the main thread whenever the active track or its playback state changes. */
        void onNowPlayingChanged();
    }

    private final Context context;
    private final ComponentName listenerComponent;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Listener listener;

    @Nullable private MediaSessionManager sessionManager;
    @Nullable private volatile MediaController current;
    private boolean started;

    private final MediaSessionManager.OnActiveSessionsChangedListener sessionsChanged =
            controllers -> selectController(controllers);

    private final MediaController.Callback controllerCallback = new MediaController.Callback() {
        @Override
        public void onMetadataChanged(@Nullable MediaMetadata metadata) {
            listener.onNowPlayingChanged();
        }

        @Override
        public void onPlaybackStateChanged(@Nullable PlaybackState state) {
            // If this app paused, another app may have started playing: re-check.
            if (state == null || state.getState() != PlaybackState.STATE_PLAYING) {
                refreshSessions();
            }
            listener.onNowPlayingChanged();
        }

        @Override
        public void onSessionDestroyed() {
            refreshSessions();
        }
    };

    NowPlayingMonitor(@NonNull Context context, @NonNull Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
        this.listenerComponent = new ComponentName(this.context, MediaListenerService.class);
    }

    /** True once the user has enabled notification access for LyricWave. */
    boolean hasAccess() {
        return NotificationManagerCompat.getEnabledListenerPackages(context)
                .contains(context.getPackageName());
    }

    ComponentName getListenerComponent() {
        return listenerComponent;
    }

    /** Start following media sessions (call from onResume). */
    void start() {
        if (started || !hasAccess()) return;
        sessionManager = (MediaSessionManager) context.getSystemService(Context.MEDIA_SESSION_SERVICE);
        if (sessionManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                // Some OEMs unbind the listener in the background; ask the system to rebind it.
                NotificationListenerService.requestRebind(listenerComponent);
            }
            sessionManager.addOnActiveSessionsChangedListener(sessionsChanged, listenerComponent, mainHandler);
            started = true;
            selectController(sessionManager.getActiveSessions(listenerComponent));
        } catch (SecurityException e) {
            // Access was revoked between the check and the call.
            started = false;
        }
    }

    /** Stop following media sessions (call from onPause). */
    void stop() {
        if (sessionManager != null && started) {
            try {
                sessionManager.removeOnActiveSessionsChangedListener(sessionsChanged);
            } catch (Exception ignored) {
            }
        }
        MediaController old = current;
        if (old != null) old.unregisterCallback(controllerCallback);
        current = null;
        started = false;
    }

    /** Re-read the active session list (main thread). */
    void refreshSessions() {
        mainHandler.post(() -> {
            if (!started || sessionManager == null) return;
            try {
                selectController(sessionManager.getActiveSessions(listenerComponent));
            } catch (SecurityException e) {
                stop();
            }
        });
    }

    /** Prefer a session that is actually playing; otherwise the highest-priority one. Never our own. */
    private void selectController(@Nullable List<MediaController> controllers) {
        MediaController best = null;
        if (controllers != null) {
            String own = context.getPackageName();
            for (MediaController c : controllers) {
                if (own.equals(c.getPackageName())) continue;
                PlaybackState s = c.getPlaybackState();
                if (s != null && s.getState() == PlaybackState.STATE_PLAYING) {
                    best = c;
                    break;
                }
                if (best == null) best = c;
            }
        }

        MediaController old = current;
        boolean same = old != null && best != null && old.getSessionToken().equals(best.getSessionToken());
        if (!same) {
            if (old != null) old.unregisterCallback(controllerCallback);
            if (best != null) best.registerCallback(controllerCallback, mainHandler);
            current = best;
        }
        listener.onNowPlayingChanged();
    }

    /**
     * Control the followed music app from LyricWave's own play/pause/seek buttons.
     * @param action "play", "pause" or "seek"
     */
    void control(String action, long positionMs) {
        MediaController c = current;
        if (c == null) return;
        MediaController.TransportControls t = c.getTransportControls();
        switch (action) {
            case "play":
                t.play();
                break;
            case "pause":
                t.pause();
                break;
            case "seek":
                if (positionMs >= 0) t.seekTo(positionMs);
                break;
            default:
                break;
        }
    }

    /** JSON snapshot of the current track for the web app. Safe to call from any thread. */
    String snapshotJson() {
        JSONObject out = new JSONObject();
        try {
            out.put("access", hasAccess());
            MediaController c = current;
            if (c == null) {
                out.put("active", false);
                return out.toString();
            }
            MediaMetadata md = c.getMetadata();
            PlaybackState ps = c.getPlaybackState();

            String title = text(md, MediaMetadata.METADATA_KEY_TITLE);
            if (title.isEmpty()) title = text(md, MediaMetadata.METADATA_KEY_DISPLAY_TITLE);
            String artist = text(md, MediaMetadata.METADATA_KEY_ARTIST);
            if (artist.isEmpty()) artist = text(md, MediaMetadata.METADATA_KEY_ALBUM_ARTIST);
            if (artist.isEmpty()) artist = text(md, MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE);

            String artUri = text(md, MediaMetadata.METADATA_KEY_ALBUM_ART_URI);
            if (artUri.isEmpty()) artUri = text(md, MediaMetadata.METADATA_KEY_ART_URI);
            if (!artUri.startsWith("https://") && !artUri.startsWith("http://")) artUri = "";

            long durationMs = md != null ? md.getLong(MediaMetadata.METADATA_KEY_DURATION) : 0;
            boolean playing = ps != null && ps.getState() == PlaybackState.STATE_PLAYING;

            long positionMs = -1;
            if (ps != null && ps.getPosition() != PlaybackState.PLAYBACK_POSITION_UNKNOWN) {
                positionMs = ps.getPosition();
                long updated = ps.getLastPositionUpdateTime();
                if (playing && updated > 0) {
                    float speed = ps.getPlaybackSpeed() > 0 ? ps.getPlaybackSpeed() : 1f;
                    positionMs += (long) ((SystemClock.elapsedRealtime() - updated) * speed);
                }
                if (durationMs > 0) positionMs = Math.min(positionMs, durationMs);
                positionMs = Math.max(0, positionMs);
            }

            out.put("active", !title.isEmpty());
            out.put("package", c.getPackageName());
            out.put("title", title);
            out.put("artist", artist);
            out.put("album", text(md, MediaMetadata.METADATA_KEY_ALBUM));
            out.put("artUri", artUri);
            out.put("durationMs", Math.max(0, durationMs));
            out.put("positionMs", positionMs);
            out.put("isPlaying", playing);
        } catch (JSONException | RuntimeException e) {
            // A misbehaving media app must never crash LyricWave.
            try {
                out.put("active", false);
            } catch (JSONException ignored) {
            }
        }
        return out.toString();
    }

    private static String text(@Nullable MediaMetadata md, String key) {
        if (md == null) return "";
        CharSequence v = md.getText(key);
        return v == null ? "" : v.toString().trim();
    }
}

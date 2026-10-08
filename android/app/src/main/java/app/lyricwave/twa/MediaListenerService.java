package app.lyricwave.twa;

import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

/**
 * Exists only so Android lets LyricWave see which media sessions are active
 * (MediaSessionManager.getActiveSessions requires an enabled notification listener).
 *
 * Privacy: notification contents are never read, stored or transmitted. The callbacks
 * below deliberately do nothing. Song info comes from MediaController metadata in
 * {@link NowPlayingMonitor}, not from notifications.
 */
public class MediaListenerService extends NotificationListenerService {

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        // Intentionally ignored.
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        // Intentionally ignored.
    }
}

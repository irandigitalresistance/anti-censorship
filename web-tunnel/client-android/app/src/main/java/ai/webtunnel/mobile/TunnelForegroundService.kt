package ai.webtunnel.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class TunnelForegroundService : Service() {
    companion object {
        private const val CHANNEL_ID = "wt_tunnel_fg"
        private const val NOTIF_ID = 1002
        private const val EXTRA_LABEL = "label"
        private const val EXTRA_STATE = "state"
        private const val WAKELOCK_TAG = "WebTunnel::ForegroundWakeLock"

        fun start(context: Context, label: String, state: String = "active") {
            val intent = Intent(context, TunnelForegroundService::class.java)
                .putExtra(EXTRA_LABEL, label)
                .putExtra(EXTRA_STATE, state)
            ContextCompat.startForegroundService(context, intent)
        }

        fun reconnecting(context: Context, label: String) {
            start(context, label, state = "reconnecting")
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, TunnelForegroundService::class.java))
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var currentLabel: String = "Web Tunnel"
    private var currentState: String = "active"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        currentLabel = intent?.getStringExtra(EXTRA_LABEL) ?: currentLabel
        currentState = intent?.getStringExtra(EXTRA_STATE) ?: currentState
        ensureChannel()
        val notif = buildNotification(currentLabel, currentState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
        ensureWakeLock()
        // START_STICKY: if the system kills us under memory pressure, restart with a
        // null intent so the foreground notification (and the main-process rank it
        // grants) comes back. The controller in the main app scope keeps the tunnel
        // alive across re-creates.
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // User swiped the app from recents. Re-post our foreground notification so
        // the OS keeps the main process alive while the VPN is still active.
        super.onTaskRemoved(rootIntent)
        ensureChannel()
        val notif = buildNotification(currentLabel, currentState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    private fun ensureWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        val lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
            setReferenceCounted(false)
            acquire()
        }
        wakeLock = lock
    }

    private fun releaseWakeLock() {
        try { wakeLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
        wakeLock = null
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            if (mgr?.getNotificationChannel(CHANNEL_ID) == null) {
                mgr?.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Tunnel status", NotificationManager.IMPORTANCE_LOW)
                )
            }
        }
    }

    private fun buildNotification(label: String, state: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(if (state == "reconnecting") "Web Tunnel reconnecting" else "Web Tunnel active")
            .setContentText(label)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
    }
}

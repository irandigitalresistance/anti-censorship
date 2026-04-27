package ai.webtunnel.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class TunnelForegroundService : Service() {
    companion object {
        private const val CHANNEL_ID = "wt_tunnel_fg"
        private const val NOTIF_ID = 1002
        private const val EXTRA_LABEL = "label"

        fun start(context: Context, label: String) {
            val intent = Intent(context, TunnelForegroundService::class.java)
                .putExtra(EXTRA_LABEL, label)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, TunnelForegroundService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val label = intent?.getStringExtra(EXTRA_LABEL) ?: "Web Tunnel"
        ensureChannel()
        startForeground(NOTIF_ID, buildNotification(label))
        return START_NOT_STICKY
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

    private fun buildNotification(label: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Web Tunnel active")
            .setContentText(label)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
    }
}

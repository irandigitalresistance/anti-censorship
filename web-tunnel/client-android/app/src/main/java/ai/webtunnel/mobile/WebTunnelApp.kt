package ai.webtunnel.mobile

import android.app.Application
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class WebTunnelApp : Application() {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    val controller: WebTunnelController by lazy { WebTunnelController(this, appScope) }

    override fun onCreate() {
        super.onCreate()
        installCrashHandler()
    }

    /**
     * Persist crashes to <filesDir>/crashes/<ts>.txt so they survive process
     * death. The controller picks them up on next start and queues for upload.
     * Hard-cap the directory at 5 most-recent files (≤ ~500 KB) to satisfy
     * the 5 MB total client-side diagnostic budget.
     */
    private fun installCrashHandler() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val dir = File(filesDir, "crashes").apply { mkdirs() }
                val ts = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
                val out = File(dir, "crash-$ts.txt")
                val message = buildString {
                    append("[$ts] thread=${thread.name}\n")
                    append("${throwable.javaClass.name}: ${throwable.message}\n")
                    append(Log.getStackTraceString(throwable))
                }
                out.writeText(message)
                pruneCrashDir(dir, keepNewest = 5)
            } catch (_: Throwable) {
                // crash-handler must never throw further
            }
            previous?.uncaughtException(thread, throwable)
        }
    }

    private fun pruneCrashDir(dir: File, keepNewest: Int) {
        try {
            val files = dir.listFiles()?.sortedByDescending { it.lastModified() } ?: return
            files.drop(keepNewest).forEach { runCatching { it.delete() } }
        } catch (_: Throwable) {
            // ignore
        }
    }
}

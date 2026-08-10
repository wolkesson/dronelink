package link.dronelink.androidshell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the process alive during flight: a foreground service (so the OS is
 * much less likely to kill it under memory pressure) holding a partial wake
 * lock (so background work keeps running even once the screen sleeps).
 * Screen-stays-on while the app is visible is handled separately by
 * MainActivity's FLAG_KEEP_SCREEN_ON — this service only covers the CPU.
 *
 * No USB/telemetry logic here — Spike 4 owns that. This just needs to exist
 * and keep running so BootUsbReceiver has something to start.
 */
class AirShellForegroundService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "onCreate")
        // Guard the *call*, not a branch inside createNotificationChannel(): ART
        // verifies bytecode per-method, and a method that references
        // NotificationChannel (API 26) can fail to resolve on older devices even
        // behind an in-method version check, once that method is actually invoked.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            createNotificationChannel()
        }
        startForegroundWithNotification()
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand startId=$startId")
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.i(TAG, "onDestroy")
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    private fun acquireWakeLock() {
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:flight").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.foreground_service_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun startForegroundWithNotification() {
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.foreground_service_notification_title))
            .setContentText(getString(R.string.foreground_service_notification_text))
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .build()

        // Same isolate-and-gate reasoning as createNotificationChannel(): the 3-arg
        // startForeground(int, Notification, int) overload doesn't exist before API
        // 29, so it lives in its own method rather than an inline branch here.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForegroundWithType(notification)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun startForegroundWithType(notification: Notification) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    }

    companion object {
        private const val TAG = "AirShellForegroundSvc"
        private const val CHANNEL_ID = "air_shell_foreground"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, AirShellForegroundService::class.java))
        }
    }
}

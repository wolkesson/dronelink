package link.dronelink.androidshell

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
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
            createNotificationChannels()
        }
        startForegroundWithNotification()
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand startId=$startId")
        // Only for BootUsbReceiver's unattended starts, not MainActivity's own
        // AirShellForegroundService.start() call -- the Activity is already on
        // screen in that case, so re-triggering the launch notification would
        // just be a redundant interruption.
        if (intent?.getBooleanExtra(EXTRA_UNATTENDED, false) == true) {
            postUnattendedLaunchNotification()
        }
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

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.foreground_service_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
        // Separate from CHANNEL_ID (IMPORTANCE_LOW, kept quiet on purpose for the
        // persistent "service running" notification): a fullScreenIntent is only
        // actually presented full-screen/heads-up by the system when its channel is
        // IMPORTANCE_HIGH or above -- on a LOW channel it silently downgrades to a
        // normal shade notification with no launch, confirmed on real hardware
        // (Moto G Play, Android 7.1.1) while validating Phase 2.5 spike 5.
        manager.createNotificationChannel(
            NotificationChannel(
                LAUNCH_CHANNEL_ID,
                getString(R.string.foreground_service_launch_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ),
        )
    }

    private fun launchIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE,
    )

    private fun startForegroundWithNotification() {
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.foreground_service_notification_title))
            .setContentText(getString(R.string.foreground_service_notification_text))
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setContentIntent(launchIntent())
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

    /**
     * Reaches MainActivity (WebView + USB bridge + camera passthrough) after
     * BOOT_COMPLETED with the FC already attached, where no live
     * USB_DEVICE_ATTACHED event fires to trigger MainActivity's own
     * device_filter-based auto-launch (see AndroidManifest.xml) -- a plain
     * BroadcastReceiver like BootUsbReceiver can't start an Activity from the
     * background on its own. setFullScreenIntent() is the standard exemption for
     * this (same mechanism alarm/incoming-call apps use). Posted on LAUNCH_CHANNEL_ID
     * (IMPORTANCE_HIGH), separate from the ongoing foreground notification's LOW
     * channel -- see createNotificationChannels(). autoCancel(true) since this is a
     * one-shot prompt, not the persistent "service running" notification.
     */
    private fun postUnattendedLaunchNotification() {
        // Not yet granted is expected on a genuinely fresh boot/install, before
        // MainActivity's own notificationPermissionLauncher has ever run -- the
        // ongoing foreground notification (startForeground()) doesn't need this
        // permission, but a plain notify() call does on API 33+ and throws
        // SecurityException without it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "Skipping unattended-launch notification: POST_NOTIFICATIONS not granted.")
            return
        }
        val notification = NotificationCompat.Builder(this, LAUNCH_CHANNEL_ID)
            .setContentTitle(getString(R.string.foreground_service_launch_notification_title))
            .setContentText(getString(R.string.foreground_service_launch_notification_text))
            .setSmallIcon(R.drawable.ic_notification)
            .setAutoCancel(true)
            .setContentIntent(launchIntent())
            .setFullScreenIntent(launchIntent(), true)
            .build()
        NotificationManagerCompat.from(this).notify(LAUNCH_NOTIFICATION_ID, notification)
    }

    companion object {
        private const val TAG = "AirShellForegroundSvc"
        private const val CHANNEL_ID = "air_shell_foreground"
        private const val LAUNCH_CHANNEL_ID = "air_shell_autolaunch"
        private const val NOTIFICATION_ID = 1
        private const val LAUNCH_NOTIFICATION_ID = 2
        private const val EXTRA_UNATTENDED = "unattended"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, AirShellForegroundService::class.java))
        }

        fun startUnattended(context: Context) {
            val intent = Intent(context, AirShellForegroundService::class.java)
                .putExtra(EXTRA_UNATTENDED, true)
            ContextCompat.startForegroundService(context, intent)
        }
    }
}

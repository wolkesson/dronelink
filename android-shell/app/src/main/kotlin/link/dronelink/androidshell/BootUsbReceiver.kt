package link.dronelink.androidshell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbManager
import android.util.Log

/**
 * Starts the foreground service unattended, so a phone mounted on a drone
 * doesn't need a human to unlock it and reopen the app after a reboot or USB
 * reconnect. Does not touch the USB device itself — that's Spike 4.
 */
class BootUsbReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, UsbManager.ACTION_USB_DEVICE_ATTACHED -> {
                Log.i(TAG, "Received ${intent.action}, starting AirShellForegroundService")
                AirShellForegroundService.start(context)
            }
        }
    }

    private companion object {
        const val TAG = "BootUsbReceiver"
    }
}

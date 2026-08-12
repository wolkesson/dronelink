package link.dronelink.androidshell

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.hoho.android.usbserial.driver.CdcAcmSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Owns the USB-serial connection to the flight controller (or, for initial wiring, a bench
 * USB-serial adapter — see spikes/spike-4-usb-serial-bridge.md). Requests USB host permission,
 * opens the port via usb-serial-for-android (covers FTDI/CP210x/CH340/PL2303/CDC-ACM chipsets,
 * not just the vendor a specific FC happens to use), and exposes plain byte callbacks. No
 * protocol parsing — bytes stay opaque, same rule as the rest of the transport layer.
 *
 * No device_filter is used (see BootUsbReceiver): this just takes whatever recognized
 * USB-serial device is attached, matching this spike's assumption that the only thing on the
 * drone's USB-OTG port is the FC (or, during bring-up, a bench adapter).
 */
class UsbSerialBridge(private val context: Context) {

    interface Listener {
        fun onData(data: ByteArray)

        /** Fired for any USB-side failure, including physical disconnection. */
        fun onError(message: String)
    }

    private val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private var port: UsbSerialPort? = null
    private var ioManager: SerialInputOutputManager? = null
    private var permissionReceiver: BroadcastReceiver? = null

    /** Finds the first recognized USB-serial device, requests permission if needed, and opens it. */
    fun connect(listener: Listener) {
        val driver = findDriver()
        if (driver == null) {
            listener.onError("No recognized USB-serial device attached.")
            return
        }

        val device = driver.device
        if (usbManager.hasPermission(device)) {
            open(driver, listener)
        } else {
            requestPermission(device) { granted ->
                if (granted) open(driver, listener) else listener.onError("USB permission denied.")
            }
        }
    }

    /**
     * UsbSerialProber.getDefaultProber() only matches a hardcoded VID/PID whitelist
     * (FTDI, CP210x, PL2303, CH34x, and a handful of specific CDC-ACM boards) — it does
     * NOT recognize arbitrary CDC-ACM devices by USB class. Most flight controllers
     * (an STM32's built-in USB peripheral, for instance) present as a generic CDC-ACM
     * virtual COM port under a custom VID/PID that's very unlikely to be in that table,
     * so the table lookup alone silently finds nothing for exactly the device this
     * bridge cares most about. Fall back to forcing CdcAcmSerialDriver for any attached
     * device whose interface descriptors look like CDC-ACM (a COMM-class interface),
     * regardless of VID/PID — the driver classes themselves don't care about VID/PID,
     * only the ProbeTable-based lookup does.
     */
    private fun findDriver(): UsbSerialDriver? {
        UsbSerialProber.getDefaultProber().findAllDrivers(usbManager).firstOrNull()?.let { return it }
        return usbManager.deviceList.values.firstOrNull(::looksLikeCdcAcm)?.let { CdcAcmSerialDriver(it) }
    }

    private fun looksLikeCdcAcm(device: UsbDevice): Boolean =
        (0 until device.interfaceCount).any { device.getInterface(it).interfaceClass == UsbConstants.USB_CLASS_COMM }

    /**
     * Queues bytes for write via SerialInputOutputManager's own internal write queue —
     * NOT a raw blocking port.write() dispatched onto ioExecutor, which is permanently
     * occupied running that same manager's read loop once connected; a separately
     * queued write task there would never get a turn to run.
     */
    fun write(data: ByteArray) {
        val manager = ioManager
        if (manager == null) {
            Log.w(TAG, "write() called with no open USB port; dropping ${data.size} byte(s).")
            return
        }
        manager.writeAsync(data)
    }

    fun disconnect() {
        ioManager?.stop()
        ioManager = null
        try {
            port?.close()
        } catch (e: IOException) {
            Log.w(TAG, "Error closing USB serial port", e)
        }
        port = null

        permissionReceiver?.let {
            try {
                context.unregisterReceiver(it)
            } catch (e: IllegalArgumentException) {
                // Already unregistered (permission result already arrived) — fine.
            }
        }
        permissionReceiver = null
    }

    private fun open(driver: UsbSerialDriver, listener: Listener) {
        val connection = usbManager.openDevice(driver.device)
        if (connection == null) {
            listener.onError("Failed to open USB connection.")
            return
        }

        val serialPort = driver.ports.firstOrNull()
        if (serialPort == null) {
            listener.onError("USB-serial driver exposed no ports.")
            return
        }

        try {
            serialPort.open(connection)
            serialPort.setParameters(
                SERIAL_BAUD_RATE,
                UsbSerialPort.DATABITS_8,
                UsbSerialPort.STOPBITS_1,
                UsbSerialPort.PARITY_NONE,
            )
        } catch (e: IOException) {
            listener.onError("Failed to configure USB-serial port: ${e.message}")
            return
        }

        port = serialPort
        val manager = SerialInputOutputManager(
            serialPort,
            object : SerialInputOutputManager.Listener {
                override fun onNewData(data: ByteArray) = listener.onData(data)

                override fun onRunError(e: Exception) {
                    listener.onError("USB read error: ${e.message}")
                }
            },
        )
        ioManager = manager
        ioExecutor.execute(manager)
    }

    private fun requestPermission(device: UsbDevice, onResult: (Boolean) -> Unit) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context, intent: Intent) {
                if (intent.action != ACTION_USB_PERMISSION) return
                try {
                    context.unregisterReceiver(this)
                } catch (e: IllegalArgumentException) {
                    // Already unregistered by disconnect() racing this callback — fine.
                }
                permissionReceiver = null
                onResult(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
            }
        }
        permissionReceiver = receiver
        ContextCompat.registerReceiver(
            context,
            receiver,
            IntentFilter(ACTION_USB_PERMISSION),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        // FLAG_MUTABLE is required (not just allowed): the system fills in
        // EXTRA_PERMISSION_GRANTED on this PendingIntent's Intent when it broadcasts the
        // result, which an immutable PendingIntent would not permit.
        val permissionIntent = PendingIntent.getBroadcast(
            context,
            0,
            Intent(ACTION_USB_PERMISSION).setPackage(context.packageName),
            PendingIntent.FLAG_MUTABLE,
        )
        usbManager.requestPermission(device, permissionIntent)
    }

    companion object {
        private const val TAG = "UsbSerialBridge"
        private const val ACTION_USB_PERMISSION = "link.dronelink.androidshell.USB_PERMISSION"

        /** Matches INAV's default MSP configuration, same as WebSerialTransport.SERIAL_BAUD_RATE. */
        const val SERIAL_BAUD_RATE = 115200
    }
}

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
 * USB-serial adapter — see android-shell/README.md "Testing the USB serial bridge"). Requests
 * USB host permission, opens the port via usb-serial-for-android (covers
 * FTDI/CP210x/CH340/PL2303/CDC-ACM chipsets, not just the vendor a specific FC happens to use),
 * and exposes plain byte callbacks. No protocol parsing — bytes stay opaque, same rule as the
 * rest of the transport layer.
 *
 * No device_filter is used (see BootUsbReceiver): this just takes whatever recognized
 * USB-serial device is attached, on the assumption that the only thing on the drone's USB-OTG
 * port is the FC (or, during bring-up, a bench adapter).
 */
class UsbSerialBridge(private val context: Context) {

    interface Listener {
        /** Fired once the port is open and configured, before any data has necessarily arrived. */
        fun onConnected()

        fun onData(data: ByteArray)

        /** Fired for any USB-side failure, including physical disconnection. */
        fun onError(message: String)
    }

    private val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    /**
     * Dedicated thread for writes, separate from ioExecutor's blocking read loop. Calling
     * UsbSerialPort.write() here concurrently with a read in progress on ioExecutor is safe
     * -- reads and writes use separate USB bulk IN/OUT endpoints -- and it decouples write
     * latency from read timing entirely, unlike SerialInputOutputManager.writeAsync() (see
     * write() below).
     */
    private val writeExecutor: ExecutorService = Executors.newSingleThreadExecutor()
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
     * bridge cares most about. Falls back to:
     *   1. Forcing CdcAcmSerialDriver for any attached device whose interface
     *      descriptors look like CDC-ACM (a COMM-class interface), regardless of
     *      VID/PID — the driver classes themselves don't care about VID/PID, only the
     *      ProbeTable-based lookup does.
     *   2. KNOWN_SERIAL_DEVICES below, for devices that don't expose a standard
     *      COMM-class interface either (e.g. a vendor-specific class).
     * If neither finds anything, logs every attached device's vendorId/productId and
     * interface classes so a KNOWN_SERIAL_DEVICES entry can be added for it.
     */
    private fun findDriver(): UsbSerialDriver? {
        UsbSerialProber.getDefaultProber().findAllDrivers(usbManager).firstOrNull()?.let { return it }

        val devices = usbManager.deviceList.values
        devices.firstOrNull(::looksLikeCdcAcm)?.let { return cdcAcmDriverFor(it) }
        devices.firstOrNull { (it.vendorId to it.productId) in KNOWN_SERIAL_DEVICES }?.let { return cdcAcmDriverFor(it) }

        logUnrecognizedDevices(devices)
        return null
    }

    /**
     * usb-serial-for-android 3.4.3's CdcAcmSerialDriver only exposes the 1-arg
     * constructor (device) — it auto-detects the control/data interface pair itself.
     * There's no overload for passing explicit interface indices.
     */
    private fun cdcAcmDriverFor(device: UsbDevice): CdcAcmSerialDriver = CdcAcmSerialDriver(device)

    /** First 16 bytes as hex, for spotting whether traffic looks like a real MSP frame (e.g. "24 4d 3c ..." / "$M<") vs garbage. */
    private fun ByteArray.toHexPreview(maxBytes: Int = 16): String {
        val hex = take(maxBytes).joinToString(" ") { "%02x".format(it) }
        return if (size > maxBytes) "$hex …" else hex
    }

    private fun looksLikeCdcAcm(device: UsbDevice): Boolean =
        (0 until device.interfaceCount).any { device.getInterface(it).interfaceClass == UsbConstants.USB_CLASS_COMM }

    private fun logUnrecognizedDevices(devices: Collection<UsbDevice>) {
        if (devices.isEmpty()) {
            Log.w(TAG, "No USB devices attached at all.")
            return
        }
        Log.w(TAG, "No recognized USB-serial device among ${devices.size} attached device(s):")
        for (device in devices) {
            val interfaces = (0 until device.interfaceCount).joinToString { i ->
                val iface = device.getInterface(i)
                "class=0x%02x sub=0x%02x proto=0x%02x".format(
                    iface.interfaceClass,
                    iface.interfaceSubclass,
                    iface.interfaceProtocol,
                )
            }
            Log.w(
                TAG,
                "  vendorId=0x%04x productId=0x%04x name=%s interfaces=[%s]".format(
                    device.vendorId,
                    device.productId,
                    device.deviceName,
                    interfaces,
                ),
            )
        }
        Log.w(TAG, "If one of these is really a serial device, add its (vendorId, productId) to KNOWN_SERIAL_DEVICES.")
    }

    /**
     * Writes bytes directly to the port on writeExecutor, a thread dedicated to writes and
     * separate from ioExecutor's blocking read loop -- NOT via SerialInputOutputManager's
     * writeAsync() queue, which only flushes queued writes when the manager's read-then-flush
     * step() loop next returns from its blocking read() call (bounded by
     * SERIAL_READ_TIMEOUT_MS, so a write could sit queued for up to that long whenever the FC
     * was momentarily quiet). Reading `port` synchronously here (rather than inside the
     * executor task) means a write issued after disconnect() has already nulled it is dropped
     * immediately instead of being queued behind a port that's going away.
     *
     * The `port !== openPort` re-check inside the executor task guards a different window:
     * several writes can get queued in the brief gap between a physical unplug and the read
     * loop actually noticing (onRunError firing, which is what triggers disconnect()). Without
     * it, every one of those already-queued writes would still attempt a real blocking
     * port.write() against a device that's already gone, and on some devices/kernels a
     * bulkTransfer to a vanished device doesn't fail fast -- it blocks for the full
     * WRITE_TIMEOUT_MS before giving up. Several of those stacking up on this single-thread
     * executor is exactly what produced the "degraded performance after disconnect/replug"
     * symptom seen on real hardware: writeExecutor stayed busy working through a backlog of
     * timed-out writes to the dead port instead of servicing the new connection's writes. The
     * re-check turns each stale queued write into a same-microsecond no-op instead.
     */
    fun write(data: ByteArray) {
        val openPort = port
        if (openPort == null) {
            Log.w(TAG, "write() called with no open USB port; dropping ${data.size} byte(s).")
            return
        }
        writeExecutor.execute {
            if (port !== openPort) {
                Log.w(TAG, "Dropping stale queued write (${data.size}B); USB port changed before this write's turn.")
                return@execute
            }
            Log.d(TAG, "-> USB ${data.size}B: ${data.toHexPreview()}")
            try {
                openPort.write(data, WRITE_TIMEOUT_MS)
            } catch (e: IOException) {
                Log.w(TAG, "Error writing to USB serial port", e)
            }
        }
    }

    fun disconnect() {
        val manager = ioManager
        val portToClose = port
        ioManager = null
        port = null
        manager?.stop()

        // stop() only *requests* the read loop stop -- it doesn't wait for the
        // background thread to actually exit, which might currently be mid blocking
        // read/control-transfer call. Closing the port right away, from this (a
        // different) thread, can null out the connection that in-flight call is still
        // using -- exactly how "invoke virtual method ... controlTransfer(...) on a
        // null object reference" crashes happen. The same risk now applies to
        // writeExecutor, which may have an in-flight or queued port.write() call at
        // the moment disconnect() runs (write() above reads `port` before this method
        // nulls it, so a write racing this call can still get queued). Chaining the
        // close behind writeExecutor first, then ioExecutor, guarantees writeExecutor's
        // queue has fully drained before the port actually closes, and still only
        // closes once ioExecutor's manager run() task has actually returned. portToClose
        // is captured explicitly (rather than reading the port field from inside the
        // closure) so a hypothetical fast disconnect-then-reconnect can't end up closing
        // whatever new port a later open() has since assigned to that field.
        writeExecutor.execute {
            ioExecutor.execute {
                try {
                    portToClose?.close()
                } catch (e: IOException) {
                    Log.w(TAG, "Error closing USB serial port", e)
                }
            }
        }

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
            // Many CDC-ACM firmwares (including most flight controllers) gate whether
            // they actively respond on the DTR line, the same way a real serial
            // terminal signals "I'm connected and listening" on open -- without this,
            // writes reach the device fine but it never talks back. Not every chipset
            // supports control lines, so that failure alone isn't fatal to the
            // connection.
            try {
                serialPort.setDTR(true)
                serialPort.setRTS(true)
            } catch (e: UnsupportedOperationException) {
                Log.w(TAG, "Device doesn't support DTR/RTS control lines: ${e.message}")
            }
        } catch (e: IOException) {
            listener.onError("Failed to configure USB-serial port: ${e.message}")
            return
        }

        Log.i(TAG, "USB-serial port open: ${driver.javaClass.simpleName} on ${driver.device.deviceName}")

        port = serialPort
        val manager = SerialInputOutputManager(
            serialPort,
            object : SerialInputOutputManager.Listener {
                override fun onNewData(data: ByteArray) {
                    Log.d(TAG, "<- USB ${data.size}B: ${data.toHexPreview()}")
                    listener.onData(data)
                }

                override fun onRunError(e: Exception) {
                    listener.onError("USB read error: ${e.message}")
                }
            },
        )
        // Writes no longer go through this manager (see write() above, which uses
        // writeExecutor + a direct port.write() instead of writeAsync()), so this timeout
        // no longer gates write latency. It still bounds how long the read loop's blocking
        // read() call can run before returning control to step(), which matters for how
        // promptly manager.stop() (called from disconnect()) actually takes effect -- with
        // the default readTimeout=0 (infinite), a read blocks forever whenever the other
        // side hasn't sent anything yet, so stop() wouldn't be noticed until the FC next
        // sends data. Must be set before ioExecutor.execute(manager) below --
        // SerialInputOutputManager throws if changed after it starts running.
        manager.setReadTimeout(SERIAL_READ_TIMEOUT_MS)
        ioManager = manager
        ioExecutor.execute(manager)
        listener.onConnected()
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

        /**
         * Bounds how long the read loop's blocking read() call can run before manager.stop()
         * (see disconnect()) is noticed; long enough to avoid busy-looping the read call when
         * the FC is idle. No longer affects write latency -- see write()'s doc comment.
         */
        private const val SERIAL_READ_TIMEOUT_MS = 500

        /**
         * Safety ceiling for a single blocking port.write() call on writeExecutor (see
         * write()), not a normal-path delay -- just bounds how long a wedged/unresponsive
         * device can hang the write executor for. A real write at this baud rate completes
         * in well under a millisecond, so this only matters for a device that's wedged or
         * has just vanished (the write()'s `port !== openPort` re-check catches most of that
         * window, but not the narrow gap before the read loop has noticed the disconnect
         * yet). Kept short, unlike SERIAL_READ_TIMEOUT_MS, so that gap can't stack up a
         * multi-second backlog on writeExecutor if several writes land in it.
         */
        private const val WRITE_TIMEOUT_MS = 100

        /**
         * (vendorId, productId) pairs to force-treat as CdcAcmSerialDriver when neither
         * usb-serial-for-android's built-in whitelist nor the COMM-class interface
         * heuristic in looksLikeCdcAcm() recognizes the device — e.g. a flight
         * controller that exposes its serial port under a vendor-specific interface
         * class instead of a standard CDC-ACM one.
         *
         * Find the values to add here from a "No recognized USB-serial device..."
         * logcat line (see findDriver()/logUnrecognizedDevices()), which prints every
         * attached device's vendorId/productId and interface classes. Example:
         *   0x0483 to 0x5740, // STMicroelectronics Virtual COM Port
         */
        private val KNOWN_SERIAL_DEVICES: Set<Pair<Int, Int>> = setOf()
    }
}

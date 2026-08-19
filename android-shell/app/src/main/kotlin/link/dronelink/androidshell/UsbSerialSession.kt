package link.dronelink.androidshell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbManager
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Owns a persistent UsbSerialBridge connection independent of any Activity/WebView --
 * meant to be held by AirShellForegroundService so USB survives Activity recreation.
 * A listener (in practice, one NativeSerialBridgeController per live WebView) attaches
 * and detaches as the WebView comes and goes; onData()/onError() delivered with no
 * listener attached are simply dropped. MSP telemetry/control bytes are only useful
 * live -- there is nothing worth buffering or replaying for a page that isn't there.
 */
class UsbSerialSession(
    private val context: Context,
    private val usbBridge: UsbSerialBridge = UsbSerialBridge(context),
) {
    interface Listener {
        /**
         * @param isReconnect True if this session has connected at least once before --
         * either earlier in this attachment (e.g. a replug) or before this listener ever
         * attached (e.g. a WebView reattaching to an already-connected session). False
         * only for a session's genuinely first-ever successful connect. Lets a caller
         * decide whether the same explicit user gesture a true first connect wants (e.g.
         * WebSerialTransport's device picker) is still necessary.
         */
        fun onConnected(isReconnect: Boolean)
        fun onData(data: ByteArray)
        fun onError(message: String)
    }

    private val lock = Any()
    private var listener: Listener? = null
    private var connected = false
    private var connecting = false
    private var started = false
    private var reattachReceiver: BroadcastReceiver? = null

    /** Latches true on the first successful connect, for the lifetime of this session. */
    private var hasEverConnected = false

    /** Idempotent -- Service.onBind() can run again after an unbind/rebind cycle. */
    fun start() {
        synchronized(lock) {
            if (started) return
            started = true
        }
        attemptConnect()

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context, intent: Intent) {
                if (intent.action != UsbManager.ACTION_USB_DEVICE_ATTACHED) return
                val alreadyBusy = synchronized(lock) { connected || connecting }
                if (alreadyBusy) return
                Log.i(TAG, "USB device (re)attached, attempting reconnect.")
                attemptConnect()
            }
        }
        reattachReceiver = receiver
        ContextCompat.registerReceiver(
            context,
            receiver,
            IntentFilter(UsbManager.ACTION_USB_DEVICE_ATTACHED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    /**
     * Joins the session: delivers onConnected() synchronously if already connected, so a
     * listener attaching while a connect is in flight can't miss or double-fire that
     * state, then receives future onConnected()/onData()/onError() callbacks. Only one
     * listener at a time is supported -- one live WebView at a time is the only case this
     * needs to cover; a second attachListener() call simply replaces the first.
     */
    fun attachListener(listener: Listener) {
        synchronized(lock) {
            this.listener = listener
            // Already connected implies a prior successful connect happened, so this is
            // unconditionally a reconnect from this listener's point of view.
            if (connected) listener.onConnected(isReconnect = true)
        }
    }

    /** Does NOT disconnect the USB device -- the session keeps running without a listener. */
    fun detachListener(listener: Listener) {
        synchronized(lock) {
            if (this.listener === listener) this.listener = null
        }
    }

    fun write(data: ByteArray) = usbBridge.write(data)

    private fun attemptConnect() {
        synchronized(lock) { connecting = true }
        usbBridge.connect(
            object : UsbSerialBridge.Listener {
                override fun onConnected() {
                    synchronized(lock) {
                        val isReconnect = hasEverConnected
                        hasEverConnected = true
                        connecting = false
                        connected = true
                        listener?.onConnected(isReconnect)
                    }
                }

                override fun onData(data: ByteArray) {
                    val current = synchronized(lock) { listener }
                    current?.onData(data)
                }

                override fun onError(message: String) {
                    Log.e(TAG, "USB serial session error: $message")
                    synchronized(lock) {
                        connecting = false
                        connected = false
                        listener?.onError(message)
                    }
                    // Fully tears down the dead port/ioManager so a future reattach's
                    // attemptConnect() starts clean rather than layering a new connection
                    // on top of stale state.
                    usbBridge.disconnect()
                }
            },
        )
    }

    fun stop() {
        reattachReceiver?.let { context.unregisterReceiver(it) }
        reattachReceiver = null
        usbBridge.disconnect()
        synchronized(lock) {
            connected = false
            connecting = false
            listener = null
            started = false
        }
    }

    companion object {
        private const val TAG = "UsbSerialSession"
    }
}

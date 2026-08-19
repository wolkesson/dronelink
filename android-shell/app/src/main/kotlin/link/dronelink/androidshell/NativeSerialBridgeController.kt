package link.dronelink.androidshell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Ties UsbSerialBridge (owns the USB device) to a WebMessageChannel posted into the WebView,
 * matching the open()/write() contract NativeBridgeTransport.ts expects on the JS side —
 * see packages/air-client-sdk/src/transport/NativeBridgeTransport.ts.
 *
 * Bytes from the page arrive as WebMessageCompat ArrayBuffer messages on the native-held
 * port and go straight to USB; bytes from USB go straight out as ArrayBuffer messages on
 * the same port. No protocol parsing here either.
 */
class NativeSerialBridgeController(
    private val context: Context,
    private val webView: WebView,
    private val pageOrigin: Uri,
) {
    private val usbBridge = UsbSerialBridge(context)
    private var nativePort: WebMessagePortCompat? = null
    private var connected = false
    private var connecting = false
    private var reattachReceiver: BroadcastReceiver? = null

    /**
     * Runs the page->native WebMessage callback (see attemptConnect()'s
     * setWebMessageCallback below) off the main/UI thread. The default (no-Handler)
     * overload dispatches onMessage() on the UI thread -- the same thread the WebView
     * uses for compositing and, when a video track is active, frame capture/encoding
     * scheduling. A burst of reconnect activity landing there (USB device enumeration,
     * tearing down/recreating the WebMessageChannel) can introduce send-side jitter that
     * WebRTC's delay-based bandwidth estimator (GCC) misreads as network congestion,
     * cutting the video/data-channel bitrate and then ramping it back up slowly over
     * tens of seconds -- confirmed on real hardware as elevated MSP round-trip time for
     * about a minute after a USB replug, even though the WebRTC connection's own RTT
     * stayed flat throughout (ruling out an actual network-path issue). Isolating this
     * callback onto its own thread keeps USB/serial JS-bridge traffic from contending
     * with the UI thread at all.
     */
    private val callbackThread = HandlerThread("NativeSerialBridge-Callback").apply { start() }
    private val callbackHandler = Handler(callbackThread.looper)

    /**
     * Attempts to find and open an already-attached USB-serial device and hand a
     * MessagePort to the page, then keeps watching for a live USB reattach (FC unplugged
     * and replugged, or first attached after this controller already started) so a later
     * "Connect FC" retry isn't stuck waiting on a port that will never arrive -- both the
     * WebMessageChannel port and NativeBridgeTransport's pendingNativePort buffer on the
     * JS side are otherwise consumed after the first connect (confirmed hanging on real
     * hardware while validating Phase 2.5 spike 5).
     */
    fun start() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        ) {
            Log.e(TAG, "Installed WebView doesn't support the WebMessage APIs this bridge needs.")
            return
        }

        attemptConnect()

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context, intent: Intent) {
                if (intent.action != UsbManager.ACTION_USB_DEVICE_ATTACHED || connected || connecting) return
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
     * Creates a fresh WebMessageChannel and posts its page-side port, mirroring the "may
     * push the MessagePort before Connect FC is ever clicked" eager behavior app.ts
     * expects (see its window "message" listener) -- both for the very first connect and
     * for every later reattach. The previous channel's ports (if any) are simply
     * abandoned; MessageChannel/MessagePort has no explicit close-and-replace API, and
     * the old page-side port is already unusable once its NativeBridgeTransport instance
     * disconnected.
     */
    private fun attemptConnect() {
        connecting = true
        val channel = WebViewCompat.createWebMessageChannel(webView)
        val pageSidePort = channel[0]
        val nativeSidePort = channel[1]
        nativePort = nativeSidePort

        nativeSidePort.setWebMessageCallback(
            callbackHandler,
            object : WebMessagePortCompat.WebMessageCallbackCompat() {
                override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat?) {
                    if (message?.type != WebMessageCompat.TYPE_ARRAY_BUFFER) {
                        Log.w(TAG, "Ignoring non-ArrayBuffer WebMessage from page (type=${message?.type})")
                        return
                    }
                    Log.d(TAG, "<- WebView ${message.arrayBuffer.size}B")
                    usbBridge.write(message.arrayBuffer)
                }
            },
        )

        usbBridge.connect(
            object : UsbSerialBridge.Listener {
                override fun onConnected() {
                    connecting = false
                    connected = true
                }

                override fun onData(data: ByteArray) {
                    Log.d(TAG, "-> WebView ${data.size}B")
                    nativePort?.postMessage(WebMessageCompat(data))
                }

                override fun onError(message: String) {
                    Log.e(TAG, "USB serial bridge error: $message")
                    connecting = false
                    connected = false
                    // Mirrors WebSerialTransport's disconnect signal: a zero-length chunk
                    // dispatched to subscribers, so higher layers don't need a separate
                    // native-only error channel to detect this.
                    nativePort?.postMessage(WebMessageCompat(ByteArray(0)))
                    // Fully tears down the dead port/ioManager so a future reattach's
                    // attemptConnect() -> usbBridge.connect() starts clean rather than
                    // layering a new connection on top of stale state.
                    usbBridge.disconnect()
                }
            },
        )

        WebViewCompat.postWebMessage(
            webView,
            WebMessageCompat(NATIVE_BRIDGE_PORT_MESSAGE, arrayOf(pageSidePort)),
            pageOrigin,
        )
    }

    fun stop() {
        reattachReceiver?.let { context.unregisterReceiver(it) }
        reattachReceiver = null
        usbBridge.disconnect()
        nativePort = null
        connected = false
        connecting = false
        // quitSafely() lets any WebMessage callback already dispatched to this thread
        // finish before the thread exits, rather than cutting it off mid-callback.
        // This controller instance is one-shot (see MainActivity.onDestroy()), so the
        // thread never needs to come back after this.
        callbackThread.quitSafely()
    }

    companion object {
        private const val TAG = "NativeSerialBridge"

        /** Must match NATIVE_BRIDGE_PORT_MESSAGE in NativeBridgeTransport.ts. */
        const val NATIVE_BRIDGE_PORT_MESSAGE = "dronelink:native-bridge-port"
    }
}

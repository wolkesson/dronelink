package link.dronelink.androidshell

import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Ties a UsbSerialSession (owns the USB device, lives in AirShellForegroundService,
 * independent of this Activity/WebView) to a WebMessageChannel posted into the WebView,
 * matching the open()/write() contract NativeBridgeTransport.ts expects on the JS side —
 * see packages/air-client-sdk/src/transport/NativeBridgeTransport.ts.
 *
 * Bytes from the page arrive as WebMessageCompat ArrayBuffer messages on the native-held
 * port and go straight to the session's USB write(); bytes from USB go straight out as
 * ArrayBuffer messages on the same port. No protocol parsing here either.
 */
class NativeSerialBridgeController(
    private val session: UsbSerialSession,
    private val webView: WebView,
    private val pageOrigin: Uri,
) {
    private var nativePort: WebMessagePortCompat? = null

    /**
     * Runs the page->native WebMessage callback (see postFreshPort()'s
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

    private val sessionListener = object : UsbSerialSession.Listener {
        override fun onConnected(isReconnect: Boolean) = postFreshPort(isReconnect)

        override fun onData(data: ByteArray) {
            Log.d(TAG, "-> WebView ${data.size}B")
            nativePort?.postMessage(WebMessageCompat(data))
        }

        override fun onError(message: String) {
            Log.e(TAG, "USB serial session error: $message")
            // Mirrors WebSerialTransport's disconnect signal: a zero-length chunk
            // dispatched to subscribers, so higher layers don't need a separate
            // native-only error channel to detect this.
            nativePort?.postMessage(WebMessageCompat(ByteArray(0)))
        }
    }

    /**
     * Joins the session (see UsbSerialSession.attachListener()'s doc comment): delivers a
     * port immediately if the session is already connected, otherwise waits for it to
     * connect -- including a later USB reattach, which UsbSerialSession itself now
     * watches for independent of any attached listener.
     */
    fun attach() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        ) {
            Log.e(TAG, "Installed WebView doesn't support the WebMessage APIs this bridge needs.")
            return
        }

        session.attachListener(sessionListener)
    }

    /**
     * Creates a fresh WebMessageChannel and posts its page-side port, mirroring the "may
     * push the MessagePort before Connect FC is ever clicked" eager behavior app.ts
     * expects (see its window "message" listener) -- both for the very first connect and
     * for every later reconnect. The previous channel's ports (if any) are simply
     * abandoned; MessageChannel/MessagePort has no explicit close-and-replace API, and
     * the old page-side port is already unusable once its NativeBridgeTransport instance
     * disconnected.
     *
     * Posts the RECONNECT message variant whenever isReconnect is true (a session that
     * has proven itself before -- either this WebView reattaching to an already-connected
     * session, or a live replug) so app.ts can auto-connect without the pilot re-tapping
     * "Connect FC"; the plain variant is reserved for a session's genuine first-ever
     * connect, which still wants that explicit gesture (see NativeBridgeTransport.ts).
     */
    private fun postFreshPort(isReconnect: Boolean) {
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
                    session.write(message.arrayBuffer)
                }
            },
        )

        val messageType = if (isReconnect) NATIVE_BRIDGE_PORT_RECONNECT_MESSAGE else NATIVE_BRIDGE_PORT_MESSAGE
        WebViewCompat.postWebMessage(
            webView,
            WebMessageCompat(messageType, arrayOf(pageSidePort)),
            pageOrigin,
        )
    }

    /** Detaches from the session WITHOUT disconnecting USB -- the session keeps running. */
    fun detach() {
        session.detachListener(sessionListener)
        nativePort = null
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

        /** Must match NATIVE_BRIDGE_PORT_RECONNECT_MESSAGE in NativeBridgeTransport.ts. */
        const val NATIVE_BRIDGE_PORT_RECONNECT_MESSAGE = "dronelink:native-bridge-port-reconnect"
    }
}

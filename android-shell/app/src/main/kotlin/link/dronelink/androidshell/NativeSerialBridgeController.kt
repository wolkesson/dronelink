package link.dronelink.androidshell

import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.WebView
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

    /**
     * Attempts to find and open an already-attached USB-serial device and hand a
     * MessagePort to the page. Does not retry if no device is attached yet — the
     * expected flow is BootUsbReceiver/AirShellForegroundService keeping the device
     * connected before the WebView (and this controller) starts. See spikes/
     * spike-4-usb-serial-bridge.md "Depends on" for why this is in MainActivity, not
     * the foreground service, for now.
     */
    fun start() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        ) {
            Log.e(TAG, "Installed WebView doesn't support the WebMessage APIs this bridge needs.")
            return
        }

        val channel = WebViewCompat.createWebMessageChannel(webView)
        val pageSidePort = channel[0]
        val nativeSidePort = channel[1]
        nativePort = nativeSidePort

        nativeSidePort.setWebMessageCallback(object : WebMessagePortCompat.WebMessageCallbackCompat() {
            override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat?) {
                if (message?.type != WebMessageCompat.TYPE_ARRAY_BUFFER) {
                    Log.w(TAG, "Ignoring non-ArrayBuffer WebMessage from page (type=${message?.type})")
                    return
                }
                Log.d(TAG, "<- WebView ${message.arrayBuffer.size}B")
                usbBridge.write(message.arrayBuffer)
            }
        })

        usbBridge.connect(
            object : UsbSerialBridge.Listener {
                override fun onData(data: ByteArray) {
                    Log.d(TAG, "-> WebView ${data.size}B")
                    nativePort?.postMessage(WebMessageCompat(data))
                }

                override fun onError(message: String) {
                    Log.e(TAG, "USB serial bridge error: $message")
                    // Mirrors WebSerialTransport's disconnect signal: a zero-length chunk
                    // dispatched to subscribers, so higher layers don't need a separate
                    // native-only error channel to detect this.
                    nativePort?.postMessage(WebMessageCompat(ByteArray(0)))
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
        usbBridge.disconnect()
        nativePort = null
    }

    companion object {
        private const val TAG = "NativeSerialBridge"

        /** Must match NATIVE_BRIDGE_PORT_MESSAGE in NativeBridgeTransport.ts. */
        const val NATIVE_BRIDGE_PORT_MESSAGE = "dronelink:native-bridge-port"
    }
}

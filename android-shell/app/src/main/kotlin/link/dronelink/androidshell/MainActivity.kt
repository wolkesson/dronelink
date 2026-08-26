package link.dronelink.androidshell

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import java.io.IOException

class MainActivity : AppCompatActivity() {

    private lateinit var webAppServer: LocalWebAppServer
    private var serialBridgeController: NativeSerialBridgeController? = null

    // Nullable (not lateinit) so onDestroy() can safely no-op if onCreate() returned
    // early (e.g. webAppServer failed to start) before this was ever assigned.
    private var webView: WebView? = null

    // Shared with WebPermissionBridge -- see PermissionRequestSequencer's doc comment
    // for why the notification-permission request below and the WebView's camera/mic
    // passthrough must not call Android's requestPermissions() concurrently.
    private val permissionSequencer = PermissionRequestSequencer()
    private val permissionBridge = WebPermissionBridge(this, permissionSequencer)

    // Set once onPageFinished() has confirmed the WebView is showing pageOrigin, and
    // once the service connection hands over the USB session -- whichever arrives
    // second is what actually attaches the bridge (see maybeAttachBridge()).
    private var pageOrigin: Uri? = null
    private var usbSession: UsbSerialSession? = null
    private var serviceBound = false
    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            usbSession = (binder as AirShellForegroundService.LocalBinder).getService().usbSession
            maybeAttachBridge()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            // Only fires on the service process crashing/being killed out from under us
            // (not a normal unbind, which never calls this) -- AirShellForegroundService
            // lives in this same process, so this shouldn't happen in practice.
            usbSession = null
        }
    }

    // The foreground service functions either way; this only affects whether
    // its notification is visible (Android 13+ requires it to be granted).
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { permissionSequencer.next() }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissionSequencer.run { notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
        }
        AirShellForegroundService.start(this)
        serviceBound = bindService(
            Intent(this, AirShellForegroundService::class.java),
            serviceConnection,
            Context.BIND_AUTO_CREATE,
        )

        webAppServer = LocalWebAppServer(assets)
        try {
            webAppServer.start()
        } catch (e: IOException) {
            Log.e(TAG, "Failed to start local webapp server", e)
            finish()
            return
        }

        val webView = WebView(this).also { setContentView(it) }
        this.webView = webView
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        // Lets apps/air-webapp's platform.ts pick NativeBridgeTransport over
        // WebSerialTransport synchronously (no async feature-detection race).
        webView.settings.userAgentString += " $ANDROID_SHELL_USER_AGENT_MARKER"
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                permissionBridge.onPermissionRequest(request)
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                permissionBridge.onPermissionRequestCanceled(request)
            }
        }

        val origin = Uri.parse("http://127.0.0.1:${webAppServer.listeningPort}")

        // postWebMessage() targets a specific origin and is dropped silently if the WebView
        // isn't actually showing that origin yet (e.g. still on about:blank mid-navigation),
        // so the bridge only attaches once onPageFinished confirms the page has loaded --
        // attaching right after loadUrl() would race that.
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                if (pageOrigin != null) return
                pageOrigin = origin
                maybeAttachBridge()
            }
        }
        webView.loadUrl("$origin/")
    }

    // The service connecting and the page finishing can arrive in either order -- this
    // runs from both callbacks and only actually attaches once both have happened.
    private fun maybeAttachBridge() {
        if (serialBridgeController != null) return
        val session = usbSession ?: return
        val view = webView ?: return
        val origin = pageOrigin ?: return
        serialBridgeController = NativeSerialBridgeController(session, view, origin).also { it.attach() }
    }

    override fun onDestroy() {
        // detach(), not the old stop() -- AirShellForegroundService's UsbSerialSession
        // deliberately keeps the USB connection alive independent of this Activity, so
        // tearing it down here would defeat the entire point of owning it in the service.
        serialBridgeController?.detach()
        serialBridgeController = null
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
        webAppServer.stop()

        // AirShellForegroundService deliberately keeps the process alive independent
        // of this Activity, so — unlike a normal app, where process death implicitly
        // frees everything — a WebView left undestroyed here can leak native resources
        // (notably an open camera from getUserMedia) across an Activity restart within
        // that same still-running process, breaking getUserMedia the next time this
        // Activity is created.
        webView?.let { view ->
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
        }
        webView = null

        super.onDestroy()
    }

    private companion object {
        const val TAG = "MainActivity"

        /** Must match ANDROID_SHELL_USER_AGENT_MARKER in apps/air-webapp/src/platform.ts. */
        const val ANDROID_SHELL_USER_AGENT_MARKER = "DroneLinkAndroidShell"
    }
}

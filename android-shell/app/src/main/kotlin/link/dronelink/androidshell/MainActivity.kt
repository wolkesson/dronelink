package link.dronelink.androidshell

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import java.io.IOException

class MainActivity : AppCompatActivity() {

    private lateinit var webAppServer: LocalWebAppServer
    private val permissionBridge = WebPermissionBridge(this)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webAppServer = LocalWebAppServer(assets)
        try {
            webAppServer.start()
        } catch (e: IOException) {
            Log.e(TAG, "Failed to start local webapp server", e)
            finish()
            return
        }

        val webView = WebView(this).also { setContentView(it) }
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                permissionBridge.onPermissionRequest(request)
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                permissionBridge.onPermissionRequestCanceled(request)
            }
        }

        webView.loadUrl("http://127.0.0.1:${webAppServer.listeningPort}/")
    }

    override fun onDestroy() {
        webAppServer.stop()
        super.onDestroy()
    }

    private companion object {
        const val TAG = "MainActivity"
    }
}

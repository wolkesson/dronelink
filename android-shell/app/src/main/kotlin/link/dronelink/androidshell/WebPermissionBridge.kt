package link.dronelink.androidshell

import android.Manifest
import android.content.pm.PackageManager
import android.webkit.PermissionRequest
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

/**
 * Grants WebView getUserMedia requests through to native CAMERA/RECORD_AUDIO
 * runtime permissions. No capture code lives here — the WebView's browser
 * engine performs capture itself via standard web APIs once permission is
 * granted (see ../../../../../../README.md "What not to add").
 *
 * Must be constructed before the host activity reaches STARTED (a property
 * initializer, same timing as calling registerForActivityResult directly
 * in onCreate/as a field), since ActivityResultCaller requires that.
 */
class WebPermissionBridge(private val activity: ComponentActivity) {

    private var pendingRequest: PermissionRequest? = null

    private val permissionLauncher = activity.registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { resolvePendingRequest() }

    fun onPermissionRequest(request: PermissionRequest) {
        pendingRequest = request
        val needed = request.resources.mapNotNull { nativePermissionFor(it) }.distinct()

        if (needed.all { hasPermission(it) }) {
            resolvePendingRequest()
        } else {
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    fun onPermissionRequestCanceled(request: PermissionRequest) {
        if (pendingRequest === request) pendingRequest = null
    }

    private fun resolvePendingRequest() {
        val request = pendingRequest ?: return
        pendingRequest = null

        val grantedResources = request.resources.filter { resource ->
            nativePermissionFor(resource)?.let { hasPermission(it) } ?: false
        }

        if (grantedResources.isNotEmpty()) request.grant(grantedResources.toTypedArray()) else request.deny()
    }

    private fun nativePermissionFor(resource: String): String? = when (resource) {
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
        else -> null
    }

    private fun hasPermission(permission: String) =
        ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED
}

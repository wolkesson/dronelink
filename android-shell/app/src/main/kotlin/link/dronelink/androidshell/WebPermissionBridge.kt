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
 *
 * [sequencer] must be the same instance MainActivity uses for its own
 * notification-permission request -- see PermissionRequestSequencer's doc
 * comment for why an unshared launcher call here would race it.
 */
class WebPermissionBridge(
    private val activity: ComponentActivity,
    private val sequencer: PermissionRequestSequencer,
) {

    private var pendingRequest: PermissionRequest? = null

    private val permissionLauncher = activity.registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { resolvePendingRequest() }

    fun onPermissionRequest(request: PermissionRequest) {
        val needed = request.resources.mapNotNull { nativePermissionFor(it) }.distinct()

        if (needed.all { hasPermission(it) }) {
            grantOrDeny(request)
        } else {
            pendingRequest = request
            sequencer.run { permissionLauncher.launch(needed.toTypedArray()) }
        }
    }

    fun onPermissionRequestCanceled(request: PermissionRequest) {
        if (pendingRequest === request) pendingRequest = null
    }

    private fun grantOrDeny(request: PermissionRequest) {
        val grantedResources = request.resources.filter { resource ->
            nativePermissionFor(resource)?.let { hasPermission(it) } ?: false
        }

        if (grantedResources.isNotEmpty()) request.grant(grantedResources.toTypedArray()) else request.deny()
    }

    // Only reached via the permissionLauncher callback, so every call here corresponds
    // to exactly one sequencer.run() above -- always releases it, even if the request
    // was cancelled (pendingRequest already cleared) in the meantime.
    private fun resolvePendingRequest() {
        val request = pendingRequest
        pendingRequest = null
        if (request != null) grantOrDeny(request)
        sequencer.next()
    }

    private fun nativePermissionFor(resource: String): String? = when (resource) {
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
        else -> null
    }

    private fun hasPermission(permission: String) =
        ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED
}

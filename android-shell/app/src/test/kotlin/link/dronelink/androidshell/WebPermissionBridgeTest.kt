package link.dronelink.androidshell

import android.Manifest
import android.app.Application
import android.webkit.PermissionRequest
import androidx.activity.ComponentActivity
import androidx.test.core.app.ApplicationProvider
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * WebPermissionBridge's constructor calls ComponentActivity.registerForActivityResult(),
 * which needs a real ActivityResultRegistry -- hence Robolectric rather than a plain
 * mocked Context/Activity.
 */
@RunWith(RobolectricTestRunner::class)
class WebPermissionBridgeTest {

    private lateinit var activity: ComponentActivity
    private lateinit var bridge: WebPermissionBridge

    @Before
    fun setUp() {
        activity = Robolectric.buildActivity(ComponentActivity::class.java).create().get()
        bridge = WebPermissionBridge(activity)
    }

    private fun requestFor(vararg resources: String): PermissionRequest {
        val request = mockk<PermissionRequest>(relaxed = true)
        every { request.resources } returns resources
        return request
    }

    private fun grant(vararg permissions: String) {
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).grantPermissions(*permissions)
    }

    private fun deny(vararg permissions: String) {
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).denyPermissions(*permissions)
    }

    @Test
    fun `grants immediately when the mapped permission is already held`() {
        grant(Manifest.permission.CAMERA)
        val request = requestFor(PermissionRequest.RESOURCE_VIDEO_CAPTURE)

        bridge.onPermissionRequest(request)

        verify { request.grant(match { it.contentEquals(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) }) }
    }

    @Test
    fun `denies immediately when no requested resource maps to a known permission`() {
        val request = requestFor("unknown-resource")

        bridge.onPermissionRequest(request)

        verify { request.deny() }
    }

    @Test
    fun `neither grants nor denies immediately when the permission still needs to be requested`() {
        deny(Manifest.permission.CAMERA)
        val request = requestFor(PermissionRequest.RESOURCE_VIDEO_CAPTURE)

        // Falls through to permissionLauncher.launch() instead of resolving synchronously --
        // the system permission dialog result would arrive asynchronously on a real device.
        bridge.onPermissionRequest(request)

        verify(exactly = 0) { request.grant(any()) }
        verify(exactly = 0) { request.deny() }
    }

    @Test
    fun `onPermissionRequestCanceled with no pending request is a no-op`() {
        val request = requestFor(PermissionRequest.RESOURCE_AUDIO_CAPTURE)

        bridge.onPermissionRequestCanceled(request)
    }
}

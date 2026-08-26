package link.dronelink.androidshell

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import io.mockk.Runs
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * start()/stop() register/unregister a real BroadcastReceiver via ContextCompat, which
 * needs a real (Robolectric-shadowed) Context rather than a plain mocked one -- same
 * reasoning as WebPermissionBridgeTest. UsbSerialBridge itself is mocked out so these
 * tests exercise only UsbSerialSession's attach/detach/reconnect bookkeeping, not any
 * real USB I/O.
 */
@RunWith(RobolectricTestRunner::class)
class UsbSerialSessionTest {

    private val context = ApplicationProvider.getApplicationContext<Application>().apply {
        // Robolectric emulates API 33+'s RECEIVER_NOT_EXPORTED enforcement at this
        // project's targetSdk (34) regardless of minSdk, and otherwise refuses to
        // register the receiver ContextCompat.registerReceiver() sets up in start().
        shadowOf(this).grantPermissions("org.robolectric.default.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
    }
    private val usbBridge = mockk<UsbSerialBridge>()
    private lateinit var session: UsbSerialSession

    private fun startAndCaptureBridgeListener(): UsbSerialBridge.Listener {
        val slot = slot<UsbSerialBridge.Listener>()
        every { usbBridge.connect(capture(slot)) } just Runs
        every { usbBridge.disconnect() } just Runs
        session = UsbSerialSession(context, usbBridge)
        session.start()
        return slot.captured
    }

    private fun testListener(): Pair<UsbSerialSession.Listener, MutableList<Boolean>> {
        val connectedCalls = mutableListOf<Boolean>()
        val listener = object : UsbSerialSession.Listener {
            override fun onConnected(isReconnect: Boolean) {
                connectedCalls += isReconnect
            }

            override fun onData(data: ByteArray) {}

            override fun onError(message: String) {}
        }
        return listener to connectedCalls
    }

    @Test
    fun `attachListener delivers onConnected synchronously when already connected`() {
        val bridgeListener = startAndCaptureBridgeListener()
        bridgeListener.onConnected()
        val (listener, connectedCalls) = testListener()

        session.attachListener(listener)

        assertEquals(listOf(true), connectedCalls)
    }

    @Test
    fun `attachListener delivers nothing when not yet connected`() {
        startAndCaptureBridgeListener()
        val (listener, connectedCalls) = testListener()

        session.attachListener(listener)

        assertEquals(emptyList<Boolean>(), connectedCalls)
    }

    @Test
    fun `first-ever connect reports isReconnect false, later connects report true`() {
        val bridgeListener = startAndCaptureBridgeListener()
        val (listener, connectedCalls) = testListener()
        session.attachListener(listener)

        bridgeListener.onConnected()
        bridgeListener.onConnected()

        assertEquals(listOf(false, true), connectedCalls)
    }

    @Test
    fun `onData with no attached listener is a silent no-op`() {
        val bridgeListener = startAndCaptureBridgeListener()

        // No listener attached at all -- must not throw.
        bridgeListener.onData(byteArrayOf(0x01, 0x02))
    }

    @Test
    fun `onData is forwarded to the attached listener but not after detach`() {
        val bridgeListener = startAndCaptureBridgeListener()
        val received = mutableListOf<ByteArray>()
        val listener = object : UsbSerialSession.Listener {
            override fun onConnected(isReconnect: Boolean) {}
            override fun onData(data: ByteArray) { received += data }
            override fun onError(message: String) {}
        }

        session.attachListener(listener)
        bridgeListener.onData(byteArrayOf(0x01))
        session.detachListener(listener)
        bridgeListener.onData(byteArrayOf(0x02))

        assertEquals(1, received.size)
        assertArrayEquals(byteArrayOf(0x01), received[0])
    }

    @Test
    fun `detachListener does not disconnect the USB device`() {
        val bridgeListener = startAndCaptureBridgeListener()
        bridgeListener.onConnected()
        val (listener, _) = testListener()
        session.attachListener(listener)

        session.detachListener(listener)

        verify(exactly = 0) { usbBridge.disconnect() }
    }

    @Test
    fun `bridge onError disconnects the bridge and clears connected state`() {
        val bridgeListener = startAndCaptureBridgeListener()
        bridgeListener.onConnected()

        bridgeListener.onError("USB read error")

        verify(exactly = 1) { usbBridge.disconnect() }
        val (listener, connectedCalls) = testListener()
        session.attachListener(listener)
        // connected is now false, so a fresh attach must not get a synchronous onConnected.
        assertEquals(emptyList<Boolean>(), connectedCalls)
    }

    @Test
    fun `hasEverConnected latches true across a later disconnect`() {
        val bridgeListener = startAndCaptureBridgeListener()
        val (listener, connectedCalls) = testListener()
        session.attachListener(listener)

        bridgeListener.onConnected()
        bridgeListener.onError("USB read error")
        bridgeListener.onConnected()

        assertEquals(listOf(false, true), connectedCalls)
    }
}

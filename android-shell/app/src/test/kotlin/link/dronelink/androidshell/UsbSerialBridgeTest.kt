package link.dronelink.androidshell

import android.content.Context
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UsbSerialBridgeTest {

    private val usbManager = mockk<UsbManager>()
    private val context = mockk<Context>()
    private val bridge: UsbSerialBridge

    init {
        every { context.getSystemService(Context.USB_SERVICE) } returns usbManager
        bridge = UsbSerialBridge(context)
    }

    private fun deviceWithInterfaceClasses(vararg classes: Int): UsbDevice {
        val device = mockk<UsbDevice>()
        every { device.interfaceCount } returns classes.size
        classes.forEachIndexed { index, interfaceClass ->
            val iface = mockk<UsbInterface>()
            every { iface.interfaceClass } returns interfaceClass
            every { device.getInterface(index) } returns iface
        }
        return device
    }

    @Test
    fun `looksLikeCdcAcm true when a COMM-class interface is present`() {
        val device = deviceWithInterfaceClasses(UsbConstants.USB_CLASS_VENDOR_SPEC, UsbConstants.USB_CLASS_COMM)

        assertTrue(bridge.looksLikeCdcAcm(device))
    }

    @Test
    fun `looksLikeCdcAcm false when no interface is COMM-class`() {
        val device = deviceWithInterfaceClasses(UsbConstants.USB_CLASS_VENDOR_SPEC, UsbConstants.USB_CLASS_HID)

        assertFalse(bridge.looksLikeCdcAcm(device))
    }

    @Test
    fun `looksLikeCdcAcm false for a device with no interfaces`() {
        val device = deviceWithInterfaceClasses()

        assertFalse(bridge.looksLikeCdcAcm(device))
    }

    @Test
    fun `toHexPreview formats bytes as lowercase space-separated hex`() {
        val bytes = byteArrayOf(0x24, 0x4d, 0x3c)

        with(bridge) {
            assertEquals("24 4d 3c", bytes.toHexPreview())
        }
    }

    @Test
    fun `toHexPreview truncates with ellipsis beyond maxBytes`() {
        val bytes = ByteArray(20) { it.toByte() }

        with(bridge) {
            assertEquals("00 01 02 03 …", bytes.toHexPreview(maxBytes = 4))
        }
    }

    @Test
    fun `toHexPreview does not append ellipsis when exactly maxBytes`() {
        val bytes = byteArrayOf(0x00, 0x01, 0x02, 0x03)

        with(bridge) {
            assertEquals("00 01 02 03", bytes.toHexPreview(maxBytes = 4))
        }
    }
}

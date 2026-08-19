package link.dronelink.androidshell

import android.content.res.AssetManager
import fi.iki.elonen.NanoHTTPD
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import java.io.ByteArrayInputStream
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalWebAppServerTest {

    private val assets = mockk<AssetManager>()
    private val server = LocalWebAppServer(assets)

    private fun sessionFor(uri: String): NanoHTTPD.IHTTPSession {
        val session = mockk<NanoHTTPD.IHTTPSession>()
        every { session.uri } returns uri
        return session
    }

    private fun responseBody(response: NanoHTTPD.Response): String =
        response.data.bufferedReader().readText()

    @Test
    fun `serves a known JS asset with the explicit text-javascript mime type`() {
        every { assets.open("webapp/app.js") } returns ByteArrayInputStream("console.log(1)".toByteArray())

        val response = server.serve(sessionFor("/app.js"))

        assertEquals(NanoHTTPD.Response.Status.OK, response.status)
        assertEquals("text/javascript", response.mimeType)
    }

    @Test
    fun `falls back to application-octet-stream for an unknown extension`() {
        every { assets.open("webapp/data.bin") } returns ByteArrayInputStream(byteArrayOf(1, 2, 3))

        val response = server.serve(sessionFor("/data.bin"))

        assertEquals("application/octet-stream", response.mimeType)
    }

    @Test
    fun `empty request path resolves to index-html`() {
        every { assets.open("webapp/index.html") } returns ByteArrayInputStream("<html></html>".toByteArray())

        val response = server.serve(sessionFor(""))

        assertEquals(NanoHTTPD.Response.Status.OK, response.status)
        verify { assets.open("webapp/index.html") }
    }

    @Test
    fun `missing asset returns 404 with a build-reminder message`() {
        every { assets.open("webapp/missing.js") } throws IOException("not found")

        val response = server.serve(sessionFor("/missing.js"))

        assertEquals(NanoHTTPD.Response.Status.NOT_FOUND, response.status)
        assertTrue(responseBody(response).contains("npm run build --workspace @dronelink/air-webapp"))
    }
}

package link.dronelink.androidshell

import android.content.res.AssetManager
import fi.iki.elonen.NanoHTTPD
import java.io.IOException
import java.net.URLConnection

/**
 * Serves the bundled air-webapp PWA build from Android assets over
 * http://127.0.0.1:<port>. `file://` is intentionally avoided because
 * getUserMedia/WebRTC require a secure context; Chrome treats
 * http://127.0.0.1 as a trustworthy origin regardless of scheme, so no TLS
 * is needed here (see ../../../../../../README.md "What not to add").
 */
class LocalWebAppServer(private val assets: AssetManager) : NanoHTTPD("127.0.0.1", 0) {

    override fun serve(session: IHTTPSession): Response {
        val requestPath = session.uri.trimStart('/').ifEmpty { INDEX_FILE }
        val assetPath = "$ASSET_ROOT/$requestPath"

        return try {
            val stream = assets.open(assetPath)
            val mimeType = URLConnection.guessContentTypeFromName(assetPath) ?: "application/octet-stream"
            newChunkedResponse(Response.Status.OK, mimeType, stream)
        } catch (e: IOException) {
            newFixedLengthResponse(
                Response.Status.NOT_FOUND,
                MIME_PLAINTEXT,
                "Not found: $assetPath. Did you run `npm run build --workspace @dronelink/air-webapp` " +
                    "before building android-shell? The copyWebapp Gradle task embeds that build into assets."
            )
        }
    }

    private companion object {
        const val ASSET_ROOT = "webapp"
        const val INDEX_FILE = "index.html"
    }
}

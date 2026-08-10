package link.dronelink.androidshell

import android.content.res.AssetManager
import fi.iki.elonen.NanoHTTPD
import java.io.IOException

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
            newChunkedResponse(Response.Status.OK, mimeTypeFor(assetPath), stream)
        } catch (e: IOException) {
            newFixedLengthResponse(
                Response.Status.NOT_FOUND,
                MIME_PLAINTEXT,
                "Not found: $assetPath. Did you run `npm run build --workspace @dronelink/air-webapp` " +
                    "before building android-shell? The copyWebapp Gradle task embeds that build into assets."
            )
        }
    }

    private fun mimeTypeFor(path: String): String =
        MIME_TYPES[path.substringAfterLast('.', "")] ?: "application/octet-stream"

    private companion object {
        const val ASSET_ROOT = "webapp"
        const val INDEX_FILE = "index.html"

        // Android's URLConnection.guessContentTypeFromName() unreliably returns null for
        // "js" (and others), which falls back to application/octet-stream — Chrome's strict
        // MIME checking then refuses to run it as a module script or register it as a service
        // worker, producing a blank page with no visible error beyond the JS console. Serve
        // an explicit table for the extensions a Vite PWA build actually emits instead.
        val MIME_TYPES = mapOf(
            "html" to "text/html",
            "js" to "text/javascript",
            "mjs" to "text/javascript",
            "css" to "text/css",
            "json" to "application/json",
            "webmanifest" to "application/manifest+json",
            "svg" to "image/svg+xml",
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "gif" to "image/gif",
            "ico" to "image/x-icon",
            "woff" to "font/woff",
            "woff2" to "font/woff2",
            "ttf" to "font/ttf",
            "wasm" to "application/wasm",
            "txt" to "text/plain",
            "map" to "application/json",
        )
    }
}

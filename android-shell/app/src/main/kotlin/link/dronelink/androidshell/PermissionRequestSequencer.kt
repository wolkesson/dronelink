package link.dronelink.androidshell

/**
 * Serializes calls to Android's runtime permission request API across independent
 * call sites within one Activity.
 *
 * Two concurrent `requestPermissions()` calls from the same Activity race: whichever
 * one is still pending when the second fires gets silently cancelled (empty grant
 * results, no dialog shown). MainActivity has two independent triggers that both end
 * up calling it -- the notification-permission request in onCreate() and
 * WebPermissionBridge's camera/mic passthrough, fired whenever the page's JS calls
 * getUserMedia(). On a fresh install these can land within milliseconds of each
 * other (the notification dialog is still up when the WebView's first camera
 * request arrives), which silently drops the camera dialog on exactly the first
 * launch -- see WebPermissionBridge's doc comment. Routing every such call through
 * one sequencer instead fixes that by construction.
 */
class PermissionRequestSequencer {

    private var busy = false
    private val queue = ArrayDeque<() -> Unit>()

    /**
     * Runs [action] now if no permission request is in flight, otherwise queues it
     * to run once the current one resolves. [action] must eventually call [next]
     * exactly once, from whatever asynchronous callback resolves the request it starts.
     */
    fun run(action: () -> Unit) {
        queue.addLast(action)
        advance()
    }

    /** Call after a request started via [run] has resolved (its result callback fired). */
    fun next() {
        busy = false
        advance()
    }

    private fun advance() {
        if (busy) return
        val action = queue.removeFirstOrNull() ?: return
        busy = true
        action()
    }
}

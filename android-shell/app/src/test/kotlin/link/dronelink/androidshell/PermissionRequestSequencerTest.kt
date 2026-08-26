package link.dronelink.androidshell

import org.junit.Assert.assertEquals
import org.junit.Test

class PermissionRequestSequencerTest {

    @Test
    fun `runs a single action immediately`() {
        val sequencer = PermissionRequestSequencer()
        var ran = false

        sequencer.run { ran = true }

        assertEquals(true, ran)
    }

    @Test
    fun `queues a second action until the first resolves`() {
        val sequencer = PermissionRequestSequencer()
        var firstRan = false
        var secondRan = false

        sequencer.run { firstRan = true }
        sequencer.run { secondRan = true }

        assertEquals(true, firstRan)
        assertEquals(false, secondRan)

        sequencer.next()

        assertEquals(true, secondRan)
    }

    @Test
    fun `next with an empty queue is a harmless no-op`() {
        val sequencer = PermissionRequestSequencer()

        sequencer.next()
        var ran = false
        sequencer.run { ran = true }

        assertEquals(true, ran)
    }

    @Test
    fun `runs several queued actions in order as each resolves`() {
        val sequencer = PermissionRequestSequencer()
        val order = mutableListOf<Int>()

        sequencer.run { order.add(1) }
        sequencer.run { order.add(2) }
        sequencer.run { order.add(3) }
        sequencer.next()
        sequencer.next()

        assertEquals(listOf(1, 2, 3), order)
    }
}

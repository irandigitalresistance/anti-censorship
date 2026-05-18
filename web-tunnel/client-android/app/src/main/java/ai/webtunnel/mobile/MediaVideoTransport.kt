package ai.webtunnel.mobile

import android.os.SystemClock
import android.util.Log
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.VideoTrackPublishOptions
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.TrackPublication
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import io.livekit.android.room.track.VideoTrack as LiveKitVideoTrack
import io.livekit.android.room.track.video.VideoFrameCapturer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import livekit.org.webrtc.JavaI420Buffer
import livekit.org.webrtc.VideoFrame
import livekit.org.webrtc.VideoSink
import java.nio.ByteBuffer
import java.util.concurrent.PriorityBlockingQueue
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

private const val MEDIA_VIDEO_FRAME_INTERVAL_MS = 33L
private const val MEDIA_VIDEO_ACK_INTERVAL_MS = 50L
private const val MEDIA_VIDEO_ACK_REPEAT_COUNT = 6
private const val MEDIA_VIDEO_MAX_PENDING_PACKETS = 192
private const val MEDIA_VIDEO_RETRANSMIT_MS = 350L
private const val MEDIA_VIDEO_TRACK_NAME = "wt-media-packets"
private const val MEDIA_VIDEO_FPS = 30
private const val MEDIA_VIDEO_BITRATE = 1_500_000

class MediaVideoTransport private constructor(
  private val room: Room,
  private val scope: CoroutineScope,
  private val capturer: VideoFrameCapturer,
  private val localTrack: LocalVideoTrack,
  private val peerIdentity: String?,
  private val onLog: (String) -> Unit,
) : Transport {
  private var onMessageHandler: ((ByteArray) -> Unit)? = null
  private var onCloseHandler: ((String) -> Unit)? = null
  private val closed = AtomicBoolean(false)
  private val sendQueue = PriorityBlockingQueue<MediaOutboundPacket>()
  private val sendSignal = Semaphore(0)
  private val sendSeq = AtomicLong(0L)
  private val stateLock = Object()
  private val partialLock = Object()
  private val sinks = linkedMapOf<LiveKitVideoTrack, VideoSink>()
  private val pendingPackets = linkedMapOf<Int, PendingMediaPacket>()
  private val ackRepeats = linkedMapOf<Int, Int>()
  private val partialMessages = linkedMapOf<String, MediaFragmentSet>()
  private val completedMessages = linkedMapOf<String, MutableMap<Int, ByteArray>>()
  private val expectedMessageIds = linkedMapOf<String, Int>()
  private val seenDataSeqs = ArrayDeque<Int>()
  private var lastAckSeqToSend: Int? = null
  private var lastAckFrameAt = 0L
  private var nextPacketSeq = 1
  private var nextMessageId = 1
  private var nextPacketOrder = 1L

  private val eventsJob: Job = scope.launch(Dispatchers.IO) {
    room.events.collect { event ->
      when (event) {
        is RoomEvent.TrackSubscribed -> {
          startVideoReader(event.track, event.publication, event.participant)
        }
        is RoomEvent.TrackUnsubscribed -> {
          val track = event.track as? LiveKitVideoTrack ?: return@collect
          stopVideoReader(track)
        }
        is RoomEvent.Disconnected -> {
          closeFromTransport("disconnected")
        }
        is RoomEvent.FailedToConnect -> {
          closeFromTransport("livekit failed to connect: ${event.error.message ?: "unknown"}")
        }
        else -> Unit
      }
    }
  }

  private val tickerJob: Job = scope.launch(Dispatchers.Default) {
    while (!closed.get()) {
      try {
        publishFrame(selectFramePacket())
      } catch (error: Throwable) {
        Log.w("WebTunnel", "media-video publish frame failed: ${error.message}")
      }
      delay(MEDIA_VIDEO_FRAME_INTERVAL_MS)
    }
  }

  private val sendJob: Job = scope.launch(Dispatchers.IO) {
    while (!closed.get()) {
      try {
        sendSignal.acquire()
      } catch (_: InterruptedException) {
        break
      }
      if (closed.get()) continue
      val outbound = sendQueue.poll() ?: continue
      try {
        sendBytes(outbound.bytes)
      } catch (error: Throwable) {
        closeFromTransport("media-video send failed: ${error.message ?: "unknown"}")
        break
      }
    }
  }

  init {
    startExistingVideoReaders()
  }

  override fun send(bytes: ByteArray) {
    enqueueOutbound(bytes, priority = 1)
  }

  override fun sendPriority(bytes: ByteArray) {
    enqueueOutbound(bytes, priority = 0)
  }

  override fun sendUnreliable(bytes: ByteArray) {
    enqueueOutbound(bytes, priority = 0)
  }

  private fun enqueueOutbound(bytes: ByteArray, priority: Int) {
    if (closed.get()) return
    sendQueue.offer(MediaOutboundPacket(priority, sendSeq.getAndIncrement(), bytes.copyOf()))
    sendSignal.release()
  }

  override fun onMessage(cb: (ByteArray) -> Unit) {
    onMessageHandler = cb
  }

  override fun onClose(cb: (String) -> Unit) {
    onCloseHandler = cb
    if (closed.get()) cb("already closed")
  }

  override fun close(reason: String) {
    if (!closed.compareAndSet(false, true)) return
    sendQueue.clear()
    sendSignal.release()
    synchronized(stateLock) {
      pendingPackets.clear()
      ackRepeats.clear()
    }
    scope.launch(Dispatchers.IO) {
      eventsJob.cancel()
      tickerJob.cancel()
      sendJob.cancel()
      synchronized(sinks) {
        for ((track, sink) in sinks) {
          try { track.removeRenderer(sink) } catch (_: Throwable) {}
        }
        sinks.clear()
      }
      try { localTrack.stopCapture() } catch (_: Throwable) {}
      try { room.localParticipant.unpublishTrack(localTrack, true) } catch (_: Throwable) {}
      try { localTrack.dispose() } catch (_: Throwable) {}
      try { room.disconnect() } catch (_: Throwable) {}
      onCloseHandler?.invoke(reason)
    }
  }

  private fun closeFromTransport(reason: String) {
    if (!closed.compareAndSet(false, true)) return
    sendQueue.clear()
    sendSignal.release()
    synchronized(stateLock) {
      pendingPackets.clear()
      ackRepeats.clear()
    }
    onCloseHandler?.invoke(reason)
  }

  private suspend fun sendBytes(bytes: ByteArray) {
    val msgId = synchronized(stateLock) {
      val msgId = nextMessageId
      nextMessageId = nextU16(nextMessageId)
      msgId
    }
    val chunks = chunkMediaPayload(bytes)
    require(chunks.size <= 0xff) { "media-video message has too many fragments (${chunks.size} > 255)" }
    for (index in chunks.indices) {
      waitForPendingCapacity()
      synchronized(stateLock) {
        if (closed.get()) throw IllegalStateException("media-video carrier closed")
        val seq = nextPacketSeq
        nextPacketSeq = nextU16(nextPacketSeq)
        pendingPackets[seq] = PendingMediaPacket(
          packet = MediaVideoPacket(
            kind = MEDIA_VIDEO_PACKET_KIND_DATA,
            seq = seq,
            ackSeq = lastAckSeqToSend,
            msgId = msgId,
            fragIndex = index,
            fragCount = chunks.size,
            payload = chunks[index],
          ),
          order = nextPacketOrder++,
        )
      }
    }
  }

  private suspend fun waitForPendingCapacity() {
    while (!closed.get()) {
      val hasCapacity = synchronized(stateLock) {
        pendingPackets.size < MEDIA_VIDEO_MAX_PENDING_PACKETS
      }
      if (hasCapacity) return
      delay(10L)
    }
    throw IllegalStateException("media-video carrier closed")
  }

  private fun selectFramePacket(): MediaVideoPacket {
    val now = SystemClock.elapsedRealtime()
    synchronized(stateLock) {
      val pending = selectPendingPacketLocked(now)
      val ackDue = ackRepeats.isNotEmpty() &&
        (now - lastAckFrameAt >= MEDIA_VIDEO_ACK_INTERVAL_MS || pending == null)
      if (ackDue) return buildAckPacketLocked(now, consumeRepeats = true)
      if (pending != null) {
        pending.lastSentAt = now
        pending.sendCount += 1
        return pending.packet.copy(ackSeq = lastAckSeqToSend)
      }
      return buildAckPacketLocked(now, consumeRepeats = false)
    }
  }

  private fun selectPendingPacketLocked(now: Long): PendingMediaPacket? {
    var retry: PendingMediaPacket? = null
    for (pending in pendingPackets.values) {
      if (pending.lastSentAt == 0L) return pending
      if (now - pending.lastSentAt < MEDIA_VIDEO_RETRANSMIT_MS) continue
      val currentRetry = retry
      if (
        currentRetry == null ||
        pending.lastSentAt < currentRetry.lastSentAt ||
        (pending.lastSentAt == currentRetry.lastSentAt && pending.order < currentRetry.order)
      ) {
        retry = pending
      }
    }
    return retry
  }

  private fun buildAckPacketLocked(now: Long, consumeRepeats: Boolean): MediaVideoPacket {
    val seqs = ArrayList<Int>(minOf(ackRepeats.size, MEDIA_VIDEO_PAYLOAD_BYTES / 2))
    if (consumeRepeats) {
      val iterator = ackRepeats.entries.iterator()
      while (iterator.hasNext() && seqs.size < MEDIA_VIDEO_PAYLOAD_BYTES / 2) {
        val entry = iterator.next()
        seqs += entry.key
        if (entry.value <= 1) iterator.remove() else entry.setValue(entry.value - 1)
      }
      lastAckFrameAt = now
    }
    return MediaVideoPacket(
      kind = MEDIA_VIDEO_PACKET_KIND_ACK,
      seq = 0,
      ackSeq = lastAckSeqToSend,
      msgId = 0,
      fragIndex = 0,
      fragCount = 0,
      payload = encodeMediaVideoAckPayload(seqs),
    )
  }

  private fun publishFrame(packet: MediaVideoPacket) {
    if (closed.get()) return
    val packetBytes = encodeMediaVideoPacket(packet)
    val frameBytes = encodeMediaVideoPacketToI420(packetBytes)
    val yBytes = MEDIA_VIDEO_FRAME_WIDTH * MEDIA_VIDEO_FRAME_HEIGHT
    val chromaWidth = (MEDIA_VIDEO_FRAME_WIDTH + 1) / 2
    val chromaHeight = (MEDIA_VIDEO_FRAME_HEIGHT + 1) / 2
    val chromaBytes = chromaWidth * chromaHeight
    val buffer = JavaI420Buffer.allocate(MEDIA_VIDEO_FRAME_WIDTH, MEDIA_VIDEO_FRAME_HEIGHT)
    buffer.dataY.put(frameBytes, 0, yBytes)
    buffer.dataU.put(frameBytes, yBytes, chromaBytes)
    buffer.dataV.put(frameBytes, yBytes + chromaBytes, chromaBytes)
    val frame = VideoFrame(buffer, 0, System.nanoTime())
    try {
      capturer.pushVideoFrame(frame)
    } finally {
      frame.release()
    }
  }

  private fun startExistingVideoReaders() {
    for (participant in room.remoteParticipants.values) {
      for ((publication, track) in participant.videoTrackPublications) {
        if (track != null) startVideoReader(track, publication, participant)
      }
    }
  }

  private fun startVideoReader(track: Track, publication: TrackPublication, participant: Participant) {
    val videoTrack = track as? LiveKitVideoTrack ?: return
    val fromIdentity = participant.identity?.value ?: "unknown"
    if (fromIdentity == room.localParticipant.identity?.value) return
    if (peerIdentity != null && fromIdentity != peerIdentity) return
    if (publication.name != MEDIA_VIDEO_TRACK_NAME && videoTrack.name != MEDIA_VIDEO_TRACK_NAME) return
    synchronized(sinks) {
      if (sinks.containsKey(videoTrack)) return
      val sink = VideoSink { frame ->
        handleVideoFrame(frame, fromIdentity)
      }
      sinks[videoTrack] = sink
      videoTrack.addRenderer(sink)
    }
    onLog("media-video subscribed identity=$fromIdentity track=${publication.name}")
  }

  private fun stopVideoReader(track: LiveKitVideoTrack) {
    val sink = synchronized(sinks) { sinks.remove(track) } ?: return
    try { track.removeRenderer(sink) } catch (_: Throwable) {}
  }

  private fun handleVideoFrame(frame: VideoFrame, fromIdentity: String) {
    if (closed.get()) return
    val i420 = try {
      frame.buffer.toI420()
    } catch (_: Throwable) {
      return
    } ?: return
    try {
      val yPlane = copyPlane(i420.dataY, i420.width, i420.height, i420.strideY)
      val raw = decodeMediaVideoPacketFromI420(yPlane, i420.width, i420.height)
      val packet = decodeMediaVideoPacket(raw) ?: return
      handlePacket(packet, fromIdentity)
    } catch (_: Throwable) {
      return
    } finally {
      i420.release()
    }
  }

  private fun handlePacket(packet: MediaVideoPacket, fromIdentity: String) {
    packet.ackSeq?.let { markAcked(it) }
    if (packet.kind == MEDIA_VIDEO_PACKET_KIND_ACK) {
      for (seq in decodeMediaVideoAckPayload(packet.payload)) markAcked(seq)
      return
    }
    if (packet.kind != MEDIA_VIDEO_PACKET_KIND_DATA) return
    queueAck(packet.seq)
    val deliveries = synchronized(partialLock) {
      if (hasSeenSeq(packet.seq)) return@synchronized emptyList()
      rememberSeq(packet.seq)
      if (packet.fragCount == 0 || packet.fragIndex >= packet.fragCount) return@synchronized emptyList()
      val key = "$fromIdentity:${packet.msgId}"
      var partial = partialMessages[key]
      if (partial == null || partial.fragCount != packet.fragCount) {
        partial = MediaFragmentSet(packet.fragCount, fromIdentity)
        partialMessages[key] = partial
      }
      partial.received[packet.fragIndex] = packet.payload
      if (partial.received.size != partial.fragCount) return@synchronized emptyList()
      partialMessages.remove(key)
      val total = partial.received.values.sumOf { it.size }
      val out = ByteArray(total)
      var offset = 0
      for (index in 0 until partial.fragCount) {
        val fragment = partial.received[index] ?: return@synchronized emptyList()
        System.arraycopy(fragment, 0, out, offset, fragment.size)
        offset += fragment.size
      }
      bufferCompletedMessageLocked(partial.fromIdentity, packet.msgId, out)
    }
    for (delivery in deliveries) {
      try {
        onMessageHandler?.invoke(delivery)
      } catch (error: Throwable) {
        Log.w("WebTunnel", "media-video receive callback threw: ${error.javaClass.simpleName}: ${error.message}")
      }
    }
  }

  private fun queueAck(seq: Int) {
    synchronized(stateLock) {
      lastAckSeqToSend = seq
      ackRepeats[seq] = MEDIA_VIDEO_ACK_REPEAT_COUNT
    }
  }

  private fun markAcked(seq: Int) {
    synchronized(stateLock) {
      pendingPackets.remove(seq)
    }
  }

  private fun bufferCompletedMessageLocked(fromIdentity: String, msgId: Int, bytes: ByteArray): List<ByteArray> {
    val completed = completedMessages.getOrPut(fromIdentity) { linkedMapOf() }
    completed[msgId] = bytes
    var expected = expectedMessageIds[fromIdentity] ?: 1
    val deliveries = ArrayList<ByteArray>()
    while (true) {
      val next = completed.remove(expected) ?: break
      deliveries += next
      expected = nextU16(expected)
    }
    expectedMessageIds[fromIdentity] = expected
    return deliveries
  }

  private fun hasSeenSeq(seq: Int): Boolean = seenDataSeqs.contains(seq)

  private fun rememberSeq(seq: Int) {
    seenDataSeqs.addLast(seq)
    while (seenDataSeqs.size > 8192) seenDataSeqs.removeFirst()
  }

  companion object {
    suspend fun create(
      room: Room,
      scope: CoroutineScope,
      peerIdentity: String?,
      onLog: (String) -> Unit,
    ): MediaVideoTransport {
      val capturer = VideoFrameCapturer()
      val track = room.localParticipant.createVideoTrack(
        MEDIA_VIDEO_TRACK_NAME,
        capturer,
        LocalVideoTrackOptions(
          captureParams = VideoCaptureParameter(
            MEDIA_VIDEO_FRAME_WIDTH,
            MEDIA_VIDEO_FRAME_HEIGHT,
            MEDIA_VIDEO_FPS,
          ),
        ),
        null,
      )
      track.startCapture()
      val published = room.localParticipant.publishVideoTrack(
        track,
        VideoTrackPublishOptions(
          name = MEDIA_VIDEO_TRACK_NAME,
          videoEncoding = VideoEncoding(MEDIA_VIDEO_BITRATE, MEDIA_VIDEO_FPS),
          simulcast = false,
          source = Track.Source.CAMERA,
        ),
      )
      if (!published) {
        try { track.dispose() } catch (_: Throwable) {}
        throw IllegalStateException("media-video track publish failed")
      }
      onLog("media-video published track=$MEDIA_VIDEO_TRACK_NAME bitrate=$MEDIA_VIDEO_BITRATE fps=$MEDIA_VIDEO_FPS")
      return MediaVideoTransport(room, scope, capturer, track, peerIdentity, onLog)
    }
  }
}

private data class PendingMediaPacket(
  val packet: MediaVideoPacket,
  val order: Long,
  var lastSentAt: Long = 0L,
  var sendCount: Int = 0,
)

private data class MediaFragmentSet(
  val fragCount: Int,
  val fromIdentity: String,
  val received: MutableMap<Int, ByteArray> = linkedMapOf(),
)

private data class MediaOutboundPacket(
  val priority: Int,
  val seq: Long,
  val bytes: ByteArray,
) : Comparable<MediaOutboundPacket> {
  override fun compareTo(other: MediaOutboundPacket): Int {
    val byPriority = priority.compareTo(other.priority)
    return if (byPriority != 0) byPriority else seq.compareTo(other.seq)
  }
}

private fun chunkMediaPayload(bytes: ByteArray): List<ByteArray> {
  if (bytes.isEmpty()) return listOf(ByteArray(0))
  val out = ArrayList<ByteArray>((bytes.size + MEDIA_VIDEO_PAYLOAD_BYTES - 1) / MEDIA_VIDEO_PAYLOAD_BYTES)
  var offset = 0
  while (offset < bytes.size) {
    val end = minOf(offset + MEDIA_VIDEO_PAYLOAD_BYTES, bytes.size)
    out += bytes.copyOfRange(offset, end)
    offset = end
  }
  return out
}

private fun copyPlane(data: ByteBuffer, width: Int, height: Int, stride: Int): ByteArray {
  val out = ByteArray(width * height)
  val dup = data.duplicate()
  for (row in 0 until height) {
    dup.position(row * stride)
    dup.get(out, row * width, width)
  }
  return out
}

private fun nextU16(value: Int): Int {
  val next = (value + 1) and 0xffff
  return if (next == 0) 1 else next
}

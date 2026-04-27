package ai.webtunnel.mobile

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import net.jpountz.lz4.LZ4Factory
import net.jpountz.lz4.LZ4FrameOutputStream
import org.bouncycastle.math.ec.rfc7748.X25519
import org.bouncycastle.math.ec.rfc8032.Ed25519
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

private const val WT2_VERSION: Int = 2
private const val WT2_HEADER_BYTES: Int = 10
private const val WT2_FLAG_COMPRESSED: Int = 1 shl 0
private const val WT2_FLAG_RELIABLE: Int = 1 shl 1
private const val WT2_TYPE_CONTROL: Int = 1
private const val WT2_TYPE_TCP: Int = 2
private const val WT2_TYPE_UDP: Int = 3
private const val WT2_TYPE_LOG: Int = 4
private const val WT2_CLIENT_MAGIC = "WT2CH"
private const val WT2_SERVER_MAGIC = "WT2SH"
private const val WT2_SIG_LABEL = "WT2-SIG"
private const val WT2_INFO = "web-tunnel session v2"
private const val WT2_NONCE_BYTES = 16
private const val WT2_PUB_BYTES = 32
private const val WT2_SIG_BYTES = 64
private const val WT2_DEFAULT_COMPRESSION_THRESHOLD = 512
private const val WT2_DEFAULT_MIN_COMPRESSION_SAVINGS = 48
private const val WT2_MAX_CHUNK_PAYLOAD = 2_000

private val RANDOM_V2 = SecureRandom()

data class RunClientTunnelV2Result(
  val mux: TunnelMuxV2,
  val serverPublicKey: ByteArray,
  val serverFingerprint: String,
)

private data class V2ClientHandshakeResult(
  val cipher: SessionCipher,
  val serverPublicKey: ByteArray,
  val serverFingerprint: String,
)

suspend fun runClientTunnelV2(
  transport: Transport,
  metadata: Map<String, Any?>? = null,
): RunClientTunnelV2Result {
  val hs = clientHandshakeV2(transport, metadata)
  val mux = TunnelMuxV2(
    transport = transport,
    cipher = hs.cipher,
    role = "client",
  )
  return RunClientTunnelV2Result(
    mux = mux,
    serverPublicKey = hs.serverPublicKey,
    serverFingerprint = hs.serverFingerprint,
  )
}

private suspend fun clientHandshakeV2(
  transport: Transport,
  metadata: Map<String, Any?>? = null,
): V2ClientHandshakeResult {
  val deferred = CompletableDeferred<V2ClientHandshakeResult>()

  val clientSecret = ByteArray(32).also { X25519.generatePrivateKey(RANDOM_V2, it) }
  val clientPublic = ByteArray(32).also { X25519.generatePublicKey(clientSecret, 0, it, 0) }
  val clientNonce = randomBytes(WT2_NONCE_BYTES)
  val clientHello = encodeClientHello(clientPublic, clientNonce, System.currentTimeMillis(), metadata)

  transport.onMessage { wire ->
    if (deferred.isCompleted) return@onMessage
    try {
      val hello = decodeServerHello(wire)
      val transcript = concat(
        WT2_SIG_LABEL.toByteArray(Charsets.UTF_8),
        clientHello,
        encodeServerHelloUnsigned(
          hello.serverIdentityPublicKey,
          hello.serverEphemeralPublicKey,
          hello.serverNonce,
          hello.serverTs,
        ),
      )
      val sigOk = Ed25519.verify(
        hello.signature,
        0,
        hello.serverIdentityPublicKey,
        0,
        transcript,
        0,
        transcript.size,
      )
      if (!sigOk) throw IOException("v2 server signature verification failed")

      val shared = ByteArray(32)
      val agreeOk = X25519.calculateAgreement(
        clientSecret, 0,
        hello.serverEphemeralPublicKey, 0,
        shared, 0,
      )
      if (!agreeOk) throw IOException("v2 key agreement failed")
      val key = hkdfSha256V2(
        ikm = shared,
        salt = concat(clientNonce, hello.serverNonce),
        info = WT2_INFO.toByteArray(Charsets.UTF_8),
        length = 32,
      )
      deferred.complete(
        V2ClientHandshakeResult(
          cipher = SessionCipher.fromKey(key),
          serverPublicKey = hello.serverIdentityPublicKey,
          serverFingerprint = serverFingerprint(hello.serverIdentityPublicKey),
        ),
      )
    } catch (error: Throwable) {
      deferred.completeExceptionally(error)
    }
  }
  transport.onClose { reason ->
    if (!deferred.isCompleted) {
      deferred.completeExceptionally(IOException("transport closed during v2 handshake: $reason"))
    }
  }
  transport.send(clientHello)
  return deferred.await()
}

private data class DecodedServerHello(
  val serverIdentityPublicKey: ByteArray,
  val serverEphemeralPublicKey: ByteArray,
  val serverNonce: ByteArray,
  val serverTs: Long,
  val signature: ByteArray,
)

private fun encodeClientHello(
  clientPublicKey: ByteArray,
  clientNonce: ByteArray,
  clientTs: Long,
  metadata: Map<String, Any?>? = null,
): ByteArray {
  require(clientPublicKey.size == WT2_PUB_BYTES) { "invalid client public key length" }
  require(clientNonce.size == WT2_NONCE_BYTES) { "invalid client nonce length" }
  val magic = WT2_CLIENT_MAGIC.toByteArray(Charsets.UTF_8)
  val baseLen = magic.size + 1 + 8 + WT2_NONCE_BYTES + WT2_PUB_BYTES
  val metaBytes: ByteArray? = if (!metadata.isNullOrEmpty()) {
    val json = JSONObject()
    for ((k, v) in metadata) json.put(k, v)
    val encoded = json.toString().toByteArray(Charsets.UTF_8)
    require(encoded.size <= 0xffff) { "v2 client metadata too large" }
    encoded
  } else {
    null
  }
  val out = ByteArray(baseLen + (metaBytes?.let { 2 + it.size } ?: 0))
  System.arraycopy(magic, 0, out, 0, magic.size)
  out[magic.size] = WT2_VERSION.toByte()
  val ts = ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN).putLong(clientTs).array()
  System.arraycopy(ts, 0, out, magic.size + 1, 8)
  System.arraycopy(clientNonce, 0, out, magic.size + 1 + 8, clientNonce.size)
  System.arraycopy(clientPublicKey, 0, out, magic.size + 1 + 8 + clientNonce.size, clientPublicKey.size)
  if (metaBytes != null) {
    val lenBytes = ByteBuffer.allocate(2).order(ByteOrder.BIG_ENDIAN).putShort(metaBytes.size.toShort()).array()
    System.arraycopy(lenBytes, 0, out, baseLen, 2)
    System.arraycopy(metaBytes, 0, out, baseLen + 2, metaBytes.size)
  }
  return out
}

private fun encodeServerHelloUnsigned(
  serverIdentityPublicKey: ByteArray,
  serverEphemeralPublicKey: ByteArray,
  serverNonce: ByteArray,
  serverTs: Long,
): ByteArray {
  val magic = WT2_SERVER_MAGIC.toByteArray(Charsets.UTF_8)
  val out = ByteArray(magic.size + 1 + 8 + WT2_NONCE_BYTES + WT2_PUB_BYTES + WT2_PUB_BYTES)
  System.arraycopy(magic, 0, out, 0, magic.size)
  out[magic.size] = WT2_VERSION.toByte()
  val ts = ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN).putLong(serverTs).array()
  System.arraycopy(ts, 0, out, magic.size + 1, 8)
  var offset = magic.size + 1 + 8
  System.arraycopy(serverNonce, 0, out, offset, serverNonce.size)
  offset += serverNonce.size
  System.arraycopy(serverIdentityPublicKey, 0, out, offset, serverIdentityPublicKey.size)
  offset += serverIdentityPublicKey.size
  System.arraycopy(serverEphemeralPublicKey, 0, out, offset, serverEphemeralPublicKey.size)
  return out
}

private fun decodeServerHello(wire: ByteArray): DecodedServerHello {
  val magic = WT2_SERVER_MAGIC.toByteArray(Charsets.UTF_8)
  val unsignedLen = magic.size + 1 + 8 + WT2_NONCE_BYTES + WT2_PUB_BYTES + WT2_PUB_BYTES
  val expectedLen = unsignedLen + WT2_SIG_BYTES
  require(wire.size == expectedLen) { "invalid v2 server hello length" }
  require(wire.copyOfRange(0, magic.size).contentEquals(magic)) { "invalid v2 server hello magic" }
  val version = wire[magic.size].toInt() and 0xff
  require(version == WT2_VERSION) { "unsupported v2 server hello version: $version" }

  val ts = ByteBuffer.wrap(wire, magic.size + 1, 8).order(ByteOrder.BIG_ENDIAN).long
  var offset = magic.size + 1 + 8
  val serverNonce = wire.copyOfRange(offset, offset + WT2_NONCE_BYTES)
  offset += WT2_NONCE_BYTES
  val serverIdentityPublicKey = wire.copyOfRange(offset, offset + WT2_PUB_BYTES)
  offset += WT2_PUB_BYTES
  val serverEphemeralPublicKey = wire.copyOfRange(offset, offset + WT2_PUB_BYTES)
  val signature = wire.copyOfRange(unsignedLen, expectedLen)
  return DecodedServerHello(
    serverIdentityPublicKey = serverIdentityPublicKey,
    serverEphemeralPublicKey = serverEphemeralPublicKey,
    serverNonce = serverNonce,
    serverTs = ts,
    signature = signature,
  )
}

private fun serverFingerprint(serverPublicKey: ByteArray): String {
  val digest = MessageDigest.getInstance("SHA-256").digest(serverPublicKey)
  return digest.joinToString(separator = "") { b -> "%02x".format(b) }
}

private fun hmacSha256V2(key: ByteArray, data: ByteArray): ByteArray {
  val mac = Mac.getInstance("HmacSHA256")
  mac.init(SecretKeySpec(key, "HmacSHA256"))
  return mac.doFinal(data)
}

private fun hkdfSha256V2(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
  val prk = hmacSha256V2(salt, ikm)
  val out = ByteArray(length)
  var previous = ByteArray(0)
  var offset = 0
  var counter = 1
  while (offset < length) {
    previous = hmacSha256V2(prk, concat(previous, info, byteArrayOf(counter.toByte())))
    val take = minOf(previous.size, length - offset)
    System.arraycopy(previous, 0, out, offset, take)
    offset += take
    counter += 1
  }
  return out
}

class TunnelMuxV2(
  private val transport: Transport,
  private val cipher: SessionCipher,
  private val role: String,
  private val pingIntervalMs: Long = 5_000L,
  private val maxMissedPongs: Int = 3,
  private val disableHeartbeat: Boolean = false,
) : StreamMux, UdpStreamMux {
  private val streams = linkedMapOf<Int, StreamV2Impl>()
  private var nextClientStreamId = 1
  private val udpFlows = linkedMapOf<Int, UdpFlowV2Impl>()
  private var nextClientFlowId = 1
  private var onStreamHandler: ((Stream) -> Unit)? = null
  private var onCloseHandler: ((String) -> Unit)? = null
  private val closed = AtomicBoolean(false)
  @Volatile
  private var closeReason: String? = null
  private val pendingPings = linkedMapOf<Long, CompletableDeferred<Unit>>()

  // Heartbeat: both sides ping every pingIntervalMs; whichever side sees
  // maxMissedPongs consecutive misses tears down the mux. Detects LiveKit
  // data-channel staleness (the ~20s Android disconnect) before it becomes
  // user-visible.
  private val heartbeatScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var heartbeatJob: Job? = null
  @Volatile private var lastPongAt: Long = 0L
  @Volatile private var missedPongs: Int = 0

  init {
    transport.onMessage { wire -> handleWire(wire) }
    transport.onClose { reason -> shutdown(reason) }
    if (!disableHeartbeat) {
      startHeartbeat()
    }
  }

  private fun startHeartbeat() {
    lastPongAt = System.currentTimeMillis()
    missedPongs = 0
    heartbeatJob = heartbeatScope.launch {
      while (!closed.get()) {
        delay(pingIntervalMs)
        if (closed.get()) break
        val sincePong = System.currentTimeMillis() - lastPongAt
        if (sincePong > pingIntervalMs) {
          missedPongs += 1
        }
        if (missedPongs >= maxMissedPongs) {
          val reason = "keepalive timeout — $missedPongs missed pongs (${sincePong / 1000}s silent)"
          shutdown(reason)
          try { transport.close(reason) } catch (_: Throwable) {}
          break
        }
        try {
          val ping = JSONObject().put("kind", "ping").put("ts", System.currentTimeMillis())
          sendPacket(WT2_TYPE_CONTROL, 0, ping.toString().toByteArray(Charsets.UTF_8), WT2_FLAG_RELIABLE)
        } catch (_: Throwable) {
          missedPongs += 1
        }
      }
    }
  }

  private fun stopHeartbeat() {
    heartbeatJob?.cancel()
    heartbeatJob = null
    try { heartbeatScope.cancel() } catch (_: Throwable) {}
  }

  fun onStream(cb: (Stream) -> Unit) {
    onStreamHandler = cb
  }

  override fun onClose(cb: (String) -> Unit) {
    onCloseHandler = cb
    closeReason?.let { cb(it) }
  }

  override fun openStream(addr: OpenAddress): Stream {
    check(role == "client") { "openStream is client-only" }
    check(!closed.get()) { "mux closed" }
    val id = nextClientStreamId
    nextClientStreamId += 2
    val stream = createStream(id, addr)
    synchronized(streams) {
      streams[id] = stream
    }
    sendControlTcpOpen(id, addr)
    return stream
  }

  override fun openUdpFlow(addr: OpenAddress): UdpFlow {
    check(role == "client") { "openUdpFlow is client-only" }
    check(!closed.get()) { "mux closed" }
    val id = nextClientFlowId
    nextClientFlowId += 2
    val flow = createUdpFlow(id, addr)
    synchronized(udpFlows) {
      udpFlows[id] = flow
    }
    sendControlUdpOpen(id, addr)
    return flow
  }

  override fun close(reason: String) {
    shutdown(reason)
    transport.close(reason)
  }

  suspend fun measurePingRtt(timeoutMs: Long = 5_000L): Long {
    val ts = System.currentTimeMillis()
    val deferred = CompletableDeferred<Unit>()
    synchronized(pendingPings) { pendingPings[ts] = deferred }
    val ping = JSONObject().put("kind", "ping").put("ts", ts)
    val sentAt = System.currentTimeMillis()
    sendPacket(WT2_TYPE_CONTROL, 0, ping.toString().toByteArray(Charsets.UTF_8), WT2_FLAG_RELIABLE)
    return try {
      withTimeout(timeoutMs) { deferred.await() }
      System.currentTimeMillis() - sentAt
    } finally {
      synchronized(pendingPings) { pendingPings.remove(ts) }
    }
  }

  private fun sendControlTcpOpen(streamId: Int, addr: OpenAddress) {
    val json = JSONObject()
      .put("kind", "tcp-open")
      .put("streamId", streamId)
      .put(
        "addr",
        JSONObject()
          .put("kind", addr.kind)
          .put("host", addr.host)
          .put("port", addr.port),
      )
    sendPacket(
      typeCode = WT2_TYPE_CONTROL,
      channelId = 0,
      payload = json.toString().toByteArray(Charsets.UTF_8),
      flags = WT2_FLAG_RELIABLE,
    )
  }

  private fun sendControlTcpClose(streamId: Int, reason: String?) {
    val json = JSONObject()
      .put("kind", "tcp-close")
      .put("streamId", streamId)
    if (reason != null) json.put("reason", reason)
    sendPacket(
      typeCode = WT2_TYPE_CONTROL,
      channelId = 0,
      payload = json.toString().toByteArray(Charsets.UTF_8),
      flags = WT2_FLAG_RELIABLE,
    )
  }

  private fun sendControlUdpOpen(flowId: Int, addr: OpenAddress) {
    val json = JSONObject()
      .put("kind", "udp-open")
      .put("flowId", flowId)
      .put(
        "addr",
        JSONObject()
          .put("kind", addr.kind)
          .put("host", addr.host)
          .put("port", addr.port),
      )
    sendPacket(
      typeCode = WT2_TYPE_CONTROL,
      channelId = 0,
      payload = json.toString().toByteArray(Charsets.UTF_8),
      flags = WT2_FLAG_RELIABLE,
    )
  }

  private fun sendControlUdpClose(flowId: Int, reason: String?) {
    val json = JSONObject().put("kind", "udp-close").put("flowId", flowId)
    if (reason != null) json.put("reason", reason)
    sendPacket(
      typeCode = WT2_TYPE_CONTROL,
      channelId = 0,
      payload = json.toString().toByteArray(Charsets.UTF_8),
      flags = WT2_FLAG_RELIABLE,
    )
  }

  private fun sendPacket(typeCode: Int, channelId: Int, payload: ByteArray, flags: Int = 0) {
    if (closed.get()) return
    val plain = encodeV2Packet(typeCode, channelId, payload, flags)
    val encrypted = cipher.encrypt(plain)
    transport.send(encrypted)
  }

  private fun handleWire(wire: ByteArray) {
    if (closed.get()) return
    val plain = try {
      cipher.decrypt(wire)
    } catch (_: Throwable) {
      shutdown("decryption failed: possible network corruption or key mismatch")
      try { transport.close("decryption failed") } catch (_: Throwable) {}
      return
    }
    val packet = try {
      decodeV2Packet(plain)
    } catch (_: Throwable) {
      shutdown("received malformed data from peer")
      try { transport.close("received malformed data from peer") } catch (_: Throwable) {}
      return
    }
    when (packet.typeCode) {
      WT2_TYPE_CONTROL -> handleControl(packet.payload)
      WT2_TYPE_TCP -> synchronized(streams) {
        streams[packet.channelId]?.deliverData(packet.payload)
      }
      WT2_TYPE_UDP -> synchronized(udpFlows) {
        udpFlows[packet.channelId]?.deliver(packet.payload)
      }
      WT2_TYPE_LOG -> Unit
      else -> Unit
    }
  }

  private fun handleControl(payload: ByteArray) {
    val text = payload.toString(Charsets.UTF_8)
    val msg = try {
      JSONObject(text)
    } catch (_: Throwable) {
      shutdown("v2 control decode failed")
      return
    }
    when (msg.optString("kind")) {
      "tcp-open" -> {
        if (role != "server") return
        val streamId = msg.optInt("streamId", -1)
        if (streamId < 0) {
          shutdown("v2 bad tcp-open")
          return
        }
        synchronized(streams) {
          if (streams.containsKey(streamId)) return
          val addrJson = msg.optJSONObject("addr")
          val addr = if (addrJson != null) {
            OpenAddress(
              kind = addrJson.optString("kind"),
              host = addrJson.optString("host"),
              port = addrJson.optInt("port"),
            )
          } else {
            null
          }
          if (addr == null || addr.host.isBlank() || addr.port !in 0..65535) {
            shutdown("v2 bad tcp-open addr")
            return
          }
          val stream = createStream(streamId, addr)
          streams[streamId] = stream
          onStreamHandler?.invoke(stream)
        }
      }

      "tcp-close" -> {
        val streamId = msg.optInt("streamId", -1)
        if (streamId < 0) return
        synchronized(streams) {
          streams[streamId]?.remoteClose()
        }
      }

      "udp-close" -> {
        val flowId = msg.optInt("flowId", -1)
        if (flowId < 0) return
        synchronized(udpFlows) { udpFlows[flowId]?.remoteClose() }
      }

      "terminate" -> {
        val reason = msg.optString("reason", "terminated")
        shutdown("terminated: $reason")
      }

      "ping" -> {
        val ts = msg.optLong("ts", System.currentTimeMillis())
        val pong = JSONObject().put("kind", "pong").put("ts", ts)
        sendPacket(
          WT2_TYPE_CONTROL,
          0,
          pong.toString().toByteArray(Charsets.UTF_8),
          WT2_FLAG_RELIABLE,
        )
      }

      "pong" -> {
        lastPongAt = System.currentTimeMillis()
        missedPongs = 0
        val ts = msg.optLong("ts", -1L)
        if (ts >= 0L) {
          synchronized(pendingPings) { pendingPings[ts]?.complete(Unit) }
        }
      }

      else -> Unit
    }
  }

  private fun createStream(id: Int, addr: OpenAddress): StreamV2Impl {
    val dataHandlers = CopyOnWriteArrayList<(ByteArray) -> Unit>()
    val closeHandlers = CopyOnWriteArrayList<() -> Unit>()
    val isClosed = AtomicBoolean(false)
    return object : StreamV2Impl {
      override val id: Int = id
      override val addr: OpenAddress = addr
      override val closed: Boolean
        get() = isClosed.get()

      override fun write(data: ByteArray) {
        if (isClosed.get()) return
        for (chunk in chunkPayloadV2(data)) {
          sendPacket(WT2_TYPE_TCP, id, chunk, WT2_FLAG_RELIABLE)
        }
      }

      override fun onData(cb: (ByteArray) -> Unit) {
        dataHandlers += cb
      }

      override fun close() {
        if (!isClosed.compareAndSet(false, true)) return
        synchronized(streams) { streams.remove(id) }
        sendControlTcpClose(id, "local close")
        closeHandlers.forEach { it.invoke() }
      }

      override fun onClose(cb: () -> Unit) {
        closeHandlers += cb
      }

      override fun deliverData(data: ByteArray) {
        dataHandlers.forEach { it.invoke(data) }
      }

      override fun remoteClose() {
        if (!isClosed.compareAndSet(false, true)) return
        synchronized(streams) { streams.remove(id) }
        closeHandlers.forEach { it.invoke() }
      }
    }
  }

  private fun createUdpFlow(id: Int, addr: OpenAddress): UdpFlowV2Impl {
    val messageHandlers = CopyOnWriteArrayList<(ByteArray) -> Unit>()
    val closeHandlers = CopyOnWriteArrayList<() -> Unit>()
    val isClosed = AtomicBoolean(false)
    return object : UdpFlowV2Impl {
      override val addr: OpenAddress = addr
      override val closed: Boolean get() = isClosed.get()

      override fun send(data: ByteArray) {
        if (isClosed.get()) return
        sendPacket(WT2_TYPE_UDP, id, data, 0)
      }

      override fun onMessage(cb: (ByteArray) -> Unit) {
        messageHandlers += cb
      }

      override fun close() {
        if (!isClosed.compareAndSet(false, true)) return
        synchronized(udpFlows) { udpFlows.remove(id) }
        sendControlUdpClose(id, "local close")
        closeHandlers.forEach { it.invoke() }
      }

      override fun onClose(cb: () -> Unit) {
        closeHandlers += cb
      }

      override fun deliver(data: ByteArray) {
        messageHandlers.forEach { it.invoke(data) }
      }

      override fun remoteClose() {
        if (!isClosed.compareAndSet(false, true)) return
        synchronized(udpFlows) { udpFlows.remove(id) }
        closeHandlers.forEach { it.invoke() }
      }
    }
  }

  private fun shutdown(reason: String) {
    if (!closed.compareAndSet(false, true)) return
    closeReason = reason
    stopHeartbeat()
    val streamsCopy = synchronized(streams) {
      val list = streams.values.toList()
      streams.clear()
      list
    }
    streamsCopy.forEach { it.remoteClose() }
    val udpCopy = synchronized(udpFlows) {
      val list = udpFlows.values.toList()
      udpFlows.clear()
      list
    }
    udpCopy.forEach { it.remoteClose() }
    synchronized(pendingPings) {
      val ex = IOException("mux closed: $reason")
      pendingPings.values.forEach { it.completeExceptionally(ex) }
      pendingPings.clear()
    }
    onCloseHandler?.invoke(reason)
  }
}

private interface StreamV2Impl : Stream {
  fun deliverData(data: ByteArray)
  fun remoteClose()
}

private interface UdpFlowV2Impl : UdpFlow {
  fun deliver(data: ByteArray)
  fun remoteClose()
}

private data class DecodedV2Packet(
  val typeCode: Int,
  val channelId: Int,
  val flags: Int,
  val payload: ByteArray,
)

private fun encodeV2Packet(typeCode: Int, channelId: Int, payload: ByteArray, flags: Int): ByteArray {
  var encodedPayload = payload
  var encodedFlags = flags

  val shouldCompress = payload.size >= WT2_DEFAULT_COMPRESSION_THRESHOLD && typeCode != WT2_TYPE_CONTROL
  if (shouldCompress) {
    val compressed = lz4CompressFrame(payload)
    if (payload.size - compressed.size >= WT2_DEFAULT_MIN_COMPRESSION_SAVINGS) {
      encodedPayload = compressed
      encodedFlags = encodedFlags or WT2_FLAG_COMPRESSED
    }
  }

  require(encodedPayload.size <= 0xffff) { "v2 payload exceeds 65535 bytes" }
  require(channelId >= 0) { "v2 channelId must be non-negative" }

  val out = ByteArray(WT2_HEADER_BYTES + encodedPayload.size)
  out[0] = WT2_VERSION.toByte()
  out[1] = typeCode.toByte()
  out[2] = encodedFlags.toByte()
  out[3] = 0
  writeU32BEV2(out, 4, channelId)
  writeU16BEV2(out, 8, encodedPayload.size)
  System.arraycopy(encodedPayload, 0, out, WT2_HEADER_BYTES, encodedPayload.size)
  return out
}

private fun decodeV2Packet(bytes: ByteArray): DecodedV2Packet {
  require(bytes.size >= WT2_HEADER_BYTES) { "v2 packet too short" }
  val version = bytes[0].toInt() and 0xff
  require(version == WT2_VERSION) { "unsupported v2 packet version: $version" }
  val typeCode = bytes[1].toInt() and 0xff
  val flags = bytes[2].toInt() and 0xff
  val channelId = readU32BEV2(bytes, 4)
  val payloadLen = readU16BEV2(bytes, 8)
  require(bytes.size == WT2_HEADER_BYTES + payloadLen) { "v2 packet length mismatch" }
  var payload = bytes.copyOfRange(WT2_HEADER_BYTES, bytes.size)
  if ((flags and WT2_FLAG_COMPRESSED) != 0) {
    payload = lz4DecompressFrame(payload)
  }
  return DecodedV2Packet(
    typeCode = typeCode,
    channelId = channelId,
    flags = flags,
    payload = payload,
  )
}

private fun chunkPayloadV2(payload: ByteArray, max: Int = WT2_MAX_CHUNK_PAYLOAD): List<ByteArray> {
  if (payload.size <= max) return listOf(payload)
  val chunks = ArrayList<ByteArray>((payload.size + max - 1) / max)
  var offset = 0
  while (offset < payload.size) {
    val end = minOf(offset + max, payload.size)
    chunks += payload.copyOfRange(offset, end)
    offset = end
  }
  return chunks
}

private fun lz4CompressFrame(input: ByteArray): ByteArray {
  val out = ByteArrayOutputStream()
  LZ4FrameOutputStream(out).use { stream ->
    stream.write(input)
  }
  return out.toByteArray()
}

// lz4js (server-side) writes LZ4 frames with Block Independence=0 (linked blocks).
// Java's LZ4FrameInputStream rejects those frames. We parse the frame header manually
// and feed the raw block to LZ4SafeDecompressor, which avoids the flag check entirely.
private val lz4SafeDecompressor = LZ4Factory.fastestInstance().safeDecompressor()

private fun lz4DecompressFrame(input: ByteArray): ByteArray {
  // LZ4 frame layout: 4-byte magic | 1-byte FLG | 1-byte BD | 1-byte HC |
  //                   4-byte block-size (LE) | block-data | 4-byte end-mark
  require(input.size >= 11) { "lz4 frame too short: ${input.size}" }
  val blockSizeWord = readU32LEv2(input, 7)
  val isUncompressed = (blockSizeWord and 0x80000000.toInt()) != 0
  val blockDataSize = blockSizeWord and 0x7FFFFFFF
  require(blockDataSize >= 0 && input.size >= 11 + blockDataSize) {
    "lz4 frame block size invalid: $blockDataSize, frame: ${input.size}"
  }
  return if (isUncompressed) {
    input.copyOfRange(11, 11 + blockDataSize)
  } else {
    // Output is at most WT2_MAX_CHUNK_PAYLOAD original bytes; 4096 is generous.
    val out = ByteArray(4096)
    val n = lz4SafeDecompressor.decompress(input, 11, blockDataSize, out, 0)
    out.copyOf(n)
  }
}

private fun readU32LEv2(bytes: ByteArray, offset: Int): Int =
  (bytes[offset].toInt() and 0xff) or
    ((bytes[offset + 1].toInt() and 0xff) shl 8) or
    ((bytes[offset + 2].toInt() and 0xff) shl 16) or
    ((bytes[offset + 3].toInt() and 0xff) shl 24)

private fun readU16BEV2(bytes: ByteArray, offset: Int): Int =
  ((bytes[offset].toInt() and 0xff) shl 8) or
    (bytes[offset + 1].toInt() and 0xff)

private fun writeU16BEV2(out: ByteArray, offset: Int, value: Int) {
  out[offset] = (value ushr 8).toByte()
  out[offset + 1] = value.toByte()
}

private fun readU32BEV2(bytes: ByteArray, offset: Int): Int =
  ((bytes[offset].toInt() and 0xff) shl 24) or
    ((bytes[offset + 1].toInt() and 0xff) shl 16) or
    ((bytes[offset + 2].toInt() and 0xff) shl 8) or
    (bytes[offset + 3].toInt() and 0xff)

private fun writeU32BEV2(out: ByteArray, offset: Int, value: Int) {
  out[offset] = (value ushr 24).toByte()
  out[offset + 1] = (value ushr 16).toByte()
  out[offset + 2] = (value ushr 8).toByte()
  out[offset + 3] = value.toByte()
}

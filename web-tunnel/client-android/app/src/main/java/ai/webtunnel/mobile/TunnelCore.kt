package ai.webtunnel.mobile

import android.content.Context
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.Participant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.EOFException
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

interface Transport {
  fun send(bytes: ByteArray)
  fun onMessage(cb: (ByteArray) -> Unit)
  fun onClose(cb: (String) -> Unit)
  fun close(reason: String = "transport closed")
}

data class OpenAddress(
  val kind: String,
  val host: String,
  val port: Int,
)

data class Frame(
  val streamId: Int,
  val opcode: Int,
  val payload: ByteArray,
)

object Opcode {
  const val OPEN: Int = 0x01
  const val DATA: Int = 0x02
  const val CLOSE: Int = 0x03
  const val ACK: Int = 0x04
  const val PING: Int = 0x05
  const val PONG: Int = 0x06
}

private const val HEADER_BYTES = 7
private const val MAX_CHUNK_PAYLOAD = 2_000

suspend fun runClientTunnel(transport: Transport, psk: ByteArray): TunnelMux {
  val cipher = clientHandshake(transport, psk)
  return TunnelMux(
    transport = transport,
    cipher = cipher,
    role = "client",
  )
}

suspend fun clientHandshake(transport: Transport, psk: ByteArray): SessionCipher {
  val deferred = CompletableDeferred<SessionCipher>()
  val (wire, clientNonce) = makeHandshakeReq(psk)
  transport.onMessage { okWire ->
    if (deferred.isCompleted) return@onMessage
    try {
      val verified = verifyHandshakeOk(okWire, psk, clientNonce)
      deferred.complete(SessionCipher.derive(psk, clientNonce, verified.serverNonce))
    } catch (error: Throwable) {
      deferred.completeExceptionally(error)
    }
  }
  transport.onClose { reason ->
    if (!deferred.isCompleted) {
      deferred.completeExceptionally(IOException("transport closed during handshake: $reason"))
    }
  }
  transport.send(wire)
  return deferred.await()
}

fun encodeFrame(frame: Frame): ByteArray {
  require(frame.payload.size <= 0xffff) { "payload exceeds single-frame cap" }
  require(frame.streamId >= 0) { "streamId must fit in u32" }
  val out = ByteArray(HEADER_BYTES + frame.payload.size)
  writeU32BE(out, 0, frame.streamId)
  out[4] = frame.opcode.toByte()
  writeU16BE(out, 5, frame.payload.size)
  System.arraycopy(frame.payload, 0, out, HEADER_BYTES, frame.payload.size)
  return out
}

fun decodeFrame(bytes: ByteArray): Frame {
  require(bytes.size >= HEADER_BYTES) { "frame too short" }
  val streamId = readU32BE(bytes, 0)
  val opcode = bytes[4].toInt() and 0xff
  val payloadLen = readU16BE(bytes, 5)
  require(bytes.size == HEADER_BYTES + payloadLen) { "frame length mismatch" }
  require(opcode == Opcode.OPEN || opcode == Opcode.DATA || opcode == Opcode.CLOSE || opcode == Opcode.ACK || opcode == Opcode.PING || opcode == Opcode.PONG) {
    "unknown opcode 0x${opcode.toString(16)}"
  }
  return Frame(
    streamId = streamId,
    opcode = opcode,
    payload = bytes.copyOfRange(HEADER_BYTES, HEADER_BYTES + payloadLen),
  )
}

fun encodeOpen(addr: OpenAddress): ByteArray {
  require(addr.port in 0..0xffff) { "port must fit in u16" }
  val hostBytes: ByteArray
  val addrType: Int
  when (addr.kind) {
    "domain" -> {
      addrType = 0x01
      hostBytes = addr.host.toByteArray(Charsets.UTF_8)
      require(hostBytes.size <= 0xff) { "domain >255 bytes" }
    }
    "ipv4" -> {
      addrType = 0x02
      hostBytes = parseIpv4(addr.host)
    }
    "ipv6" -> {
      addrType = 0x03
      hostBytes = parseIpv6(addr.host)
    }
    else -> throw IllegalArgumentException("unknown addr kind ${addr.kind}")
  }
  val out = ByteArray(1 + 1 + hostBytes.size + 2)
  out[0] = addrType.toByte()
  out[1] = hostBytes.size.toByte()
  System.arraycopy(hostBytes, 0, out, 2, hostBytes.size)
  writeU16BE(out, 2 + hostBytes.size, addr.port)
  return out
}

fun decodeOpen(bytes: ByteArray): OpenAddress {
  require(bytes.size >= 4) { "OPEN payload too short" }
  val addrType = bytes[0].toInt() and 0xff
  val hostLen = bytes[1].toInt() and 0xff
  require(bytes.size == 2 + hostLen + 2) { "OPEN length mismatch" }
  val hostBytes = bytes.copyOfRange(2, 2 + hostLen)
  val port = readU16BE(bytes, 2 + hostLen)
  return when (addrType) {
    0x01 -> OpenAddress(kind = "domain", host = hostBytes.toString(Charsets.UTF_8), port = port)
    0x02 -> {
      require(hostLen == 4) { "ipv4 addr must be 4 bytes" }
      OpenAddress(
        kind = "ipv4",
        host = "${hostBytes[0].toInt() and 0xff}.${hostBytes[1].toInt() and 0xff}.${hostBytes[2].toInt() and 0xff}.${hostBytes[3].toInt() and 0xff}",
        port = port,
      )
    }
    0x03 -> {
      require(hostLen == 16) { "ipv6 addr must be 16 bytes" }
      OpenAddress(kind = "ipv6", host = formatIpv6(hostBytes), port = port)
    }
    else -> throw IllegalArgumentException("unknown addr type 0x${addrType.toString(16)}")
  }
}

interface Stream {
  val id: Int
  val addr: OpenAddress
  val closed: Boolean
  fun write(data: ByteArray)
  fun onData(cb: (ByteArray) -> Unit)
  fun close()
  fun onClose(cb: () -> Unit)
}

interface UdpFlow {
  val addr: OpenAddress
  val closed: Boolean
  fun send(data: ByteArray)
  fun onMessage(cb: (ByteArray) -> Unit)
  fun close()
  fun onClose(cb: () -> Unit)
}

interface StreamMux {
  fun openStream(addr: OpenAddress): Stream
  fun onClose(cb: (String) -> Unit)
  fun close(reason: String = "mux closed")
}

interface UdpStreamMux {
  fun openUdpFlow(addr: OpenAddress): UdpFlow
}

private interface StreamImpl : Stream {
  fun deliverData(data: ByteArray)
  fun remoteClose()
}

class TunnelMux(
  private val transport: Transport,
  private val cipher: SessionCipher,
  private val role: String,
) : StreamMux {
  private val streams = linkedMapOf<Int, StreamImpl>()
  private var nextClientStreamId: Int = 1
  private var onStreamHandler: ((Stream) -> Unit)? = null
  private var onCloseHandler: ((String) -> Unit)? = null
  private val closed = AtomicBoolean(false)

  init {
    transport.onMessage { wire -> handleWire(wire) }
    transport.onClose { reason -> shutdown(reason) }
  }

  fun onStream(cb: (Stream) -> Unit) {
    onStreamHandler = cb
  }

  override fun onClose(cb: (String) -> Unit) {
    onCloseHandler = cb
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
    sendFrame(id, Opcode.OPEN, encodeOpen(addr))
    return stream
  }

  override fun close(reason: String) {
    shutdown(reason)
    transport.close(reason)
  }

  private fun sendFrame(streamId: Int, opcode: Int, payload: ByteArray) {
    if (closed.get()) return
    val plain = encodeFrame(Frame(streamId = streamId, opcode = opcode, payload = payload))
    val encrypted = cipher.encrypt(plain)
    transport.send(encrypted)
  }

  private fun handleWire(wire: ByteArray) {
    if (closed.get()) return
    val plain = try {
      cipher.decrypt(wire)
    } catch (_: Throwable) {
      shutdown("decrypt failed")
      return
    }
    val frame = try {
      decodeFrame(plain)
    } catch (_: Throwable) {
      shutdown("bad frame")
      return
    }
    when (frame.opcode) {
      Opcode.OPEN -> {
        if (role != "server") {
          shutdown("OPEN from server")
          return
        }
        if (streams.containsKey(frame.streamId)) {
          shutdown("duplicate OPEN")
          return
        }
        val addr = try {
          decodeOpen(frame.payload)
        } catch (_: Throwable) {
          shutdown("bad OPEN payload")
          return
        }
        val stream = createStream(frame.streamId, addr)
        synchronized(streams) {
          streams[frame.streamId] = stream
        }
        onStreamHandler?.invoke(stream)
      }
      Opcode.DATA -> synchronized(streams) {
        streams[frame.streamId]?.deliverData(frame.payload)
      }
      Opcode.CLOSE -> synchronized(streams) {
        streams[frame.streamId]?.remoteClose()
      }
      Opcode.PING -> sendFrame(frame.streamId, Opcode.PONG, frame.payload)
      Opcode.PONG, Opcode.ACK -> Unit
    }
  }

  private fun createStream(id: Int, addr: OpenAddress): StreamImpl {
    val dataHandlers = CopyOnWriteArrayList<(ByteArray) -> Unit>()
    val closeHandlers = CopyOnWriteArrayList<() -> Unit>()
    val isClosed = AtomicBoolean(false)
    return object : StreamImpl {
      override val id: Int = id
      override val addr: OpenAddress = addr
      override val closed: Boolean
        get() = isClosed.get()

      override fun write(data: ByteArray) {
        if (isClosed.get()) return
        for (chunk in chunkPayload(data)) {
          sendFrame(id, Opcode.DATA, chunk)
        }
      }

      override fun onData(cb: (ByteArray) -> Unit) {
        dataHandlers += cb
      }

      override fun close() {
        if (!isClosed.compareAndSet(false, true)) return
        synchronized(streams) { streams.remove(id) }
        sendFrame(id, Opcode.CLOSE, ByteArray(0))
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

  private fun shutdown(reason: String) {
    if (!closed.compareAndSet(false, true)) return
    val copy = synchronized(streams) {
      val list = streams.values.toList()
      streams.clear()
      list
    }
    copy.forEach { it.remoteClose() }
    onCloseHandler?.invoke(reason)
  }
}

class LiveKitTransport(
  private val room: Room,
  private val scope: CoroutineScope,
  private val peerIdentity: String? = null,
) : Transport {
  private var onMessageHandler: ((ByteArray) -> Unit)? = null
  private var onCloseHandler: ((String) -> Unit)? = null
  private val closed = AtomicBoolean(false)
  private val sendQueue = Channel<ByteArray>(Channel.UNLIMITED)
  private val receiveQueue = Channel<ByteArray>(Channel.UNLIMITED)
  private val eventsJob: Job = scope.launch(Dispatchers.IO) {
    room.events.collect { event ->
      when (event) {
        is RoomEvent.DataReceived -> {
          if (closed.get()) return@collect
          val from = event.participant?.identity?.value ?: "unknown"
          val localIdentity = room.localParticipant.identity?.value
          if (from == localIdentity) return@collect
          if (peerIdentity != null && from != peerIdentity) return@collect
          val offered = receiveQueue.trySend(event.data.copyOf())
          if (!offered.isSuccess && closed.compareAndSet(false, true)) {
            onCloseHandler?.invoke("receive queue closed")
          }
        }
        is RoomEvent.Disconnected -> {
          if (closed.compareAndSet(false, true)) {
            onCloseHandler?.invoke("disconnected")
          }
        }
        else -> Unit
      }
    }
  }
  private val receiveJob: Job = scope.launch(Dispatchers.IO) {
    for (bytes in receiveQueue) {
      if (closed.get()) continue
      onMessageHandler?.invoke(bytes)
    }
  }
  private val sendJob: Job = scope.launch(Dispatchers.IO) {
    for (bytes in sendQueue) {
      if (closed.get()) continue
      try {
        val identities = if (peerIdentity != null) listOf(Participant.Identity(peerIdentity)) else null
        val result = room.localParticipant.publishData(bytes, identities = identities)
        if (result.isFailure && closed.compareAndSet(false, true)) {
          onCloseHandler?.invoke("publishData failed: ${result.exceptionOrNull()?.message ?: "unknown"}")
          break
        }
      } catch (error: Throwable) {
        if (closed.compareAndSet(false, true)) {
          onCloseHandler?.invoke("publishData failed: ${error.message ?: "unknown"}")
        }
        break
      }
    }
  }

  override fun send(bytes: ByteArray) {
    if (closed.get()) return
    val offered = sendQueue.trySend(bytes.copyOf())
    if (!offered.isSuccess && closed.compareAndSet(false, true)) {
      onCloseHandler?.invoke("publishData failed: send queue closed")
    }
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
    sendQueue.close()
    receiveQueue.close()
    eventsJob.cancel()
    receiveJob.cancel()
    sendJob.cancel()
    scope.launch {
      try {
        room.disconnect()
      } finally {
        onCloseHandler?.invoke(reason)
      }
    }
  }
}

class Socks5Server(
  private val scope: CoroutineScope,
  private val requestedPort: Int,
  private val mux: StreamMux,
  private val udpMux: UdpStreamMux? = null,
  private val onConnect: ((OpenAddress) -> Unit)? = null,
  private val onStreamOpened: ((OpenAddress) -> Unit)? = null,
  private val onStreamClosed: ((OpenAddress) -> Unit)? = null,
  private val onUpload: ((OpenAddress, Int) -> Unit)? = null,
  private val onDownload: ((OpenAddress, Int) -> Unit)? = null,
  private val onError: ((Throwable) -> Unit)? = null,
  private val onEvent: ((String) -> Unit)? = null,
) {
  private var serverSocket: ServerSocket? = null
  private var acceptJob: Job? = null

  suspend fun start(): Int = withContext(Dispatchers.IO) {
    val server = ServerSocket()
    server.reuseAddress = true
    server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), requestedPort))
    serverSocket = server
    acceptJob = scope.launch(Dispatchers.IO) {
      while (!server.isClosed) {
        val socket = try {
          server.accept()
        } catch (_: IOException) {
          break
        }
        launch(Dispatchers.IO) {
          handleClient(socket)
        }
      }
    }
    server.localPort
  }

  suspend fun stop() {
    serverSocket?.close()
    serverSocket = null
    acceptJob?.cancelAndJoin()
    acceptJob = null
  }

  private suspend fun handleClient(socket: Socket) = withContext(Dispatchers.IO) {
    socket.tcpNoDelay = true
    socket.use { sock ->
      var stream: Stream? = null
      var activeAddr: OpenAddress? = null
      val streamClosed = AtomicBoolean(false)
      fun notifyStreamClosed() {
        val addr = activeAddr ?: return
        if (stream != null && streamClosed.compareAndSet(false, true)) {
          onStreamClosed?.invoke(addr)
        }
      }
      try {
        val input = sock.getInputStream()
        val output = sock.getOutputStream()

        val greet = readExact(input, 2)
        val version = greet[0].toInt() and 0xff
        val methodCount = greet[1].toInt() and 0xff
        require(version == 5) { "socks5 only" }
        readExact(input, methodCount)
        output.write(byteArrayOf(0x05, 0x00))
        output.flush()

        val header = readExact(input, 4)
        require((header[0].toInt() and 0xff) == 5) { "bad socks version" }
        val command = header[1].toInt() and 0xff
        val atyp = header[3].toInt() and 0xff
        if (command == 0x03) {
          // UDP ASSOCIATE: read and discard the client's desired source addr
          try { parseAddr(input, atyp) } catch (_: Throwable) {}
          val localUdpMux = udpMux
          if (localUdpMux == null) {
            output.write(replyFailure(0x07))
            output.flush()
          } else {
            handleUdpAssociate(output, input, localUdpMux)
          }
          return@withContext
        }
        if (command != 0x01) {
          try { parseAddr(input, atyp) } catch (_: Throwable) {}
          output.write(replyFailure(0x07))
          output.flush()
          return@withContext
        }

        val addr = parseAddr(input, atyp)
        activeAddr = addr
        onConnect?.invoke(addr)
        stream = try {
          mux.openStream(addr)
        } catch (error: Throwable) {
          output.write(replyFailure(0x01))
          output.flush()
          throw error
        }
        val openedStream = stream ?: throw IOException("stream open failed")
        onStreamOpened?.invoke(addr)
        output.write(replySuccess())
        output.flush()

        openedStream.onData { data ->
          onDownload?.invoke(addr, data.size)
          onEvent?.invoke("SOCKS down ${data.size}B from ${addr.host}:${addr.port}")
          synchronized(output) {
            output.write(data)
            output.flush()
          }
        }
        openedStream.onClose {
          notifyStreamClosed()
          onEvent?.invoke("SOCKS stream closed ${addr.host}:${addr.port}")
          try {
            sock.close()
          } catch (_: Throwable) {
            Unit
          }
        }

        val buffer = ByteArray(8_192)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          if (count == 0) continue
          onUpload?.invoke(addr, count)
          onEvent?.invoke("SOCKS up ${count}B to ${addr.host}:${addr.port}")
          openedStream.write(buffer.copyOfRange(0, count))
        }
        onEvent?.invoke("SOCKS client EOF ${addr.host}:${addr.port}")
        openedStream.close()
      } catch (error: Throwable) {
        try {
          stream?.close()
        } catch (_: Throwable) {
          Unit
        }
        notifyStreamClosed()
        onError?.invoke(error)
      }
    }
  }

  private suspend fun handleUdpAssociate(
    output: java.io.OutputStream,
    input: java.io.InputStream,
    udpMux: UdpStreamMux,
  ) {
    val udpSocket = DatagramSocket(0, InetAddress.getByName("127.0.0.1"))
    val port = udpSocket.localPort
    output.write(byteArrayOf(
      0x05, 0x00, 0x00, 0x01,
      127.toByte(), 0, 0, 1,
      (port shr 8).toByte(), (port and 0xff).toByte(),
    ))
    output.flush()
    val flows = mutableMapOf<String, UdpFlow>()
    val tcpMonitor = scope.launch(Dispatchers.IO) {
      try {
        val buf = ByteArray(16)
        while (input.read(buf) >= 0) { /* drain until TCP closes */ }
      } catch (_: Throwable) {}
      try { udpSocket.close() } catch (_: Throwable) {}
    }
    try {
      val buf = ByteArray(65_535)
      val pkt = DatagramPacket(buf, buf.size)
      while (!udpSocket.isClosed) {
        try { udpSocket.receive(pkt) } catch (_: Throwable) { break }
        val clientAddr = InetSocketAddress(pkt.address, pkt.port)
        val raw = pkt.data.copyOf(pkt.length)
        if (raw.size < 4) continue
        if (raw[2].toInt() and 0xff != 0) continue // skip fragmented
        val atyp = raw[3].toInt() and 0xff
        val parsed = parseUdpAddr(raw, atyp) ?: continue
        val (addr, dataOffset) = parsed
        if (dataOffset >= raw.size) continue
        val payload = raw.copyOfRange(dataOffset, raw.size)
        val flowKey = "${addr.kind}:${addr.host}:${addr.port}"
        val existing = flows[flowKey]
        val flow: UdpFlow
        if (existing != null && !existing.closed) {
          flow = existing
        } else {
          flow = try { udpMux.openUdpFlow(addr) } catch (_: Throwable) { continue }
          flows[flowKey] = flow
          val savedClientAddr = clientAddr
          flow.onMessage { resp ->
            if (udpSocket.isClosed) return@onMessage
            val header = buildUdpReplyHeader(addr)
            val packet = header + resp
            try { udpSocket.send(DatagramPacket(packet, packet.size, savedClientAddr)) } catch (_: Throwable) {}
          }
        }
        try { flow.send(payload) } catch (_: Throwable) {}
      }
    } finally {
      tcpMonitor.cancel()
      flows.values.forEach { try { it.close() } catch (_: Throwable) {} }
      try { udpSocket.close() } catch (_: Throwable) {}
    }
  }

  private fun parseUdpAddr(data: ByteArray, atyp: Int): Pair<OpenAddress, Int>? {
    return try {
      when (atyp) {
        0x01 -> {
          if (data.size < 10) return null
          val host = "${data[4].toInt() and 0xff}.${data[5].toInt() and 0xff}.${data[6].toInt() and 0xff}.${data[7].toInt() and 0xff}"
          val port = ((data[8].toInt() and 0xff) shl 8) or (data[9].toInt() and 0xff)
          OpenAddress(kind = "ipv4", host = host, port = port) to 10
        }
        0x03 -> {
          if (data.size < 5) return null
          val len = data[4].toInt() and 0xff
          if (data.size < 7 + len) return null
          val host = data.copyOfRange(5, 5 + len).toString(Charsets.UTF_8)
          val port = ((data[5 + len].toInt() and 0xff) shl 8) or (data[6 + len].toInt() and 0xff)
          OpenAddress(kind = "domain", host = host, port = port) to (7 + len)
        }
        0x04 -> {
          if (data.size < 22) return null
          val hostBytes = data.copyOfRange(4, 20)
          val port = ((data[20].toInt() and 0xff) shl 8) or (data[21].toInt() and 0xff)
          OpenAddress(kind = "ipv6", host = InetAddress.getByAddress(hostBytes).hostAddress ?: "", port = port) to 22
        }
        else -> null
      }
    } catch (_: Throwable) { null }
  }

  private fun buildUdpReplyHeader(addr: OpenAddress): ByteArray {
    return when (addr.kind) {
      "ipv4" -> {
        val parts = addr.host.split('.').map { it.toInt() and 0xff }
        byteArrayOf(
          0x00, 0x00, 0x00, 0x01,
          parts[0].toByte(), parts[1].toByte(), parts[2].toByte(), parts[3].toByte(),
          (addr.port shr 8).toByte(), (addr.port and 0xff).toByte(),
        )
      }
      "ipv6" -> {
        val hostBytes = try { InetAddress.getByName(addr.host).address } catch (_: Throwable) { ByteArray(16) }
        byteArrayOf(0x00, 0x00, 0x00, 0x04) + hostBytes +
          byteArrayOf((addr.port shr 8).toByte(), (addr.port and 0xff).toByte())
      }
      else -> {
        val hostBytes = addr.host.toByteArray(Charsets.UTF_8)
        byteArrayOf(0x00, 0x00, 0x00, 0x03, hostBytes.size.toByte()) + hostBytes +
          byteArrayOf((addr.port shr 8).toByte(), (addr.port and 0xff).toByte())
      }
    }
  }
}

suspend fun connectLiveKitRoom(context: Context, url: String): Room {
  val (serverUrl, token) = extractLiveKitConnectArgs(url)
  val room = LiveKit.create(context.applicationContext)
  room.connect(serverUrl, token)
  return room
}

fun extractLiveKitConnectArgs(url: String): Pair<String, String> {
  val uri = URI(url)
  val token = uri.rawQuery
    ?.split('&')
    ?.mapNotNull {
      val idx = it.indexOf('=')
      if (idx < 0) null else it.substring(0, idx) to it.substring(idx + 1)
    }
    ?.firstOrNull { it.first == "access_token" }
    ?.second
    ?.let { java.net.URLDecoder.decode(it, Charsets.UTF_8.name()) }
    ?: ""
  var path = uri.path ?: ""
  path = path.replace(Regex("/rtc(?:/v1)?/?$", RegexOption.IGNORE_CASE), "")
  path = path.replace(Regex("/+$"), "")
  val serverUrl = buildString {
    append(uri.scheme)
    append("://")
    append(uri.host)
    if (uri.port != -1) append(":${uri.port}")
    append(path)
  }
  return serverUrl to token
}

private fun chunkPayload(payload: ByteArray, max: Int = MAX_CHUNK_PAYLOAD): List<ByteArray> {
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

private fun parseAddr(input: java.io.InputStream, atyp: Int): OpenAddress {
  return when (atyp) {
    0x01 -> {
      val bytes = readExact(input, 6)
      val host = "${bytes[0].toInt() and 0xff}.${bytes[1].toInt() and 0xff}.${bytes[2].toInt() and 0xff}.${bytes[3].toInt() and 0xff}"
      val port = ((bytes[4].toInt() and 0xff) shl 8) or (bytes[5].toInt() and 0xff)
      OpenAddress(kind = "ipv4", host = host, port = port)
    }
    0x03 -> {
      val len = readExact(input, 1)[0].toInt() and 0xff
      val rest = readExact(input, len + 2)
      val host = rest.copyOfRange(0, len).toString(Charsets.UTF_8)
      val port = ((rest[len].toInt() and 0xff) shl 8) or (rest[len + 1].toInt() and 0xff)
      OpenAddress(kind = "domain", host = host, port = port)
    }
    0x04 -> {
      val bytes = readExact(input, 18)
      val hostBytes = bytes.copyOfRange(0, 16)
      val port = ((bytes[16].toInt() and 0xff) shl 8) or (bytes[17].toInt() and 0xff)
      OpenAddress(kind = "ipv6", host = formatIpv6(hostBytes), port = port)
    }
    else -> throw IOException("unsupported SOCKS5 atyp $atyp")
  }
}

private fun parseIpv4(host: String): ByteArray {
  val parts = host.split('.')
  require(parts.size == 4) { "invalid ipv4: $host" }
  return ByteArray(4) { idx ->
    val value = parts[idx].toInt()
    require(value in 0..255) { "invalid ipv4 octet ${parts[idx]}" }
    value.toByte()
  }
}

private fun parseIpv6(host: String): ByteArray {
  val address = InetAddress.getByName(host)
  require(address is Inet6Address) { "invalid ipv6: $host" }
  return address.address
}

private fun formatIpv6(bytes: ByteArray): String =
  InetAddress.getByAddress(bytes).hostAddress ?: ""

private fun replySuccess(): ByteArray =
  byteArrayOf(0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)

private fun replyFailure(code: Int): ByteArray =
  byteArrayOf(0x05, code.toByte(), 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)

private fun readExact(input: java.io.InputStream, size: Int): ByteArray {
  val out = ByteArray(size)
  var offset = 0
  while (offset < size) {
    val read = input.read(out, offset, size - offset)
    if (read < 0) throw EOFException("socket ended before expected bytes")
    offset += read
  }
  return out
}

private fun readU16BE(bytes: ByteArray, offset: Int): Int =
  ((bytes[offset].toInt() and 0xff) shl 8) or
    (bytes[offset + 1].toInt() and 0xff)

private fun writeU16BE(out: ByteArray, offset: Int, value: Int) {
  out[offset] = (value ushr 8).toByte()
  out[offset + 1] = value.toByte()
}

private fun readU32BE(bytes: ByteArray, offset: Int): Int =
  ((bytes[offset].toInt() and 0xff) shl 24) or
    ((bytes[offset + 1].toInt() and 0xff) shl 16) or
    ((bytes[offset + 2].toInt() and 0xff) shl 8) or
    (bytes[offset + 3].toInt() and 0xff)

private fun writeU32BE(out: ByteArray, offset: Int, value: Int) {
  out[offset] = (value ushr 24).toByte()
  out[offset + 1] = (value ushr 16).toByte()
  out[offset + 2] = (value ushr 8).toByte()
  out[offset + 3] = value.toByte()
}

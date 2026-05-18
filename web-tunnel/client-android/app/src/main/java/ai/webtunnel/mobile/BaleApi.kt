package ai.webtunnel.mobile

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.IOException
import java.util.concurrent.TimeUnit
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.util.UUID

private const val BALE_BASE_URL = "https://next-ws.bale.ai"
private const val DEFAULT_APP_ID = 4L
private const val DEFAULT_APP_KEY = "C28D46DC4C3A7A26564BFCC48B929086A95C93C98E789A19847BEE8627DE4E7D"
private val GRPC_WEB_MEDIA = "application/grpc-web+proto".toMediaType()
private val UTF8_BALE = StandardCharsets.UTF_8

enum class BalePeerType(val code: Int) {
  UNKNOWN(0),
  PRIVATE(1),
  GROUP(2),
}

data class BalePeer(
  val type: BalePeerType,
  val id: Long,
  val accessHash: Long? = null,
)

data class PhoneAuthResponse(
  val transactionHash: String,
  val isRegistered: Boolean,
)

data class DialogPeerData(
  val peer: BalePeer,
  val unreadCount: Long,
  val lastMessage: String?,
)

data class BaleUser(
  val id: Long,
  val accessHash: Long,
  val name: String,
  val username: String?,
)

data class StartCallResult(
  val callId: Long,
  val jwt: String,
  val roomUuid: String,
  val baseUrl: String,
  val startedAtMs: Long,
  val serverAuthTs: Long,
  val peer: BalePeer,
  val state: Int,
)

class GrpcError(
  override val message: String,
  val status: Int,
  val httpStatus: Int,
  val rawBody: ByteArray? = null,
) : IOException(message)

class WrongCodeException : IOException("wrong code")
class PasswordNeededException : IOException("password needed")
class SignUpNeededException : IOException("sign up needed")
class WrongPasswordException : IOException("wrong password")

class BaleClient(
  private val httpClient: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .build(),
) {
  private val deviceHash: String = UUID.randomUUID().toString()
  private val deviceTitle: String = "Chrome_143.0.0.0, Android"
  private val sessionId: String = makeSessionId()
  private var session: BaleSession? = null

  fun loadSession(value: BaleSession) {
    session = value
  }

  fun currentSession(): BaleSession? = session

  suspend fun startPhoneAuth(phoneNumber: String): PhoneAuthResponse = withContext(Dispatchers.IO) {
    val digits = phoneNumber.filter { it.isDigit() }
    grpcUnary(
      service = "bale.auth.v1.Auth",
      method = "StartPhoneAuth",
      request = encodeStartPhoneAuth(digits.toLong()),
      accessToken = null,
      decode = ::decodePhoneAuthResponse,
    )
  }

  suspend fun validateCode(code: String, transactionHash: String): BaleSession = withContext(Dispatchers.IO) {
    try {
      val resp = grpcUnary(
        service = "bale.auth.v1.Auth",
        method = "ValidateCode",
        request = encodeValidateCode(transactionHash, code),
        accessToken = null,
        decode = ::decodeValidateCodeResponse,
      )
      val built = requireSession(resp.jwt, resp.userId, resp.userName, resp.userAccessHash)
      session = built
      built
    } catch (error: GrpcError) {
      val msg = error.message.lowercase()
      when {
        msg.contains("phone_code_invalid") || msg.contains("wrong code") -> throw WrongCodeException()
        msg.contains("password needed") -> throw PasswordNeededException()
        msg.contains("phone_number_unoccupied") -> throw SignUpNeededException()
        else -> throw error
      }
    }
  }

  suspend fun validatePassword(password: String, transactionHash: String): BaleSession = withContext(Dispatchers.IO) {
    try {
      val resp = grpcUnary(
        service = "bale.auth.v1.Auth",
        method = "ValidatePassword",
        request = encodeValidatePassword(transactionHash, password),
        accessToken = null,
        decode = ::decodeValidateCodeResponse,
      )
      val built = requireSession(resp.jwt, resp.userId, resp.userName, resp.userAccessHash)
      session = built
      built
    } catch (error: GrpcError) {
      val msg = error.message.lowercase()
      when {
        msg.contains("wrong password") -> throw WrongPasswordException()
        else -> throw error
      }
    }
  }

  suspend fun loadDialogs(limit: Int = 40): List<DialogPeerData> = withContext(Dispatchers.IO) {
    val auth = requireSession()
    grpcUnary(
      service = "bale.messaging.v2.Messaging",
      method = "LoadDialogs",
      request = encodeLoadDialogs(limit),
      accessToken = auth.jwt,
      decode = ::decodeLoadDialogsResponse,
    )
  }

  suspend fun loadUsers(peers: List<Long>): List<BaleUser> = withContext(Dispatchers.IO) {
    val auth = requireSession()
    if (peers.isEmpty()) return@withContext emptyList()
    grpcUnary(
      service = "bale.users.v1.Users",
      method = "LoadUsers",
      request = encodeLoadUsers(peers),
      accessToken = auth.jwt,
      decode = ::decodeLoadUsersResponse,
    )
  }

  suspend fun startCall(targetPeer: BalePeer): StartCallResult = withContext(Dispatchers.IO) {
    val auth = requireSession()
    grpcUnary(
      service = "bale.meet.v1.Meet",
      method = "StartCall",
      request = encodeStartCall(targetPeer),
      accessToken = auth.jwt,
      decode = ::decodeStartCallResponse,
    )
  }

  suspend fun sendTextMessage(targetPeer: BalePeer, text: String): Long = withContext(Dispatchers.IO) {
    val auth = requireSession()
    val messageId = randomPositiveId64()
    grpcUnary(
      service = "bale.messaging.v2.Messaging",
      method = "SendMessage",
      request = encodeSendMessage(targetPeer, messageId, text),
      accessToken = auth.jwt,
      decode = { Unit },
    )
    messageId
  }

  suspend fun discardCall(callId: Long, reason: Int = 3) = withContext(Dispatchers.IO) {
    val auth = requireSession()
    grpcUnary(
      service = "bale.meet.v1.Meet",
      method = "DiscardCall",
      request = encodeDiscardCall(callId, reason),
      accessToken = auth.jwt,
      decode = { Unit },
    )
  }

  fun liveKitUrlFor(result: StartCallResult): String =
    buildLiveKitUrl(result)

  private suspend fun <T> grpcUnary(
    service: String,
    method: String,
    request: ByteArray,
    accessToken: String?,
    decode: (ByteArray) -> T,
  ): T {
    val url = "$BALE_BASE_URL/$service/$method"
    val framed = frameGrpcRequest(request)
    val requestBuilder = Request.Builder()
      .url(url)
      .post(framed.toRequestBody(GRPC_WEB_MEDIA))
      .header("content-type", "application/grpc-web+proto")
      .header("x-grpc-web", "1")
      .header("session_id", sessionId)
      .header("mt_session_id", sessionId)
      .header("app_version", "151668")
      .header("mt_app_version", "151668")
      .header("browser_type", "1")
      .header("mt_browser_type", "1")
      .header("browser_version", "143.0.0.0")
      .header("mt_browser_version", "143.0.0.0")
      .header("os_type", "4")
      .header("mt_os_type", "4")
      .header("accept", "application/grpc-web+proto")
      .header("origin", "https://web.bale.ai")
      .header("user-agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36")
    if (accessToken != null) {
      requestBuilder.header("cookie", "access_token=$accessToken")
    }
    httpClient.newCall(requestBuilder.build()).execute().use { response ->
      val raw = response.body?.bytes() ?: ByteArray(0)
      val parsed = parseGrpcWebBody(raw)
      val headerStatus = response.header("grpc-status")
      val headerMessage = response.header("grpc-message")
      val status = parsed.trailers["grpc-status"] ?: headerStatus
      val message = parsed.trailers["grpc-message"] ?: headerMessage
      if (!response.isSuccessful || (status != null && status != "0")) {
        throw GrpcError(
          message = "gRPC $service/$method failed: http=${response.code} status=${status ?: "n/a"} msg=${message ?: ""}",
          status = status?.toIntOrNull() ?: -1,
          httpStatus = response.code,
          rawBody = raw,
        )
      }
      return decode(parsed.payload)
    }
  }

  private fun requireSession(): BaleSession =
    session ?: throw IOException("BaleClient: not authenticated")

  private fun requireSession(
    jwt: String?,
    userId: Long?,
    userName: String?,
    userAccessHash: Long?,
  ): BaleSession {
    if (jwt == null || userId == null || userAccessHash == null) {
      throw IOException("BaleClient: invalid auth response")
    }
    return BaleSession(
      jwt = jwt,
      userId = userId,
      userName = userName,
      userAccessHash = userAccessHash,
    )
  }
}

private fun makeSessionId(): String = System.currentTimeMillis().toString()

private fun frameGrpcRequest(payload: ByteArray): ByteArray {
  val out = ByteArray(5 + payload.size)
  out[0] = 0
  val len = payload.size
  out[1] = (len ushr 24).toByte()
  out[2] = (len ushr 16).toByte()
  out[3] = (len ushr 8).toByte()
  out[4] = len.toByte()
  System.arraycopy(payload, 0, out, 5, payload.size)
  return out
}

private data class ParsedGrpcWebBody(
  val payload: ByteArray,
  val trailers: Map<String, String>,
)

private fun parseGrpcWebBody(body: ByteArray): ParsedGrpcWebBody {
  var offset = 0
  var payload = ByteArray(0)
  val trailers = linkedMapOf<String, String>()
  while (offset + 5 <= body.size) {
    val flag = body[offset].toInt() and 0xff
    val len = ((body[offset + 1].toInt() and 0xff) shl 24) or
      ((body[offset + 2].toInt() and 0xff) shl 16) or
      ((body[offset + 3].toInt() and 0xff) shl 8) or
      (body[offset + 4].toInt() and 0xff)
    val start = offset + 5
    val end = start + len
    if (end > body.size) break
    val frame = body.copyOfRange(start, end)
    if ((flag and 0x80) == 0) {
      payload = frame
    } else {
      val text = frame.toString(UTF8_BALE)
      for (line in text.split(Regex("\\r\\n|\\n"))) {
        val idx = line.indexOf(':')
        if (idx < 0) continue
        trailers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
      }
    }
    offset = end
  }
  return ParsedGrpcWebBody(payload = payload, trailers = trailers)
}

private class ProtoWriter {
  private val out = ByteArrayOutputStream()

  fun toByteArray(): ByteArray = out.toByteArray()

  fun tag(fieldNumber: Int, wireType: Int): ProtoWriter = varint(((fieldNumber shl 3) or wireType).toULong())

  fun varint(value: Long): ProtoWriter = varint(value.toULong())

  fun varint(value: ULong): ProtoWriter {
    var v = value
    while (v > 0x7fUL) {
      out.write(((v and 0x7fUL) or 0x80UL).toInt())
      v = v shr 7
    }
    out.write(v.toInt())
    return this
  }

  fun int(fieldNumber: Int, value: Long): ProtoWriter = tag(fieldNumber, 0).varint(value)

  fun string(fieldNumber: Int, value: String): ProtoWriter = bytes(fieldNumber, value.toByteArray(UTF8_BALE))

  fun bytes(fieldNumber: Int, value: ByteArray): ProtoWriter {
    tag(fieldNumber, 2)
    varint(value.size.toULong())
    out.write(value)
    return this
  }

  fun message(fieldNumber: Int, block: ProtoWriter.() -> Unit): ProtoWriter {
    val inner = ProtoWriter().apply(block).toByteArray()
    return bytes(fieldNumber, inner)
  }
}

private data class ProtoField(
  val fieldNumber: Int,
  val wireType: Int,
  val varint: ULong? = null,
  val bytes: ByteArray? = null,
)

private class ProtoReader(private val buffer: ByteArray) {
  private var offset = 0

  fun fields(): Sequence<ProtoField> = sequence {
    while (offset < buffer.size) {
      val tag = readVarint()
      val fieldNumber = (tag.toInt() ushr 3)
      val wireType = (tag.toInt() and 0x7)
      when (wireType) {
        0 -> yield(ProtoField(fieldNumber = fieldNumber, wireType = wireType, varint = readVarint()))
        2 -> yield(ProtoField(fieldNumber = fieldNumber, wireType = wireType, bytes = readLenPrefixed()))
        1 -> offset += 8
        5 -> offset += 4
        else -> throw IOException("proto: unsupported wire type $wireType")
      }
    }
  }

  private fun readVarint(): ULong {
    var result = 0UL
    var shift = 0
    repeat(10) {
      if (offset >= buffer.size) throw IOException("proto: unexpected EOF")
      val byte = buffer[offset++].toInt() and 0xff
      result = result or ((byte and 0x7f).toULong() shl shift)
      if ((byte and 0x80) == 0) return result
      shift += 7
    }
    throw IOException("proto: varint too long")
  }

  private fun readLenPrefixed(): ByteArray {
    val length = readVarint().toInt()
    if (offset + length > buffer.size) throw IOException("proto: LEN overruns buffer")
    return buffer.copyOfRange(offset, offset + length).also {
      offset += length
    }
  }
}

private fun encodeStartPhoneAuth(phoneNumber: Long): ByteArray =
  ProtoWriter()
    .int(1, phoneNumber)
    .int(2, DEFAULT_APP_ID)
    .string(3, DEFAULT_APP_KEY)
    .string(4, UUID.randomUUID().toString())
    .string(5, "Chrome_143.0.0.0, Android")
    .int(9, 0)
    .message(10) {
      int(1, 0)
      int(2, 1)
    }
    .toByteArray()

private fun decodePhoneAuthResponse(bytes: ByteArray): PhoneAuthResponse {
  var transactionHash = ""
  var isRegistered = false
  for (field in ProtoReader(bytes).fields()) {
    when (field.fieldNumber) {
      1 -> if (field.wireType == 2) transactionHash = decodeString(field.bytes!!)
      2 -> if (field.wireType == 0) isRegistered = field.varint == 1UL
    }
  }
  return PhoneAuthResponse(transactionHash = transactionHash, isRegistered = isRegistered)
}

private data class ValidateResponse(
  val jwt: String?,
  val userId: Long?,
  val userName: String?,
  val userAccessHash: Long?,
)

private fun encodeValidateCode(transactionHash: String, code: String): ByteArray =
  encodeValidateLike(transactionHash, code)

private fun encodeValidatePassword(transactionHash: String, password: String): ByteArray =
  encodeValidateLike(transactionHash, password)

private fun encodeValidateLike(transactionHash: String, value: String): ByteArray =
  ProtoWriter()
    .string(1, transactionHash)
    .string(2, value)
    .message(3) {
      int(1, 1)
      int(2, 1)
    }
    .toByteArray()

private fun decodeValidateCodeResponse(bytes: ByteArray): ValidateResponse {
  var jwt: String? = null
  var userId: Long? = null
  var userName: String? = null
  var accessHash: Long? = null
  for (field in ProtoReader(bytes).fields()) {
    when (field.fieldNumber) {
      2 -> if (field.wireType == 2) {
        val user = decodeUserAuth(field.bytes!!)
        userId = user.id
        userName = user.name
        accessHash = user.accessHash
      }
      4 -> if (field.wireType == 2) jwt = decodeStringValue(field.bytes!!)
    }
  }
  return ValidateResponse(jwt = jwt, userId = userId, userName = userName, userAccessHash = accessHash)
}

private data class UserAuth(val id: Long, val accessHash: Long, val name: String)

private fun decodeUserAuth(bytes: ByteArray): UserAuth {
  var id = 0L
  var accessHash = -1L
  var name = ""
  for (field in ProtoReader(bytes).fields()) {
    when (field.fieldNumber) {
      1 -> if (field.wireType == 0) id = field.varint!!.toLong()
      2 -> if (field.wireType == 0) accessHash = field.varint!!.toLong()
      3 -> if (field.wireType == 2) name = decodeString(field.bytes!!)
    }
  }
  return UserAuth(id = id, accessHash = accessHash, name = name)
}

private fun decodeStringValue(bytes: ByteArray): String {
  for (field in ProtoReader(bytes).fields()) {
    if (field.fieldNumber == 1 && field.wireType == 2) return decodeString(field.bytes!!)
  }
  return ""
}

private fun encodePeer(peer: BalePeer): ByteArray =
  ProtoWriter()
    .int(1, peer.type.code.toLong())
    .int(2, peer.id)
    .apply {
      if (peer.accessHash != null) int(3, peer.accessHash)
    }
    .toByteArray()

private fun decodePeer(bytes: ByteArray): BalePeer {
  var type = BalePeerType.UNKNOWN
  var id = 0L
  var accessHash: Long? = null
  for (field in ProtoReader(bytes).fields()) {
    when (field.fieldNumber) {
      1 -> if (field.wireType == 0) type = BalePeerType.entries.firstOrNull { it.code == field.varint!!.toInt() } ?: BalePeerType.UNKNOWN
      2 -> if (field.wireType == 0) id = field.varint!!.toLong()
      3 -> if (field.wireType == 0) accessHash = field.varint!!.toLong()
    }
  }
  return BalePeer(type = type, id = id, accessHash = accessHash)
}

private fun encodeLoadDialogs(limit: Int): ByteArray =
  ProtoWriter()
    .int(1, -1L)
    .int(2, limit.toLong())
    .int(5, 0L)
    .toByteArray()

private fun decodeLoadDialogsResponse(bytes: ByteArray): List<DialogPeerData> {
  val dialogs = mutableListOf<DialogPeerData>()
  for (field in ProtoReader(bytes).fields()) {
    if (field.fieldNumber == 3 && field.wireType == 2) {
      dialogs += decodePeerData(field.bytes!!)
    }
  }
  return dialogs
}

private fun decodePeerData(bytes: ByteArray): DialogPeerData {
  var peer = BalePeer(BalePeerType.UNKNOWN, 0)
  var unreadCount = 0L
  var lastMessage: String? = null
  for (field in ProtoReader(bytes).fields()) {
    when (field.fieldNumber) {
      1 -> if (field.wireType == 2) peer = decodePeer(field.bytes!!)
      2 -> if (field.wireType == 0) unreadCount = field.varint!!.toLong()
      7 -> if (field.wireType == 2) lastMessage = decodeMessageContent(field.bytes!!)
    }
  }
  return DialogPeerData(peer = peer, unreadCount = unreadCount, lastMessage = lastMessage)
}

private fun decodeMessageContent(bytes: ByteArray): String? {
  for (field in ProtoReader(bytes).fields()) {
    if (field.fieldNumber == 15 && field.wireType == 2) {
      for (inner in ProtoReader(field.bytes!!).fields()) {
        if (inner.fieldNumber == 1 && inner.wireType == 2) return decodeString(inner.bytes!!)
      }
    }
  }
  return null
}

private fun encodeLoadUsers(peers: List<Long>): ByteArray {
  val writer = ProtoWriter()
  for (peerId in peers) {
    writer.message(1) {
      int(1, peerId)
    }
  }
  return writer.toByteArray()
}

private fun decodeLoadUsersResponse(bytes: ByteArray): List<BaleUser> {
  val users = mutableListOf<BaleUser>()
  for (field in ProtoReader(bytes).fields()) {
    if (field.fieldNumber == 1 && field.wireType == 2) {
      users += decodeBaleUser(field.bytes!!)
    }
  }
  return users
}

private fun decodeBaleUser(bytes: ByteArray): BaleUser {
  var id = 0L
  var accessHash = 0L
  var name = ""
  var username: String? = null
  for (field in ProtoReader(bytes).fields()) {
    when (field.fieldNumber) {
      1 -> if (field.wireType == 0) id = field.varint!!.toLong()
      2 -> if (field.wireType == 0) accessHash = field.varint!!.toLong()
      3 -> if (field.wireType == 2) name = decodeString(field.bytes!!)
      9 -> if (field.wireType == 2) {
        username = decodeMaybeStringValue(field.bytes!!)
      }
    }
  }
  return BaleUser(id = id, accessHash = accessHash, name = name, username = username)
}

private fun decodeMaybeStringValue(bytes: ByteArray): String? {
  return try {
    decodeString(bytes)
  } catch (_: Exception) {
    decodeStringValue(bytes)
  }
}

private fun encodeStartCall(peer: BalePeer): ByteArray =
  ProtoWriter()
    .message(6) {
      bytes(1, encodePeer(peer))
      int(2, randomPositiveId64())
      message(4) {
        int(1, 1)
      }
    }
    .toByteArray()

private fun decodeStartCallResponse(bytes: ByteArray): StartCallResult {
  for (field in ProtoReader(bytes).fields()) {
    if (field.fieldNumber == 1 && field.wireType == 2) return decodeStartCallResult(field.bytes!!)
  }
  throw IOException("StartCall response missing field 1")
}

private fun decodeStartCallResult(bytes: ByteArray): StartCallResult {
  var callId = 0L
  var jwt = ""
  var roomUuid = ""
  var baseUrl = ""
  var startedAtMs = 0L
  var serverAuthTs = 0L
  var peer = BalePeer(BalePeerType.UNKNOWN, 0)
  var state = 0
  for (field in ProtoReader(bytes).fields()) {
    when (field.fieldNumber) {
      1 -> if (field.wireType == 0) callId = field.varint!!.toLong()
      2 -> if (field.wireType == 2) jwt = decodeString(field.bytes!!)
      3 -> if (field.wireType == 2) roomUuid = decodeString(field.bytes!!)
      4 -> if (field.wireType == 2) {
        for (inner in ProtoReader(field.bytes!!).fields()) {
          if (inner.fieldNumber == 1 && inner.wireType == 2) baseUrl = decodeString(inner.bytes!!)
        }
      }
      6 -> if (field.wireType == 0) startedAtMs = field.varint!!.toLong()
      8 -> if (field.wireType == 0) serverAuthTs = field.varint!!.toLong()
      9 -> if (field.wireType == 2) peer = decodePeer(field.bytes!!)
      10 -> if (field.wireType == 0) state = field.varint!!.toInt()
    }
  }
  return StartCallResult(
    callId = callId,
    jwt = jwt,
    roomUuid = roomUuid,
    baseUrl = baseUrl,
    startedAtMs = startedAtMs,
    serverAuthTs = serverAuthTs,
    peer = peer,
    state = state,
  )
}

private fun encodeDiscardCall(callId: Long, reason: Int): ByteArray =
  ProtoWriter()
    .int(1, callId)
    .int(3, reason.toLong())
    .toByteArray()

private fun encodeSendMessage(peer: BalePeer, messageId: Long, text: String): ByteArray =
  ProtoWriter()
    .bytes(1, encodePeer(peer))
    .int(2, messageId)
    .message(3) {
      message(15) {
        string(1, text)
      }
    }
    .message(6) {
      int(
        1,
        when (peer.type) {
          BalePeerType.PRIVATE -> 1
          BalePeerType.GROUP -> 2
          BalePeerType.UNKNOWN -> 0
        }.toLong(),
      )
      int(2, peer.id)
    }
    .toByteArray()

private fun buildLiveKitUrl(result: StartCallResult): String {
  val query = listOf(
    "access_token=${result.jwt}",
    "auto_subscribe=1",
    "sdk=js",
    "version=2.15.2",
    "protocol=16",
    "adaptive_stream=0",
  ).joinToString("&")
  return "${result.baseUrl}?$query"
}

private fun randomPositiveId64(): Long {
  val bytes = randomBytes(8)
  var value = 0L
  for (byte in bytes) {
    value = (value shl 8) or (byte.toLong() and 0xffL)
  }
  return value and ((1L shl 62) - 1)
}

private fun decodeString(bytes: ByteArray): String = bytes.toString(UTF8_BALE)

package ai.webtunnel.mobile

import android.util.Base64
import org.json.JSONObject
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.util.UUID

private const val CLIENT_CONFIG_PREFIX = "wtc1:"
private const val CONFIG_KEY_LABEL = "web-tunnel encrypted client config v1"
private const val NONCE_BYTES = 12

data class ClientConfigServerPeer(
  val chatId: Long,
  val chatType: String,
  val label: String,
)

data class ClientConfigPayload(
  val clientId: String,
  val clientName: String,
  val createdAt: Long,
  val defaultSocksPort: Int,
  val baleSession: BaleSession,
  val serverPeer: ClientConfigServerPeer,
  val serverUuid: String,
  val serverFingerprint: String?,
)

fun decodeClientConfig(input: String): ClientConfigPayload {
  val trimmed = input.trim()
  require(trimmed.startsWith(CLIENT_CONFIG_PREFIX)) { "client config must start with wtc1:" }
  val encoded = trimmed.removePrefix(CLIENT_CONFIG_PREFIX)
  val packed = Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  require(packed.size > NONCE_BYTES) { "client config payload is too short" }
  val nonce = packed.copyOfRange(0, NONCE_BYTES)
  val encrypted = packed.copyOfRange(NONCE_BYTES, packed.size)
  val key = MessageDigest.getInstance("SHA-256").digest(CONFIG_KEY_LABEL.toByteArray(Charsets.UTF_8))
  val cipher = Cipher.getInstance("AES/GCM/NoPadding")
  cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
  val plain = cipher.doFinal(encrypted).toString(Charsets.UTF_8)
  val raw = JSONObject(plain)
  require(raw.optInt("schema") == 1) { "unsupported client config schema" }
  val sessionRaw = raw.getJSONObject("baleSession")
  val serverRaw = raw.getJSONObject("serverPeer")
  val carrier = raw.optString("carrier")
  val serverUuid = raw.getString("serverUuid")
  require(carrier == "webrtc") { "client config carrier must be webrtc" }
  require(isValidUuid(serverUuid)) { "client config has invalid server uuid" }
  return ClientConfigPayload(
    clientId = raw.getString("clientId"),
    clientName = raw.getString("clientName"),
    createdAt = raw.optLong("createdAt", System.currentTimeMillis()),
    defaultSocksPort = raw.optInt("defaultSocksPort", 1080),
    baleSession = BaleSession(
      jwt = sessionRaw.getString("jwt"),
      userId = sessionRaw.getString("userId").toLong(),
      userName = sessionRaw.optString("userName").ifBlank { null },
      userAccessHash = sessionRaw.getString("userAccessHash").toLong(),
    ),
    serverPeer = ClientConfigServerPeer(
      chatId = serverRaw.getLong("chatId"),
      chatType = serverRaw.getString("chatType"),
      label = serverRaw.optString("label").ifBlank { "server" },
    ),
    serverUuid = serverUuid,
    serverFingerprint = raw.optString("serverFingerprint").ifBlank { null },
  )
}

private fun isValidUuid(value: String): Boolean {
  return try {
    UUID.fromString(value).toString().equals(value, ignoreCase = true)
  } catch (_: Throwable) {
    false
  }
}

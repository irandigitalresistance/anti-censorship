package ai.webtunnel.mobile

import android.content.Context
import org.json.JSONObject
import java.io.File

data class BaleSession(
  val jwt: String,
  val userId: Long,
  val userName: String?,
  val userAccessHash: Long,
)

class SessionStore(context: Context) {
  private val file = File(context.filesDir, "bale-session.json")
  private val keyPinsFile = File(context.filesDir, "server-key-pins.json")

  fun load(): BaleSession? {
    if (!file.exists()) return null
    val raw = JSONObject(file.readText())
    return BaleSession(
      jwt = raw.getString("jwt"),
      userId = raw.getString("userId").toLong(),
      userName = raw.optString("userName").ifBlank { null },
      userAccessHash = raw.getString("userAccessHash").toLong(),
    )
  }

  fun save(session: BaleSession) {
    val raw = JSONObject()
      .put("jwt", session.jwt)
      .put("userId", session.userId.toString())
      .put("userName", session.userName)
      .put("userAccessHash", session.userAccessHash.toString())
    file.writeText(raw.toString())
  }

  fun clear() {
    if (file.exists()) file.delete()
  }

  fun loadPinnedFingerprint(keyId: String): String? {
    if (keyId.isBlank()) return null
    val pins = loadPinsMap()
    return pins[keyId]?.takeIf { it.isNotBlank() }
  }

  fun savePinnedFingerprint(keyId: String, fingerprint: String) {
    require(keyId.isNotBlank()) { "keyId is required" }
    require(fingerprint.isNotBlank()) { "fingerprint is required" }
    val pins = loadPinsMap()
    pins[keyId] = fingerprint
    savePinsMap(pins)
  }

  fun clearPinnedFingerprint(keyId: String? = null) {
    if (keyId == null) {
      if (keyPinsFile.exists()) keyPinsFile.delete()
      return
    }
    if (keyId.isBlank()) return
    val pins = loadPinsMap()
    if (pins.remove(keyId) != null) savePinsMap(pins)
  }

  private fun loadPinsMap(): MutableMap<String, String> {
    if (!keyPinsFile.exists()) return linkedMapOf()
    return try {
      val raw = JSONObject(keyPinsFile.readText())
      val out = linkedMapOf<String, String>()
      val keys = raw.keys()
      while (keys.hasNext()) {
        val key = keys.next()
        val value = raw.optString(key)
        if (value.isNotBlank()) out[key] = value
      }
      out
    } catch (_: Throwable) {
      linkedMapOf()
    }
  }

  private fun savePinsMap(pins: Map<String, String>) {
    val raw = JSONObject()
    for ((key, value) in pins) {
      if (value.isNotBlank()) raw.put(key, value)
    }
    keyPinsFile.writeText(raw.toString())
  }
}

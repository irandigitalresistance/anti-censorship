package ai.webtunnel.mobile

import org.bouncycastle.crypto.generators.SCrypt
import org.bouncycastle.crypto.macs.Poly1305
import org.bouncycastle.crypto.params.KeyParameter
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

const val PSK_SALT_INFO: String = "web-tunnel v0 psk derivation"

private const val KEY_BYTES = 32
private const val NONCE_BYTES = 24
private const val TAG_BYTES = 16
private const val SESSION_NONCE_BYTES = 16

private val UTF8 = StandardCharsets.UTF_8
private val RANDOM = SecureRandom()
private val SIGMA = intArrayOf(
  0x61707865,
  0x3320646e,
  0x79622d32,
  0x6b206574,
)
private val ZERO_PAD_16 = ByteArray(16)
private val ZERO_SALT = ByteArray(32)

fun deriveKeyFromPassword(password: String, salt: ByteArray): ByteArray =
  SCrypt.generate(password.toByteArray(UTF8), salt, 1 shl 15, 8, 1, KEY_BYTES)

data class HandshakeReq(val clientNonce: ByteArray, val mac: ByteArray)
data class HandshakeOk(val serverNonce: ByteArray, val mac: ByteArray)

fun makeHandshakeReq(psk: ByteArray): Pair<ByteArray, ByteArray> {
  requireKey(psk)
  val clientNonce = randomBytes(SESSION_NONCE_BYTES)
  val mac = hmacSha256(psk, concat("WT-REQ".toByteArray(UTF8), clientNonce))
  return Pair(concat(clientNonce, mac), clientNonce)
}

fun verifyHandshakeReq(wire: ByteArray, psk: ByteArray): HandshakeReq {
  requireKey(psk)
  require(wire.size == SESSION_NONCE_BYTES + 32) { "bad REQ length" }
  val clientNonce = wire.copyOfRange(0, SESSION_NONCE_BYTES)
  val mac = wire.copyOfRange(SESSION_NONCE_BYTES, wire.size)
  val expected = hmacSha256(psk, concat("WT-REQ".toByteArray(UTF8), clientNonce))
  require(ctEquals(mac, expected)) { "REQ MAC mismatch" }
  return HandshakeReq(clientNonce = clientNonce, mac = mac)
}

fun makeHandshakeOk(psk: ByteArray, clientNonce: ByteArray): Pair<ByteArray, ByteArray> {
  requireKey(psk)
  require(clientNonce.size == SESSION_NONCE_BYTES) { "bad client nonce length" }
  val serverNonce = randomBytes(SESSION_NONCE_BYTES)
  val mac = hmacSha256(psk, concat("WT-OK".toByteArray(UTF8), clientNonce, serverNonce))
  return Pair(concat(serverNonce, mac), serverNonce)
}

fun verifyHandshakeOk(wire: ByteArray, psk: ByteArray, clientNonce: ByteArray): HandshakeOk {
  requireKey(psk)
  require(wire.size == SESSION_NONCE_BYTES + 32) { "bad OK length" }
  val serverNonce = wire.copyOfRange(0, SESSION_NONCE_BYTES)
  val mac = wire.copyOfRange(SESSION_NONCE_BYTES, wire.size)
  val expected = hmacSha256(psk, concat("WT-OK".toByteArray(UTF8), clientNonce, serverNonce))
  require(ctEquals(mac, expected)) { "OK MAC mismatch" }
  return HandshakeOk(serverNonce = serverNonce, mac = mac)
}

class SessionCipher private constructor(private val key: ByteArray) {
  companion object {
    fun fromKey(key: ByteArray): SessionCipher {
      requireKey(key)
      return SessionCipher(key.copyOf())
    }

    fun derive(psk: ByteArray, clientNonce: ByteArray, serverNonce: ByteArray): SessionCipher {
      val ikm = concat(psk, clientNonce, serverNonce)
      val derived = hkdfSha256(ikm = ikm, salt = null, info = "web-tunnel session v0".toByteArray(UTF8), length = KEY_BYTES)
      return fromKey(derived)
    }
  }

  fun encrypt(plaintext: ByteArray, aad: ByteArray? = null): ByteArray {
    val nonce = randomBytes(NONCE_BYTES)
    val ciphertext = xchacha20poly1305Encrypt(key, nonce, plaintext, aad ?: ByteArray(0))
    return concat(nonce, ciphertext)
  }

  fun decrypt(wire: ByteArray, aad: ByteArray? = null): ByteArray {
    require(wire.size >= NONCE_BYTES + TAG_BYTES) { "ciphertext too short" }
    val nonce = wire.copyOfRange(0, NONCE_BYTES)
    val ciphertext = wire.copyOfRange(NONCE_BYTES, wire.size)
    return xchacha20poly1305Decrypt(key, nonce, ciphertext, aad ?: ByteArray(0))
  }
}

private fun xchacha20poly1305Encrypt(
  key: ByteArray,
  nonce: ByteArray,
  plaintext: ByteArray,
  aad: ByteArray,
): ByteArray {
  require(key.size == KEY_BYTES) { "xchacha key must be 32 bytes" }
  require(nonce.size == NONCE_BYTES) { "xchacha nonce must be 24 bytes" }
  val ciphertext = xchacha20Xor(key, nonce, plaintext, counter = 1)
  val tag = computePoly1305Tag(key, nonce, ciphertext, aad)
  return concat(ciphertext, tag)
}

private fun xchacha20poly1305Decrypt(
  key: ByteArray,
  nonce: ByteArray,
  ciphertextWithTag: ByteArray,
  aad: ByteArray,
): ByteArray {
  require(ciphertextWithTag.size >= TAG_BYTES) { "invalid ciphertext length" }
  val ciphertext = ciphertextWithTag.copyOfRange(0, ciphertextWithTag.size - TAG_BYTES)
  val suppliedTag = ciphertextWithTag.copyOfRange(ciphertextWithTag.size - TAG_BYTES, ciphertextWithTag.size)
  val computedTag = computePoly1305Tag(key, nonce, ciphertext, aad)
  require(ctEquals(suppliedTag, computedTag)) { "invalid tag" }
  return xchacha20Xor(key, nonce, ciphertext, counter = 1)
}

private fun computePoly1305Tag(
  key: ByteArray,
  nonce: ByteArray,
  data: ByteArray,
  aad: ByteArray,
): ByteArray {
  val authKey = xchacha20Xor(key, nonce, ByteArray(32), counter = 0)
  val poly1305 = Poly1305()
  poly1305.init(KeyParameter(authKey))
  if (aad.isNotEmpty()) {
    poly1305.update(aad, 0, aad.size)
    updatePad16(poly1305, aad.size)
  }
  if (data.isNotEmpty()) {
    poly1305.update(data, 0, data.size)
    updatePad16(poly1305, data.size)
  }
  val lengths = ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN)
    .putLong(aad.size.toLong())
    .putLong(data.size.toLong())
    .array()
  poly1305.update(lengths, 0, lengths.size)
  return ByteArray(TAG_BYTES).also { poly1305.doFinal(it, 0) }
}

private fun updatePad16(poly1305: Poly1305, length: Int) {
  val remainder = length % 16
  if (remainder != 0) {
    poly1305.update(ZERO_PAD_16, 0, 16 - remainder)
  }
}

private fun xchacha20Xor(
  key: ByteArray,
  nonce: ByteArray,
  input: ByteArray,
  counter: Int,
): ByteArray {
  val subKey = hChaCha20(key, nonce.copyOfRange(0, 16))
  val finalNonce = ByteArray(12)
  System.arraycopy(nonce, 16, finalNonce, 4, 8)
  return chacha20Xor(subKey, finalNonce, input, counter)
}

private fun hChaCha20(key: ByteArray, input: ByteArray): ByteArray {
  require(key.size == 32) { "invalid hchacha key length" }
  require(input.size == 16) { "invalid hchacha input length" }
  val working = IntArray(16)
  working[0] = SIGMA[0]
  working[1] = SIGMA[1]
  working[2] = SIGMA[2]
  working[3] = SIGMA[3]
  for (i in 0 until 8) working[4 + i] = intLE(key, i * 4)
  for (i in 0 until 4) working[12 + i] = intLE(input, i * 4)
  repeat(10) {
    quarterRound(working, 0, 4, 8, 12)
    quarterRound(working, 1, 5, 9, 13)
    quarterRound(working, 2, 6, 10, 14)
    quarterRound(working, 3, 7, 11, 15)
    quarterRound(working, 0, 5, 10, 15)
    quarterRound(working, 1, 6, 11, 12)
    quarterRound(working, 2, 7, 8, 13)
    quarterRound(working, 3, 4, 9, 14)
  }
  return ByteArray(32).also { out ->
    writeIntLE(out, 0, working[0])
    writeIntLE(out, 4, working[1])
    writeIntLE(out, 8, working[2])
    writeIntLE(out, 12, working[3])
    writeIntLE(out, 16, working[12])
    writeIntLE(out, 20, working[13])
    writeIntLE(out, 24, working[14])
    writeIntLE(out, 28, working[15])
  }
}

private fun chacha20Xor(
  key: ByteArray,
  nonce: ByteArray,
  input: ByteArray,
  counter: Int,
): ByteArray {
  require(key.size == 32) { "invalid chacha key length" }
  require(nonce.size == 12) { "invalid chacha nonce length" }
  val keyWords = IntArray(8) { idx -> intLE(key, idx * 4) }
  val nonceWords = IntArray(3) { idx -> intLE(nonce, idx * 4) }
  val out = ByteArray(input.size)
  var blockCounter = counter
  var offset = 0
  while (offset < input.size) {
    val block = chacha20Block(keyWords, nonceWords, blockCounter)
    val take = minOf(64, input.size - offset)
    for (i in 0 until take) {
      out[offset + i] = (input[offset + i].toInt() xor block[i].toInt()).toByte()
    }
    blockCounter += 1
    offset += take
  }
  return out
}

private fun chacha20Block(keyWords: IntArray, nonceWords: IntArray, counter: Int): ByteArray {
  val state = IntArray(16)
  state[0] = SIGMA[0]
  state[1] = SIGMA[1]
  state[2] = SIGMA[2]
  state[3] = SIGMA[3]
  for (i in 0 until 8) state[4 + i] = keyWords[i]
  state[12] = counter
  state[13] = nonceWords[0]
  state[14] = nonceWords[1]
  state[15] = nonceWords[2]
  val working = state.copyOf()
  repeat(10) {
    quarterRound(working, 0, 4, 8, 12)
    quarterRound(working, 1, 5, 9, 13)
    quarterRound(working, 2, 6, 10, 14)
    quarterRound(working, 3, 7, 11, 15)
    quarterRound(working, 0, 5, 10, 15)
    quarterRound(working, 1, 6, 11, 12)
    quarterRound(working, 2, 7, 8, 13)
    quarterRound(working, 3, 4, 9, 14)
  }
  for (i in working.indices) working[i] += state[i]
  return ByteArray(64).also { out ->
    for (i in working.indices) writeIntLE(out, i * 4, working[i])
  }
}

private fun quarterRound(state: IntArray, a: Int, b: Int, c: Int, d: Int) {
  state[a] += state[b]
  state[d] = rotl(state[d] xor state[a], 16)
  state[c] += state[d]
  state[b] = rotl(state[b] xor state[c], 12)
  state[a] += state[b]
  state[d] = rotl(state[d] xor state[a], 8)
  state[c] += state[d]
  state[b] = rotl(state[b] xor state[c], 7)
}

private fun rotl(value: Int, bits: Int): Int =
  (value shl bits) or (value ushr (32 - bits))

private fun intLE(bytes: ByteArray, offset: Int): Int =
  (bytes[offset].toInt() and 0xff) or
    ((bytes[offset + 1].toInt() and 0xff) shl 8) or
    ((bytes[offset + 2].toInt() and 0xff) shl 16) or
    ((bytes[offset + 3].toInt() and 0xff) shl 24)

private fun writeIntLE(out: ByteArray, offset: Int, value: Int) {
  out[offset] = value.toByte()
  out[offset + 1] = (value ushr 8).toByte()
  out[offset + 2] = (value ushr 16).toByte()
  out[offset + 3] = (value ushr 24).toByte()
}

private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
  val mac = Mac.getInstance("HmacSHA256")
  mac.init(SecretKeySpec(key, "HmacSHA256"))
  return mac.doFinal(data)
}

private fun hkdfSha256(
  ikm: ByteArray,
  salt: ByteArray?,
  info: ByteArray,
  length: Int,
): ByteArray {
  require(length > 0) { "length must be positive" }
  val prk = hmacSha256(salt ?: ZERO_SALT, ikm)
  val result = ByteArray(length)
  var previous = ByteArray(0)
  var generated = 0
  var counter = 1
  while (generated < length) {
    val blockInput = concat(previous, info, byteArrayOf(counter.toByte()))
    previous = hmacSha256(prk, blockInput)
    val take = minOf(previous.size, length - generated)
    System.arraycopy(previous, 0, result, generated, take)
    generated += take
    counter += 1
  }
  return result
}

private fun requireKey(psk: ByteArray) {
  require(psk.size == KEY_BYTES) { "key must be 32 bytes, got ${psk.size}" }
}

fun ctEquals(a: ByteArray, b: ByteArray): Boolean {
  if (a.size != b.size) return false
  var diff = 0
  for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
  return diff == 0
}

fun concat(vararg parts: ByteArray): ByteArray {
  val total = parts.sumOf { it.size }
  val out = ByteArray(total)
  var offset = 0
  for (part in parts) {
    System.arraycopy(part, 0, out, offset, part.size)
    offset += part.size
  }
  return out
}

fun randomBytes(length: Int): ByteArray =
  ByteArray(length).also { RANDOM.nextBytes(it) }

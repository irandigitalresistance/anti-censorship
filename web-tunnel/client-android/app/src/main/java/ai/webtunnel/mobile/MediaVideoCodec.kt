package ai.webtunnel.mobile

const val MEDIA_VIDEO_FRAME_WIDTH: Int = 640
const val MEDIA_VIDEO_FRAME_HEIGHT: Int = 360
const val MEDIA_VIDEO_GRID_COLS: Int = 160
const val MEDIA_VIDEO_GRID_ROWS: Int = 90
const val MEDIA_VIDEO_SYMBOL_BITS: Int = 2
const val MEDIA_VIDEO_PACKET_BYTES: Int = MEDIA_VIDEO_GRID_COLS * MEDIA_VIDEO_GRID_ROWS * MEDIA_VIDEO_SYMBOL_BITS / 8
const val MEDIA_VIDEO_PAYLOAD_BYTES: Int = MEDIA_VIDEO_PACKET_BYTES - 17

const val MEDIA_VIDEO_PACKET_KIND_ACK: Int = 0
const val MEDIA_VIDEO_PACKET_KIND_DATA: Int = 1

private const val MAGIC0 = 0x57
private const val MAGIC1 = 0x54
private const val MAGIC2 = 0x4d
private const val VERSION = 2
private const val HEADER_BYTES = 15
private const val CRC_OFFSET = MEDIA_VIDEO_PACKET_BYTES - 2
private const val NO_ACK = 0xffff
private val SYMBOL_VALUES = intArrayOf(24, 96, 160, 232)

data class MediaVideoPacket(
  val kind: Int,
  val seq: Int,
  val ackSeq: Int?,
  val msgId: Int,
  val fragIndex: Int,
  val fragCount: Int,
  val payload: ByteArray,
)

fun encodeMediaVideoPacket(packet: MediaVideoPacket): ByteArray {
  require(packet.payload.size <= MEDIA_VIDEO_PAYLOAD_BYTES) {
    "media-video payload too large (${packet.payload.size} > $MEDIA_VIDEO_PAYLOAD_BYTES)"
  }
  require(isU16(packet.seq) && isU16(packet.msgId)) { "seq/msgId must fit in uint16" }
  require(isU8(packet.fragIndex) && isU8(packet.fragCount)) { "fragment index/count must fit in uint8" }
  val out = ByteArray(MEDIA_VIDEO_PACKET_BYTES)
  out[0] = MAGIC0.toByte()
  out[1] = MAGIC1.toByte()
  out[2] = MAGIC2.toByte()
  out[3] = VERSION.toByte()
  out[4] = packet.kind.toByte()
  writeU16(out, 5, packet.seq)
  writeU16(out, 7, packet.ackSeq ?: NO_ACK)
  writeU16(out, 9, packet.msgId)
  out[11] = packet.fragIndex.toByte()
  out[12] = packet.fragCount.toByte()
  writeU16(out, 13, packet.payload.size)
  System.arraycopy(packet.payload, 0, out, HEADER_BYTES, packet.payload.size)
  writeU16(out, CRC_OFFSET, crc16(out, 0, CRC_OFFSET))
  return out
}

fun decodeMediaVideoPacket(bytes: ByteArray): MediaVideoPacket? {
  if (bytes.size < MEDIA_VIDEO_PACKET_BYTES) return null
  if ((bytes[0].toInt() and 0xff) != MAGIC0) return null
  if ((bytes[1].toInt() and 0xff) != MAGIC1) return null
  if ((bytes[2].toInt() and 0xff) != MAGIC2) return null
  if ((bytes[3].toInt() and 0xff) != VERSION) return null
  val expectedCrc = readU16(bytes, CRC_OFFSET)
  val actualCrc = crc16(bytes, 0, CRC_OFFSET)
  if (expectedCrc != actualCrc) return null
  val payloadLen = readU16(bytes, 13)
  if (payloadLen > MEDIA_VIDEO_PAYLOAD_BYTES) return null
  val kind = bytes[4].toInt() and 0xff
  if (kind != MEDIA_VIDEO_PACKET_KIND_ACK && kind != MEDIA_VIDEO_PACKET_KIND_DATA) return null
  val ack = readU16(bytes, 7)
  return MediaVideoPacket(
    kind = kind,
    seq = readU16(bytes, 5),
    ackSeq = if (ack == NO_ACK) null else ack,
    msgId = readU16(bytes, 9),
    fragIndex = bytes[11].toInt() and 0xff,
    fragCount = bytes[12].toInt() and 0xff,
    payload = bytes.copyOfRange(HEADER_BYTES, HEADER_BYTES + payloadLen),
  )
}

fun encodeMediaVideoPacketToI420(
  packetBytes: ByteArray,
  width: Int = MEDIA_VIDEO_FRAME_WIDTH,
  height: Int = MEDIA_VIDEO_FRAME_HEIGHT,
): ByteArray {
  require(packetBytes.size == MEDIA_VIDEO_PACKET_BYTES) {
    "media-video packet must be $MEDIA_VIDEO_PACKET_BYTES bytes"
  }
  val chromaWidth = (width + 1) / 2
  val chromaHeight = (height + 1) / 2
  val yBytes = width * height
  val out = ByteArray(yBytes + chromaWidth * chromaHeight * 2)
  fillGrid(out, width, height, packetBytes)
  out.fill(128.toByte(), yBytes, out.size)
  return out
}

fun decodeMediaVideoPacketFromI420(yPlane: ByteArray, width: Int, height: Int): ByteArray {
  require(yPlane.size >= width * height) { "I420 frame is missing the luma plane" }
  val out = ByteArray(MEDIA_VIDEO_PACKET_BYTES)
  val symbols = MEDIA_VIDEO_PACKET_BYTES * (8 / MEDIA_VIDEO_SYMBOL_BITS)
  for (symbolIndex in 0 until symbols) {
    val col = symbolIndex % MEDIA_VIDEO_GRID_COLS
    val row = symbolIndex / MEDIA_VIDEO_GRID_COLS
    writeSymbol(out, symbolIndex, readCellSymbol(yPlane, width, height, col, row))
  }
  return out
}

fun encodeMediaVideoAckPayload(seqs: List<Int>): ByteArray {
  val maxSeqs = MEDIA_VIDEO_PAYLOAD_BYTES / 2
  val count = minOf(seqs.size, maxSeqs)
  val out = ByteArray(count * 2)
  for (i in 0 until count) writeU16(out, i * 2, seqs[i])
  return out
}

fun decodeMediaVideoAckPayload(payload: ByteArray): List<Int> {
  val out = ArrayList<Int>(payload.size / 2)
  var offset = 0
  while (offset + 1 < payload.size) {
    out += readU16(payload, offset)
    offset += 2
  }
  return out
}

private fun fillGrid(yPlane: ByteArray, width: Int, height: Int, packetBytes: ByteArray) {
  for (row in 0 until MEDIA_VIDEO_GRID_ROWS) {
    val y0 = (row * height) / MEDIA_VIDEO_GRID_ROWS
    val y1 = ((row + 1) * height) / MEDIA_VIDEO_GRID_ROWS
    for (col in 0 until MEDIA_VIDEO_GRID_COLS) {
      val symbolIndex = row * MEDIA_VIDEO_GRID_COLS + col
      val value = SYMBOL_VALUES[readSymbol(packetBytes, symbolIndex)].toByte()
      val x0 = (col * width) / MEDIA_VIDEO_GRID_COLS
      val x1 = ((col + 1) * width) / MEDIA_VIDEO_GRID_COLS
      for (y in y0 until y1) {
        yPlane.fill(value, y * width + x0, y * width + x1)
      }
    }
  }
}

private fun readCellSymbol(yPlane: ByteArray, width: Int, height: Int, col: Int, row: Int): Int {
  val x0 = (((col + 0.25) * width) / MEDIA_VIDEO_GRID_COLS).toInt()
  val x1 = maxOf(x0 + 1, (((col + 0.75) * width) / MEDIA_VIDEO_GRID_COLS).toInt())
  val y0 = (((row + 0.25) * height) / MEDIA_VIDEO_GRID_ROWS).toInt()
  val y1 = maxOf(y0 + 1, (((row + 0.75) * height) / MEDIA_VIDEO_GRID_ROWS).toInt())
  var sum = 0
  var n = 0
  for (y in y0 until y1) {
    for (x in x0 until x1) {
      sum += yPlane[y * width + x].toInt() and 0xff
      n += 1
    }
  }
  val avg = sum / maxOf(1, n)
  return when {
    avg < 60 -> 0
    avg < 128 -> 1
    avg < 196 -> 2
    else -> 3
  }
}

private fun readSymbol(bytes: ByteArray, symbolIndex: Int): Int {
  val byteIndex = symbolIndex / 4
  val shift = 6 - (symbolIndex % 4) * 2
  return (bytes[byteIndex].toInt() ushr shift) and 0x03
}

private fun writeSymbol(bytes: ByteArray, symbolIndex: Int, symbol: Int) {
  val byteIndex = symbolIndex / 4
  val shift = 6 - (symbolIndex % 4) * 2
  val current = bytes[byteIndex].toInt() and 0xff
  bytes[byteIndex] = ((current and (0x03 shl shift).inv()) or ((symbol and 0x03) shl shift)).toByte()
}

private fun crc16(bytes: ByteArray, offset: Int, length: Int): Int {
  var crc = 0xffff
  for (i in offset until offset + length) {
    crc = crc xor ((bytes[i].toInt() and 0xff) shl 8)
    repeat(8) {
      crc = if ((crc and 0x8000) != 0) {
        ((crc shl 1) xor 0x1021) and 0xffff
      } else {
        (crc shl 1) and 0xffff
      }
    }
  }
  return crc and 0xffff
}

private fun isU16(value: Int): Boolean = value in 0..0xffff
private fun isU8(value: Int): Boolean = value in 0..0xff

private fun writeU16(out: ByteArray, offset: Int, value: Int) {
  out[offset] = ((value ushr 8) and 0xff).toByte()
  out[offset + 1] = (value and 0xff).toByte()
}

private fun readU16(bytes: ByteArray, offset: Int): Int =
  ((bytes[offset].toInt() and 0xff) shl 8) or (bytes[offset + 1].toInt() and 0xff)

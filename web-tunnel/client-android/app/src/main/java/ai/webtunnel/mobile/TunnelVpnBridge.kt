package ai.webtunnel.mobile

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import hev.sockstun.TProxyService

data class TunnelVpnConfig(
  val sessionLabel: String,
  val socksPort: Int,
  val remoteDns: Boolean = true,
  val enableIpv4: Boolean = true,
  val enableIpv6: Boolean = true,
  // Standard Ethernet MTU. Earlier builds used 8500 which caused fragmentation
  // through the WebRTC data-channel carrier; large TCP segments and UDP datagrams
  // (e.g. WebRTC voice/video, Telegram calls, Google Meet) silently dropped on
  // some networks. 1500 matches what SocksDroid and Hiddify use for SOCKS5-TUN.
  val mtu: Int = 1500,
)

object TunnelVpnBridge {
  const val ACTION_CONNECT: String = "ai.webtunnel.mobile.VPN_CONNECT"
  const val ACTION_DISCONNECT: String = "ai.webtunnel.mobile.VPN_DISCONNECT"
  const val EXTRA_SESSION_LABEL: String = "ai.webtunnel.mobile.extra.SESSION_LABEL"
  const val EXTRA_SOCKS_PORT: String = "ai.webtunnel.mobile.extra.SOCKS_PORT"
  const val EXTRA_REMOTE_DNS: String = "ai.webtunnel.mobile.extra.REMOTE_DNS"
  const val EXTRA_ENABLE_IPV4: String = "ai.webtunnel.mobile.extra.ENABLE_IPV4"
  const val EXTRA_ENABLE_IPV6: String = "ai.webtunnel.mobile.extra.ENABLE_IPV6"
  const val EXTRA_MTU: String = "ai.webtunnel.mobile.extra.MTU"

  fun start(context: Context, config: TunnelVpnConfig) {
    val intent = Intent(context, TProxyService::class.java)
      .setAction(ACTION_CONNECT)
      .putExtra(EXTRA_SESSION_LABEL, config.sessionLabel)
      .putExtra(EXTRA_SOCKS_PORT, config.socksPort)
      .putExtra(EXTRA_REMOTE_DNS, config.remoteDns)
      .putExtra(EXTRA_ENABLE_IPV4, config.enableIpv4)
      .putExtra(EXTRA_ENABLE_IPV6, config.enableIpv6)
      .putExtra(EXTRA_MTU, config.mtu)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ContextCompat.startForegroundService(context, intent)
    } else {
      context.startService(intent)
    }
  }

  fun stop(context: Context) {
    val intent = Intent(context, TProxyService::class.java).setAction(ACTION_DISCONNECT)
    context.startService(intent)
  }
}

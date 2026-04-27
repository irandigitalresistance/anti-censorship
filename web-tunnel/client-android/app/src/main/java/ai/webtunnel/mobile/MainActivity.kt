package ai.webtunnel.mobile

import android.net.VpnService
import android.os.Bundle
import android.text.format.Formatter
import android.view.Menu
import android.view.MenuItem
import android.widget.ArrayAdapter
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import ai.webtunnel.mobile.databinding.ActivityMainBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private data class AutoStartConfig(
  val enabled: Boolean,
  val carrier: Carrier,
  val peerLabel: String?,
  val peerId: Long?,
  val socksPort: Int,
)

private data class StartTunnelRequest(
  val carrier: Carrier,
  val selected: ChatOption,
  val socksPort: Int,
)

private data class VpnProbeConfig(
  val sessionLabel: String,
  val socksPort: Int,
)

class MainActivity : AppCompatActivity() {
  private lateinit var binding: ActivityMainBinding
  private lateinit var controller: WebTunnelController
  private lateinit var chatAdapter: ArrayAdapter<ChatOption>
  private var uiState: ControllerState = ControllerState()
  private var selectedCarrier: Carrier = Carrier.WEBRTC
  private var autoStartConfig: AutoStartConfig? = null
  private var autoStartConsumed = false
  private var pendingTunnelRequest: StartTunnelRequest? = null
  private var pendingVpnProbe: VpnProbeConfig? = null
  private val vpnPermissionLauncher =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val request = pendingTunnelRequest
      val vpnProbe = pendingVpnProbe
      pendingTunnelRequest = null
      pendingVpnProbe = null
      if (result.resultCode == RESULT_OK && request != null) {
        launchTunnelStart(request)
      } else if (result.resultCode == RESULT_OK && vpnProbe != null) {
        startVpnProbe(vpnProbe)
      } else if (request != null) {
        render(uiState.copy(lastError = "VPN permission is required"))
      } else if (vpnProbe != null) {
        render(uiState.copy(lastError = "VPN permission is required"))
      }
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    binding = ActivityMainBinding.inflate(layoutInflater)
    setContentView(binding.root)
    setSupportActionBar(binding.toolbar)
    supportActionBar?.title = "Web Tunnel ${BuildConfig.VERSION_NAME}"

    chatAdapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, mutableListOf())
    chatAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
    binding.chatSelect.adapter = chatAdapter
    binding.socksPort.setText("1080")
    autoStartConfig = parseAutoStartConfig()

    controller = (application as WebTunnelApp).controller
    controller.onStateChanged = { state ->
      runOnUiThread {
        uiState = state
        syncAdapters(state.chats)
        render(state)
        maybeApplyAutoStart(state)
      }
    }

    // Render the current controller state immediately (handles Activity recreations
    // where the tunnel is already running and no state-change event will fire).
    val initState = controller.currentState()
    uiState = initState
    syncAdapters(initState.chats)
    render(initState)

    setupActions()
    maybeStartVpnProbe()

    lifecycleScope.launch {
      controller.bootstrap()
    }
    lifecycleScope.launch {
      while (true) {
        delay(1_000)
        val tunnel = uiState.tunnel ?: continue
        binding.kSince.text = formatDuration(System.currentTimeMillis() - tunnel.startedAt)
      }
    }
  }

  override fun onDestroy() {
    super.onDestroy()
    controller.onStateChanged = null
  }

  override fun onCreateOptionsMenu(menu: Menu): Boolean {
    menuInflater.inflate(R.menu.toolbar_menu, menu)
    return true
  }

  override fun onPrepareOptionsMenu(menu: Menu): Boolean {
    // Sign out only makes sense once the user is authenticated.
    val signOutItem = menu.findItem(R.id.action_sign_out)
    signOutItem?.isVisible = uiState.loginStage == LoginStage.READY
    return super.onPrepareOptionsMenu(menu)
  }

  override fun onOptionsItemSelected(item: MenuItem): Boolean {
    return when (item.itemId) {
      R.id.action_open_log -> {
        MaterialAlertDialogBuilder(this)
          .setTitle("Client log")
          .setMessage(controller.logsText().ifBlank { "No log lines yet." })
          .setPositiveButton("Close", null)
          .show()
        true
      }
      R.id.action_sign_out -> {
        lifecycleScope.launch {
          binding.phone.setText("")
          binding.code.setText("")
          binding.password.setText("")
          controller.signOut()
        }
        true
      }
      else -> super.onOptionsItemSelected(item)
    }
  }

  private fun setupActions() {
    binding.sendCode.setOnClickListener {
      val phone = binding.phone.text?.toString()?.trim().orEmpty()
      if (phone.isBlank()) {
        render(uiState.copy(lastError = "Enter a phone number"))
        return@setOnClickListener
      }
      lifecycleScope.launch {
        controller.sendPhoneCode(phone)
      }
    }

    binding.verifyCode.setOnClickListener {
      val code = binding.code.text?.toString()?.trim().orEmpty()
      if (code.isBlank()) {
        render(uiState.copy(lastError = "Enter the code"))
        return@setOnClickListener
      }
      lifecycleScope.launch {
        controller.verifyCode(code)
      }
    }

    binding.verifyPassword.setOnClickListener {
      val password = binding.password.text?.toString().orEmpty()
      if (password.isBlank()) {
        render(uiState.copy(lastError = "Enter your 2FA password"))
        return@setOnClickListener
      }
      lifecycleScope.launch {
        controller.verifyPassword(password)
      }
    }

    binding.backFromCode.setOnClickListener {
      binding.code.setText("")
      controller.backToPhone()
    }

    binding.backFromPassword.setOnClickListener {
      binding.password.setText("")
      controller.backToCode()
    }

    binding.resendCode.setOnClickListener {
      lifecycleScope.launch {
        controller.resendCode()
      }
    }

    // Sign-out and Open log moved into the toolbar overflow menu — wired in
    // onOptionsItemSelected. The chat/webrtc carrier radio is hidden on
    // Android (WebRTC only) so we don't bind those listeners anymore.

    binding.start.setOnClickListener {
      val socksPort = binding.socksPort.text?.toString()?.toIntOrNull() ?: 1080
      val selected = binding.chatSelect.selectedItem as? ChatOption
      if (selected == null) {
        render(uiState.copy(lastError = "Pick the server's Bale account"))
        return@setOnClickListener
      }
      ensureVpnPermissionAndStart(
        StartTunnelRequest(
          carrier = selectedCarrier,
          selected = selected,
          socksPort = socksPort,
        ),
      )
    }

    binding.stop.setOnClickListener {
      lifecycleScope.launch {
        controller.stopTunnel()
      }
    }

    binding.testSpeed.setOnClickListener {
      binding.testSpeed.isEnabled = false
      binding.testSpeed.text = ""
      binding.testSpeedSpinner.isVisible = true
      binding.speedResult.isVisible = false
      lifecycleScope.launch {
        try {
          val result = controller.speedTest()
          binding.speedLatency.text = if (result.latencyMs < 0) "N/A" else "${result.latencyMs} ms"
          binding.speedUpload.text = fmtKbps(result.uploadKbps)
          binding.speedDownload.text = fmtKbps(result.downloadKbps)
          binding.speedResult.isVisible = true
        } catch (e: Throwable) {
          render(uiState.copy(lastError = "speed test failed: ${e.message}"))
        } finally {
          binding.testSpeed.isEnabled = true
          binding.testSpeed.text = getString(R.string.test_speed)
          binding.testSpeedSpinner.isVisible = false
        }
      }
    }

    binding.sendLogs.setOnClickListener {
      binding.sendLogs.isEnabled = false
      binding.sendLogs.text = ""
      binding.sendLogsSpinner.isVisible = true
      lifecycleScope.launch {
        try {
          val result = controller.sendLogs()
          MaterialAlertDialogBuilder(this@MainActivity)
            .setTitle("Send logs")
            .setMessage(result)
            .setPositiveButton("OK", null)
            .show()
        } catch (e: Throwable) {
          render(uiState.copy(lastError = "send logs failed: ${e.message}"))
        } finally {
          binding.sendLogs.isEnabled = true
          binding.sendLogs.text = getString(R.string.send_logs)
          binding.sendLogsSpinner.isVisible = false
        }
      }
    }
  }

  private fun fmtKbps(kbps: Int): String {
    return if (kbps >= 1024) "${"%.1f".format(kbps / 1024.0)} Mbps"
    else "$kbps Kbps"
  }

  private fun syncAdapters(chats: List<ChatOption>) {
    chatAdapter.clear()
    chatAdapter.addAll(chats)
    chatAdapter.notifyDataSetChanged()
  }

  private fun render(state: ControllerState) {
    binding.errCard.isVisible = !state.lastError.isNullOrBlank()
    binding.err.text = state.lastError.orEmpty()

    binding.me.text = state.meLabel ?: getString(R.string.not_logged_in)
    invalidateOptionsMenu()

    binding.phoneStep.isVisible = state.loginStage == LoginStage.UNAUTHENTICATED
    binding.codeStep.isVisible = state.loginStage == LoginStage.AWAITING_CODE
    binding.passwordStep.isVisible = state.loginStage == LoginStage.AWAITING_PASSWORD
    val connecting = state.connectingEvents != null
    binding.picker.isVisible = state.loginStage == LoginStage.READY && state.tunnel == null && !connecting
    binding.connectingCard.isVisible = connecting
    binding.connected.isVisible = state.tunnel != null

    if (connecting) {
      binding.connectingEvents.text = state.connectingEvents?.joinToString("\n").orEmpty()
    }

    binding.codePhoneDisplay.text = state.pendingPhone ?: "-"
    binding.pwPhoneDisplay.text = state.pendingPhone ?: "-"

    // Carrier is always WebRTC on Android (chat carrier hidden in v0.2 layout).
    selectedCarrier = Carrier.WEBRTC
    binding.carrierWebrtc.isChecked = true

    val busy = state.busy
    binding.sendCode.isEnabled = !busy
    binding.verifyCode.isEnabled = !busy
    binding.verifyPassword.isEnabled = !busy
    binding.start.isEnabled = !busy
    binding.stop.isEnabled = !busy

    val tunnel = state.tunnel
    if (tunnel != null) {
      binding.kServer.text = tunnel.serverLabel
      binding.kSocks.text = "127.0.0.1:${tunnel.socksPort}"
      binding.kStreams.text = "${tunnel.streamsActive} / ${tunnel.streamsOpened}"
      binding.kUp.text = Formatter.formatShortFileSize(this, tunnel.bytesUp)
      binding.kDown.text = Formatter.formatShortFileSize(this, tunnel.bytesDown)
      binding.kSince.text = formatDuration(System.currentTimeMillis() - tunnel.startedAt)
      binding.socksHint.text = "127.0.0.1:${tunnel.socksPort}"
    }
  }

  private fun parseAutoStartConfig(): AutoStartConfig? {
    val extras = intent.extras ?: return null
    if (
      !extras.containsKey("wt_autostart")
      && !extras.containsKey("wt_carrier")
      && !extras.containsKey("wt_peer_label")
      && !extras.containsKey("wt_peer_id")
      && !extras.containsKey("wt_socks_port")
    ) {
      return null
    }
    val autoStart = intent.getBooleanExtra("wt_autostart", false)
    val carrier = when (intent.getStringExtra("wt_carrier")?.trim()?.lowercase()) {
      "webrtc", "livekit" -> Carrier.WEBRTC
      else -> Carrier.WEBRTC
    }
    val peerLabel = intent.getStringExtra("wt_peer_label")?.trim()?.takeIf { it.isNotEmpty() }
    val peerId = intent.extras?.let { bundle ->
      if (bundle.containsKey("wt_peer_id")) bundle.getLong("wt_peer_id") else null
    }
    val socksPort = intent.getIntExtra("wt_socks_port", 1080)
    return AutoStartConfig(
      enabled = autoStart,
      carrier = carrier,
      peerLabel = peerLabel,
      peerId = peerId,
      socksPort = socksPort,
    )
  }

  private fun maybeApplyAutoStart(state: ControllerState) {
    val config = autoStartConfig ?: return
    if (autoStartConsumed) return
    if (state.loginStage != LoginStage.READY || state.tunnel != null || state.chats.isEmpty()) return
    if (state.busy) return

    selectedCarrier = config.carrier
    render(state)

    val selectedIndex = state.chats.indexOfFirst { chat ->
      when {
        config.peerId != null -> chat.chatId == config.peerId
        config.peerLabel != null -> {
          val wanted = config.peerLabel.trim()
          chat.label == wanted || chat.label.contains(wanted, ignoreCase = false)
        }
        else -> true
      }
    }
    if (selectedIndex < 0) {
      autoStartConsumed = true
      render(state.copy(lastError = "Auto-start peer not found"))
      return
    }

    binding.chatSelect.setSelection(selectedIndex, false)
    binding.socksPort.setText(config.socksPort.toString())

    if (!config.enabled) {
      autoStartConsumed = true
      return
    }

    autoStartConsumed = true
    binding.start.post { binding.start.performClick() }
  }

  private fun ensureVpnPermissionAndStart(request: StartTunnelRequest) {
    pendingVpnProbe = null
    pendingTunnelRequest = request
    val intent = VpnService.prepare(this)
    if (intent != null) {
      vpnPermissionLauncher.launch(intent)
    } else {
      launchTunnelStart(request)
    }
  }

  private fun launchTunnelStart(request: StartTunnelRequest) {
    pendingTunnelRequest = null
    lifecycleScope.launch {
      try {
        val newState = controller.startTunnel(
          carrier = request.carrier,
          selected = request.selected,
          socksPort = request.socksPort,
        )
        val tunnel = newState.tunnel ?: return@launch
        try {
          TunnelVpnBridge.start(
            applicationContext,
            TunnelVpnConfig(
              sessionLabel = "Web Tunnel ${tunnel.serverLabel}",
              socksPort = tunnel.socksPort,
            ),
          )
          TunnelForegroundService.start(applicationContext, tunnel.serverLabel)
        } catch (error: Throwable) {
          controller.stopTunnel()
          render(uiState.copy(lastError = "start VPN failed: ${error.message}"))
        }
      } catch (error: Throwable) {
        render(uiState.copy(lastError = "start tunnel failed: ${error.message}"))
      }
    }
  }

  private fun maybeStartVpnProbe() {
    if (!intent.getBooleanExtra("wt_vpn_probe", false)) return
    val socksPort = intent.getIntExtra("wt_socks_port", 1080)
    val sessionLabel = intent.getStringExtra("wt_vpn_label")?.takeIf { it.isNotBlank() }
      ?: "Web Tunnel VPN Probe"
    pendingTunnelRequest = null
    pendingVpnProbe = VpnProbeConfig(
      sessionLabel = sessionLabel,
      socksPort = socksPort,
    )
    val prepareIntent = VpnService.prepare(this)
    if (prepareIntent != null) {
      vpnPermissionLauncher.launch(prepareIntent)
    } else {
      val config = pendingVpnProbe ?: return
      pendingVpnProbe = null
      startVpnProbe(config)
    }
  }

  private fun startVpnProbe(config: VpnProbeConfig) {
    try {
      TunnelVpnBridge.start(
        applicationContext,
        TunnelVpnConfig(
          sessionLabel = config.sessionLabel,
          socksPort = config.socksPort,
        ),
      )
      render(uiState.copy(lastError = null))
    } catch (error: Throwable) {
      render(uiState.copy(lastError = "start VPN failed: ${error.message}"))
    }
  }

  private fun formatDuration(ms: Long): String {
    val seconds = (ms / 1_000).coerceAtLeast(0)
    if (seconds < 60) return "${seconds}s"
    if (seconds < 3_600) return "${seconds / 60}m${seconds % 60}s"
    return "${seconds / 3_600}h${(seconds % 3_600) / 60}m"
  }
}

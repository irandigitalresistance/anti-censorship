package ai.webtunnel.mobile

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
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
  val peerLabel: String?,
  val peerId: Long?,
  val socksPort: Int,
)

private data class StartTunnelRequest(
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
    supportActionBar?.title = "NovaNet ${BuildConfig.VERSION_NAME}"

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
        // The bootstrap path sets loginStage=READY asynchronously after a fresh
        // process — at onResume time it's still UNAUTHENTICATED, so the resume
        // call below skips. Re-check here every time state changes so the
        // recovery fires once the controller is actually ready.
        maybeRecoverGhostVpn(state)
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

  override fun onResume() {
    super.onResume()
    // The controller lives in the application scope, so it survives Activity
    // recreation and even some forms of process kill (when the foreground service
    // keeps the main process alive). Pull the live state on every resume so the
    // UI accurately reflects whether the tunnel is still up.
    val live = controller.currentState()
    uiState = live
    syncAdapters(live.chats)
    render(live)
    maybeRecoverGhostVpn(live)
  }

  /**
   * Detect and recover from a "ghost VPN" — the :vpn process kept the TUN
   * alive after the main process was killed by Android (Doze, OEM background
   * killer, low memory). Symptom: VPN icon stays in the status bar but no
   * traffic flows because the SOCKS5 server (in the main process) is gone,
   * and reopening the app shows the Start-tunnel page even though the
   * system thinks a VPN is connected.
   *
   * When detected, attempt to auto-reconnect to the last known target. If the
   * target is missing or the reconnect fails, stop the stale VPN cleanly so
   * the user sees a clean Start-tunnel page and a clear error.
   */
  private var ghostRecoveryAttempted = false

  private fun maybeRecoverGhostVpn(state: ControllerState) {
    if (ghostRecoveryAttempted) return
    if (state.tunnel != null) return
    if (state.connectingEvents != null) return // already reconnecting
    if (state.loginStage != LoginStage.READY) return
    if (!isOurVpnServiceAlive()) return
    ghostRecoveryAttempted = true
    val saved = controller.loadLastTunnelTarget()
    if (saved == null) {
      // VPN is up but we don't know what to reconnect to — stop it so the
      // user gets a clean state.
      TunnelVpnBridge.stop(applicationContext)
      TunnelForegroundService.stop(applicationContext)
      render(state.copy(lastError = "VPN was running without a saved target — stopped. Tap Start tunnel to reconnect."))
      return
    }
    // Stop the stale TUN and immediately re-establish via the normal start
    // flow. The VPN consent prompt has already been granted in this session
    // (the system remembers per-app), so this is silent.
    TunnelVpnBridge.stop(applicationContext)
    TunnelForegroundService.stop(applicationContext)
    val matching = state.chats.firstOrNull {
      it.chatId == saved.chatId && it.chatType == saved.chatType
    } ?: ChatOption(label = saved.label, chatId = saved.chatId, chatType = saved.chatType)
    render(state.copy(connectingEvents = listOf("Reconnecting tunnel to ${matching.label} after process restart…")))
    ensureVpnPermissionAndStart(
      StartTunnelRequest(selected = matching, socksPort = saved.socksPort),
    )
  }

  private fun isOurVpnServiceAlive(): Boolean {
    return try {
      val mgr = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      // getRunningServices is intentionally restricted on modern Android to
      // only return the caller's own services — which is exactly what we want.
      @Suppress("DEPRECATION")
      mgr.getRunningServices(Int.MAX_VALUE).any {
        it.service.className == "hev.sockstun.TProxyService"
      }
    } catch (_: Throwable) {
      false
    }
  }

  private fun maybeRequestBatteryOptimizationExemption() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    if (pm.isIgnoringBatteryOptimizations(packageName)) return
    try {
      @Suppress("BatteryLife")
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        .setData(Uri.parse("package:$packageName"))
      startActivity(intent)
    } catch (_: Throwable) {
      // some OEMs hide this — fall back to a no-op; user can still grant
      // manually via Settings.
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
    binding.importConfig.setOnClickListener {
      val config = binding.clientConfig.text?.toString()?.trim().orEmpty()
      if (config.isBlank()) {
        render(uiState.copy(lastError = "Paste a client config"))
        return@setOnClickListener
      }
      lifecycleScope.launch {
        controller.importClientConfig(config)
        binding.clientConfig.setText("")
      }
    }

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
    // onOptionsItemSelected.

    binding.start.setOnClickListener {
      val socksPort = binding.socksPort.text?.toString()?.toIntOrNull() ?: 1080
      val selected = binding.chatSelect.selectedItem as? ChatOption
      if (selected == null) {
        render(uiState.copy(lastError = "Import a client config first"))
        return@setOnClickListener
      }
      ensureVpnPermissionAndStart(
        StartTunnelRequest(
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
    if (kbps < 0) return "n/a"
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

    binding.me.text = state.configClient?.let { "Server UUID: ${it.serverUuid}" }
      ?: state.meLabel
      ?: getString(R.string.not_logged_in)
    invalidateOptionsMenu()

    binding.configStep.isVisible = state.loginStage == LoginStage.UNAUTHENTICATED
    binding.phoneStep.isVisible = false
    binding.codeStep.isVisible = false
    binding.passwordStep.isVisible = false
    val connecting = state.connectingEvents != null
    binding.picker.isVisible = state.loginStage == LoginStage.READY && state.tunnel == null && !connecting
    binding.connectingCard.isVisible = connecting
    binding.connected.isVisible = state.tunnel != null

    if (connecting) {
      binding.connectingEvents.text = state.connectingEvents?.joinToString("\n").orEmpty()
    }

    binding.codePhoneDisplay.text = state.pendingPhone ?: "-"
    binding.pwPhoneDisplay.text = state.pendingPhone ?: "-"

    val busy = state.busy
    binding.sendCode.isEnabled = !busy
    binding.importConfig.isEnabled = !busy
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
      && !extras.containsKey("wt_peer_label")
      && !extras.containsKey("wt_peer_id")
      && !extras.containsKey("wt_socks_port")
    ) {
      return null
    }
    val autoStart = intent.getBooleanExtra("wt_autostart", false)
    val peerLabel = intent.getStringExtra("wt_peer_label")?.trim()?.takeIf { it.isNotEmpty() }
    val peerId = intent.extras?.let { bundle ->
      if (bundle.containsKey("wt_peer_id")) bundle.getLong("wt_peer_id") else null
    }
    val socksPort = intent.getIntExtra("wt_socks_port", 1080)
    return AutoStartConfig(
      enabled = autoStart,
      peerLabel = peerLabel,
      peerId = peerId,
      socksPort = socksPort,
    )
  }

  private fun maybeApplyAutoStart(state: ControllerState) {
    val config = autoStartConfig ?: return
    if (autoStartConsumed) return
    if (state.loginStage != LoginStage.READY || state.tunnel != null || state.connectingEvents != null || state.chats.isEmpty()) return
    if (state.busy) return

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
    // Best-effort battery-optimization exemption prompt. Doesn't block the start
    // flow — the system shows its own dialog and we proceed regardless of the
    // user's choice. The exemption matters most on Samsung/Xiaomi/Huawei where
    // the OEM background killer is more aggressive than stock Android.
    maybeRequestBatteryOptimizationExemption()
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
          selected = request.selected,
          socksPort = request.socksPort,
        )
        if (newState.tunnel == null && newState.connectingEvents == null) {
          render(newState)
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
      ?: "NovaNet VPN Probe"
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

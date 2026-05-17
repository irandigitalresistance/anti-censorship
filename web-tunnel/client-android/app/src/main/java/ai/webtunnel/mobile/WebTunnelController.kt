package ai.webtunnel.mobile

import android.content.Context
import android.os.SystemClock
import android.util.Log
import io.livekit.android.room.Room
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

enum class LoginStage {
  UNAUTHENTICATED,
  AWAITING_CODE,
  AWAITING_PASSWORD,
  READY,
}

data class ChatOption(
  val label: String,
  val chatId: Long,
  val chatType: String,
) {
  override fun toString(): String = label
}

data class TunnelStatus(
  val serverLabel: String,
  val socksPort: Int,
  val startedAt: Long,
  val bytesUp: Long = 0,
  val bytesDown: Long = 0,
  val streamsOpened: Int = 0,
  val streamsActive: Int = 0,
)

data class ClientConfigSummary(
  val clientId: String,
  val serverUuid: String,
)

data class SpeedTestResult(
  val latencyMs: Long,
  val uploadKbps: Int,
  val downloadKbps: Int,
)

private data class TunnelMetrics(
  val bytesUp: Long = 0,
  val bytesDown: Long = 0,
  val streamsOpened: Int = 0,
  val streamsActive: Int = 0,
)

private class TunnelCounters {
  private val bytesUp = AtomicLong(0)
  private val bytesDown = AtomicLong(0)
  private val streamsOpened = AtomicInteger(0)
  private val streamsActive = AtomicInteger(0)

  fun addUpload(count: Int) {
    bytesUp.addAndGet(count.toLong())
  }

  fun addDownload(count: Int) {
    bytesDown.addAndGet(count.toLong())
  }

  fun streamOpened() {
    streamsOpened.incrementAndGet()
    streamsActive.incrementAndGet()
  }

  fun streamClosed() {
    while (true) {
      val current = streamsActive.get()
      if (current <= 0) return
      if (streamsActive.compareAndSet(current, current - 1)) return
    }
  }

  fun snapshot(): TunnelMetrics =
    TunnelMetrics(
      bytesUp = bytesUp.get(),
      bytesDown = bytesDown.get(),
      streamsOpened = streamsOpened.get(),
      streamsActive = streamsActive.get(),
    )
}

data class ControllerState(
  val loginStage: LoginStage = LoginStage.UNAUTHENTICATED,
  val pendingPhone: String? = null,
  val meLabel: String? = null,
  val configClient: ClientConfigSummary? = null,
  val chats: List<ChatOption> = emptyList(),
  val tunnel: TunnelStatus? = null,
  val lastError: String? = null,
  val busy: Boolean = false,
  val connectingEvents: List<String>? = null,
  /** "idle" | "reconnecting" — drives the cancel button label. */
  val retryState: String = "idle",
  val retryAttempt: Int = 0,
)

private data class TunnelRuntime(
  val callId: Long,
  val room: io.livekit.android.room.Room,
  val transport: LiveKitTransport,
  val mux: TunnelMuxV2,
  val socksServer: Socks5Server,
  val meetRepeatsJob: Job?,
  val metricsJob: Job?,
  val closeJob: Job?,
)

private const val MAGIC_MEET_OFFER = "__WT_MEET__"
private const val V2_HANDSHAKE_TIMEOUT_MS = 12_000L
private const val CONNECTING_EVENT_LIMIT = 80

class WebTunnelController(
  private val context: Context,
  private val scope: CoroutineScope,
) {
  private val appContext = context.applicationContext
  private val sessionStore = SessionStore(appContext)
  private val baleClient = BaleClient()
  private val logs = ArrayDeque<String>()
  private var managedConfig: ClientConfigPayload? = null

  private var pendingTransactionHash: String? = null
  private var runtime: TunnelRuntime? = null
  private var state: ControllerState = ControllerState()
  private var bootstrapped = false

  // Reconnect bookkeeping. lastStartParams remembers what the user asked for
  // so we can re-issue startTunnel after a drop. userCancelled stops the loop
  // when the user taps Stop.
  private data class StartParams(
    val selected: ChatOption,
    val socksPort: Int,
  )
  private var lastStartParams: StartParams? = null
  @Volatile private var userCancelled = false
  private var reconnectJob: Job? = null
  /** True while the current `startTunnel` call was initiated from the reconnect loop. */
  @Volatile private var insideReconnect = false
  private val startMutex = Mutex()

  var onStateChanged: ((ControllerState) -> Unit)? = null

  fun currentState(): ControllerState = snapshot()

  suspend fun bootstrap(): ControllerState {
    if (bootstrapped) return snapshot()
    bootstrapped = true
    setBusy(true)
    val rawConfig = withContext(Dispatchers.IO) { sessionStore.loadClientConfig() }
    var loadError: String? = null
    if (!rawConfig.isNullOrBlank()) {
      try {
        applyClientConfig(decodeClientConfig(rawConfig))
        setBusy(false)
        return snapshot()
      } catch (error: Throwable) {
        loadError = "load client config failed: ${error.message}"
      }
    }
    state = ControllerState(lastError = loadError)
    setBusy(false)
    return snapshot()
  }

  suspend fun importClientConfig(rawConfig: String): ControllerState {
    setBusy(true)
    clearError()
    return try {
      val payload = decodeClientConfig(rawConfig)
      withContext(Dispatchers.IO) { sessionStore.saveClientConfig(rawConfig.trim()) }
      applyClientConfig(payload)
      logLine("client config imported for server ${payload.serverUuid}")
      snapshot()
    } catch (error: Throwable) {
      state = state.copy(lastError = "import config failed: ${error.message}")
      snapshot()
    } finally {
      setBusy(false)
    }
  }

  private fun applyClientConfig(payload: ClientConfigPayload) {
    managedConfig = payload
    baleClient.loadSession(payload.baleSession)
    val server = ChatOption(
      label = payload.serverUuid,
      chatId = payload.serverPeer.chatId,
      chatType = payload.serverPeer.chatType,
    )
    state = state.copy(
      loginStage = LoginStage.READY,
      pendingPhone = null,
      meLabel = "Server UUID: ${payload.serverUuid}",
      configClient = ClientConfigSummary(
        clientId = payload.clientId,
        serverUuid = payload.serverUuid,
      ),
      chats = listOf(server),
      lastError = null,
    )
    pendingTransactionHash = null
    emit()
  }

  suspend fun sendPhoneCode(phone: String): ControllerState {
    setBusy(true)
    clearError()
    return try {
      val response = baleClient.startPhoneAuth(phone)
      pendingTransactionHash = response.transactionHash
      state = state.copy(
        loginStage = LoginStage.AWAITING_CODE,
        pendingPhone = phone,
        lastError = null,
      )
      logLine("OTP requested for $phone")
      snapshot()
    } catch (error: Throwable) {
      state = state.copy(lastError = "send code failed: ${error.message}")
      snapshot()
    } finally {
      setBusy(false)
    }
  }

  suspend fun resendCode(): ControllerState {
    val phone = state.pendingPhone ?: throw IllegalStateException("no pending phone")
    return sendPhoneCode(phone)
  }

  fun backToPhone(): ControllerState {
    pendingTransactionHash = null
    state = state.copy(
      loginStage = LoginStage.UNAUTHENTICATED,
      lastError = null,
      busy = false,
    )
    emit()
    return snapshot()
  }

  fun backToCode(): ControllerState {
    state = state.copy(
      loginStage = LoginStage.AWAITING_CODE,
      lastError = null,
      busy = false,
    )
    emit()
    return snapshot()
  }

  suspend fun verifyCode(code: String): ControllerState {
    val tx = pendingTransactionHash ?: throw IllegalStateException("no pending login transaction")
    setBusy(true)
    clearError()
    return try {
      val session = baleClient.validateCode(code, tx)
      onAuthenticated(session)
      snapshot()
    } catch (_: PasswordNeededException) {
      state = state.copy(loginStage = LoginStage.AWAITING_PASSWORD, lastError = null)
      snapshot()
    } catch (_: WrongCodeException) {
      state = state.copy(lastError = "wrong code")
      snapshot()
    } catch (_: SignUpNeededException) {
      state = state.copy(lastError = "account not registered on Bale yet")
      snapshot()
    } catch (error: Throwable) {
      state = state.copy(lastError = "verify code failed: ${error.message}")
      snapshot()
    } finally {
      setBusy(false)
    }
  }

  suspend fun verifyPassword(password: String): ControllerState {
    val tx = pendingTransactionHash ?: throw IllegalStateException("no pending login transaction")
    setBusy(true)
    clearError()
    return try {
      val session = baleClient.validatePassword(password, tx)
      onAuthenticated(session)
      snapshot()
    } catch (_: WrongPasswordException) {
      state = state.copy(lastError = "wrong 2FA password")
      snapshot()
    } catch (error: Throwable) {
      state = state.copy(lastError = "verify password failed: ${error.message}")
      snapshot()
    } finally {
      setBusy(false)
    }
  }

  suspend fun signOut(): ControllerState {
    stopTunnel()
    sessionStore.clear()
    sessionStore.clearClientConfig()
    managedConfig = null
    pendingTransactionHash = null
    state = ControllerState()
    emit()
    return snapshot()
  }

  suspend fun startTunnel(
    selected: ChatOption,
    socksPort: Int,
  ): ControllerState = startMutex.withLock {
    startTunnelLocked(selected, socksPort)
  }

  @Suppress("UNUSED_PARAMETER")
  private suspend fun startTunnelLocked(
    selected: ChatOption,
    socksPort: Int,
  ): ControllerState {
    val config = managedConfig
    if (config == null) {
      state = state.copy(lastError = "import a client config first")
      emit()
      return snapshot()
    }
    val effectiveSelected = ChatOption(
      label = config.serverUuid,
      chatId = config.serverPeer.chatId,
      chatType = config.serverPeer.chatType,
    )
    if (state.loginStage != LoginStage.READY) {
      state = state.copy(lastError = "not authenticated")
      emit()
      return snapshot()
    }
    if (runtime != null) {
      if (insideReconnect) {
        if (state.tunnel != null) {
          logLine("reconnect skipped; tunnel already active")
          state = state.copy(
            connectingEvents = null,
            busy = false,
            lastError = null,
            retryState = "idle",
            retryAttempt = 0,
          )
          emit()
          return snapshot()
        }
        logLine("reconnect replacing stale runtime")
        tearDownRuntime("reconnect replacing stale runtime")
      } else {
        state = state.copy(lastError = "tunnel already running")
        emit()
        return snapshot()
      }
    }

    lastStartParams = StartParams(effectiveSelected, socksPort)
    if (!insideReconnect) {
      userCancelled = false
      reconnectJob?.cancel()
      reconnectJob = null
    }
    state = state.copy(
      tunnel = null,
      connectingEvents = if (insideReconnect) (state.connectingEvents ?: emptyList()) else emptyList(),
      busy = true,
      lastError = null,
      retryState = if (insideReconnect) state.retryState else "idle",
      retryAttempt = if (insideReconnect) state.retryAttempt else 0,
    )
    emit()
    logLine("starting WebRTC tunnel to ${effectiveSelected.label} on SOCKS $socksPort")

    var room: io.livekit.android.room.Room? = null
    var transport: LiveKitTransport? = null
    var socks: Socks5Server? = null
    var meetRepeatsJob: Job? = null
    var callId: Long? = null
    var startupMuxClosedReason: String? = null
    var tunnelMarkedReady = false

    try {
      ensureStartNotCancelled()
      val peer = BalePeer(
        type = if (effectiveSelected.chatType == "PRIVATE") BalePeerType.PRIVATE else BalePeerType.GROUP,
        id = effectiveSelected.chatId,
      )
      val keyId = serverKeyId(effectiveSelected)
      pushConnectingEvent("Initiating Bale Meet call...")
      val call = baleClient.startCall(peer)
      callId = call.callId
      logLine("Meet.StartCall OK callId=${call.callId} room=${call.roomUuid}")
      sendMeetOffer(peer, call.callId)
      meetRepeatsJob = scheduleMeetOfferRepeats(peer, call.callId)
      ensureStartNotCancelled()
      pushConnectingEvent("Connecting to LiveKit room...")
      room = connectLiveKitRoom(appContext, baleClient.liveKitUrlFor(call))
      logLine("LiveKit connect OK local=${room.localParticipant.identity?.value ?: "unknown"}")
      ensureStartNotCancelled()
      val peerIdentity = awaitRemoteParticipant(
        room,
        timeoutMs = if (insideReconnect) 8_000 else 15_000,
      )
      if (peerIdentity != null) logLine("LiveKit peer connected identity=$peerIdentity")
      else logLine("LiveKit peer not visible yet; continuing without identity lock")
      transport = LiveKitTransport(room = room, scope = scope, peerIdentity = peerIdentity)
      pushConnectingEvent("Transport ready, starting v2 handshake...")
      val run = try {
        withTimeout(V2_HANDSHAKE_TIMEOUT_MS) {
          runClientTunnelV2(
            transport,
            mapOf(
            "clientType" to "android",
            "clientVersion" to BuildConfig.VERSION_NAME,
            "webTunnelClientId" to managedConfig?.clientId,
            "webTunnelConfigVersion" to if (managedConfig != null) 1 else null,
          ),
          )
        }
      } catch (_: TimeoutCancellationException) {
        throw IllegalStateException("server did not respond in time — check that the server is running")
      }
      meetRepeatsJob.cancel()
      meetRepeatsJob = null
      ensureStartNotCancelled()
      assertServerIdentityTrusted(keyId, run.serverFingerprint)
      pushConnectingEvent("Handshake complete. Starting SOCKS5...")
      val mux = run.mux
      mux.onClose { reason ->
        if (!tunnelMarkedReady && startupMuxClosedReason == null) {
          startupMuxClosedReason = reason
        }
        logLine("tunnel closed: $reason")
        if (reason == "user stop") return@onClose
        scope.launch(Dispatchers.IO) {
          val wasReady = tunnelMarkedReady
          if (runtime?.callId != call.callId) {
            logLine("ignoring close for stale call ${call.callId}: $reason")
            return@launch
          }
          tearDownRuntime("tunnel dropped")
          state = state.copy(
            tunnel = null,
            busy = false,
            lastError = "tunnel closed: $reason",
          )
          emit()
          // Recover until the user explicitly stops. Early drops after a
          // successful handshake are still recoverable and should not leave the
          // UI showing a stale active tunnel.
          if (!userCancelled && lastStartParams != null && isRecoverableTunnelFailure(reason)) {
            scheduleReconnect(reason)
          } else if (!wasReady) {
            stopLocalVpnServices()
          }
        }
      }
      logLine("tunnel v2 handshake OK serverFp=${run.serverFingerprint}")
      if (startupMuxClosedReason != null) {
        throw IllegalStateException("MUX_CLOSED_DURING_START:$startupMuxClosedReason")
      }
      val counters = TunnelCounters()
      socks = Socks5Server(
        scope = scope,
        requestedPort = socksPort,
        mux = mux,
        udpMux = mux,
        onConnect = { addr -> logLine("SOCKS open ${addr.kind}:${addr.host}:${addr.port}") },
        onStreamOpened = {
          counters.streamOpened()
        },
        onStreamClosed = {
          counters.streamClosed()
        },
        onUpload = { _, count ->
          counters.addUpload(count)
        },
        onDownload = { _, count ->
          counters.addDownload(count)
        },
        onError = { error ->
          logLine("SOCKS error: ${error.message}")
          val message = error.message.orEmpty()
          if (message.contains("mux closed", ignoreCase = true)) {
            scope.launch(Dispatchers.IO) {
              if (runtime?.callId != call.callId) {
                logLine("ignoring SOCKS mux close for stale call ${call.callId}: $message")
                return@launch
              }
              tearDownRuntime("mux closed")
              state = state.copy(
                tunnel = null,
                busy = false,
                lastError = "tunnel closed: mux closed",
              )
              emit()
              if (!userCancelled && lastStartParams != null) {
                scheduleReconnect("mux closed")
              }
            }
          }
        },
        onEvent = { line -> logLine(line) },
      )
      val boundPort = socks.start()
      if (startupMuxClosedReason != null) {
        throw IllegalStateException("MUX_CLOSED_DURING_START:$startupMuxClosedReason")
      }
      ensureStartNotCancelled()
      tunnelMarkedReady = true
      val metricsJob = scope.launch {
        while (true) {
          delay(1_000)
          publishTunnelMetrics(call.callId, counters.snapshot())
        }
      }
      runtime = TunnelRuntime(
        callId = call.callId,
        room = room,
        transport = transport,
        mux = mux,
        socksServer = socks,
        meetRepeatsJob = meetRepeatsJob,
        metricsJob = metricsJob,
        closeJob = null,
      )
      // Persist the active target so onResume after a process kill can detect
      // a ghost VPN and either auto-reconnect or stop the stale TUN cleanly.
      try {
        sessionStore.saveLastTunnelTarget(
          LastTunnelTarget(
            chatId = effectiveSelected.chatId,
            chatType = effectiveSelected.chatType,
            label = effectiveSelected.label,
            socksPort = boundPort,
          ),
        )
      } catch (_: Throwable) { /* best effort */ }
      val initialMetrics = counters.snapshot()
      val tunnelStatus = TunnelStatus(
        serverLabel = effectiveSelected.label,
        socksPort = boundPort,
        startedAt = System.currentTimeMillis(),
        bytesUp = initialMetrics.bytesUp,
        bytesDown = initialMetrics.bytesDown,
        streamsOpened = initialMetrics.streamsOpened,
        streamsActive = initialMetrics.streamsActive,
      )
      startLocalVpnServices(tunnelStatus)
      state = state.copy(
        connectingEvents = null,
        tunnel = tunnelStatus,
        lastError = null,
      )
      emit()
      return snapshot()
    } catch (error: Throwable) {
      logLine("startTunnel failed: ${error.message}")
      val cancelledByUser = userCancelled || error is CancellationException
      val detail = error.message ?: "unknown"
      val display = when {
        cancelledByUser -> null
        detail.contains("CONFIG_ALREADY_CONNECTED") ->
          "This client config is already connected on another device"
        detail.contains("CONFIG_REQUIRED") ->
          "Import a client config first"
        detail.contains("CONFIG_UNKNOWN_CLIENT") ->
          "This client config is not registered on the server"
        detail.startsWith("MUX_CLOSED_DURING_START:") -> "tunnel closed before startup completed"
        detail.contains("SERVER_KEY_MISMATCH") ->
          "Server identity changed — use Reset pins to reconnect to a reinstalled server"
        else -> detail
      }
      val recoverable = !cancelledByUser && isRecoverableTunnelFailure(detail)
      state = if (cancelledByUser) {
        state.copy(
          tunnel = null,
          connectingEvents = null,
          lastError = null,
          retryState = "idle",
          retryAttempt = 0,
        )
      } else if (insideReconnect) {
        state.copy(
          tunnel = null,
          connectingEvents = appendConnectingEvent("Reconnect failed: ${display ?: detail}"),
          lastError = "reconnect failed: ${display ?: detail}",
          retryState = "reconnecting",
        )
      } else {
        state.copy(
          tunnel = null,
          connectingEvents = if (recoverable) appendConnectingEvent("Start failed; retrying: ${display ?: detail}") else null,
          lastError = "start tunnel failed: ${display ?: detail}",
        )
      }
      try {
        meetRepeatsJob?.cancel()
      } catch (_: Throwable) {
        Unit
      }
      try {
        socks?.stop()
      } catch (_: Throwable) {
        Unit
      }
      try {
        transport?.close("startup failed")
      } catch (_: Throwable) {
        Unit
      }
      try {
        room?.disconnect()
      } catch (_: Throwable) {
        Unit
      }
      try {
        if (callId != null) discardCallAsync(callId)
      } catch (_: Throwable) {
        Unit
      }
      emit()
      if (!insideReconnect && recoverable && !userCancelled && lastStartParams != null) {
        scheduleReconnect(display ?: detail)
      }
      return snapshot()
    } finally {
      setBusy(false)
    }
  }

  suspend fun stopTunnel(): ControllerState {
    userCancelled = true
    reconnectJob?.cancel()
    reconnectJob = null
    lastStartParams = null
    tearDownRuntime("user stop")
    stopLocalVpnServices()
    try { sessionStore.clearLastTunnelTarget() } catch (_: Throwable) {}
    state = state.copy(
      tunnel = null,
      connectingEvents = null,
      busy = false,
      lastError = null,
      retryState = "idle",
      retryAttempt = 0,
    )
    emit()
    return snapshot()
  }

  /**
   * Returns the chat target that was active at the time of the last successful
   * tunnel start, or null if the user has explicitly stopped or never started.
   * Used by MainActivity to recover from a "ghost VPN" — when the main process
   * was killed but the :vpn process kept the TUN alive, leaving the device with
   * a connected-looking VPN that drops every packet because the SOCKS5 server
   * (in the main process) is gone.
   */
  fun loadLastTunnelTarget(): LastTunnelTarget? = sessionStore.loadLastTunnelTarget()

  /** Drops the saved target without touching any running services. */
  fun clearLastTunnelTarget() { sessionStore.clearLastTunnelTarget() }

  private suspend fun tearDownRuntime(reason: String) {
    val current = runtime
    runtime = null
    if (current != null) {
      try { current.socksServer.stop() } catch (_: Throwable) {}
      try { current.meetRepeatsJob?.cancel() } catch (_: Throwable) {}
      try { current.metricsJob?.cancel() } catch (_: Throwable) {}
      try { current.mux.close(reason) } catch (_: Throwable) {}
      try { current.transport.close(reason) } catch (_: Throwable) {}
      try { current.room.disconnect() } catch (_: Throwable) {}
      discardCallAsync(current.callId)
      try { current.closeJob?.cancel() } catch (_: Throwable) {}
    }
  }

  private fun discardCallAsync(callId: Long) {
    scope.launch(Dispatchers.IO) {
      try { baleClient.discardCall(callId) } catch (_: Throwable) {}
    }
  }

  @Synchronized
  private fun scheduleReconnect(reason: String) {
    val params = lastStartParams ?: return
    if (userCancelled) return
    if (runtime != null && state.tunnel != null) {
      logLine("skip reconnect after $reason; tunnel already active")
      return
    }
    if (reconnectJob?.isActive == true) {
      logLine("reconnect already running; latest reason=$reason")
      return
    }
    val job = scope.launch(Dispatchers.IO) {
      var attempt = 0
      try { TunnelForegroundService.reconnecting(appContext, params.selected.label) } catch (e: Throwable) {
        logLine("foreground reconnect notification failed: ${e.message}")
      }
      state = state.copy(
        tunnel = null,
        busy = false,
        connectingEvents = listOf("Tunnel dropped ($reason); reconnecting…"),
        retryState = "reconnecting",
        retryAttempt = 0,
      )
      emit()
      while (!userCancelled) {
        if (runtime != null && state.tunnel != null) {
          state = state.copy(connectingEvents = null, retryState = "idle", retryAttempt = 0)
          emit()
          return@launch
        }
        attempt += 1
        val backoff = when (attempt) {
          1 -> 250L
          2 -> 1_000L
          else -> minOf(8_000L, 1_000L * (1L shl minOf(attempt - 2, 3)))
        }
        val jitter = (Math.random() * 500).toLong()
        val delayMs = backoff + jitter
        logLine("reconnect attempt $attempt scheduled in ${delayMs}ms after $reason")
        state = state.copy(
          retryState = "reconnecting",
          retryAttempt = attempt,
          connectingEvents = (state.connectingEvents ?: emptyList()) + "Reconnect attempt $attempt in ${delayMs / 1000}s…",
        )
        emit()
        try { delay(delayMs) } catch (_: Throwable) { return@launch }
        if (userCancelled) return@launch
        if (runtime != null && state.tunnel != null) {
          state = state.copy(connectingEvents = null, retryState = "idle", retryAttempt = 0)
          emit()
          return@launch
        }
        try {
          logLine("reconnecting attempt $attempt")
          state = state.copy(
            connectingEvents = (state.connectingEvents ?: emptyList()) + "Reconnecting (attempt $attempt)…",
          )
          emit()
          insideReconnect = true
          try {
            startTunnel(params.selected, params.socksPort)
          } finally {
            insideReconnect = false
          }
          if (state.tunnel != null) {
            state = state.copy(retryState = "idle", retryAttempt = 0)
            emit()
            return@launch
          }
        } catch (e: Throwable) {
          insideReconnect = false
          state = state.copy(lastError = "reconnect $attempt failed: ${e.message}")
          emit()
        }
      }
      state = state.copy(retryState = "idle", retryAttempt = 0)
      emit()
    }
    reconnectJob = job
    job.invokeOnCompletion {
      synchronized(this@WebTunnelController) {
        if (reconnectJob === job) reconnectJob = null
      }
    }
  }

  private fun appendConnectingEvent(message: String): List<String> {
    val ts = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
    return ((state.connectingEvents ?: emptyList()) + "[$ts] $message")
      .takeLast(CONNECTING_EVENT_LIMIT)
  }

  private fun ensureStartNotCancelled() {
    if (userCancelled) throw CancellationException("user stop")
  }

  private fun isRecoverableTunnelFailure(message: String): Boolean {
    val permanent = listOf(
      "SERVER_KEY_MISMATCH",
      "CONFIG_UNKNOWN_CLIENT",
      "CONFIG_REQUIRED",
      "not authenticated",
      "import a client config",
    )
    return permanent.none { message.contains(it, ignoreCase = true) }
  }

  private fun startLocalVpnServices(tunnel: TunnelStatus) {
    TunnelVpnBridge.start(
      appContext,
      TunnelVpnConfig(
        sessionLabel = "Web Tunnel ${tunnel.serverLabel}",
        socksPort = tunnel.socksPort,
      ),
    )
    try {
      TunnelForegroundService.start(appContext, tunnel.serverLabel)
    } catch (e: Throwable) {
      logLine("foreground tunnel notification failed: ${e.message}")
    }
  }

  private fun stopLocalVpnServices() {
    try { TunnelVpnBridge.stop(appContext) } catch (_: Throwable) {}
    try { TunnelForegroundService.stop(appContext) } catch (_: Throwable) {}
  }

  fun logsText(): String =
    logs.joinToString(separator = "\n")

  suspend fun speedTest(): SpeedTestResult {
    val mux = runtime?.mux ?: throw IllegalStateException("not connected")

    val rtts = mutableListOf<Long>()
    repeat(3) {
      try {
        rtts += mux.measurePingRtt()
        if (rtts.size < 3) delay(200)
      } catch (_: Throwable) {}
    }
    val latencyMs = if (rtts.isEmpty()) -1L else rtts.sum() / rtts.size

    val CHUNK = 4096
    val UPLOAD_BYTES = 512 * 1024
    val chunk = ByteArray(CHUNK)

    val stream = mux.openStream(OpenAddress(kind = "domain", host = "wt-speedtest", port = 80))
    val downloadBytes = AtomicInteger(0)
    val downloadDone = CompletableDeferred<Long>()
    val dlStart = AtomicLong(0L)

    stream.onData { data ->
      dlStart.compareAndSet(0L, System.currentTimeMillis())
      downloadBytes.addAndGet(data.size)
    }
    stream.onClose {
      if (!downloadDone.isCompleted) {
        val start = dlStart.get()
        downloadDone.complete(if (start > 0L) System.currentTimeMillis() - start else 0L)
      }
    }

    val uploadStart = System.currentTimeMillis()
    var sent = 0
    while (sent < UPLOAD_BYTES) {
      val toSend = minOf(CHUNK, UPLOAD_BYTES - sent)
      stream.write(chunk.copyOf(toSend))
      sent += toSend
    }
    val uploadMs = System.currentTimeMillis() - uploadStart

    val downloadMs = withTimeout(15_000) { downloadDone.await() }
    val totalDown = downloadBytes.get()

    val uploadKbps = if (uploadMs > 0) ((sent.toLong() * 8L) / uploadMs).toInt() else 0
    val downloadKbps = if (downloadMs > 0) ((totalDown.toLong() * 8L) / downloadMs).toInt() else 0

    return SpeedTestResult(latencyMs = latencyMs, uploadKbps = uploadKbps, downloadKbps = downloadKbps)
  }

  suspend fun sendLogs(): String {
    val mux = runtime?.mux
    val pendingDir = java.io.File(appContext.filesDir, "pending-logs").apply { mkdirs() }
    val crashDir = java.io.File(appContext.filesDir, "crashes")
    val text = buildString {
      append(logsText())
      // Append any saved crash dumps so they ride along on the next upload.
      crashDir.listFiles()?.forEach { f ->
        append("\n\n----- crash: ${f.name} -----\n")
        try { append(f.readText()) } catch (_: Throwable) {}
      }
    }
    val data = text.toByteArray(Charsets.UTF_8)
    if (mux == null) {
      // No active tunnel — drop into a single rolling pending file (≤ 1 MB).
      val pending = java.io.File(pendingDir, "pending.txt")
      try {
        pending.writeText(text.takeLast(1_000_000))
      } catch (_: Throwable) {}
      return "queued (${data.size} bytes; will upload on next tunnel)"
    }
    return try {
      val stream = mux.openStream(OpenAddress(kind = "domain", host = "wt-sendlog", port = 80))
      var offset = 0
      val CHUNK = 4096
      while (offset < data.size) {
        val end = minOf(offset + CHUNK, data.size)
        stream.write(data.copyOfRange(offset, end))
        offset = end
      }
      stream.close()
      // Successful send — drop pending file and crash dumps.
      try { java.io.File(pendingDir, "pending.txt").delete() } catch (_: Throwable) {}
      try { crashDir.listFiles()?.forEach { it.delete() } } catch (_: Throwable) {}
      "sent ${data.size} bytes"
    } catch (e: Throwable) {
      "send logs failed: ${e.message}"
    }
  }

  /** Cap the in-memory log buffer at ~5 KB lines (~5 MB upper bound). */
  private fun trimLogs() {
    while (logs.size > 200) logs.removeFirst()
  }

  private fun pushConnectingEvent(msg: String) {
    state = state.copy(connectingEvents = appendConnectingEvent(msg))
    emit()
    logLine("connecting: $msg")
  }

  private suspend fun onAuthenticated(session: BaleSession) {
    withContext(Dispatchers.IO) { sessionStore.save(session) }
    managedConfig = null
    pendingTransactionHash = null
    state = state.copy(
      loginStage = LoginStage.READY,
      meLabel = session.userName ?: "logged in",
      configClient = null,
      lastError = null,
    )
    reloadChatsInternal()
    logLine("authenticated as ${session.userName ?: session.userId}")
  }

  private suspend fun reloadChatsInternal() {
    managedConfig?.let {
      state = state.copy(chats = listOf(ChatOption(
        label = it.serverUuid,
        chatId = it.serverPeer.chatId,
        chatType = it.serverPeer.chatType,
      )))
      emit()
      return
    }
    state = state.copy(chats = emptyList())
    emit()
  }

  private fun setBusy(value: Boolean) {
    state = state.copy(busy = value)
    emit()
  }

  private fun clearError() {
    state = state.copy(lastError = null)
    emit()
  }

  private fun logLine(line: String) {
    val stamped = "[${System.currentTimeMillis()}] $line"
    Log.d("WebTunnel", stamped)
    if (logs.size >= 200) logs.removeFirst()
    logs.addLast(stamped)
  }

  private fun snapshot(): ControllerState =
    state.copy(
      chats = state.chats.toList(),
      tunnel = state.tunnel?.copy(),
    )

  @Synchronized
  private fun publishTunnelMetrics(callId: Long, metrics: TunnelMetrics) {
    val current = runtime ?: return
    if (current.callId != callId) return
    val tunnel = state.tunnel ?: return
    state = state.copy(
      tunnel = tunnel.copy(
        bytesUp = metrics.bytesUp,
        bytesDown = metrics.bytesDown,
        streamsOpened = metrics.streamsOpened,
        streamsActive = metrics.streamsActive,
      ),
    )
    emit()
  }

  private suspend fun awaitRemoteParticipant(room: Room, timeoutMs: Long = 30_000): String? {
    room.remoteParticipants.values.firstOrNull()?.identity?.value?.let { return it }
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (SystemClock.elapsedRealtime() < deadline) {
      delay(250)
      room.remoteParticipants.values.firstOrNull()?.identity?.value?.let { return it }
    }
    return null
  }

  private fun serverKeyId(selected: ChatOption): String =
    "${selected.chatType}:${selected.chatId}"

  private fun assertServerIdentityTrusted(keyId: String, fingerprint: String) {
    val configured = managedConfig?.serverFingerprint
    if (!configured.isNullOrBlank() && configured != fingerprint) {
      throw IllegalStateException("SERVER_KEY_MISMATCH: expected $configured got $fingerprint")
    }
    val pinned = sessionStore.loadPinnedFingerprint(keyId)
    if (pinned == null) {
      sessionStore.savePinnedFingerprint(keyId, fingerprint)
      logLine("TOFU pinned server key $keyId fp=$fingerprint")
      return
    }
    if (pinned != fingerprint) {
      throw IllegalStateException("SERVER_KEY_MISMATCH: expected $pinned got $fingerprint")
    }
  }

  private suspend fun sendMeetOffer(peer: BalePeer, callId: Long) {
    val payload = buildMeetOffer(callId)
    try {
      baleClient.sendTextMessage(peer, payload)
      logLine("meet-offer sent callId=$callId")
    } catch (error: Throwable) {
      logLine("meet-offer send failed callId=$callId: ${error.message}")
    }
  }

  private fun scheduleMeetOfferRepeats(peer: BalePeer, callId: Long): Job {
    val payload = buildMeetOffer(callId)
    val attempts = 5
    val delayMs = 750L
    return scope.launch(Dispatchers.IO) {
      repeat(attempts) {
        delay(delayMs)
        try {
          baleClient.sendTextMessage(peer, payload)
        } catch (_: Throwable) {
          return@launch
        }
      }
    }
  }

  private fun buildMeetOffer(callId: Long): String =
    MAGIC_MEET_OFFER + callId.toString()

  private fun emit() {
    val snap = snapshot()
    scope.launch(Dispatchers.Main.immediate) {
      onStateChanged?.invoke(snap)
    }
  }
}

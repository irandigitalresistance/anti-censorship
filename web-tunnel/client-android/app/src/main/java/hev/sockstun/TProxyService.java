package hev.sockstun;

import ai.webtunnel.mobile.R;
import ai.webtunnel.mobile.TunnelVpnBridge;
import android.app.Notification;
import android.app.Notification.Builder;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager.NameNotFoundException;
import android.content.pm.ServiceInfo;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

public final class TProxyService extends VpnService {
  private static native void TProxyStartService(String configPath, int fd);
  private static native void TProxyStopService();
  private static native long[] TProxyGetStats();

  private static final String TAG = "WebTunnelVpn";
  private static final String CHANNEL_NAME = "web-tunnel-vpn";
  private static final String TUN_IPV4 = "198.18.0.1";
  private static final int TUN_IPV4_PREFIX = 32;
  private static final String TUN_IPV6 = "fc00::1";
  private static final int TUN_IPV6_PREFIX = 128;
  private static final String MAPPED_DNS = "198.18.0.2";

  static {
    System.loadLibrary("hev-socks5-tunnel");
  }

  private ParcelFileDescriptor tunFd = null;

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && TunnelVpnBridge.ACTION_DISCONNECT.equals(intent.getAction())) {
      stopServiceInternal();
      return START_NOT_STICKY;
    }
    if (intent != null) {
      startServiceInternal(intent);
      // REDELIVER_INTENT: if the system kills the :vpn process under memory pressure,
      // it re-delivers the original CONNECT intent so the TUN can be re-established
      // without the user re-tapping Start.
      return START_REDELIVER_INTENT;
    }
    // Null intent means the service was restarted by the system after a kill but
    // we somehow lost our extras. Stay alive in foreground if we still hold a TUN
    // FD; otherwise let the controller restart us cleanly.
    if (tunFd != null) {
      return START_STICKY;
    }
    stopSelf();
    return START_NOT_STICKY;
  }

  @Override
  public void onTaskRemoved(Intent rootIntent) {
    // Do NOT stop on swipe-from-recents — the VPN must keep running.
    super.onTaskRemoved(rootIntent);
  }

  @Override
  public void onRevoke() {
    stopServiceInternal();
    super.onRevoke();
  }

  @Override
  public void onDestroy() {
    stopServiceInternal();
    super.onDestroy();
  }

  private void startServiceInternal(Intent intent) {
    if (tunFd != null) {
      return;
    }

    String sessionLabel = intent.getStringExtra(TunnelVpnBridge.EXTRA_SESSION_LABEL);
    if (sessionLabel == null || sessionLabel.isEmpty()) {
      sessionLabel = "NovaNet";
    }
    int socksPort = intent.getIntExtra(TunnelVpnBridge.EXTRA_SOCKS_PORT, 1080);
    boolean remoteDns = intent.getBooleanExtra(TunnelVpnBridge.EXTRA_REMOTE_DNS, true);
    boolean enableIpv4 = intent.getBooleanExtra(TunnelVpnBridge.EXTRA_ENABLE_IPV4, true);
    boolean enableIpv6 = intent.getBooleanExtra(TunnelVpnBridge.EXTRA_ENABLE_IPV6, true);
    int mtu = intent.getIntExtra(TunnelVpnBridge.EXTRA_MTU, 1500);

    VpnService.Builder builder = new VpnService.Builder();
    builder.setBlocking(false);
    builder.setMtu(mtu);
    if (enableIpv4) {
      builder.addAddress(TUN_IPV4, TUN_IPV4_PREFIX);
      builder.addRoute("0.0.0.0", 0);
    }
    if (enableIpv6) {
      builder.addAddress(TUN_IPV6, TUN_IPV6_PREFIX);
      builder.addRoute("::", 0);
    }
    if (remoteDns) {
      builder.addDnsServer(MAPPED_DNS);
    }
    try {
      builder.addDisallowedApplication(getPackageName());
    } catch (NameNotFoundException ignore) {
      // Ignore unexpected self-package lookup failures.
    }
    builder.setSession(sessionLabel);
    tunFd = builder.establish();
    if (tunFd == null) {
      Log.e(TAG, "VPN establish failed");
      stopSelf();
      return;
    }

    File confFile = new File(getCacheDir(), "tproxy-" + socksPort + ".conf");
    try (FileOutputStream fos = new FileOutputStream(confFile, false)) {
      StringBuilder config = new StringBuilder();
      config.append("misc:\n");
      config.append("  task-stack-size: 81920\n");
      config.append("  log-level: info\n");
      config.append("tunnel:\n");
      config.append("  mtu: ").append(mtu).append('\n');
      config.append("socks5:\n");
      config.append("  port: ").append(socksPort).append('\n');
      config.append("  address: '127.0.0.1'\n");
      config.append("  udp: 'udp'\n");
      if (remoteDns) {
        config.append("mapdns:\n");
        config.append("  address: ").append(MAPPED_DNS).append('\n');
        config.append("  port: 53\n");
        config.append("  network: 240.0.0.0\n");
        config.append("  netmask: 240.0.0.0\n");
        config.append("  cache-size: 10000\n");
      }
      fos.write(config.toString().getBytes());
    } catch (IOException error) {
      Log.e(TAG, "Writing tun2socks config failed", error);
      closeTun();
      stopSelf();
      return;
    }

    initNotificationChannel();
    createNotification();
    TProxyStartService(confFile.getAbsolutePath(), tunFd.getFd());
    Log.d(TAG, "VPN started on SOCKS " + socksPort + " for " + sessionLabel);
  }

  private void stopServiceInternal() {
    if (tunFd == null) {
      stopSelf();
      return;
    }
    try {
      TProxyStopService();
    } catch (Throwable error) {
      Log.w(TAG, "Stopping native tunnel failed", error);
    }
    closeTun();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE);
    } else {
      stopForeground(true);
    }
    stopSelf();
    Log.d(TAG, "VPN stopped");
  }

  private void closeTun() {
    if (tunFd == null) {
      return;
    }
    try {
      tunFd.close();
    } catch (IOException ignore) {
      // Ignore best-effort close failures.
    }
    tunFd = null;
  }

  private void createNotification() {
    Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent pendingIntent = null;
    if (launchIntent != null) {
      launchIntent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
      pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, PendingIntent.FLAG_IMMUTABLE);
    }
    NotificationCompat.Builder notification = new NotificationCompat.Builder(this, CHANNEL_NAME)
      .setContentTitle(getString(R.string.app_name))
      .setContentText("Android VPN is routing app traffic through the tunnel")
      .setSmallIcon(android.R.drawable.stat_sys_download_done)
      .setOngoing(true);
    if (pendingIntent != null) {
      notification.setContentIntent(pendingIntent);
    }
    Notification notify = notification.build();
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(1, notify);
    } else {
      startForeground(1, notify, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
    }
  }

  private void initNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return;
    }
    NotificationManager manager =
      (NotificationManager)getSystemService(Context.NOTIFICATION_SERVICE);
    NotificationChannel channel = new NotificationChannel(
      CHANNEL_NAME,
      getString(R.string.app_name),
      NotificationManager.IMPORTANCE_LOW);
    manager.createNotificationChannel(channel);
  }
}

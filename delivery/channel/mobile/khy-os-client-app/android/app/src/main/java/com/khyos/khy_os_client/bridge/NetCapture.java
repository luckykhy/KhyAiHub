package com.khyos.khy_os_client.bridge;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.VpnService;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 断点五的 Android 侧装配：判定核心（{@link NetCaptureCore}）+ 本机代理
 * （{@link NetProxy}）+ 代理型 VPN（{@link NetVpnService}）。
 *
 * <p>为什么抓包要先过一道「调试菜单解锁」。抓包会把别人的密码记进本机内存，
 * 而这套工具是给 agent 调的——agent 能调就意味着「任何能写 prompt 的路径」
 * 都能调。所以入口不是一个开关，是一个**人**：只有人在调试菜单里显式解锁过，
 * 工具才肯开。键不存在 = 未解锁（fail-closed），与 driver 门的 fail-open 相反，
 * 因为这两件事的风险方向相反。
 *
 * <p>为什么 ttl 的看门狗放在这里而不是核心里：核心不该起线程（谁负责关只能有
 * 一个答案）。这里用主线程 Handler 每 5 秒问一次核心「到点了吗」，到点就停
 * 代理和 VPN——三样东西一起收，不然会出现「核心说停了但代理还在听」的半开状态。
 */
public final class NetCapture {

    /** 调试菜单解锁位的偏好文件名与键名。 */
    public static final String PREFS = "khy_debug";
    public static final String KEY_UNLOCKED = "debug_menu_unlocked";

    /** 看门狗间隔：5 秒够细（ttl 是分钟级），又不至于每帧都唤醒。 */
    private static final long WATCHDOG_MS = 5_000L;

    private static final NetCaptureCore CORE = new NetCaptureCore();
    private static NetProxy proxy;
    private static Handler watchdog;
    private static String vpnState = "off";

    private NetCapture() {
    }

    public static NetCaptureCore core() {
        return CORE;
    }

    // ==================== 调试菜单门 ====================

    public static boolean debugUnlocked(Context ctx) {
        if (ctx == null) return false;
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return p.getBoolean(KEY_UNLOCKED, false);
    }

    public static void setDebugUnlocked(Context ctx, boolean unlocked) {
        if (ctx == null) return;
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_UNLOCKED, unlocked).apply();
        if (!unlocked) {
            // 锁上必须连带停抓：否则「面板收起来了，代理还在听」是一条没人看管的入口。
            try {
                stop("debug_menu_locked");
            } catch (JSONException ignored) {
            }
        }
    }

    // ==================== 生命周期 ====================

    /**
     * 开抓。{@code tlsArmed} 是显式调试档（self+tls）的开关——默认 false：默认档
     * 不需要 CA、不解 TLS，HTTPS 只记一条「无法解密」。
     */
    public static synchronized JSONObject start(Context ctx, Long ttlMs, boolean tlsArmed)
            throws JSONException {
        JSONObject r = new JSONObject();
        // 门判在核心里（纯函数、JVM 可测），装配留在这里：Context 与 VpnService
        // 只有真机上有，而「没解锁就不开」这条判定必须能在裸 JVM 上被证明。
        JSONObject gate = CORE.startGate(debugUnlocked(ctx), Build.VERSION.SDK_INT);
        if (!gate.optBoolean("ok")) return gate;
        long now = System.currentTimeMillis();
        JSONObject started = CORE.start(now, ttlMs);
        if (started.optBoolean("already_active")) {
            // 本来就在抓：ttl 不重置，档位也不跟着改。想换档位先 stop。
            return started.put("vpn", vpnState);
        }
        if (tlsArmed) {
            try {
                CORE.setTlsArmed(true);
            } catch (Throwable e) {
                CORE.stop(now, "tls_ca_failed");
                return r.put("ok", false).put("code", "tls_ca_failed")
                        .put("error", "调试 CA 生成失败：" + e);
            }
        }

        if (proxy == null) {
            proxy = new NetProxy(CORE, new NetProxy.Protector() {
                @Override
                public boolean protect(java.net.Socket socket) {
                    return NetVpnService.protectSocket(socket);
                }
            });
        }
        if (!proxy.running()) {
            try {
                int port = proxy.start(0);
                CORE.setPort(port);
            } catch (Throwable e) {
                CORE.stop(now, "proxy_bind_failed");
                return r.put("ok", false).put("code", "proxy_bind_failed")
                        .put("error", "本机代理起不来：" + e.getMessage());
            }
        }
        int port = CORE.status(now).optInt("port");

        // VPN 授权是一次性的人机交互，没法用 adb 代签。没授权时抓包照样「开着」
        // （代理已在听），但没有流量会进来——所以必须把 vpn 状态如实回给调用方，
        // 否则调用方会拿 records=0 去怀疑规则写错了。
        Intent consent = VpnService.prepare(ctx);
        if (consent != null) {
            vpnState = "consent_required";
            startWatchdog();
            return r.put("ok", true).put("active", true).put("port", port)
                    .put("vpn", "consent_required")
                    .put("hint", "VPN 未授权：请在调试菜单点「允许 VPN」，否则没有流量经过代理");
        }
        startVpn(ctx, port);
        startWatchdog();
        return r.put("ok", true).put("active", true).put("port", port)
                .put("vpn", vpnState).put("ttl_ms", started.optLong("ttl_ms"))
                .put("capture", CORE.captureMode());
    }

    /** VPN 授权拿到后由 Activity 回调这里补起服务（不重开核心）。 */
    public static synchronized JSONObject resumeVpn(Context ctx) throws JSONException {
        JSONObject r = new JSONObject();
        if (!CORE.active()) {
            return r.put("ok", false).put("code", "capture_off")
                    .put("error", "抓包已停（可能已过 ttl），请重新 net_capture_start");
        }
        int port = CORE.status(System.currentTimeMillis()).optInt("port");
        startVpn(ctx, port);
        return r.put("ok", true).put("vpn", vpnState).put("port", port);
    }

    private static void startVpn(Context ctx, int port) {
        try {
            Intent i = new Intent(ctx, NetVpnService.class).putExtra("port", port);
            ctx.startService(i);
            vpnState = "on";
        } catch (Throwable e) {
            vpnState = "start_failed:" + e.getMessage();
        }
    }

    public static synchronized JSONObject stop(String reason) throws JSONException {
        long now = System.currentTimeMillis();
        JSONObject r;
        try {
            r = CORE.stop(now, reason == null ? "manual" : reason);
        } catch (JSONException e) {
            r = new JSONObject();
            r.put("ok", true);
            r.put("active", false);
        }
        if (proxy != null) {
            proxy.stop();
            proxy = null;
        }
        Context ctx = Tools.ctxRef();
        if (ctx != null) {
            try {
                ctx.stopService(new Intent(ctx, NetVpnService.class));
            } catch (Throwable ignored) {
            }
        }
        NetVpnService.shutdown();
        vpnState = "off";
        stopWatchdog();
        r.put("vpn", vpnState);
        return r;
    }

    public static synchronized JSONObject status() throws JSONException {
        JSONObject s = CORE.status(System.currentTimeMillis());
        s.put("vpn", vpnState);
        s.put("proxy_running", proxy != null && proxy.running());
        s.put("proxy_live_connections", proxy == null ? 0 : proxy.liveConnections());
        return s;
    }

    /**
     * 导出为 JSONL。落盘的是**已脱敏**的记录——脱敏在记录时就做了，这里只是把
     * 内存里那份原样写出去。之所以还要再声明一次 redacted=true：读文件的人
     * 不该靠「相信」来判断这个文件里有没有密钥。
     */
    public static synchronized JSONObject export() throws JSONException {
        JSONObject r = new JSONObject();
        JSONObject listed = CORE.list(0, NetCaptureCore.MAX_RECORDS);
        JSONArray items = listed.optJSONArray("items");
        File dir = new File("/sdcard/khyos-evidence");
        if (!dir.exists() && !dir.mkdirs()) {
            return r.put("ok", false).put("code", "mkdir_failed")
                    .put("error", "建不了 /sdcard/khyos-evidence");
        }
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        File f = new File(dir, "net-capture-" + stamp + ".jsonl");
        long bytes = 0;
        int n = 0;
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(f, false);
            String header = new JSONObject()
                    .put("type", "meta")
                    .put("exported_at", System.currentTimeMillis())
                    .put("redacted", true)
                    .put("records", items == null ? 0 : items.length())
                    .put("ttl_ms", CORE.status(System.currentTimeMillis()).optLong("ttl_ms"))
                    .toString() + "\n";
            out.write(header.getBytes("UTF-8"));
            bytes += header.getBytes("UTF-8").length;
            if (items != null) {
                for (int i = 0; i < items.length(); i++) {
                    String line = items.optJSONObject(i).toString() + "\n";
                    out.write(line.getBytes("UTF-8"));
                    bytes += line.getBytes("UTF-8").length;
                    n++;
                }
            }
            out.flush();
        } catch (Throwable e) {
            return r.put("ok", false).put("code", "export_failed")
                    .put("error", String.valueOf(e.getMessage()));
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (Throwable ignored) {
                }
            }
        }
        return r.put("ok", true).put("path", f.getAbsolutePath())
                .put("records", n).put("bytes", bytes).put("redacted", true);
    }

    /**
     * 导出调试 CA 证书（PEM）到 /sdcard/Download，供用户自己装成**用户证书**。
     *
     * <p>为什么落在 Download 而不是证据目录：证书是要被用户在系统设置里
     * 「安装证书 → CA 证书」挑中的，Download 是文件选择器默认看得见的地方。
     * 只写证书不写私钥——私钥从不离开进程（见 NetTls 的类注释）。
     * 我们永远不代用户装：§10 禁装系统证书，用户证书也只能由用户本人在设置里装。
     */
    public static synchronized JSONObject exportCa() throws JSONException {
        JSONObject r = new JSONObject();
        NetTls ca = CORE.tls();
        if (ca == null) {
            return r.put("ok", false).put("code", "ca_not_armed")
                    .put("error", "TLS 调试档没开：先 net_capture_start 带 tls=true");
        }
        File dir = new File("/sdcard/Download");
        if (!dir.exists() && !dir.mkdirs()) {
            return r.put("ok", false).put("code", "mkdir_failed")
                    .put("error", "建不了 /sdcard/Download");
        }
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        File f = new File(dir, "khy-net-debug-ca-" + stamp + ".crt");
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(f, false);
            out.write(ca.caCertPem().getBytes("UTF-8"));
            out.flush();
        } catch (Throwable e) {
            return r.put("ok", false).put("code", "export_failed")
                    .put("error", String.valueOf(e.getMessage()));
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (Throwable ignored) {
                }
            }
        }
        return r.put("ok", true).put("path", f.getAbsolutePath())
                .put("hint", "在系统设置里「安装证书 → CA 证书」选这个文件；"
                        + "不信任它的 App 会返回「无法解密」，不会被伪装成成功");
    }

    // ==================== ttl 看门狗 ====================

    private static void startWatchdog() {
        if (watchdog != null) return;
        watchdog = new Handler(Looper.getMainLooper());
        watchdog.postDelayed(new Runnable() {
            @Override
            public void run() {
                boolean stopped;
                try {
                    stopped = CORE.tick(System.currentTimeMillis());
                } catch (Throwable e) {
                    stopped = false;
                }
                if (stopped) {
                    // 核心到点自停，代理与 VPN 必须一起收：否则「核心说停了、
                    // 代理还在听」会留下一条没人看管的明文入口。
                    try {
                        stop("ttl_expired");
                    } catch (JSONException ignored) {
                    }
                    return;
                }
                Handler h = watchdog;
                if (h != null) h.postDelayed(this, WATCHDOG_MS);
            }
        }, WATCHDOG_MS);
    }

    private static void stopWatchdog() {
        Handler h = watchdog;
        watchdog = null;
        if (h != null) h.removeCallbacksAndMessages(null);
    }
}

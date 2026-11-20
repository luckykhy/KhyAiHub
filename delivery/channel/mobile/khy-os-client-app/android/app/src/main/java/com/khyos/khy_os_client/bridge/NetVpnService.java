package com.khyos.khy_os_client.bridge;

import android.content.Intent;
import android.net.ProxyInfo;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;

import java.net.Socket;

/**
 * 代理型 VPN：只做一件事——把被覆盖 App 的 HTTP(S) 请求指到本机代理。
 *
 * <p>为什么不是 TUN 数据面。本服务的目的是让 {@link NetProxy} 能看见请求，
 * 不是接管全部 IP 流量。{@link VpnService.Builder#setHttpProxy} 把系统代理
 * 指到 127.0.0.1，被覆盖的 App 用 HTTP 代理时就把请求交给本机代理——不解析
 * 一个 IP 包，也不实现 TCP 栈。代价是**只覆盖走系统代理的客户端**：OkHttp /
 * WebView / 系统下载器会走，自己直连 socket 的客户端（包括 Dart 的
 * HttpClient，默认不读系统代理）不会走。这条限制写在证据文件里，不藏。
 *
 * <p>为什么必须有 {@link #protect}。代理自己也要连外网；若不把它的上游 socket
 * 从 VPN 里摘出去，代理的连接会再次进入 VPN → 再次交给代理 → 无限递归。
 * 这不是理论风险，是漏掉就 100% 复现的死循环。
 *
 * <p>为什么 {@code pfd} 要一直握着。VpnService 的隧道由这个 fd 的生命周期决定：
 * 一 close，VPN 就没了（系统会撤掉路由与代理设置）。所以它存在静态字段里，
 * 只在 {@link #shutdown()} 或系统 {@link #onRevoke()} 时关闭。
 */
public class NetVpnService extends VpnService {

    private static volatile NetVpnService instance;
    private static volatile ParcelFileDescriptor tunnel;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int port = intent == null ? 0 : intent.getIntExtra("port", 0);
        instance = this;
        if (Build.VERSION.SDK_INT < 29) {
            // setHttpProxy 是 API 29 才有的；更低版本没有「只设代理不建 TUN」的路，
            // 与其建一个没人读的 TUN 把设备流量黑洞掉，不如明确不支持。
            stopSelf();
            return START_NOT_STICKY;
        }
        if (port <= 0) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            closeTunnel();
            Builder b = new Builder();
            b.setSession("khy-net-capture");
            // 必须给一个地址，否则 establish() 拒绝。这个网段没有路由指向它，
            // 所以不会有真实流量被吸进一个没人读的 TUN。
            b.addAddress("10.66.0.1", 32);
            b.setHttpProxy(ProxyInfo.buildDirectProxy("127.0.0.1", port));
            try {
                // 本 App 自己不走这个 VPN：代理的上游连接属于本 App，
                // 排除掉它比逐个 protect 更彻底（有些库会自己开 socket）。
                b.addDisallowedApplication(getPackageName());
            } catch (Throwable ignored) {
            }
            ParcelFileDescriptor pfd = b.establish();
            if (pfd == null) {
                // establish 返回 null = 用户没授权 / 被系统拒。不假装成功。
                stopSelf();
                return START_NOT_STICKY;
            }
            tunnel = pfd;
            return START_STICKY;
        } catch (Throwable e) {
            stopSelf();
            return START_NOT_STICKY;
        }
    }

    /**
     * 代理的上游 socket 从这里摘出 VPN。没有 VPN 时返回 false（调用方无需处理）。
     *
     * <p>名字带 Socket 后缀不是啰嗦：VpnService 自带一个实例方法 {@code protect(Socket)}，
     * 同名静态方法会撞上它（「无法覆盖/隐藏」），编译直接红。静态入口换名是唯一干净解。
     */
    public static boolean protectSocket(Socket socket) {
        NetVpnService v = instance;
        if (v == null) return false;
        try {
            return v.protect(socket);
        } catch (Throwable e) {
            return false;
        }
    }

    public static boolean active() {
        return tunnel != null;
    }

    public static void shutdown() {
        NetVpnService v = instance;
        instance = null;
        closeTunnel();
        if (v != null) {
            try {
                v.stopSelf();
            } catch (Throwable ignored) {
            }
        }
    }

    private static void closeTunnel() {
        ParcelFileDescriptor p = tunnel;
        tunnel = null;
        if (p != null) {
            try {
                p.close();
            } catch (Throwable ignored) {
            }
        }
    }

    @Override
    public void onRevoke() {
        // 用户在系统里撤了 VPN 授权 / 别的 VPN 抢了前台：这里必须把抓包一起停，
        // 否则核心还报 active=true、代理还在听，而流量早就不经过了。
        try {
            NetCapture.stop("vpn_revoked");
        } catch (Throwable ignored) {
        }
        closeTunnel();
        instance = null;
        stopSelf();
    }

    @Override
    public void onDestroy() {
        closeTunnel();
        if (instance == this) instance = null;
        super.onDestroy();
    }
}

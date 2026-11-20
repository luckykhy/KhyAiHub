package com.khyos.khy_os_client.bridge;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.Charset;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 本机 HTTP 代理：抓明文、按规则改写；TLS 分两档。
 *
 * <p>为什么是代理而不是 TUN。TUN 要自己实现 TCP/IP 栈（或引一个几万行的库），
 * 而断点五要证明的是「能看见、能改」这件事，不是「能重组任意 TCP 流」。
 * 代理能拿到完整的 HTTP 语义（方法/主机/路径/头/体），改写才有意义——
 * 在字节流里做替换，连 gzip 和 chunked 都过不去。
 *
 * <p><b>默认档（self）：不碰 TLS。</b>收到 {@code CONNECT} 时记一条
 * {@code decrypted=false / error=tls_not_intercepted} 然后原样隧道转发，
 * 让被代理的 App 照常工作。承诺是「明确告诉你解不开」，不是「假装抓到了」。
 *
 * <p><b>调试档（self+tls）：显式开启的 TLS 中间人。</b>由用户在调试菜单里打开，
 * 用 {@link NetTls} 签的逐主机叶证书尝试解密。对方不信任这枚用户 CA 时记
 * {@code ca_untrusted} + 「无法解密」并关闭该连接——不伪造成功，也不回落到
 * 盲隧道（客户端已经收到那颗不受信任的证书，它的视角里这次连接就是失败的）。
 *
 * <p>本类不碰 Android API：上游 socket 的「绕过 VPN」由一个 {@link Protector}
 * 回调注入（真机上是 {@code VpnService.protect}）。这样整条代理逻辑可以在
 * JVM 单测里用真 socket 跑一遍，不用连设备。
 */
public final class NetProxy {

    /** 上游 socket 需要绕开本机 VPN，否则代理自己会被自己代理（死循环）。 */
    public interface Protector {
        boolean protect(Socket socket);
    }

    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final int MAX_HEADER_BYTES = 64 * 1024;
    private static final int MAX_BODY_BYTES = 4 * 1024 * 1024;
    private static final int IO_TIMEOUT_MS = 15_000;

    private final NetCaptureCore core;
    private final Protector protector;

    private ServerSocket server;
    private Thread acceptThread;
    private ExecutorService pool;
    private final AtomicInteger live = new AtomicInteger();

    public NetProxy(NetCaptureCore core, Protector protector) {
        this.core = core;
        this.protector = protector;
    }

    /** 起在 127.0.0.1 的临时端口上。返回实际端口（0 表示让系统挑）。 */
    public synchronized int start(int port) throws IOException {
        if (server != null) return server.getLocalPort();
        ServerSocket ss = new ServerSocket();
        ss.setReuseAddress(true);
        ss.bind(new InetSocketAddress("127.0.0.1", port), 64);
        server = ss;
        pool = Executors.newFixedThreadPool(8);
        acceptThread = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "khy-net-proxy-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return ss.getLocalPort();
    }

    public synchronized void stop() {
        ServerSocket ss = server;
        server = null;
        if (ss != null) {
            try {
                ss.close();
            } catch (IOException ignored) {
            }
        }
        if (pool != null) {
            pool.shutdownNow();
            pool = null;
        }
        acceptThread = null;
    }

    public synchronized boolean running() {
        return server != null && !server.isClosed();
    }

    public int liveConnections() {
        return live.get();
    }

    private void acceptLoop() {
        while (true) {
            ServerSocket ss;
            synchronized (this) {
                ss = server;
            }
            if (ss == null) return;
            try {
                final Socket client = ss.accept();
                final ExecutorService p;
                synchronized (this) {
                    p = pool;
                }
                if (p == null) {
                    closeQuietly(client);
                    return;
                }
                try {
                    p.execute(new Runnable() {
                        @Override
                        public void run() {
                            handle(client);
                        }
                    });
                } catch (RuntimeException re) {
                    // stop() 与 accept 竞态：pool 刚被 shutdownNow，这条连接没人处理。
                    // 不向上抛——抛出去会把 accept 线程连带杀死，只留一串和抓包无关的栈。
                    closeQuietly(client);
                    return;
                }
            } catch (IOException e) {
                // close() 会让 accept 抛异常退出——这是正常的停止路径，不是错误。
                return;
            }
        }
    }

    // ==================== 单条连接 ====================

    private void handle(Socket client) {
        live.incrementAndGet();
        long t0 = System.currentTimeMillis();
        try {
            client.setSoTimeout(IO_TIMEOUT_MS);
            InputStream cin = client.getInputStream();
            OutputStream cout = client.getOutputStream();

            byte[] head = readHead(cin);
            if (head == null) return;
            String headText = new String(head, UTF8);
            int lineEnd = headText.indexOf("\r\n");
            if (lineEnd < 0) return;
            String requestLine = headText.substring(0, lineEnd);
            String[] parts = requestLine.split(" ");
            if (parts.length < 3) return;
            String method = parts[0].toUpperCase(Locale.US);
            String target = parts[1];

            // ---- HTTPS：看 TLS 调试档开没开，两条完全不同的路 ----
            if ("CONNECT".equals(method)) {
                int cport = portOf(target, 443);
                String chost = stripPort(target);
                if (core.tlsArmed()) {
                    // self+tls：尝试用调试 CA 签的叶证书解开这条流。
                    mitm(client, cin, cout, chost, cport, t0);
                    return;
                }
                // 默认档：不碰 TLS，明确报「解不开」，然后原样隧道——被代理的 App
                // 照常工作，只是这条流量的明文这一版拿不到。
                connectNotIntercepted(cout, client, chost, cport, t0);
                return;
            }

            // ---- 明文 HTTP（TLS 档里解密后的请求也走这一段） ----
            handleExchange(cin, cout, head, t0, false, "", 0);
        } catch (Throwable e) {
            recordFailure(t0, e);
        } finally {
            live.decrementAndGet();
            closeQuietly(client);
        }
    }

    /**
     * 默认档对 CONNECT 的处理：记一条「无法解密」，然后盲隧道转发。
     *
     * <p>为什么必须留下记录再走：App 照常工作，用户看到的却是「没有抓到东西」。
     * 这两种事实必须分开说——记录里 {@code decrypted=false} +
     * {@code error=tls_not_intercepted}，且不带任何方法/路径/正文字段
     * （不伪造成功）。
     */
    private void connectNotIntercepted(OutputStream cout, Socket client, String chost,
                                       int cport, long t0) throws Exception {
        NetCaptureCore.Rule rule = core.match("CONNECT", chost, "", System.currentTimeMillis());
        if (rule != null && NetCaptureCore.ACT_BLOCK.equals(rule.canonicalAction())) {
            JSONObject rec = baseRecord(t0, "CONNECT", chost, cport, "");
            rec.put("decrypted", false);
            rec.put("error", "blocked_by_net_rule");
            rec.put("error_msg", "被 net_rule 拦掉（block）");
            rec.put("rule_id", rule.id);
            rec.put("rewritten", true);
            record(rec, t0);
            writeSimple(cout, 403, "{\"ok\":false,\"error\":\"blocked_by_net_rule\","
                    + "\"rule\":\"" + rule.id + "\"}");
            return;
        }
        JSONObject rec = baseRecord(t0, "CONNECT", chost, cport, "");
        rec.put("decrypted", false);
        // 这条 error 是任务书 T20 要的「无法解密要明确报错」：它不是「抓包失败」，
        // 是「这条流量的明文在这一版拿不到」，两者对使用者的含义完全不同。
        rec.put("error", "tls_not_intercepted");
        rec.put("error_msg", "无法解密：HTTPS 未做 MITM，只能看到目标主机，看不到方法/路径/正文");
        record(rec, t0);
        cout.write(("HTTP/1.1 200 Connection Established\r\n"
                + "Proxy-Agent: khy-net-capture\r\n\r\n").getBytes(UTF8));
        cout.flush();
        tunnel(client, chost, cport);
    }

    /**
     * self+tls：对 CONNECT 做 TLS 中间人。
     *
     * <p>握手失败（对方不信任导出的调试 CA）时记 {@code ca_untrusted} + 「无法解密」，
     * 然后关掉这条连接。**不回落到盲隧道**：客户端已经收到我们那颗不受信任的证书，
     * 从它的视角这次连接就是失败的；假装没发生过比失败更糟。用户要么把 CA 装上
     * （调试菜单里有导出），要么把 TLS 档关掉。
     */
    private void mitm(Socket client, InputStream cin, OutputStream cout, String chost,
                      int cport, long t0) throws Exception {
        NetTls tls = core.tls();
        if (tls == null) {
            // 档位开着但没有 CA（理论上不该发生）：按「解不开」处理，不伪造成功。
            JSONObject rec = baseRecord(t0, "CONNECT", chost, cport, "");
            rec.put("decrypted", false);
            rec.put("error", "tls_ca_missing");
            rec.put("error_msg", "无法解密：TLS 档已开但调试 CA 不在（重启过？重新开一次抓包）");
            record(rec, t0);
            return;
        }
        javax.net.ssl.SSLContext ctx = tls.serverContext(chost);
        javax.net.ssl.SSLSocket ssl = (javax.net.ssl.SSLSocket) ctx.getSocketFactory()
                .createSocket(client, chost, cport, true);
        // 先回 200 再握手：客户端在收到 Connection Established 之前不会发 ClientHello，
        // 顺序反了就是两边互相等（第一版在这里超时）。
        try {
            cout.write(("HTTP/1.1 200 Connection Established\r\n"
                    + "Proxy-Agent: khy-net-capture\r\n\r\n").getBytes(UTF8));
            cout.flush();
        } catch (Throwable e) {
            closeQuietly(ssl);
            return;
        }
        try {
            ssl.setUseClientMode(false);
            ssl.startHandshake();
        } catch (Throwable e) {
            JSONObject rec = baseRecord(t0, "CONNECT", chost, cport, "");
            rec.put("decrypted", false);
            String why = String.valueOf(e.getMessage());
            boolean untrusted = e instanceof javax.net.ssl.SSLHandshakeException
                    || why.contains("unable to find valid certification path")
                    || why.contains("PKIX")
                    || why.contains("certificate_unknown")
                    || why.contains("bad_certificate")
                    || why.contains("trust");
            rec.put("error", untrusted ? "ca_untrusted" : "tls_handshake_failed");
            rec.put("error_msg", untrusted
                    ? "无法解密：对方不信任导出的调试 CA（TLS 握手被拒）。装上 CA 或关掉 TLS 档"
                    : "无法解密：TLS 握手失败（" + why + "）");
            rec.put("detail", e.getClass().getSimpleName());
            record(rec, t0);
            closeQuietly(ssl);
            return;
        }
        // 握手成了：里面是一条普通 HTTP 会话，交给同一段交换逻辑。
        byte[] head = readHead(ssl.getInputStream());
        if (head == null) {
            closeQuietly(ssl);
            return;
        }
        try {
            handleExchange(ssl.getInputStream(), ssl.getOutputStream(), head, t0, true,
                    chost, cport);
        } finally {
            closeQuietly(ssl);
        }
    }

    /**
     * 一次 HTTP 交换：记录（已脱敏）→ 按规则改写 → 转发 → 回显。
     *
     * <p>明文路径与 TLS 档解密后的路径共用这一段——分开写两份的后果是规则在一边
     * 生效、在另一边不生效，而那种偏差没有任何测试会主动发现。
     *
     * @param upstreamTls true 时上游腿也走 TLS（MITM 路径），host/port 以
     *                    CONNECT 目标为准（forcedHost/forcedPort）
     */
    private void handleExchange(InputStream cin, OutputStream cout, byte[] head, long t0,
                                boolean upstreamTls, String forcedHost, int forcedPort)
            throws Exception {
        // 提到方法级：请求侧一旦解析完（头/体都已脱敏），这条记录就成立；
        // 后面无论响应是否读得回来，都不该把它丢掉。
        JSONObject rec = null;
        Socket upstream = null;
        try {
            String headText = new String(head, UTF8);
            int lineEnd = headText.indexOf("\r\n");
            if (lineEnd < 0) return;
            String requestLine = headText.substring(0, lineEnd);
            String[] parts = requestLine.split(" ");
            if (parts.length < 3) return;
            String method = parts[0].toUpperCase(Locale.US);
            String target = parts[1];
            String version = parts[2];

            Map<String, String> headers = parseHeaders(headText.substring(lineEnd + 2));
            String hostHeader = headers.get("host");
            String host = hostHeader == null ? "" : stripPort(hostHeader);
            int port = portOf(hostHeader, "https".equalsIgnoreCase(headers.get("x-forwarded-proto")) ? 443 : 80);
            if (upstreamTls && !forcedHost.isEmpty()) {
                host = forcedHost;
                port = forcedPort;
            }

            int contentLength = intOf(headers.get("content-length"), 0);
            byte[] reqBody = readBody(cin, contentLength);
            String path = pathOf(target);
            String hostForRule = host.isEmpty() ? hostOfAbsolute(target) : host;

            rec = baseRecord(t0, method, hostForRule, port, core.redactUrl(path));
            rec.put("decrypted", true);
            rec.put("req_headers", core.redactHeaders(toJson(headers)));
            rec.put("req_body", core.redactBody(new String(reqBody, UTF8)));

            NetCaptureCore.Rule rule = core.match(method, hostForRule, pathOf(target),
                    System.currentTimeMillis());
            if (rule != null && NetCaptureCore.ACT_BLOCK.equals(rule.canonicalAction())) {
                rec.put("status", 403);
                rec.put("rule_id", rule.id);
                rec.put("rewritten", true);
                rec.put("error", "blocked_by_net_rule");
                rec.put("error_msg", "被 net_rule 拦掉（block）");
                record(rec, t0);
                writeSimple(cout, 403, "{\"ok\":false,\"error\":\"blocked_by_net_rule\","
                        + "\"rule\":\"" + rule.id + "\"}");
                return;
            }

            if (upstreamTls) {
                // MITM 路径的上游腿： trust-all。这一档的用途是看流量，不是给上游
                // 做认证——客户端那一腿的信任决策本来就已经被这一档替换掉了。
                // 不把这件事藏起来：记录里带 upstream_tls_verified=false。
                rec.put("upstream_tls_verified", false);
                javax.net.ssl.SSLSocket us = (javax.net.ssl.SSLSocket) upstreamTlsContext()
                        .getSocketFactory().createSocket();
                upstream = us;
            } else {
                upstream = new Socket();
            }
            if (protector != null) protector.protect(upstream);
            upstream.setSoTimeout(IO_TIMEOUT_MS);
            upstream.connect(new InetSocketAddress(hostForRule, port), IO_TIMEOUT_MS);
            if (upstreamTls) ((javax.net.ssl.SSLSocket) upstream).startHandshake();
            OutputStream uout = upstream.getOutputStream();
            InputStream uin = upstream.getInputStream();

            StringBuilder reqHead = new StringBuilder();
            reqHead.append(method).append(' ').append(path).append(' ').append(version).append("\r\n");
            for (Map.Entry<String, String> e : headers.entrySet()) {
                String k = e.getKey();
                if ("proxy-connection".equals(k) || "connection".equals(k)) continue;
                reqHead.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
            // 强制 close：响应按 EOF 定界，比自解析 chunked 稳，也不会把上游连接留成半开。
            reqHead.append("Connection: close\r\n\r\n");
            uout.write(reqHead.toString().getBytes(UTF8));
            if (reqBody.length > 0) uout.write(reqBody);
            uout.flush();

            byte[] respHeadBytes = readHead(uin);
            if (respHeadBytes == null) {
                rec.put("status", 0);
                rec.put("error", "empty_upstream_response");
                record(rec, t0);
                writeSimple(cout, 502, "{\"ok\":false,\"error\":\"empty_upstream_response\"}");
                return;
            }
            String respHead = new String(respHeadBytes, UTF8);
            int rEnd = respHead.indexOf("\r\n");
            String statusLine = rEnd < 0 ? respHead : respHead.substring(0, rEnd);
            int status = statusOf(statusLine);
            Map<String, String> respHeaders = parseHeaders(rEnd < 0 ? "" : respHead.substring(rEnd + 2));
            // 响应体定界：优先 Content-Length，其次 chunked，最后才靠 EOF。
            //
            // WHY NOT EOF FIRST. 上游是 HTTP/1.1 且常常 keep-alive，即使我们发了
            // Connection: close，也不保证对端立刻断——靠 EOF 定界会一路阻塞到
            // socket 超时（15s），表现为「服务器已收到请求、客户端却一直等」。
            // 这个 bug 是在 T17 实测里被 curl 的 8s 超时暴露出来的。
            int respClen = intOf(respHeaders.get("content-length"), -1);
            String respTe = respHeaders.get("transfer-encoding");
            boolean respChunked = respTe != null
                    && respTe.toLowerCase(Locale.US).contains("chunked");
            byte[] respBody;
            if (respClen >= 0) {
                respBody = readBody(uin, respClen);
            } else if (respChunked) {
                // 本版不解 chunked：解完必须重算 Content-Length，解错比不解更危险。
                // 明确报「没解」并原样透传——客户端拿到的仍是正确响应，只是记录里
                // 看不到正文。这与 HTTPS 那条 tls_not_intercepted 是同一个立场。
                rec.put("status", status);
                rec.put("error", "chunked_not_decoded");
                rec.put("hint", "上游用 chunked 且无 Content-Length；本版不解码，响应原样透传");
                record(rec, t0);
                cout.write(respHeadBytes);
                cout.flush();
                pumpStream(uin, cout);
                return;
            } else {
                respBody = readToEof(uin);
            }

            rec.put("status", status);
            rec.put("resp_headers", core.redactHeaders(toJson(respHeaders)));
            rec.put("resp_body", core.redactBody(new String(respBody, UTF8)));
            rec.put("bytes_out", reqBody.length);
            rec.put("bytes_in", respBody.length);

            // ---- 改写 ----
            if (rule != null) {
                rec.put("rule_id", rule.id);
                rec.put("rewritten", true);
                // 前后哈希只照响应正文算；status/header 的变化进结构化摘要（diff）。
                // 任务书 T6：可按 rule_id 追溯命中次数与前后哈希——记账在 core.noteRuleHit，
                // 经 net_rule 的 op=list 逐条可读；正文本身一律不进记账。
                String beforeBody = new String(respBody, UTF8);
                int beforeStatus = status;
                String diff;
                if (NetCaptureCore.ACT_STATUS.equals(rule.canonicalAction())) {
                    status = rule.status;
                    diff = "status " + beforeStatus + " -> " + status;
                } else if (NetCaptureCore.ACT_BODY.equals(rule.canonicalAction()) && rule.body != null) {
                    respBody = rule.body.getBytes(UTF8);
                    rec.put("resp_body", core.redactBody(rule.body));
                    diff = "body " + beforeBody.length() + "B -> " + rule.body.length() + "B";
                } else if (NetCaptureCore.ACT_HEADER.equals(rule.canonicalAction()) && rule.headerName != null) {
                    respHeaders.put(rule.headerName.toLowerCase(Locale.US), rule.headerValue);
                    diff = "header " + rule.headerName + " set";
                } else {
                    diff = "noop";
                }
                core.noteRuleHit(rule.id, beforeBody, new String(respBody, UTF8), diff);
                rec.put("rule_diff", diff);
                rec.put("status", status);
            }

            StringBuilder out = new StringBuilder();
            out.append("HTTP/1.1 ").append(status).append(' ').append(reasonOf(status)).append("\r\n");
            for (Map.Entry<String, String> e : respHeaders.entrySet()) {
                String k = e.getKey();
                if ("connection".equals(k) || "content-length".equals(k)
                        || "transfer-encoding".equals(k)) continue;
                out.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
            out.append("Content-Length: ").append(respBody.length).append("\r\n");
            out.append("Connection: close\r\n\r\n");
            cout.write(out.toString().getBytes(UTF8));
            cout.write(respBody);
            cout.flush();
            record(rec, t0);
        } catch (Throwable e) {
            // 记录时机修正：请求侧已经解析完（头/体都已脱敏）时，rec 一定非空。
            // 旧实现在这里新建一条只有 error/detail 的记录，把「谁访问了哪个 URL、
            // 带了什么头（已打码）」全丢了——T17 实测里表现为记录里只剩
            // {"error":"proxy_error","detail":"Broken pipe"}，没有一个字段能证明抓到了什么。
            // 现在复用 rec 补上失败原因，请求侧事实完整保留。
            try {
                if (rec != null) {
                    rec.put("error", e instanceof SocketTimeoutException
                            ? "upstream_timeout" : "proxy_error");
                    rec.put("detail", String.valueOf(e.getMessage()));
                    record(rec, t0);
                } else {
                    JSONObject bare = new JSONObject();
                    bare.put("ts", System.currentTimeMillis());
                    bare.put("error", "proxy_error");
                    bare.put("detail", String.valueOf(e.getMessage()));
                    record(bare, t0);
                }
            } catch (Throwable ignored) {
            }
        } finally {
            closeQuietly(upstream);
        }
    }

    /** 入库前盖上耗时：任务书的自记录面是 method/host/path/status/耗时/字节数。 */
    private void record(JSONObject rec, long t0) throws JSONException {
        rec.put("duration_ms", System.currentTimeMillis() - t0);
        core.record(rec);
    }

    /** 连接级失败（请求行都没解析出来）也要留一行，否则「没有记录」无法解释。 */
    private void recordFailure(long t0, Throwable e) {
        try {
            JSONObject bare = new JSONObject();
            bare.put("ts", t0);
            bare.put("error", "proxy_error");
            bare.put("detail", String.valueOf(e.getMessage()));
            record(bare, t0);
        } catch (Throwable ignored) {
        }
    }

    private static javax.net.ssl.SSLContext upstreamTlsContext() throws Exception {
        // trust-all，理由见 handleExchange 里那段注释：调试档的上游腿不校验证书，
        // 记录里带 upstream_tls_verified=false。
        javax.net.ssl.SSLContext c = javax.net.ssl.SSLContext.getInstance("TLS");
        c.init(null, new javax.net.ssl.TrustManager[]{
                new javax.net.ssl.X509TrustManager() {
                    public void checkClientTrusted(
                            java.security.cert.X509Certificate[] chain, String auth) {
                    }

                    public void checkServerTrusted(
                            java.security.cert.X509Certificate[] chain, String auth) {
                    }

                    public java.security.cert.X509Certificate[] getAcceptedIssuers() {
                        return new java.security.cert.X509Certificate[0];
                    }
                }
        }, null);
        return c;
    }

    private void tunnel(Socket client, String host, int port) {
        Socket up = null;
        try {
            up = new Socket();
            if (protector != null) protector.protect(up);
            up.setSoTimeout(IO_TIMEOUT_MS);
            up.connect(new InetSocketAddress(host, port), IO_TIMEOUT_MS);
            final Socket u = up;
            final Socket c = client;
            Thread back = new Thread(new Runnable() {
                @Override
                public void run() {
                    pump(u, c);
                    closeQuietly(c);
                }
            }, "khy-net-proxy-tunnel");
            back.setDaemon(true);
            back.start();
            pump(c, u);
        } catch (IOException ignored) {
        } finally {
            closeQuietly(up);
        }
    }

    private static void pump(Socket from, Socket to) {
        byte[] buf = new byte[8192];
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                out.flush();
            }
        } catch (IOException ignored) {
        }
    }

    // ==================== 解析工具 ====================

    private static JSONObject baseRecord(long t0, String method, String host, int port, String path)
            throws JSONException {
        JSONObject rec = new JSONObject();
        rec.put("ts", t0);
        rec.put("method", method);
        rec.put("host", host);
        rec.put("port", port);
        rec.put("path", path);
        return rec;
    }

    private static JSONObject toJson(Map<String, String> headers) throws JSONException {
        JSONObject o = new JSONObject();
        for (Map.Entry<String, String> e : headers.entrySet()) {
            o.put(e.getKey(), e.getValue());
        }
        return o;
    }

    /** 读 HTTP 头（到空行为止）。返回含结尾空行的原始字节。 */
    /**
     * 原样把 in 的剩余字节推给 out。
     *
     * WHY IT EXISTS. 明文分支本来可以复用 {@link #pump(Socket, Socket)}，但那条路
     * 要两个 Socket；chunked 透传时手上只有流。为不改既有 tunnel 的语义，单开一个
     * 流对流的版本，行为一致（读到 EOF 为止，异常即停）。
     */
    private static void pumpStream(InputStream in, OutputStream out) {
        byte[] buf = new byte[8192];
        try {
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                out.flush();
            }
        } catch (IOException ignored) {
        }
    }

    static byte[] readHead(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        int state = 0; // 0:\r 1:\r\n 2:\r\n\r 3:\r\n\r\n
        int total = 0;
        while (true) {
            int b = in.read();
            if (b < 0) return bo.size() == 0 ? null : bo.toByteArray();
            bo.write(b);
            total++;
            if (total > MAX_HEADER_BYTES) throw new IOException("header too large");
            if (b == '\r') {
                if (state == 0) state = 1;
                else if (state == 2) state = 3;
                else state = 1;
            } else if (b == '\n') {
                if (state == 1) state = 2;
                else if (state == 3) return bo.toByteArray();
                else state = 0;
            } else {
                state = 0;
            }
        }
    }

    static Map<String, String> parseHeaders(String block) {
        Map<String, String> m = new LinkedHashMap<String, String>();
        String[] lines = block.split("\r\n");
        for (String line : lines) {
            if (line.isEmpty()) continue;
            int c = line.indexOf(':');
            if (c <= 0) continue;
            m.put(line.substring(0, c).trim().toLowerCase(Locale.US), line.substring(c + 1).trim());
        }
        return m;
    }

    static byte[] readBody(InputStream in, int len) throws IOException {
        if (len <= 0) return new byte[0];
        int cap = Math.min(len, MAX_BODY_BYTES);
        byte[] buf = new byte[cap];
        int off = 0;
        while (off < cap) {
            int n = in.read(buf, off, cap - off);
            if (n < 0) break;
            off += n;
        }
        if (off == cap) return buf;
        byte[] out = new byte[off];
        System.arraycopy(buf, 0, out, 0, off);
        return out;
    }

    static byte[] readToEof(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            bo.write(buf, 0, n);
            if (bo.size() > MAX_BODY_BYTES) break;
        }
        return bo.toByteArray();
    }

    static String stripPort(String hostPort) {
        if (hostPort == null) return "";
        String h = hostPort.trim();
        if (h.startsWith("[")) { // [::1]:443
            int e = h.indexOf(']');
            return e > 0 ? h.substring(1, e) : h;
        }
        int c = h.lastIndexOf(':');
        if (c > 0 && h.indexOf(':') == c) return h.substring(0, c);
        return h;
    }

    static int portOf(String hostPort, int dflt) {
        if (hostPort == null) return dflt;
        String h = hostPort.trim();
        int c = h.lastIndexOf(':');
        if (c < 0) return dflt;
        if (h.startsWith("[") && h.indexOf(']') > c) return dflt;
        try {
            return Integer.parseInt(h.substring(c + 1));
        } catch (NumberFormatException e) {
            return dflt;
        }
    }

    static String pathOf(String target) {
        if (target == null) return "/";
        if (target.startsWith("http://") || target.startsWith("https://")) {
            int schemeEnd = target.indexOf("://") + 3;
            int slash = target.indexOf('/', schemeEnd);
            return slash < 0 ? "/" : target.substring(slash);
        }
        return target;
    }

    static String hostOfAbsolute(String target) {
        if (target == null) return "";
        int schemeEnd = target.indexOf("://");
        if (schemeEnd < 0) return "";
        int start = schemeEnd + 3;
        int slash = target.indexOf('/', start);
        String hp = slash < 0 ? target.substring(start) : target.substring(start, slash);
        return stripPort(hp);
    }

    static int statusOf(String statusLine) {
        try {
            String[] p = statusLine.split(" ");
            return p.length > 1 ? Integer.parseInt(p[1]) : 0;
        } catch (Throwable e) {
            return 0;
        }
    }

    static int intOf(String v, int dflt) {
        try {
            return v == null ? dflt : Integer.parseInt(v.trim());
        } catch (Throwable e) {
            return dflt;
        }
    }

    static String reasonOf(int status) {
        switch (status) {
            case 200: return "OK";
            case 201: return "Created";
            case 204: return "No Content";
            case 301: return "Moved Permanently";
            case 302: return "Found";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 429: return "Too Many Requests";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            default: return "Status";
        }
    }

    private static void writeSimple(OutputStream out, int status, String json) throws IOException {
        byte[] body = json.getBytes(UTF8);
        String head = "HTTP/1.1 " + status + " " + reasonOf(status) + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(UTF8));
        out.write(body);
        out.flush();
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {
        }
    }
}

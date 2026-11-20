package com.khyos.khy_os_client.bridge;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 断点五的 TLS 调试档（self+tls）：一枚用户 CA + 逐主机叶证书。
 *
 * <p><b>为什么这一档是显式的、且默认不带。</b>解密别人的 TLS 需要往对方的信任
 * 链里插一枚我们自己的 CA。任务书 §10 禁止装系统证书，所以这一档的全部承诺是：
 * CA 由用户自己导出、自己当用户证书装；装了的 App 能被解密，没装的 App 明确
 * 得到「无法解密」——后者由 {@code NetProxy} 记 {@code ca_untrusted}，不伪造成功。
 *
 * <p><b>为什么自己写 DER 而不用 BouncyCastle。</b>release 包里多一个只在调试路径
 * 用到的重依赖不划算，而 X.509 的这一小个用例子集（EC P-256、一个 CN、一个 SAN）
 * 手写不到两百行。每一张签出来的证书都过一遍 JDK 的 {@link CertificateFactory}
 * 再交出来——DER 写错会在这里当场炸，而不是在对方 App 的握手里变成一个
 * 「无法解密」的哑巴故障。
 *
 * <p><b>为什么 CA 不落盘。</b>进程内生成、进程内有效。落盘（哪怕 filesDir）会让
 * 「上次调试留下的 CA」在下次正常运行里继续活着，而没人记得导出过它——那正是
 * 规则不持久化要防的同一类事。代价是重启后要重新导出一次证书，调试档认这个代价。
 *
 * <p><b>上游不校验证书。</b>MITM 代理的上游腿用 trust-all：这一档的用途是看流量，
 * 不是给上游做认证；客户端那一腿的信任决策本来就已经被这一档替换掉了。记录里
 * 带 {@code upstream_tls_verified=false}，不把这件事藏起来。
 */
public final class NetTls {

    private static final String SIG_ALG = "SHA256withECDSA";
    private static final String EC_CURVE = "secp256r1";

    private static final String OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
    private static final String OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
    private static final String OID_PRIME256V1 = "1.2.840.10045.3.1.7";
    private static final String OID_CN = "2.5.4.3";
    private static final String OID_BASIC_CONSTRAINTS = "2.5.29.19";
    private static final String OID_SUBJECT_ALT_NAME = "2.5.29.17";

    private static final long CA_VALIDITY_MS = 3650L * 24L * 3600L * 1000L;   // ~10y
    private static final long LEAF_VALIDITY_MS = 7L * 24L * 3600L * 1000L;    // 7d

    /** 调试 CA 的 CN。叶证书的 issuer 必须是它，否则链接不上（客户端只会看到 PKIX 失败）。 */
    private static final String CA_NAME = "Khy Net Debug CA";

    /** 每宿主缓存一张叶证书；给个上限，别让一台浏览过两百个域的设备把内存吃穿。 */
    private static final int MAX_CACHED_HOSTS = 64;

    private final KeyPair caKey;
    private final X509Certificate caCert;

    /** host -> 该主机的服务端 SSLContext（叶证书 + 私钥）。保序，满了先掉最旧。 */
    private final LinkedHashMap<String, SSLContext> perHost = new LinkedHashMap<String, SSLContext>();

    private NetTls(KeyPair caKey, X509Certificate caCert) {
        this.caKey = caKey;
        this.caCert = caCert;
    }

    // ==================== 生成 ====================

    /**
     * 生成一枚新的调试 CA。失败就抛——调用方（NetCapture.start 的 tls 档）据此把
     * 抓包停在「开不了」，而不是开成一个假的三态。
     */
    public static NetTls create() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec(EC_CURVE), new SecureRandom());
        KeyPair ca = g.generateKeyPair();
        long now = System.currentTimeMillis();
        byte[] der = signCertificate(ca, true, ca, ca.getPublic().getEncoded(),
                CA_NAME, null, now, now + CA_VALIDITY_MS);
        X509Certificate cert = parse(der);
        return new NetTls(ca, cert);
    }

    /** 给某个主机签一张叶证书（带 SAN）并包成服务端 SSLContext。同一主机重复要返回同一份。 */
    public synchronized SSLContext serverContext(String host) throws Exception {
        String h = host == null ? "" : host.toLowerCase(Locale.US).trim();
        SSLContext cached = perHost.get(h);
        if (cached != null) return cached;

        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec(EC_CURVE), new SecureRandom());
        KeyPair leaf = g.generateKeyPair();
        long now = System.currentTimeMillis();
        byte[] der = signCertificate(caKey, false, leaf, leaf.getPublic().getEncoded(),
                h, h, now - 3600_000L, now + LEAF_VALIDITY_MS);
        X509Certificate leafCert = parse(der);
        // 自签自验：叶证书必须能过 CA 公钥的验签。这一步不是形式主义——
        // 手搓 DER 写错时，客户端那一侧的表现是「不信任我们的 CA」，会把
        // NetTls 的 bug 记成 ca_untrusted（用户的配置问题）。在这里先自己抓一遍，
        // 叶证书无效就照抛，装配层把它记成 tls_leaf_invalid，不冤枉客户端。
        leafCert.verify(caCert.getPublicKey());

        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(null, null);
        ks.setKeyEntry("leaf", leaf.getPrivate(), new char[0],
                new java.security.cert.Certificate[]{leafCert});
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(
                KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(ks, new char[0]);
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(kmf.getKeyManagers(), null, null);

        perHost.put(h, ctx);
        while (perHost.size() > MAX_CACHED_HOSTS) {
            String oldest = perHost.keySet().iterator().next();
            perHost.remove(oldest);
        }
        return ctx;
    }

    /** 调试菜单「导出 CA 证书」用：只有证书，永远不含私钥。 */
    public X509Certificate caCert() {
        return caCert;
    }

    public byte[] caCertDer() throws Exception {
        return caCert.getEncoded();
    }

    public String caCertPem() throws Exception {
        // java.util.Base64，不是 android.util.Base64：这个类是纯 JCA，故意不碰
        // Android API——JVM 夹具要能原样跑它。
        String b64 = java.util.Base64.getEncoder().encodeToString(caCertDer());
        return "-----BEGIN CERTIFICATE-----\n" + b64 + "\n-----END CERTIFICATE-----\n";
    }

    // ==================== X.509（手搓 DER，只覆盖本档用到的形状） ====================

    /**
     * 签一张证书。{@code isCa} 时自签（CN=Khy Net Debug CA），否则由 caSigner 签叶证书。
     * subjectSpki 直接复用 EC 公钥的 getEncoded()——它本来就是 X.509 SPKI DER。
     */
    private static byte[] signCertificate(KeyPair caSigner, boolean isCa, KeyPair subject,
                                          byte[] subjectSpki, String cn, String san,
                                          long notBefore, long notAfter) throws Exception {
        byte[] tbs = tbsCertificate(isCa, subjectSpki, cn, san, notBefore, notAfter);
        Signature sig = Signature.getInstance(SIG_ALG);
        sig.initSign(isCa ? subject.getPrivate() : caSigner.getPrivate(), new SecureRandom());
        sig.update(tbs);
        // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
        // —— 三样都在**同一个** SEQUENCE 里。第一版把 tbs 单独包了一层、另两样放在
        // 外面当兄弟节点，JDK 解析到第三项时 DER 就断了（报 "Too short"）。
        ByteArrayOutputStream all = new ByteArrayOutputStream();
        all.write(tbs);
        all.write(seq(oid(OID_ECDSA_SHA256), null_()));   // signatureAlgorithm（一层 SEQUENCE）
        // bitString() 自己就是完整 TLV（03 L 00 <内容>），外面不能再包一层——
        // 第一版双层包装让验签方读到 "Not the correct tag"。
        all.write(bitString(sig.sign()));                  // signatureValue
        return tlv(0x30, all.toByteArray());
    }

    private static byte[] tbsCertificate(boolean isCa, byte[] subjectSpki, String cn, String san,
                                         long notBefore, long notAfter) throws Exception {
        // 各字段按 TLV 依次写进 content，最后**只包一层** SEQUENCE。
        // 第一版在这里栽了两次：先 seq(...) 包一层、外面又 tlv(0x30,...) 包一层，
        // 变成 SEQUENCE { SEQUENCE { ... } }——JDK 从版本号起就全部对错位。
        ByteArrayOutputStream content = new ByteArrayOutputStream();
        content.write(tlv(0xA0, integer(BigInteger.valueOf(2))));       // version v3
        content.write(integer(randomSerial()));                         // serial
        content.write(seq(oid(OID_ECDSA_SHA256), null_()));             // signature alg
        // 签发者：自签时是自己，叶证书时是那枚 CA。第一版在这里写反了（叶证书的
        // issuer 写成了主机名），客户端侧的表现是「PKIX path building failed」——
        // 一条和「CA 不被信任」长得一模一样的错误，而真相是链根本接不上。
        content.write(isCa ? name(cn) : name(CA_NAME));                 // issuer
        content.write(seq(utcTimeDer(notBefore), utcTimeDer(notAfter)));// validity
        content.write(name(cn));                                        // subject
        content.write(seq(seq(oid(OID_EC_PUBLIC_KEY), oid(OID_PRIME256V1)),
                bitString(rawEcPoint(subjectSpki))));                   // SPKI
        ByteArrayOutputStream ext = new ByteArrayOutputStream();
        if (isCa) {
            ext.write(tlv(0x30, seq(oid(OID_BASIC_CONSTRAINTS),
                    tlv(0x04, seq(tlv(0x01, new byte[]{(byte) 0xFF}))))));   // CA:TRUE
        } else {
            ext.write(tlv(0x30, seq(oid(OID_BASIC_CONSTRAINTS),
                    tlv(0x04, seq()))));                                      // CA:FALSE
            if (san != null && !san.isEmpty()) {
                ext.write(tlv(0x30, seq(oid(OID_SUBJECT_ALT_NAME),
                        tlv(0x04, seq(tlv(0x82, san.getBytes(StandardCharsets.US_ASCII)))))));
            }
        }
        content.write(tlv(0xA3, ext.toByteArray()));                   // [3] extensions
        return tlv(0x30, content.toByteArray());
    }

    /**
     * 从 SPKI DER 里取出裸 EC 点（0x04||X||Y）。
     *
     * SPKI = SEQUENCE { SEQUENCE{alg}, BIT STRING { 未用位0, 点 } }。按结构往下走，
     * 不按偏移硬算——偏移写法在换曲线或换库时会静默错位，而错位的表现是对方
     * 握手失败，排查起来像「CA 不被信任」，指向错误的方向。
     *
     * 第一版在这里栽过：跳过长度的同时没跳过算法标识的**内容**，于是把 OID 的
     * 第一个字节当成了 BIT STRING 的 tag。现在按 TLV 逐个走。
     */
    private static byte[] rawEcPoint(byte[] spki) {
        int i = 0;
        if (spki[i++] != 0x30) throw new IllegalStateException("SPKI: outer tag");
        i = skipLen(spki, i);          // i = 算法标识 TLV 的起点
        i = skipTlv(spki, i);          // i = BIT STRING 的 tag
        if (spki[i++] != 0x03) throw new IllegalStateException("SPKI: bitstring tag");
        i = skipLen(spki, i);          // i = 未用位字节
        if (spki[i++] != 0x00) throw new IllegalStateException("SPKI: unused bits");
        byte[] point = new byte[spki.length - i];
        System.arraycopy(spki, i, point, 0, point.length);
        return point;
    }

    /** 跳过长度字段，返回内容起点。 */
    private static int skipLen(byte[] b, int i) {
        int n = b[i++] & 0xFF;
        if (n < 0x80) return i;
        return i + (n & 0x7F);
    }

    /** 跳过一整个 TLV（tag + 长度 + 内容），返回下一个 TLV 的起点。 */
    private static int skipTlv(byte[] b, int i) {
        i++;                            // tag
        int n = b[i++] & 0xFF;          // 长度
        int content = (n < 0x80) ? n : readLongLen(b, i, n & 0x7F);
        i += (n < 0x80) ? 0 : (n & 0x7F);
        return i + content;
    }

    private static int readLongLen(byte[] b, int i, int bytes) {
        int v = 0;
        for (int k = 0; k < bytes; k++) v = (v << 8) | (b[i + k] & 0xFF);
        return v;
    }

    private static X509Certificate parse(byte[] der) throws Exception {
        // 交出去之前先让 JDK 解一遍：DER 写错在这里炸，别等到对方 App 的握手里。
        return (X509Certificate) CertificateFactory.getInstance("X.509")
                .generateCertificate(new java.io.ByteArrayInputStream(der));
    }

    private static BigInteger randomSerial() {
        byte[] b = new byte[12];
        new SecureRandom().nextBytes(b);
        b[0] &= 0x3F; // 保证正数
        return new BigInteger(1, b);
    }

    /** Name ::= RDNSequence ::= SEQUENCE OF SET OF SEQUENCE { OID, UTF8String }。 */
    private static byte[] name(String cn) throws Exception {
        return seq(set(seq(oid(OID_CN), utf8(cn))));
    }

    private static String utcTimeString(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyMMddHHmmss", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms)) + "Z";
    }

    /** UTCTime 的 DER 形态：0x17 + 长度 + "yyMMddHHmmss'Z'"。 */
    private static byte[] utcTimeDer(long ms) throws Exception {
        return tlv(0x17, utcTimeString(ms).getBytes(StandardCharsets.US_ASCII));
    }

    // ---- DER 原语 ----

    private static byte[] tlv(int tag, byte[] content) throws Exception {
        int len = content.length;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(tag);
        if (len < 128) {
            out.write(len);
        } else if (len < 256) {
            out.write(0x81);
            out.write(len);
        } else if (len < 65536) {
            out.write(0x82);
            out.write((len >> 8) & 0xFF);
            out.write(len & 0xFF);
        } else {
            out.write(0x83);
            out.write((len >> 16) & 0xFF);
            out.write((len >> 8) & 0xFF);
            out.write(len & 0xFF);
        }
        out.write(content);
        return out.toByteArray();
    }

    private static byte[] seq(byte[]... items) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] it : items) out.write(it);
        return tlv(0x30, out.toByteArray());
    }

    private static byte[] set(byte[]... items) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] it : items) out.write(it);
        return tlv(0x31, out.toByteArray());
    }

    private static byte[] integer(BigInteger v) throws Exception {
        return tlv(0x02, v.toByteArray());
    }

    private static byte[] null_() throws Exception {
        return new byte[]{0x05, 0x00};
    }

    private static byte[] oid(String dotted) throws Exception {
        String[] parts = dotted.split("\\.");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(Integer.parseInt(parts[0]) * 40 + Integer.parseInt(parts[1]));
        for (int i = 2; i < parts.length; i++) {
            int v = Integer.parseInt(parts[i]);
            if (v < 128) {
                out.write(v);
                continue;
            }
            ByteArrayOutputStream tmp = new ByteArrayOutputStream();
            tmp.write(v & 0x7F);
            v >>= 7;
            while (v > 0) {
                tmp.write((v & 0x7F) | 0x80);
                v >>= 7;
            }
            byte[] b = tmp.toByteArray();
            for (int j = b.length - 1; j >= 0; j--) out.write(b[j]);
        }
        return tlv(0x06, out.toByteArray());
    }

    private static byte[] utf8(String s) throws Exception {
        return tlv(0x0C, s.getBytes(StandardCharsets.UTF_8));
    }

    private static byte[] bitString(byte[] content) throws Exception {
        byte[] withUnused = new byte[content.length + 1];
        withUnused[0] = 0; // 未用位数
        System.arraycopy(content, 0, withUnused, 1, content.length);
        return tlv(0x03, withUnused);
    }
}

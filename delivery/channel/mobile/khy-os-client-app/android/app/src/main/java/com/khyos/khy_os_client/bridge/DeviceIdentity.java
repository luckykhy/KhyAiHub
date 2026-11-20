package com.khyos.khy_os_client.bridge;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;

/**
 * 设备身份：一把只存在于 App 私有目录的私钥，加上由它签发的 PC 证书。
 *
 * <h2>为什么要有这个类</h2>
 * 断点二的现状是「身份双轨」：桥的 Bearer token 是 32 位十六进制，躺在
 * {@code /sdcard/bridge-amoobridge/token.txt}。那意味着任何拿到存储权限的 App、
 * 任何 adb shell、任何插在同一根线上的 PC 都能读到它——「持有桥令牌」因此从来
 * 不是一句关于「谁在调用」的强主张。同时包里还有内置的 {@code sk-} 常量（现已
 * 清空，见 built_in_keys.dart），那是第二条身份来源。
 *
 * 这里把身份收成一条：设备首启生成 EC P-256 密钥对，<b>私钥只写 App 私有目录</b>；
 * 对外只出示公钥与「我用私钥签过这段」的签名。PC 侧要调用桥，必须先凭一次性码
 * 配对，拿到一张由这把私钥签发的短期证书，之后每次请求出示证书。
 *
 * <h2>为什么私钥落盘位置要自己算，而不是接一个路径参数</h2>
 * 位置谓词和位置本身必须是同一段代码。分开写的话，一个「正确拒绝 /sdcard」的
 * 谓词可以和一个照样往 /sdcard 写私钥的写入点并排存在——那种组合在评审里看起来
 * 是对的，运行时一次都不会拦住。所以 {@link #keyFile(Context)} 是唯一出口，
 * {@link #status(Context)} 每次把实际路径与「是否私有」一起报出去，供 adb 复核。
 *
 * <h2>证书形状</h2>
 * {@code {"v":1,"device_id":"…","pc_key":"…","issued_at":ms,"expires_at":ms,"sig":"b64"}}
 * 签名覆盖 {@code v|device_id|pc_key|issued_at|expires_at}（{@link #canonical}）。
 * 校验方用**设备自己的公钥**验签，所以证书不需要任何第三方 CA：签发者就是校验者。
 *
 * <p>纯函数边界：所有接受 {@code now} 的方法都由调用方给时间，自己不读时钟，
 * 这样过期规则在 JVM 上可证。
 */
public final class DeviceIdentity {

    private static final String TAG = "DeviceIdentity";

    /** 私钥文件名。扩展名只是给人看的，内容是 PKCS#8 的 base64。 */
    static final String KEY_FILE = "amoo_key.pem";

    /** 服务端签发的设备证书（设备 → 服务端方向用）。 */
    static final String DEVICE_CERT_FILE = "amoo_device_cert.json";

    /** 证书版本。改形状就加一，旧版本一律拒——不做向后兼容的猜测。 */
    static final int CERT_VERSION = 1;

    /** PC 证书默认寿命：24 小时，与 AmooIdentitySpec.certLifetime 同数。 */
    static final long PC_CERT_TTL_MS = 24L * 60L * 60L * 1000L;

    // ── 拒因码（K-23 口径；与 AmooIdentitySpec 的两条对齐）──────────────
    static final String ERR_CERT_INVALID = "cert_invalid";
    static final String ERR_CREDENTIAL_EXPIRED = "credential_expired";
    static final String ERR_DEVICE_MISMATCH = "device_mismatch";
    static final String ERR_PAIRING_REQUIRED = "pairing_required";

    private static volatile KeyPair keyPair;
    private static volatile String deviceId = "";

    private DeviceIdentity() {}

    // ── 密钥对 ────────────────────────────────────────────────────────────

    /**
     * 私钥的唯一落点：App 私有目录下的 {@code amoo_key.pem}。
     *
     * <p>用 {@code getFilesDir()} 而不是外部存储：前者是 {@code /data/user/0/<pkg>/files}，
     * 只有本 App（和 root）读得到；后者在 /sdcard 上，任何有存储权限的进程都读得到。
     */
    static File keyFile(Context ctx) {
        return new File(ctx.getFilesDir(), KEY_FILE);
    }

    /** 首启生成、之后复用。失败返回 null（调用方据此报 identity_unavailable，不静默降级）。 */
    public static synchronized KeyPair ensureKeyPair(Context ctx) {
        if (keyPair != null) return keyPair;
        File f = keyFile(ctx);
        try {
            if (f.isFile()) {
                byte[] der = Base64.decode(readText(f).trim(), Base64.DEFAULT);
                PrivateKey priv = KeyFactory.getInstance("EC")
                        .generatePrivate(new PKCS8EncodedKeySpec(der));
                // 公钥从私钥反推：PKCS#8 的 EC 私钥里带着公钥点，但 JDK 不保证
                // 每个实现都暴露它，所以这里用「重新生成会换 key」的代价换确定性——
                // 改成：私钥在盘上就用它签名，公钥单独存一份。
                PublicKey pub = readPublicKey(ctx);
                if (pub == null) {
                    Log.w(TAG, "私钥在盘上但公钥缺失：身份不可用（不重新生成，避免静默换身份）");
                    return null;
                }
                keyPair = new KeyPair(pub, priv);
                deviceId = computeDeviceId(pub);
                return keyPair;
            }
            KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
            g.initialize(new ECGenParameterSpec("secp256r1"));
            KeyPair kp = g.generateKeyPair();
            writePrivate(ctx, kp.getPrivate().getEncoded());
            writePublic(ctx, kp.getPublic().getEncoded());
            keyPair = kp;
            deviceId = computeDeviceId(kp.getPublic());
            Log.i(TAG, "已生成设备密钥对 device_id=" + deviceId);
            return kp;
        } catch (Throwable t) {
            Log.w(TAG, "密钥对不可用: " + t);
            return null;
        }
    }

    private static File pubFile(Context ctx) {
        return new File(ctx.getFilesDir(), "amoo_key.pub");
    }

    private static void writePrivate(Context ctx, byte[] der) throws Exception {
        File f = keyFile(ctx);
        // MODE_PRIVATE：同 uid 才可读。这不是装饰——它是这条身份链的地基。
        try (FileOutputStream out = ctx.openFileOutput(KEY_FILE, Context.MODE_PRIVATE)) {
            out.write(Base64.encodeToString(der, Base64.NO_WRAP).getBytes(StandardCharsets.UTF_8));
            out.flush();
        }
        // 显式收紧权限位：某些 ROM 的 umask 会让新文件带上组读。
        //noinspection ResultOfMethodCallIgnored
        f.setReadable(false, false);
        f.setReadable(true, true);
        f.setWritable(false, false);
        f.setWritable(true, true);
    }

    private static void writePublic(Context ctx, byte[] der) throws Exception {
        try (FileOutputStream out = ctx.openFileOutput("amoo_key.pub", Context.MODE_PRIVATE)) {
            out.write(Base64.encodeToString(der, Base64.NO_WRAP).getBytes(StandardCharsets.UTF_8));
        }
    }

    private static PublicKey readPublicKey(Context ctx) {
        try {
            File f = pubFile(ctx);
            if (!f.isFile()) return null;
            byte[] der = Base64.decode(readText(f).trim(), Base64.DEFAULT);
            return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der));
        } catch (Throwable t) {
            return null;
        }
    }

    private static String readText(File f) throws Exception {
        byte[] buf = new byte[(int) f.length()];
        try (FileInputStream in = new FileInputStream(f)) {
            int off = 0;
            while (off < buf.length) {
                int n = in.read(buf, off, buf.length - off);
                if (n <= 0) break;
                off += n;
            }
        }
        return new String(buf, StandardCharsets.UTF_8);
    }

    /**
     * device_id = 公钥 DER 的 SHA-256 前 16 位十六进制。
     *
     * <p>不用 ANDROID_ID：那是系统给的、跨 App 可读的标识，拿它当身份等于把
     * 「设备是谁」交给一个别人也能读的字段。用公钥指纹则是自证的——换密钥就换
     * 身份，卸载重装后旧证书自然对不上（T6 要的正是这个）。
     */
    static String computeDeviceId(PublicKey pub) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(pub.getEncoded());
        StringBuilder sb = new StringBuilder(16);
        for (int i = 0; i < 8; i++) {
            sb.append(String.format("%02x", d[i]));
        }
        return sb.toString();
    }

    public static String deviceId() {
        return deviceId == null ? "" : deviceId;
    }

    public static String publicKeyB64(Context ctx) {
        KeyPair kp = ensureKeyPair(ctx);
        if (kp == null) return "";
        return Base64.encodeToString(kp.getPublic().getEncoded(), Base64.NO_WRAP);
    }

    /** 用设备私钥签一段文本，返回 base64(DER ECDSA)。 */
    public static String signB64(Context ctx, String data) {
        KeyPair kp = ensureKeyPair(ctx);
        if (kp == null) return "";
        try {
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initSign(kp.getPrivate());
            s.update(data.getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(s.sign(), Base64.NO_WRAP);
        } catch (Throwable t) {
            Log.w(TAG, "签名失败: " + t);
            return "";
        }
    }

    // ── PC 证书：设备签发、设备校验 ───────────────────────────────────────

    static String canonical(String deviceId, String pcKey, long issuedAt, long expiresAt) {
        return CERT_VERSION + "|" + deviceId + "|" + pcKey + "|" + issuedAt + "|" + expiresAt;
    }

    /**
     * 给一张 PC 公钥签一张短期证书。
     *
     * <p>证书本身不是秘密（它就是公钥 + 签名），可以放在任何地方；秘密只有
     * 设备私钥，而它从不出私有目录。这一点是整条链能成立的前提：把证书抄走
     * 没有意义，因为对方出示证书时我们验的是「这确实是我签的」，而签名无法伪造。
     */
    public static JSONObject issuePcCert(Context ctx, String pcKeyB64, long ttlMs, long now) {
        JSONObject out = new JSONObject();
        // JSONObject.put 抛受检 JSONException：错误对象风格要求「失败也返回
        // {ok:false,code}」而不是把受检异常撒给调用方——整个方法体兜一层。
        // 早退路径语义不变；status() 就是这个兜法。
        try {
            KeyPair kp = ensureKeyPair(ctx);
            if (kp == null) {
                return out.put("ok", false).put("code", "identity_unavailable");
            }
            String key = pcKeyB64 == null ? "" : pcKeyB64.trim();
            if (key.isEmpty()) {
                return out.put("ok", false).put("code", "pc_key_required");
            }
            long ttl = ttlMs > 0 ? ttlMs : PC_CERT_TTL_MS;
            long issued = now;
            long expires = now + ttl;
            String sig = signB64(ctx, canonical(deviceId, key, issued, expires));
            if (sig.isEmpty()) {
                return out.put("ok", false).put("code", "sign_failed");
            }
            return out.put("ok", true)
                    .put("v", CERT_VERSION)
                    .put("device_id", deviceId)
                    .put("pc_key", key)
                    .put("issued_at", issued)
                    .put("expires_at", expires)
                    .put("sig", sig);
        } catch (Throwable t) {
            // catch 块里的 put 本身也可能抛：再兜一层，实在不行返回裸 out——
            // 调用方按 optBoolean("ok", false) 读，缺键即失败。
            try {
                out.put("ok", false).put("code", "encode_failed");
            } catch (Throwable ignored) {
            }
            return out;
        }
    }

    /**
     * 校验一张 PC 证书。
     *
     * <p>顺序：形状 → 设备归属 → 签名 → 过期。签名放在过期之前，是因为一张
     * 签名都不对的证书说「已过期」是在泄漏信息（等于告诉伪造者「你只要改时间
     * 就对了」）。
     *
     * @return {@code {ok:true, pc_key}} 或 {@code {ok:false, code}}，code 取
     *         {@link #ERR_CERT_INVALID} / {@link #ERR_DEVICE_MISMATCH} /
     *         {@link #ERR_CREDENTIAL_EXPIRED}。
     */
    public static JSONObject verifyPcCert(Context ctx, JSONObject cert, long now) {
        JSONObject out = new JSONObject();
        // 同 issuePcCert：put 的受检异常兜成 {ok:false,code}，早退路径语义不变。
        try {
            KeyPair kp = ensureKeyPair(ctx);
            if (kp == null) return out.put("ok", false).put("code", "identity_unavailable");
            if (cert == null) return out.put("ok", false).put("code", ERR_CERT_INVALID);

            int v = cert.optInt("v", 0);
            String did = cert.optString("device_id", "");
            String key = cert.optString("pc_key", "");
            long issued = cert.optLong("issued_at", 0L);
            long expires = cert.optLong("expires_at", 0L);
            String sig = cert.optString("sig", "");
            if (v != CERT_VERSION || did.isEmpty() || key.isEmpty() || issued <= 0
                    || expires <= issued || sig.isEmpty()) {
                return out.put("ok", false).put("code", ERR_CERT_INVALID);
            }
            if (!did.equals(deviceId)) {
                // 换了密钥（卸载重装、清数据）之后旧证书落这里：设备已经不是签发它的
                // 那台设备了。给单独一个码，别和「伪造」混成一个。
                return out.put("ok", false).put("code", ERR_DEVICE_MISMATCH);
            }
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(kp.getPublic());
            s.update(canonical(did, key, issued, expires).getBytes(StandardCharsets.UTF_8));
            if (!s.verify(Base64.decode(sig, Base64.DEFAULT))) {
                return out.put("ok", false).put("code", ERR_CERT_INVALID);
            }
            if (now >= expires) {
                return out.put("ok", false).put("code", ERR_CREDENTIAL_EXPIRED);
            }
            return out.put("ok", true).put("pc_key", key);
        } catch (Throwable t) {
            // 同上：catch 内的 put 也要兜一层。
            try {
                out.put("ok", false).put("code", ERR_CERT_INVALID);
            } catch (Throwable ignored) {
            }
            return out;
        }
    }

    // ── 状态（供 adb 复核，不返回任何私钥材料）───────────────────────────

    public static JSONObject status(Context ctx) {
        JSONObject out = new JSONObject();
        try {
            KeyPair kp = ensureKeyPair(ctx);
            File kf = keyFile(ctx);
            String path = kf.getAbsolutePath();
            boolean exists = kf.isFile();
            // 「是不是私有目录」的判据写在这里而不是抄一份谓词：目录前缀就是答案。
            String filesDir = ctx.getFilesDir().getAbsolutePath();
            boolean privateLoc = path.startsWith(filesDir + "/")
                    && (filesDir.startsWith("/data/user/") || filesDir.startsWith("/data/data/"));
            out.put("ok", kp != null)
                    .put("device_id", deviceId)
                    .put("has_key", kp != null)
                    .put("key_path", path)
                    .put("key_exists", exists)
                    .put("key_private_location", privateLoc)
                    .put("key_bytes", exists ? kf.length() : 0)
                    .put("public_key_b64", kp == null ? "" : publicKeyB64(ctx))
                    .put("cert_ttl_ms", PC_CERT_TTL_MS);
        } catch (Throwable t) {
            try {
                out.put("ok", false).put("code", "identity_unavailable").put("why", String.valueOf(t));
            } catch (Throwable ignored) {}
        }
        return out;
    }

    /** 仅供测试与迁移：清掉内存缓存（不动盘上文件）。 */
    static synchronized void resetCache() {
        keyPair = null;
        deviceId = "";
    }
}

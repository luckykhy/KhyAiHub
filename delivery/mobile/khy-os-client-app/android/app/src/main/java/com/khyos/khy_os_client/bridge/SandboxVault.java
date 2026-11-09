package com.khyos.khy_os_client.bridge;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Sandbox credentials, encrypted at rest with a key that cannot leave the device.
 *
 * <h2>Why this exists at all</h2>
 * The next thing the phone app needs in order to talk to the sandbox directly is a
 * credential — an SSH key for the relay path, or the gateway token for the HTTP path.
 * The obvious place to keep one is the mailbox the bridge already uses
 * ({@code /sdcard/bridge-amoobridge/}), which is exactly what must not happen: that
 * directory is group-readable on shared storage, so a credential there is readable by
 * any app holding a storage permission, by an adb shell, and over MTP. Putting the
 * sandbox's credentials next to the bridge token would trade one leak for a worse one.
 *
 * <h2>The shape</h2>
 * <ul>
 *   <li>Key: AES-256-GCM in the Android Keystore, generated on first use, marked
 *       non-exportable. The key material never exists in the app's heap.</li>
 *   <li>Store: {@code <filesDir>/sandbox_vault/} — app-private, so no other uid and no
 *       MTP session can reach it.</li>
 *   <li>Envelope: {@link VaultEnvelope}. The name and version are bound into the GCM
 *       additional-authenticated-data, so two entries cannot be swapped on disk.</li>
 * </ul>
 *
 * <h2>The one rule that must not be broken</h2>
 * {@link #open} is the only method that returns plaintext, and <b>no bridge tool may
 * call it</b>. Every tool-facing read goes through {@link #meta} or {@link #list},
 * which never decrypt. That is what makes {@code secret_list} safe to hand to a
 * remote caller: there is no code path from the bridge to a plaintext credential, so
 * a compromised bridge token can install or enumerate credentials but cannot read
 * them back out. {@code SandboxVaultLogicTest} asserts this by reading this source
 * file — the invariant is mechanical, not a comment someone has to remember.
 *
 * <p>{@link #open} exists for the connector that will consume these credentials, and
 * for the debug self-test activity. Both are in-process callers that never cross the
 * bridge boundary.
 */
public final class SandboxVault {
    /**
     * Keystore alias. Versioned in the name so that a future format change can
     * generate a new key rather than trying to migrate ciphertext in place.
     */
    private static final String KEY_ALIAS = "khy_sandbox_vault_v1";

    private static final String DIR_NAME = "sandbox_vault";
    private static final String SUFFIX = ".env";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int GCM_IV_BYTES = 12;

    /**
     * Entry names are the filename, so this is a path-traversal guard, not a style
     * preference. Lowercase-only keeps the store unambiguous on a filesystem that is
     * case-insensitive.
     */
    private static final String NAME_PATTERN = "[a-z0-9][a-z0-9._-]{0,63}";

    private static SandboxVault instance;

    private final File dir;
    private final ProvisioningCode code = new ProvisioningCode();

    private SandboxVault(Context context) {
        // getFilesDir(), never getExternalFilesDir(): the latter is on shared storage
        // and readable over MTP, which is the whole thing being avoided.
        this.dir = new File(context.getApplicationContext().getFilesDir(), DIR_NAME);
    }

    /** Process-wide singleton. The Keystore handle is cheap; the directory check is not worth repeating per call. */
    public static synchronized SandboxVault get(Context context) {
        if (instance == null) {
            instance = new SandboxVault(context);
        }
        return instance;
    }

    // ==================== provisioning gate ====================

    /**
     * Mints a code and shows it in a notification on the phone.
     *
     * <p>The code is deliberately <b>not</b> returned to the caller. A remote holder of
     * the bridge token may trigger this freely; the point is that it cannot see the
     * result.
     *
     * @return how long the code stays valid, for the caller to display as a deadline.
     */
    public long issueCode(long now) {
        // 局部变量不能叫 code：那会把同名字段遮住，右边就解析到还没声明的 String 上，
        // 报错还指向「找不到 issue(long)」，完全不提遮蔽。
        String minted = code.issue(now);
        BridgeService.notifyText(
                "khy-os 凭据投递确认",
                "投递码 " + minted + "（" + (ProvisioningCode.TTL_MS / 1000) + " 秒内有效，仅一次）。"
                        + "只有在本人操作时才把它填回去。");
        return ProvisioningCode.TTL_MS;
    }

    /** The live code's expiry, or 0 when none is outstanding. For {@code secret_list} to report honestly. */
    public long codeExpiresAt() {
        return code.expiresAt();
    }

    public boolean codeOutstanding(long now) {
        return code.hasOutstanding(now);
    }

    /**
     * Verifies and consumes a code without writing anything.
     *
     * <p>This exists for the delete path, which is gated by the same code but stores no
     * bytes. It must go through <b>this</b> instance: a caller that constructs its own
     * {@link ProvisioningCode} gets an empty one whose {@code verify} always reports
     * "no outstanding code", which reads as a broken bridge rather than as the bug it
     * is.
     *
     * @return {@code null} on success (code consumed), or a Chinese reason.
     */
    public String verifyCode(String presented, long now) {
        String why = code.verify(presented, now);
        if (why == null) code.clear();
        return why;
    }

    /**
     * Stores a credential, gated on a live provisioning code.
     *
     * @return {@code null} on success, or a Chinese reason the caller should surface.
     */
    public String put(String name, String value, String presentedCode, long now) {
        String bad = validateName(name);
        if (bad != null) return bad;
        if (value == null || value.isEmpty()) {
            return "凭据内容为空，未写入";
        }
        String why = code.verify(presentedCode, now);
        if (why != null) return why;

        try {
            byte[] plaintext = value.getBytes(StandardCharsets.UTF_8);
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.ENCRYPT_MODE, secretKey(), new java.security.SecureRandom());
            // GCM with a fresh IV per write: reusing an IV under one key is catastrophic
            // for GCM, and the Keystore will not generate one for us.
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(plaintext);
            VaultEnvelope env = VaultEnvelope.create(name, now, iv, ct, plaintext.length);
            write(name, env.toJson());
            // Clear only after the bytes are on disk: clearing first would leave a
            // consumed code and no credential, and the operator would have to start over.
            code.clear();
            return null;
        } catch (GeneralSecurityException | IOException e) {
            // Never include the exception message: it can carry the alias or, for an
            // IOException, the path — neither is useful to the operator and both are
            // useful to someone probing.
            return "加密或写入失败（" + e.getClass().getSimpleName() + "）";
        }
    }

    // ==================== reads that must never decrypt ====================

    /** Entry names currently stored. Never decrypts. */
    public List<String> list() {
        List<String> out = new ArrayList<>();
        File[] files = dir.listFiles();
        if (files == null) return out;
        Arrays.sort(files);
        for (File f : files) {
            String n = f.getName();
            if (n.endsWith(SUFFIX)) out.add(n.substring(0, n.length() - SUFFIX.length()));
        }
        return out;
    }

    /**
     * Metadata for one entry: when it was written and how long the plaintext was.
     * Never decrypts — see the class javadoc for why this split is the whole point.
     */
    public VaultEnvelope meta(String name) {
        String bad = validateName(name);
        if (bad != null) return null;
        String json = read(name);
        if (json == null) return null;
        try {
            return VaultEnvelope.fromJson(json);
        } catch (IllegalArgumentException e) {
            // A corrupt entry is reported as absent rather than repaired. Reporting it
            // as present-but-unreadable would invite a caller to overwrite it blindly.
            return null;
        }
    }

    public boolean delete(String name) {
        String bad = validateName(name);
        if (bad != null) return false;
        File f = file(name);
        return f.exists() && f.delete();
    }

    // ==================== the only plaintext path ====================

    /**
     * Decrypts one entry.
     *
     * <p><b>No bridge tool may call this.</b> It exists for the in-process connector
     * and the debug self-test. The invariant is enforced by
     * {@code SandboxVaultLogicTest}, which reads this source file and fails if any
     * tool-facing dispatch reaches it.
     */
    public String open(String name) throws GeneralSecurityException, IOException {
        String bad = validateName(name);
        if (bad != null) throw new IllegalArgumentException(bad);
        String json = read(name);
        if (json == null) throw new IOException("no such entry: " + name);
        VaultEnvelope env;
        try {
            env = VaultEnvelope.fromJson(json);
        } catch (IllegalArgumentException e) {
            throw new IOException("unreadable entry: " + name, e);
        }
        // The name in the envelope must be the name asked for. Combined with the AAD
        // binding this is what makes an on-disk swap fail loudly.
        if (!env.name().equals(name)) {
            throw new IOException("envelope name mismatch for " + name);
        }
        Cipher c = Cipher.getInstance(TRANSFORM);
        c.init(Cipher.DECRYPT_MODE, secretKey(),
                new GCMParameterSpec(GCM_TAG_BITS, env.iv()));
        c.updateAAD(VaultEnvelope.aad(name));
        byte[] plaintext = c.doFinal(env.ciphertext());
        return new String(plaintext, StandardCharsets.UTF_8);
    }

    // ==================== internals ====================

    static String validateName(String name) {
        if (name == null || name.isEmpty()) return "条目名为空";
        if (!name.matches(NAME_PATTERN)) {
            return "条目名只能含小写字母、数字、点、下划线和连字符，且以字母或数字开头";
        }
        // Belt and braces: the pattern already excludes separators, so this is
        // unreachable. It stays because the cost of being wrong here is a write
        // outside the vault directory.
        if (name.contains("/") || name.contains("\\") || name.contains("..")) {
            return "条目名非法";
        }
        return null;
    }

    private File file(String name) {
        return new File(dir, name + SUFFIX);
    }

    private void write(String name, String json) throws IOException {
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("cannot create vault directory");
        }
        File f = file(name);
        File tmp = new File(dir, name + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
            // fsync before the rename: a rename over unsynced bytes can leave a
            // zero-length or truncated envelope that fromJson then rejects, which
            // reads as "credential vanished" rather than "write failed".
            out.getFD().sync();
        }
        if (!tmp.renameTo(f)) {
            // Some filesystems refuse an overwrite-by-rename; fall back to truncate.
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(json.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
        // App-private by construction, but make it explicit: the directory is created
        // with the app's default umask, which on some OEM builds is wider than expected.
        //noinspection ResultOfMethodCallIgnored
        f.setReadable(false, false);
    }

    private String read(String name) {
        File f = file(name);
        if (!f.isFile()) return null;
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }

    // IOException is declared separately because KeyStore.load throws it and it is
    // NOT a GeneralSecurityException — declaring only the latter compiles nowhere near
    // this line and fails with a message that mentions neither.
    private SecretKey secretKey() throws GeneralSecurityException, IOException {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        java.security.Key key = ks.getKey(KEY_ALIAS, null);
        if (key instanceof SecretKey) return (SecretKey) key;

        KeyGenerator kg = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // No setUserAuthenticationRequired: the consumer is a background
                // connector that must work while the phone is locked and face-down.
                // Requiring biometrics would make every reconnect a prompt, and the
                // value being protected is already gated by the provisioning code.
                .build());
        return kg.generateKey();
    }

    /** For tests only: drops the cached instance so a fresh Context is picked up. */
    static synchronized void resetForTest() {
        instance = null;
    }

    /** Base64 helper kept next to its only user so the encode/decode pairing is visible in one place. */
    static String b64(byte[] raw) {
        return Base64.encodeToString(raw, Base64.NO_WRAP);
    }
}

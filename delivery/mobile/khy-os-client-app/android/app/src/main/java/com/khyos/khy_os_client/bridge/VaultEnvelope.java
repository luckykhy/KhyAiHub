package com.khyos.khy_os_client.bridge;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * The on-disk envelope for one sandbox credential.
 *
 * <h2>Why this is a separate class from {@link SandboxVault}</h2>
 * The Android side needs a Keystore-backed {@code Cipher}, which does not exist on
 * the JVM — so a unit test that constructs the vault would either throw or silently
 * no-op, and every assertion about the format would be a lie. Splitting the pure
 * serialisation out means the format, the validation rules and the
 * additional-authenticated-data binding are all provable without a device.
 *
 * <h2>What is and is not in here</h2>
 * The plaintext is <b>never</b> in this object. It holds only the ciphertext, the IV,
 * the entry name and the plaintext length. That is deliberate: {@code secret_list}
 * must be able to answer "what is stored and how big is it" without any code path
 * existing that could decrypt — see the class javadoc of {@link SandboxVault} for the
 * rule this enforces and the test that checks it.
 *
 * <p>The length is stored even though it leaks a little. The alternative — refusing
 * to answer — was rejected because an operator who pasted a truncated key has no way
 * to find out, and a silently-truncated credential fails later at a point where the
 * error message will not mention the credential at all.
 */
final class VaultEnvelope {
    /** Bumped only for a breaking format change; readers reject anything higher. */
    static final int VERSION = 1;

    private static final String K_VERSION = "v";
    private static final String K_NAME = "name";
    private static final String K_CREATED_AT = "createdAt";
    private static final String K_IV = "iv";
    private static final String K_CT = "ct";
    private static final String K_LEN = "len";

    private final String name;
    private final long createdAt;
    private final byte[] iv;
    private final byte[] ciphertext;
    private final int plaintextLength;

    private VaultEnvelope(String name, long createdAt, byte[] iv, byte[] ct, int len) {
        this.name = name;
        this.createdAt = createdAt;
        this.iv = iv;
        this.ciphertext = ct;
        this.plaintextLength = len;
    }

    static VaultEnvelope create(String name, long createdAt, byte[] iv, byte[] ct, int len) {
        return new VaultEnvelope(name, createdAt, iv, ct, len);
    }

    /**
     * The additional-authenticated-data for this entry.
     *
     * <p>Binding the name and version into the AAD is what stops an attacker with a
     * filesystem write primitive from swapping two envelopes: re-encrypting is not
     * needed to make {@code ct} decrypt under the same key, but the GCM tag will not
     * verify once the AAD no longer matches the name the caller asked for.
     */
    static byte[] aad(String name) {
        return ("khy-sandbox-vault|" + VERSION + "|" + name)
                .getBytes(StandardCharsets.UTF_8);
    }

    String name() { return name; }

    long createdAt() { return createdAt; }

    byte[] iv() { return iv; }

    byte[] ciphertext() { return ciphertext; }

    int plaintextLength() { return plaintextLength; }

    String toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put(K_VERSION, VERSION);
            o.put(K_NAME, name);
            o.put(K_CREATED_AT, createdAt);
            o.put(K_IV, Base64.getEncoder().encodeToString(iv));
            o.put(K_CT, Base64.getEncoder().encodeToString(ciphertext));
            o.put(K_LEN, plaintextLength);
        } catch (JSONException e) {
            // Unreachable: every key above is a literal and every value is a type
            // JSONObject accepts. Swallowing it would be worse than throwing.
            throw new IllegalStateException("envelope serialisation failed", e);
        }
        return o.toString();
    }

    /**
     * Parses and validates an envelope read back from disk.
     *
     * @throws IllegalArgumentException on anything malformed, unknown-version, or
     *         internally inconsistent. The caller must treat this as "entry is not
     *         readable" and <b>not</b> fall back to any other interpretation — a
     *         half-valid envelope that gets repaired into something usable is exactly
     *         how a corrupted credential becomes a silently wrong one.
     */
    static VaultEnvelope fromJson(String json) {
        final JSONObject o;
        try {
            o = new JSONObject(json);
        } catch (JSONException e) {
            throw new IllegalArgumentException("not a JSON envelope", e);
        }
        int v = o.optInt(K_VERSION, -1);
        if (v != VERSION) {
            throw new IllegalArgumentException("unsupported envelope version: " + v);
        }
        String name = o.optString(K_NAME, "");
        if (name.isEmpty()) {
            throw new IllegalArgumentException("envelope has no name");
        }
        byte[] iv = decode(o.optString(K_IV, ""), "iv");
        byte[] ct = decode(o.optString(K_CT, ""), "ct");
        int len = o.optInt(K_LEN, -1);
        if (len < 0) {
            throw new IllegalArgumentException("envelope has no plaintext length");
        }
        // GCM's IV is 12 bytes by convention and the Keystore will not accept
        // anything else for this cipher. Rejecting here rather than at decrypt time
        // keeps the failure attributable to the file, not to the crypto layer.
        if (iv.length != 12) {
            throw new IllegalArgumentException("iv is " + iv.length + " bytes, expected 12");
        }
        // 这里**没有**「ct 不能为空」的检查，因为 decode() 已经对空串报过了——
        // Base64 只有空输入才解出空数组，所以那条检查永远走不到。留着它就是
        // 一段假装在验证的死代码，比没有更糟：读的人会以为空密文被挡住了。
        return new VaultEnvelope(name, o.optLong(K_CREATED_AT, 0L), iv, ct, len);
    }

    private static byte[] decode(String b64, String field) {
        if (b64.isEmpty()) {
            throw new IllegalArgumentException("envelope has no " + field);
        }
        try {
            return Base64.getDecoder().decode(b64);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("envelope " + field + " is not base64", e);
        }
    }
}

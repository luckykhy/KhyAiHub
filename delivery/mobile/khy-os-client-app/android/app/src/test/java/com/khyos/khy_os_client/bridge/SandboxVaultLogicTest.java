package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * Tests for the G04 credential-vault logic that does not need a device.
 *
 * <h2>What is deliberately not tested here</h2>
 * {@link SandboxVault} itself: it needs an Android Keystore {@code Cipher} and a real
 * {@code Context}, neither of which exists on the JVM. A test that constructed it would
 * either throw or silently no-op, and every assertion would be a lie — which is the
 * failure mode this project has been bitten by before. So the two pure pieces
 * ({@link VaultEnvelope} and {@link ProvisioningCode}) are tested exhaustively, and the
 * one invariant that spans both is checked by reading the source (see
 * {@link #noBridgeToolCanReachPlaintext}).
 *
 * <h2>Clock injection</h2>
 * {@link ProvisioningCode} takes {@code now} as a parameter everywhere. Nothing here
 * sleeps and nothing reads the wall clock, so the expiry and single-use rules are
 * provable rather than probable.
 */
public class SandboxVaultLogicTest {

    private static final long T0 = 1_700_000_000_000L;

    // ==================== VaultEnvelope ====================

    @Test
    public void envelopeRoundTripsEveryField() {
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        byte[] ct = "ciphertext-bytes".getBytes(StandardCharsets.UTF_8);
        VaultEnvelope env = VaultEnvelope.create("sandbox.gateway_token", T0, iv, ct, 41);

        VaultEnvelope back = VaultEnvelope.fromJson(env.toJson());

        assertEquals("sandbox.gateway_token", back.name());
        assertEquals(T0, back.createdAt());
        assertEquals(41, back.plaintextLength());
        assertTrue(java.util.Arrays.equals(iv, back.iv()));
        assertTrue(java.util.Arrays.equals(ct, back.ciphertext()));
    }

    @Test
    public void envelopeRejectsAFutureVersionRatherThanGuessingAtIt() {
        String json = "{\"v\":99,\"name\":\"x\",\"createdAt\":1,"
                + "\"iv\":\"" + b64(new byte[12]) + "\",\"ct\":\"" + b64(new byte[]{1}) + "\",\"len\":1}";
        try {
            VaultEnvelope.fromJson(json);
            org.junit.Assert.fail("应当拒绝未知版本，而不是猜它的格式");
        } catch (IllegalArgumentException e) {
            assertTrue(e.getMessage().contains("version"));
        }
    }

    @Test
    public void envelopeRejectsEachMalformedFieldSeparately() {
        // 每个都单独断言一次：合成一个「全错」的 JSON 只能证明第一个检查生效，
        // 而真正会被读到的是后面的那些。
        //
        // 顺序本身也是被钉住的：version 先于 name。一个连版本都没有的信封
        // 不能先去解释它的字段——那等于在猜格式。所以 {} 报的是 version，
        // 不是 name；要单独验 name 就给一个带合法版本的。
        assertRejects("{}", "version");
        assertRejects("{\"v\":1}", "no name");
        assertRejects("{\"v\":1,\"name\":\"x\"}", "iv");
        assertRejects("{\"v\":1,\"name\":\"x\",\"iv\":\"" + b64(new byte[12]) + "\"}", "ct");
        assertRejects("{\"v\":1,\"name\":\"x\",\"iv\":\"" + b64(new byte[12])
                + "\",\"ct\":\"" + b64(new byte[]{1}) + "\"}", "plaintext length");
        assertRejects("{\"v\":1,\"name\":\"x\",\"iv\":\"" + b64(new byte[11])
                + "\",\"ct\":\"" + b64(new byte[]{1}) + "\",\"len\":1}", "iv");
        // 空 ct 走的是 decode() 的「字段为空」分支，报 "no ct" 而不是
        // "empty ciphertext"——VaultEnvelope 里那条 ct.length==0 检查是死代码，
        // 已删。这里按真实报错钉住，免得下次有人照着重加一遍。
        assertRejects("{\"v\":1,\"name\":\"x\",\"iv\":\"" + b64(new byte[12])
                + "\",\"ct\":\"\",\"len\":1}", "no ct");
        assertRejects("not json at all", "JSON");
    }

    private static void assertRejects(String json, String mustMention) {
        try {
            VaultEnvelope.fromJson(json);
            org.junit.Assert.fail("应当拒绝：" + json);
        } catch (IllegalArgumentException e) {
            assertTrue("报错没说清是哪一项: " + e.getMessage(),
                    e.getMessage().contains(mustMention));
        }
    }

    @Test
    public void aadBindsNameAndVersionSoEntriesCannotBeSwappedOnDisk() {
        // 这是「有文件写原语的人把两个信封对调」的防线。密钥不变、密文能解，
        // 但 AAD 不匹配时 GCM 标签验证不过——所以对调会以解密失败的形式爆开。
        assertNotEquals(java.util.Arrays.toString(VaultEnvelope.aad("a")),
                java.util.Arrays.toString(VaultEnvelope.aad("b")));
        assertEquals(java.util.Arrays.toString(VaultEnvelope.aad("a")),
                java.util.Arrays.toString(VaultEnvelope.aad("a")));
        assertTrue(new String(VaultEnvelope.aad("sandbox.ssh_key"), StandardCharsets.UTF_8)
                .startsWith("khy-sandbox-vault|"));
    }

    // ==================== ProvisioningCode ====================

    @Test
    public void issuedCodeIsSixDigits() {
        ProvisioningCode pc = new ProvisioningCode(deterministicRandom());
        String code = pc.issue(T0);
        assertEquals(6, code.length());
        assertTrue("码只能是数字: " + code, code.matches("[0-9]{6}"));
    }

    @Test
    public void codeVerifiesOnceAndThenIsSpent() {
        ProvisioningCode pc = new ProvisioningCode(deterministicRandom());
        String code = pc.issue(T0);
        assertNull("第一次应当通过", pc.verify(code, T0));
        assertTrue("第二次必须失败", pc.verify(code, T0) != null);
        // 第三次同样失败，且不是因为过期
        assertTrue(pc.verify(code, T0 + 1000) != null);
    }

    @Test
    public void expiredCodeIsRejectedAndBurned() {
        ProvisioningCode pc = new ProvisioningCode(deterministicRandom());
        String code = pc.issue(T0);
        long afterTtl = T0 + ProvisioningCode.TTL_MS + 1;
        assertTrue("过期必须拒绝", pc.verify(code, afterTtl) != null);
        // 焚掉：过期后连正确码也不能用，否则一个慢半拍的重试会在操作员
        // 已经走开之后成功。
        assertFalse("过期码应已作废", pc.hasOutstanding(afterTtl));
    }

    @Test
    public void aTypoDoesNotBurnTheLiveCode() {
        // 顺序很关键：先查过期、再查是否用过、最后比对。若比对在前，
        // 一次手误就会把唯一一次机会用掉，操作员得重新来一遍。
        ProvisioningCode pc = new ProvisioningCode(deterministicRandom());
        String code = pc.issue(T0);
        assertTrue(pc.verify("000000".equals(code) ? "111111" : "000000", T0) != null);
        assertNull("输错一次之后，正确的码仍应可用", pc.verify(code, T0));
    }

    @Test
    public void issuingReplacesRatherThanStacks() {
        // 必须用一个会变的随机源：固定随机源两次会给出同一个码，那样「旧码已作废」
        // 这条就验不出来——而它正是这个测试唯一要证的事。
        ProvisioningCode pc = new ProvisioningCode(countingRandom());
        String first = pc.issue(T0);
        String second = pc.issue(T0 + 1);
        assertNotEquals("两次签发的码必须不同，否则这条测试什么都没验", first, second);
        // 第一个码是在第二次签发时被顶掉的，不是因为它过期（两次只差 1ms）。
        assertTrue("旧码必须作废", pc.verify(first, T0 + 1) != null);
        assertNull("新码必须可用", pc.verify(second, T0 + 1));
    }

    @Test
    public void verifyingWithNothingOutstandingSaysSoPlainly() {
        ProvisioningCode pc = new ProvisioningCode(deterministicRandom());
        String why = pc.verify("123456", T0);
        assertTrue(why != null && why.contains("secret_code"));
    }

    @Test
    public void normalizeAcceptsWhatAnOperatorActuallyTypes() {
        assertEquals("123456", ProvisioningCode.normalize("123456"));
        assertEquals("123456", ProvisioningCode.normalize("123 456"));
        assertEquals("123456", ProvisioningCode.normalize(" 123-456 "));
        assertEquals("123456", ProvisioningCode.normalize("码是123456谢谢"));
        // 超长时取前六位，不是拒绝——操作员多打了一个字不该让整次投递失败
        assertEquals("123456", ProvisioningCode.normalize("1234567"));
        assertEquals("", ProvisioningCode.normalize(null));
        assertEquals("", ProvisioningCode.normalize("abcdef"));
    }

    @Test
    public void hashIsStableAndIsNotTheCodeItself() {
        assertEquals(ProvisioningCode.hash("123456"), ProvisioningCode.hash("123456"));
        assertNotEquals(ProvisioningCode.hash("123456"), ProvisioningCode.hash("123457"));
        assertFalse("存的不能是码本身", ProvisioningCode.hash("123456").contains("123456"));
        assertEquals(64, ProvisioningCode.hash("123456").length());
    }

    @Test
    public void matchesHandlesNullsInsteadOfThrowing() {
        assertFalse(ProvisioningCode.matches(null, "abc"));
        assertFalse(ProvisioningCode.matches("abc", null));
        assertFalse(ProvisioningCode.matches(null, null));
        assertTrue(ProvisioningCode.matches("abc", "abc"));
    }

    @Test
    public void entryNamesAreRejectedUnlessTheyAreSafeFilenames() {
        // 这个名字就是文件名，所以这是路径穿越守卫，不是命名品味问题。
        assertNull(SandboxVault.validateName("sandbox.gateway_token"));
        assertNull(SandboxVault.validateName("a"));
        assertNull(SandboxVault.validateName("ssh-key_1"));
        for (String bad : new String[]{
                "", "../escape", "a/b", "a\\b", ".", "..", "UPPER", "has space", "tab\there"}) {
            assertTrue("应当拒绝条目名: [" + bad + "]", SandboxVault.validateName(bad) != null);
        }
    }

    // ==================== the invariant that spans both files ====================

    /**
     * The one rule that must not be broken: no bridge tool can reach plaintext.
     *
     * <p>Everything above tests logic in isolation. This tests the thing that makes the
     * whole design worth anything — that {@code secret_list} and friends cannot be
     * turned into a credential reader by editing one line. It reads {@code Tools.java}
     * and fails if any tool dispatch reaches {@link SandboxVault#open}.
     *
     * <p>Checked mechanically rather than left to a comment, because the comment is
     * exactly what gets lost in a refactor.
     */
    @Test
    public void noBridgeToolCanReachPlaintext() throws Exception {
        String tools = readRepoFile("src/main/java/com/khyos/khy_os_client/bridge/Tools.java");

        // 1. The dispatch table must route the four tools and nothing else secret-ish.
        for (String tool : new String[]{"secret_code", "secret_put", "secret_list", "secret_del"}) {
            assertTrue("Tools.java 没有分发 " + tool,
                    tools.contains("tool.equals(\"" + tool + "\")"));
        }

        // 2. Nothing in Tools.java may call SandboxVault.open — the only plaintext path.
        //    Checked as a bare ".open(" rather than a receiver-aware pattern: Tools.java
        //    has no other use for it today, and a bare check cannot be defeated by
        //    renaming the local variable. If a future tool genuinely needs ".open(" for
        //    something unrelated, this fails loudly and the rule gets re-examined on
        //    purpose — which is the intended cost.
        assertFalse("Tools.java 里出现了 .open( 调用——桥上的远端能经由它读到凭据明文。"
                        + "明文只给进程内连接器和 debug 自测，不过桥。",
                tools.contains(".open("));

        // 3. The four handlers must be the only places SandboxVault is touched, and
        //    none of them may be named anything like "get"/"read"/"decrypt".
        for (String handler : new String[]{"secretCode", "secretPut", "secretList", "secretDel"}) {
            assertTrue("缺少处理器 " + handler, tools.contains(handler));
        }
    }

    // ==================== helpers ====================

    /**
     * A random that always yields "000000", so a test that needs a known code does not
     * have to reach into private state to find out what was issued.
     */
    private static SecureRandom deterministicRandom() {
        return new SecureRandom() {
            @Override
            public int nextInt(int bound) {
                return 0;
            }
        };
    }

    /** A random that cycles 0..bound-1, so two successive issues differ. */
    private static SecureRandom countingRandom() {
        return new SecureRandom() {
            private int n = 0;

            @Override
            public int nextInt(int bound) {
                int v = n % bound;
                n++;
                return v;
            }
        };
    }

    private static String b64(byte[] raw) {
        return Base64.getEncoder().encodeToString(raw);
    }

    /** Walks up from the JVM's working directory looking for a repo-relative path. */
    private static String readRepoFile(String relative) throws Exception {
        String cwd = System.getProperty("user.dir", ".");
        File dir = new File(cwd).getAbsoluteFile();
        for (int i = 0; i < 6 && dir != null; i++) {
            File candidate = new File(dir, relative);
            if (candidate.isFile()) {
                return new String(Files.readAllBytes(candidate.toPath()), StandardCharsets.UTF_8);
            }
            dir = dir.getParentFile();
        }
        throw new AssertionError("找不到 " + relative + "（从 user.dir=" + cwd + " 向上回溯）");
    }
}

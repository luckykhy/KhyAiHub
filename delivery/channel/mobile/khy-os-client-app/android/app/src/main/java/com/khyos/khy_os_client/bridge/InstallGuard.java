package com.khyos.khy_os_client.bridge;

import org.json.JSONObject;

/**
 * 装包前的签名一致性判据（S5 / T15）。
 *
 * WHY THIS EXISTS. 实测（2026-11-17/18）：/sdcard/Download 里 debug 签名包与
 * 已装的 release 包同包名、同 versionName，肉眼看不出差别；照着一装，
 * 要么被系统以 INSTALL_FAILED_UPDATE_INCOMPATIBLE 拒绝（且报错里没有一个字
 * 说清「这是另一个签名的包」），要么反过来把 release 覆盖成 debug。
 * 判据收成一个纯函数，JVM 单测不需要 Android 运行时就能钉死这条决策表。
 */
public final class InstallGuard {
    private InstallGuard() {}

    /** 同包名、不同签名：拒装，并指出去删哪个文件。 */
    public static final String CODE_SIGNATURE_MISMATCH = "signature_mismatch";

    /** 包本身解析不出签名：不拦（拦会把合法安装一起拒），但必须说没验证过。 */
    public static final String CODE_SIGNATURE_UNKNOWN = "signature_unknown";

    /** 文案里露出的摘要前缀：够判读，又不把 64 个十六进制字符摊在屏幕上。 */
    private static final int SHORT_DIGEST = 8;

    /**
     * @param archivePkg     待装包声明的包名（读不出来为 null）
     * @param ownPkg         本进程的包名
     * @param archiveSigSha256 待装包的签名证书 SHA-256（小写十六进制；读不出为空）
     * @param ownSigSha256   本进程的签名证书 SHA-256
     * @return {ok, code, error?, archive_signer?, own_signer?, note?}
     */
    public static JSONObject evaluate(String archivePkg, String ownPkg,
                                      String archiveSigSha256, String ownSigSha256) {
        try {
            // 别的包、或读不出包名：这道闸只管「往本 App 头上盖不同签名的同一个包」。
            if (archivePkg == null || archivePkg.length() == 0
                    || ownPkg == null || !archivePkg.equals(ownPkg)) {
                return pass();
            }
            if (isBlank(archiveSigSha256) || isBlank(ownSigSha256)) {
                return new JSONObject()
                        .put("ok", true)
                        .put("code", CODE_SIGNATURE_UNKNOWN)
                        .put("note", "读不出包签名，未做签名比对：交给系统的安装校验");
            }
            if (!archiveSigSha256.equalsIgnoreCase(ownSigSha256)) {
                return new JSONObject()
                        .put("ok", false)
                        .put("code", CODE_SIGNATURE_MISMATCH)
                        .put("archive_signer", shortOf(archiveSigSha256))
                        .put("own_signer", shortOf(ownSigSha256))
                        .put("error", "这是另一个签名的包（" + shortOf(archiveSigSha256)
                                + "…），与已装件的签名（" + shortOf(ownSigSha256)
                                + "…）不同，装上会被系统拒绝"
                                + "（INSTALL_FAILED_UPDATE_INCOMPATIBLE）。"
                                + "修复：先删掉 /sdcard/Download 里这个文件，再装对应的 release 包。");
            }
            return pass();
        } catch (Throwable t) {
            return new JSONObject();
        }
    }

    private static JSONObject pass() {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true).put("code", "");
        } catch (Throwable ignored) {}
        return o;
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().length() == 0;
    }

    private static String shortOf(String digest) {
        String d = digest.trim().toLowerCase(java.util.Locale.ROOT);
        return d.length() <= SHORT_DIGEST ? d : d.substring(0, SHORT_DIGEST);
    }
}

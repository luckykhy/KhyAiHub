package com.khyos.khy_os_client.bridge;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * S5 / T15：会话导出物不是交付物，不许再落进 /sdcard/Download。
 *
 * 实测（2026-11-18）：Download 里躺着 4 个 khy-os-console-*.jsonl——导出默认
 * 落点写死了 Download，而这个目录正是 install_apk 的白名单根：导出物越堆越多，
 * 真正要装的那个包越容易被拿错。
 *
 * 这条测试用「源码判据」而不是行为断言，是因为 JVM 上 /sdcard/Download 不存在，
 * export() 的回退分支恰好会掩盖这个坑——行为断言在 JVM 里恒绿，测不住。
 */
public class KhyConsoleExportLocationTest {

    private static String source(String name) throws Exception {
        Path cur = Paths.get(System.getProperty("user.dir", ".")).toAbsolutePath();
        for (int up = 0; up < 8; up++) {
            Path p = cur.resolve("app/src/main/java/com/khyos/khy_os_client/bridge/" + name);
            if (Files.exists(p)) {
                return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
            }
            Path p2 = cur.resolve("android/app/src/main/java/com/khyos/khy_os_client/bridge/" + name);
            if (Files.exists(p2)) {
                return new String(Files.readAllBytes(p2), StandardCharsets.UTF_8);
            }
            Path dart = cur.resolve("lib/core/services/console_service.dart");
            if (name.equals("console_service.dart") && Files.exists(dart)) {
                return new String(Files.readAllBytes(dart), StandardCharsets.UTF_8);
            }
            cur = cur.getParent();
            if (cur == null) break;
        }
        throw new IllegalStateException("找不到 " + name);
    }

    @Test
    public void exportDefaultDoesNotPointAtDownload() throws Exception {
        String src = source("KhyConsole.java");
        String body = src.substring(src.indexOf("public static JSONObject export"));
        // 判据盯的是代码而不是注释：默认分支的落点必须是 baseDir()，
        // 且不得再出现 `new File("/sdcard/Download"` 这个行为字面量。
        assertFalse("导出默认落点不许再 new File(\"/sdcard/Download\"): " + body,
                body.contains("new File(\"/sdcard/Download\""));
        assertTrue("默认分支必须取 App 自己的目录（baseDir）",
                body.contains("File dir = baseDir()"));
    }

    @Test
    public void theWhyIsWrittenDownWhereThePathUsedToBe() throws Exception {
        String src = source("KhyConsole.java");
        assertTrue("落点为什么改，要在现场留一句（导出物不是交付物）",
                src.contains("不是交付物"));
    }

    @Test
    public void dartSampleArgsNoLongerSuggestDownload() throws Exception {
        // cp 的 dest、zip 的 out 的示例值就是给 Agent 抄的——示例指到 Download，
        // 每个照抄的命令都在往交接目录里堆东西。
        String dart = source("console_service.dart");
        assertFalse("示例值不许指向 Download: " + dart, dart.contains("/sdcard/Download"));
    }

    @Test
    public void exportStillWorksOnTheJvm() throws Exception {
        // 行为兜底：JVM 上走回退分支，导出要真能落盘（路径不属于 Download）。
        org.json.JSONObject r = KhyConsole.export(null);
        org.junit.Assert.assertNotNull(r);
        if (r.optBoolean("ok")) {
            String p = r.optString("path");
            assertFalse("JVM 回退落点也不许是 Download: " + p, p.contains("Download"));
        }
    }
}

// khy-canary: Khy-20261101-056-PS2GTE58
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Tests for the zip/unzip tools.
 *
 * WHY THESE EXIST. On 2026-10-26 Amoo reported to the user that "zip, unzip, and
 * ffmpeg are not installed" and concluded that packing up a batch of files could
 * not be done. The first two were a wrong conclusion, not a missing capability:
 * Android's shell has no zip binary, but {@code java.util.zip} has been inside
 * this process the whole time — the bridge is itself Java, and all that was
 * missing was a tool exposing it.
 *
 * These tests run on a bare JVM against a real temp directory: neither tool
 * touches an Android API, which is precisely why the gap was closable without
 * adding a dependency, a native binary, or a permission.
 */
public class ZipToolsTest {

    private File tmp;

    @Before
    public void setUp() throws Exception {
        Tools.resetSessionBudget();
        tmp = Files.createTempDirectory("khy-zip-test").toFile();
    }

    @After
    public void tearDown() {
        deleteTree(tmp);
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteTree(k);
        }
        f.delete();
    }

    private static void write(File f, String content) throws Exception {
        File p = f.getParentFile();
        if (p != null) p.mkdirs();
        Files.write(f.toPath(), content.getBytes(StandardCharsets.UTF_8));
    }

    private static String read(File f) throws Exception {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    @Test
    public void zipPreservesDirectoryStructure() throws Exception {
        // 层级是打包的全部意义：散成一堆文件的 zip 不如不打包。
        File root = new File(tmp, "src");
        write(new File(root, "a.txt"), "AAA");
        write(new File(root, "sub/b.txt"), "BBB");

        File out = new File(tmp, "out.zip");
        JSONObject r = Tools.dispatch("zip", new JSONObject()
                .put("path", root.getAbsolutePath())
                .put("out", out.getAbsolutePath()));

        assertTrue(r.optString("error", ""), r.getBoolean("ok"));
        assertEquals(2, r.getLong("files"));
        assertTrue(out.exists());
        assertTrue(out.length() > 0);
    }

    @Test
    public void roundTripRestoresEveryByte() throws Exception {
        File root = new File(tmp, "src");
        write(new File(root, "a.txt"), "AAA");
        write(new File(root, "sub/b.txt"), "中文内容 with spaces");
        write(new File(root, "sub/deep/c.bin"), new String(new char[]{'x', 'y'}));

        File out = new File(tmp, "out.zip");
        Tools.dispatch("zip", new JSONObject()
                .put("path", root.getAbsolutePath())
                .put("out", out.getAbsolutePath()));

        File dest = new File(tmp, "restored");
        JSONObject r = Tools.dispatch("unzip", new JSONObject()
                .put("path", out.getAbsolutePath())
                .put("dest", dest.getAbsolutePath()));

        assertTrue(r.optString("error", ""), r.getBoolean("ok"));
        assertEquals(3, r.getLong("files"));
        // 逐字节比对，不是只看文件数：压缩/解压把内容写坏而条数不变是可能的。
        assertEquals("AAA", read(new File(dest, "src/a.txt")));
        assertEquals("中文内容 with spaces", read(new File(dest, "src/sub/b.txt")));
        assertEquals("xy", read(new File(dest, "src/sub/deep/c.bin")));
    }

    @Test
    public void zipOfASingleFileWorks() throws Exception {
        // 「打包一个文件」是常见用法（把单个 apk 传出去），不该被目录逻辑挡住。
        File f = new File(tmp, "solo.txt");
        write(f, "solo");
        File out = new File(tmp, "solo.zip");

        JSONObject r = Tools.dispatch("zip", new JSONObject()
                .put("path", f.getAbsolutePath())
                .put("out", out.getAbsolutePath()));

        assertTrue(r.optString("error", ""), r.getBoolean("ok"));
        assertEquals(1, r.getLong("files"));
    }

    @Test
    public void missingSourceFailsWithAReason() throws Exception {
        JSONObject r = Tools.dispatch("zip", new JSONObject()
                .put("path", new File(tmp, "nope").getAbsolutePath())
                .put("out", new File(tmp, "x.zip").getAbsolutePath()));
        assertEquals(false, r.getBoolean("ok"));
        assertTrue(r.optString("error", "").contains("源不存在"));
    }

    @Test
    public void missingOutFailsRatherThanWritingNowhere() throws Exception {
        // 不给 out 就静默什么都不做，是「调了像成功了」那种失败。
        File f = new File(tmp, "a.txt");
        write(f, "a");
        JSONObject r = Tools.dispatch("zip", new JSONObject()
                .put("path", f.getAbsolutePath()));
        assertEquals(false, r.getBoolean("ok"));
        assertTrue(r.optString("error", "").contains("out"));
    }

    @Test
    public void missingZipFailsWithAReason() throws Exception {
        JSONObject r = Tools.dispatch("unzip", new JSONObject()
                .put("path", new File(tmp, "nope.zip").getAbsolutePath())
                .put("dest", new File(tmp, "d").getAbsolutePath()));
        assertEquals(false, r.getBoolean("ok"));
        assertTrue(r.optString("error", "").contains("zip"));
    }

    @Test
    public void zipIsChargedToTheExportBudget() throws Exception {
        // zip 自己不往设备外发一个字节，但它把「读 200 个小文件」换成「读 1 个 zip」。
        // 不记账的话，逐文件读会被额度挡住，打个包再读就绕过去了。
        File root = new File(tmp, "src");
        write(new File(root, "a.txt"), "AAA");
        write(new File(root, "b.txt"), "BBB");

        Tools.dispatch("zip", new JSONObject()
                .put("path", root.getAbsolutePath())
                .put("out", new File(tmp, "o.zip").getAbsolutePath()));

        JSONObject b = Tools.sessionBudget();
        assertEquals(2, b.getLong("copies"));
        assertTrue("源字节数应记入额度", b.getLong("bytes") >= 6);
    }

    @Test
    public void unzipRefusesEntriesThatEscapeTheDestination() throws Exception {
        // Zip Slip：条目名带 ../ 就写到目标目录外面。压缩包可能来自别人，
        // 这个检查不是可选项。这里直接构造一个恶意条目名来验证拒绝路径。
        File zipFile = new File(tmp, "evil.zip");
        java.util.zip.ZipOutputStream zo =
                new java.util.zip.ZipOutputStream(new java.io.FileOutputStream(zipFile));
        try {
            zo.putNextEntry(new java.util.zip.ZipEntry("../escaped.txt"));
            zo.write("pwned".getBytes(StandardCharsets.UTF_8));
            zo.closeEntry();
        } finally {
            zo.close();
        }

        JSONObject r = Tools.dispatch("unzip", new JSONObject()
                .put("path", zipFile.getAbsolutePath())
                .put("dest", new File(tmp, "dest").getAbsolutePath()));

        assertEquals(false, r.getBoolean("ok"));
        assertTrue(r.optString("error", "").contains("越出"));
        assertTrue("文件不该被写到目标目录外",
                !new File(tmp, "escaped.txt").exists());
    }
}

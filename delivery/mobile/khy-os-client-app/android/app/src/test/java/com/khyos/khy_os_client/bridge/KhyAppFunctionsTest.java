package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.Test;

/**
 * Tests for the AppFunction surface: {@link KhyAppFunctions} and the metadata
 * XML the system actually reads.
 *
 * THE FAILURE MODE THESE GUARD. The system does not read the Java table — it
 * reads {@code assets/app_functions.xml} (and the v2 twin). So the description
 * that decides whether the assistant routes to a tool lives in a file that can
 * drift from {@link Tools#ROUTING}, where the same text is maintained. Drift is
 * silent: the assistant keeps following stale instructions while the source of
 * truth says something else, and nobody sees an error.
 *
 * Hence: the XML is regenerated from the Java table by
 * {@code scripts/generate-appfunctions-metadata.js}, and these tests pin the two
 * together so a hand edit to either side goes red instead of shipping.
 *
 * The generator itself is Node and is not run by the JVM, so its correctness is
 * pinned here rather than tested in its own language — a generator that cannot
 * be checked by the suite that depends on its output is a generator nobody runs.
 */
public class KhyAppFunctionsTest {

    private static final String PREFIX =
            "com.khyos.khy_os_client.bridge.KhyAppFunctions#";

    /**
     * Read a main-source asset as text.
     *
     * Resolved from the source tree rather than the classpath on purpose: a
     * Flutter module's assets arrive through the flutter bundle, so
     * {@code getResourceAsStream} does not see them during a JVM unit test. And
     * the file under test IS the source file — the system reads the packaged copy,
     * but the thing a human edits is this one, so this is the one to pin.
     *
     * The search walks up from the working directory instead of assuming a fixed
     * depth, because Gradle's test working directory is not a contract this test
     * should depend on.
     */
    private static String asset(String name) throws Exception {
        java.io.File f = findAsset(name);
        if (f == null) {
            throw new AssertionError("找不到 src/main/assets/" + name
                    + "（从 user.dir=" + System.getProperty("user.dir") + " 向上回溯）");
        }
        byte[] bytes = java.nio.file.Files.readAllBytes(f.toPath());
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private static java.io.File findAsset(String name) {
        java.io.File dir = new java.io.File(System.getProperty("user.dir", ".")).getAbsoluteFile();
        for (int i = 0; i < 8 && dir != null; i++) {
            java.io.File candidate = new java.io.File(dir, "src/main/assets/" + name);
            if (candidate.isFile()) {
                return candidate;
            }
            dir = dir.getParentFile();
        }
        return null;
    }

    /**
     * Distinct function ids declared in the XML.
     *
     * Matched by prefix rather than by tag alone: the v2 file nests
     * {@code <id>unused</id>} inside every {@code <response><valueType>}, so a
     * bare {@code <id>} pattern picks those up too. And the v2 format declares
     * each function TWICE — once as {@code <id>} and once as {@code <functionId>}
     * — so the count is of DISTINCT ids, not of matches. Both facts were found
     * by the first run of this test coming back 22 instead of 11.
     */
    private static java.util.Set<String> idsIn(String xml) {
        java.util.Set<String> out = new java.util.LinkedHashSet<String>();
        Matcher m = Pattern.compile(">(com\\.khyos[^<]*#[a-z0-9_]+)<").matcher(xml);
        while (m.find()) {
            out.add(m.group(1).trim());
        }
        return out;
    }

    // ── 暴露面 ───────────────────────────────────────────────────────────────

    @Test
    public void exposedIsExactlyTheObserveAndActSurface() {
        // 这份表就是「哪些能力走了不需要前台窗口的那条路」。加一项是一个决定，
        // 不是漂移——所以把全集钉死，改动必须显式。
        Set<String> exposed = new LinkedHashSet<String>();
        for (String t : KhyAppFunctions.EXPOSED) exposed.add(t);
        assertEquals(11, exposed.size());
        for (String t : new String[]{"ping", "info", "tools", "ui_dump", "ui_click",
                "ui_tap", "ui_swipe", "ui_type", "ui_back", "ui_home", "shot"}) {
            assertTrue("EXPOSED 缺 " + t, exposed.contains(t));
        }
    }

    @Test
    public void destructiveToolsAreNotExposed() {
        // 这条与上一条同等重要，方向相反。AppFunction 可由助手路由器直接调，
        // 没有前台窗口也没有确认面——那正是「不许提供破坏性文件操作」的形状。
        // 这些工具仍走 HTTP 桥与反代循环，那里有 LoopModes 与确认底。
        Set<String> exposed = new LinkedHashSet<String>();
        for (String t : KhyAppFunctions.EXPOSED) exposed.add(t);
        for (String t : new String[]{"exec", "rm", "write", "mv", "cp", "mkdir",
                "shell_exec", "shot_b64", "clipboard", "amoo_ask", "amoo_result",
                "loop_start", "loop_stop"}) {
            assertFalse("不该经 AppFunction 暴露 " + t, exposed.contains(t));
        }
    }

    @Test
    public void everyExposedToolIsARealDispatchedTool() {
        // 暴露一个 dispatch 里没有的工具 = 助手路由过去，得到一个 not found，
        // 而它已经据此告诉用户「做不了」。
        Set<String> real = new LinkedHashSet<String>(java.util.Arrays.asList(Tools.NAMES));
        for (String t : KhyAppFunctions.EXPOSED) {
            assertTrue("EXPOSED 里的 " + t + " 不在 Tools.NAMES", real.contains(t));
        }
    }

    // ── 元数据与 Java 表的一致性 ─────────────────────────────────────────────

    @Test
    public void theLegacyMetadataDeclaresExactlyTheExposedTools() throws Exception {
        java.util.Set<String> ids = idsIn(asset("app_functions.xml"));
        assertEquals(KhyAppFunctions.EXPOSED.length, ids.size());
        for (String t : KhyAppFunctions.EXPOSED) {
            assertTrue("app_functions.xml 缺 " + t, ids.contains(PREFIX + t));
        }
    }

    @Test
    public void theV2MetadataDeclaresExactlyTheExposedTools() throws Exception {
        java.util.Set<String> ids = idsIn(asset("app_functions_v2.xml"));
        assertEquals(KhyAppFunctions.EXPOSED.length, ids.size());
        for (String t : KhyAppFunctions.EXPOSED) {
            assertTrue("app_functions_v2.xml 缺 " + t, ids.contains(PREFIX + t));
        }
    }

    @Test
    public void bothMetadataFilesDeclareTheSameFunctionSet() throws Exception {
        // 两份都声明（照本机第一方应用的惯例），因为从外部无法判定框架读哪一份。
        // 但两份**必须**是同一个集合——否则同一个工具在两份里路由指令不同。
        Set<String> legacy = new LinkedHashSet<String>(
                idsIn(asset("app_functions.xml")));
        Set<String> v2 = new LinkedHashSet<String>(
                idsIn(asset("app_functions_v2.xml")));
        assertEquals(legacy, v2);
    }

    @Test
    public void theMetadataDescriptionIsTheRoutingTableVerbatim() throws Exception {
        // 最重要的一条：XML 里的描述必须逐字等于 Tools.ROUTING。
        // 不等就意味着系统在读一份过期/手改的路由指令，而没有任何报错。
        for (String name : new String[]{"app_functions.xml", "app_functions_v2.xml"}) {
            String xml = asset(name);
            for (String[] row : Tools.ROUTING) {
                String tool = row[0];
                if (!java.util.Arrays.asList(KhyAppFunctions.EXPOSED).contains(tool)) {
                    continue; // 没暴露的工具不进元数据，这是设计不是遗漏
                }
                assertTrue(name + " 里没有 " + tool + " 的描述",
                        xml.contains(row[1]));
            }
        }
    }

    @Test
    public void everyExposedToolHasARoutingDescription() throws Exception {
        // 反方向：暴露了却没有描述 = 把空路由指令发给模型。生成器会拒，但测试
        // 必须在没有 Node 的机器上也能拦住。
        for (String t : KhyAppFunctions.EXPOSED) {
            assertTrue("暴露了 " + t + " 但 Tools.ROUTING 没有它的描述",
                    Tools.routingFor(t) != null);
        }
    }

    @Test
    public void theMetadataDescriptionCarriesTheRoutingSections() throws Exception {
        // 描述要能当路由指令用，而不是当文档用。格式照本机第一方应用实测形状。
        for (String t : KhyAppFunctions.EXPOSED) {
            String d = Tools.routingFor(t);
            assertTrue(t + " 缺 # description", d.contains("# description"));
            assertTrue(t + " 缺 # positive_samples", d.contains("# positive_samples"));
            assertTrue(t + " 缺 # negative_samples", d.contains("# negative_samples"));
            assertTrue(t + " 缺 # return", d.contains("# return"));
        }
    }
}

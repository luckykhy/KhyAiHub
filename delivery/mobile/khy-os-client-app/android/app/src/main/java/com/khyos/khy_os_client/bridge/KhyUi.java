// khy-canary: Khy-20261101-013-99ZJHZKA
package com.khyos.khy_os_client.bridge;

import android.graphics.Bitmap;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;

import com.khyos.khy_os_client.KhyAccessibilityService;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * KhyUi — 桥的 UI 工具到 app 既有无障碍服务的适配层。
 *
 * 独立版 StepBridge 自带 BridgeAccessibilityService；并入 khy-os 手机端后，
 * 一个 app 只需一个无障碍服务，UI 工具全部路由到既有的
 * KhyAccessibilityService（tap/swipe/find/dumpUi/typeText 都已具备）。
 * 本类补三件它没有的：
 *   1) uiautomator 兼容 XML 输出——PC 侧 khy-os 的解析器只认这个格式；
 *   2) 按坐标的手势（tap/swipe/longpress）与全局动作的 JSON 包装；
 *   3) 截图——AccessibilityService.takeScreenshot（API 30+，无需
 *      MediaProjection 授权，也不需要 root）。
 *
 * 服务未开启时每个工具返回可执行的中文指引，而不是 "unknown tool"。
 */
public final class KhyUi {
    private KhyUi() {}

    /**
     * The parameter surface of every UI tool, in the one place the readers can
     * see it.
     *
     * WHY THIS TABLE EXISTS. Until 2026-10-29 the AppFunctions metadata declared
     * no parameters at all, so the assistant could read what each tool DOES
     * (that comes from Tools.ROUTING) but not what it TAKES — it had no way to
     * know ui_swipe wants x1/y1/x2/y2. First-party functions on this device all
     * declare parameters; we declared none.
     *
     * WHY IT LIVES HERE AND NOT IN Tools.java. The values are read by the private
     * methods below (optLong("x"), optString("text"), …). A table anywhere else
     * is a second source of truth for the same fact, and the two drift the moment
     * a param is renamed — which already happened once: Tools.ROUTING described
     * ui_swipe's optional duration as `durationMs` while the code has always
     * read `ms`. Nothing caught it because nothing compared them. Keeping the
     * table next to the readers is what makes that comparison possible; see
     * {@code ParamsDriftTest} in the test source set.
     *
     * WHY EVERY TYPE IS "string". The platform accepts a numeric type code, but
     * no first-party function on this device uses one — even semantically numeric
     * params like weather's startHour are declared string (read off
     * `dumpsys app_function`). Our readers are tolerant in both directions:
     * org.json's optLong coerces a numeric string ("540" → 540) and optString
     * stringifies a number, so declaring string is safe for the callers we
     * actually have. Changing one row to a numeric type is a deliberate decision
     * about the platform, not a formatting detail — hence the explicit column
     * rather than a hardcoded type in the generator.
     *
     * Columns: tool, param, type, required, description (what the model reads).
     */
    static final String[][] PARAMS = {
        // ui_tap — coordinates come from ui_dump's bounds, never hand-computed.
        {"ui_tap", "x", "string", "true", "横坐标（像素）。取 ui_dump 里目标控件的 bounds 左边界，不要手算。"},
        {"ui_tap", "y", "string", "true", "纵坐标（像素）。取 ui_dump 里目标控件的 bounds 上边界。"},

        // ui_click — text first, id as the fallback for controls with no label.
        {"ui_click", "text", "string", "false", "控件上可见的文字。优先用这个，比坐标可靠。"},
        {"ui_click", "id", "string", "false", "控件的 resource-id。文字匹配不上时才用它；text 与 id 至少给一个。"},

        {"ui_swipe", "x1", "string", "true", "起点横坐标（像素）。"},
        {"ui_swipe", "y1", "string", "true", "起点纵坐标（像素）。"},
        {"ui_swipe", "x2", "string", "true", "终点横坐标（像素）。"},
        {"ui_swipe", "y2", "string", "true", "终点纵坐标（像素）。"},
        {"ui_swipe", "ms", "string", "false", "时长（毫秒），默认 300。列表滚动用 300 左右，翻页可到 600。"},

        {"ui_longpress", "x", "string", "true", "长按的横坐标（像素）。"},
        {"ui_longpress", "y", "string", "true", "长按的纵坐标（像素）。"},
        {"ui_longpress", "ms", "string", "false", "时长（毫秒），默认 700，上限 10000。"},

        {"ui_type", "text", "string", "true", "要写入当前聚焦输入框的文字。中文与换行都可以。"},
    };

    /** Every param of one tool, in declaration order. Never null. */
    static java.util.List<String[]> paramsFor(String tool) {
        java.util.List<String[]> out = new java.util.ArrayList<String[]>();
        for (String[] row : PARAMS) {
            if (row[0].equals(tool)) out.add(row);
        }
        return out;
    }

    /** Tools that take at least one param. */
    static java.util.Set<String> toolsWithParams() {
        java.util.Set<String> out = new java.util.LinkedHashSet<String>();
        for (String[] row : PARAMS) out.add(row[0]);
        return out;
    }

    public static boolean isReady() {
        return KhyAccessibilityService.Companion.isReady();
    }

    public static JSONObject dispatch(String tool, JSONObject a) {
        JSONObject r = new JSONObject();
        try {
            if (!isReady()) {
                return r.put("ok", false)
                    .put("error", "无障碍服务未开启：请在系统设置 > 无障碍 > khy-os 里启用")
                    .put("ui", false);
            }
            if (tool.equals("ui_dump")) return dump(a);
            if (tool.equals("ui_tap")) return tap(a);
            if (tool.equals("ui_click")) return click(a);
            if (tool.equals("ui_swipe")) return swipe(a);
            if (tool.equals("ui_longpress")) return longpress(a);
            if (tool.equals("ui_type")) return type(a);
            if (tool.equals("ui_back")) return global(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
            if (tool.equals("ui_home")) return global(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME);
            if (tool.equals("ui_recents")) return global(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_RECENTS);
            if (tool.equals("shot")) return shot(a, false);
            if (tool.equals("shot_b64")) return shot(a, true);
            return r.put("ok", false).put("error", "unknown ui tool: " + tool);
        } catch (Throwable t) {
            try {
                return r.put("ok", false).put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
            } catch (Throwable ignored) {
                return r;
            }
        }
    }

    // ── ui_dump：uiautomator 兼容 XML ───────────────────────────────────────

    private static JSONObject dump(JSONObject a) throws Exception {
        JSONObject r = new JSONObject();
        AccessibilityNodeInfo root = KhyAccessibilityService.Companion.getInstance().getRootInActiveWindow();
        if (root == null) {
            return r.put("ok", false).put("error", "拿不到当前窗口（可能正在过渡动画，重试即可）");
        }
        int maxNodes = Math.max(1, Math.min(a.optInt("max_nodes", 600), 5000));
        StringBuilder sb = new StringBuilder();
        sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
        int[] count = new int[] { 0 };
        walk(root, sb, 0, count, maxNodes);
        sb.append("</hierarchy>");
        return r.put("ok", true).put("xml", sb.toString()).put("nodes", count[0]);
    }

    private static void walk(AccessibilityNodeInfo n, StringBuilder sb, int depth, int[] count, int maxNodes) {
        if (n == null || depth > 80 || count[0] >= maxNodes) return;
        count[0] += 1;
        Rect b = new Rect();
        try { n.getBoundsInScreen(b); } catch (Throwable ignored) {}
        sb.append("<node index=\"").append(count[0]).append("\"");
        attr(sb, "text", n.getText());
        attr(sb, "resource-id", n.getViewIdResourceName());
        attr(sb, "class", n.getClassName() == null ? "" : n.getClassName().toString());
        attr(sb, "package", n.getPackageName() == null ? "" : n.getPackageName().toString());
        attr(sb, "content-desc", n.getContentDescription());
        sb.append(" checkable=\"").append(n.isCheckable()).append("\"");
        sb.append(" checked=\"").append(n.isChecked()).append("\"");
        sb.append(" clickable=\"").append(n.isClickable()).append("\"");
        sb.append(" enabled=\"").append(n.isEnabled()).append("\"");
        sb.append(" focusable=\"").append(n.isFocusable()).append("\"");
        sb.append(" focused=\"").append(n.isFocused()).append("\"");
        sb.append(" scrollable=\"").append(n.isScrollable()).append("\"");
        sb.append(" long-clickable=\"").append(n.isLongClickable()).append("\"");
        sb.append(" selected=\"").append(n.isSelected()).append("\"");
        sb.append(" bounds=\"[").append(b.left).append(",").append(b.top).append("][")
                .append(b.right).append(",").append(b.bottom).append("]\"/>\n");
        for (int i = 0; i < n.getChildCount(); i++) {
            try { walk(n.getChild(i), sb, depth + 1, count, maxNodes); } catch (Throwable ignored) {}
        }
    }

    private static void attr(StringBuilder sb, String name, CharSequence value) {
        sb.append(' ').append(name).append("=\"").append(escapeXml(value == null ? "" : value.toString())).append('"');
    }

    private static String escapeXml(String s) {
        if (s == null || s.length() == 0) return "";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '<': sb.append("&lt;"); break;
                case '>': sb.append("&gt;"); break;
                case '&': sb.append("&amp;"); break;
                case '"': sb.append("&#34;"); break;
                case '\'': sb.append("&#39;"); break;
                case '\n': sb.append("&#10;"); break;
                case '\r': sb.append("&#13;"); break;
                case '\t': sb.append("&#9;"); break;
                default:
                    if (c < 0x20) sb.append(' ');
                    else sb.append(c);
            }
        }
        return sb.toString();
    }

    // ── 手势 ────────────────────────────────────────────────────────────────

    private static JSONObject tap(JSONObject a) throws Exception {
        long x = a.optLong("x", -1);
        long y = a.optLong("y", -1);
        if (x < 0 || y < 0) return new JSONObject().put("ok", false).put("error", "ui_tap 需要 x 与 y");
        boolean ok = KhyAccessibilityService.Companion.getInstance().tap((int) x, (int) y);
        JSONObject r = new JSONObject().put("ok", ok).put("x", x).put("y", y);
        if (!ok) r.put("error", "手势被系统取消（目标窗口可能不接受注入）");
        return r;
    }

    private static JSONObject longpress(JSONObject a) throws Exception {
        long x = a.optLong("x", -1);
        long y = a.optLong("y", -1);
        long ms = Math.max(200, Math.min(a.optLong("ms", 700), 10000));
        if (x < 0 || y < 0) return new JSONObject().put("ok", false).put("error", "ui_longpress 需要 x 与 y");
        // KhyAccessibilityService 只有 tap/swipe；长按用同起点同终点的慢速滑动等价实现。
        boolean ok = KhyAccessibilityService.Companion.getInstance().swipe((int) x, (int) y, (int) x, (int) y, (int) ms);
        JSONObject r = new JSONObject().put("ok", ok).put("x", x).put("y", y).put("ms", ms);
        if (!ok) r.put("error", "长按手势被系统取消");
        return r;
    }

    private static JSONObject swipe(JSONObject a) throws Exception {
        long x1 = a.optLong("x1", -1), y1 = a.optLong("y1", -1);
        long x2 = a.optLong("x2", -1), y2 = a.optLong("y2", -1);
        long ms = Math.max(50, Math.min(a.optLong("ms", 300), 10000));
        if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0) {
            return new JSONObject().put("ok", false).put("error", "ui_swipe 需要 x1 y1 x2 y2");
        }
        boolean ok = KhyAccessibilityService.Companion.getInstance().swipe((int) x1, (int) y1, (int) x2, (int) y2, (int) ms);
        JSONObject r = new JSONObject().put("ok", ok).put("from", x1 + "," + y1).put("to", x2 + "," + y2).put("ms", ms);
        if (!ok) r.put("error", "滑动手势被系统取消");
        return r;
    }

    /**
     * 向当前聚焦的输入框写入文本。
     *
     * 走 ACTION_SET_TEXT，所以中文/emoji/换行都能进——这是 PC 侧
     * `adb shell input text` 做不到的（它拒收非 ASCII），也是无 PC 闭环里
     * 「把执行结果写回 Amoo 输入框」的唯一可靠路线。
     * 写入是替换而非追加：先清掉输入框里既有内容。
     */
    private static JSONObject type(JSONObject a) throws Exception {
        String text = a.optString("text", "");
        if (text.length() == 0) {
            return new JSONObject().put("ok", false).put("error", "ui_type 需要 text");
        }
        boolean ok = KhyAccessibilityService.Companion.getInstance().typeText(text);
        JSONObject r = new JSONObject().put("ok", ok).put("chars", text.length());
        if (!ok) {
            r.put("error", "写入失败：当前窗口里没有可聚焦的输入框");
        }
        return r;
    }

    /** 按文本或 resource-id 点击：先节点点击，失败退回坐标。 */
    private static JSONObject click(JSONObject a) throws Exception {
        String text = a.optString("text", "");
        String id = a.optString("id", "");
        if (text.length() == 0 && id.length() == 0) {
            return new JSONObject().put("ok", false).put("error", "ui_click 需要 text 或 id");
        }
        String query = id.length() > 0 ? id : text;
        boolean ok = KhyAccessibilityService.Companion.getInstance().findAndClick(query);
        if (ok) {
            return new JSONObject().put("ok", true).put("via", "node").put("query", query);
        }
        int[] centre = KhyAccessibilityService.Companion.getInstance().findCenterBounds(query);
        if (centre != null && centre.length >= 2) {
            boolean tapped = KhyAccessibilityService.Companion.getInstance().tap(centre[0], centre[1]);
            if (tapped) {
                return new JSONObject().put("ok", true).put("via", "gesture").put("x", centre[0]).put("y", centre[1]);
            }
        }
        return new JSONObject().put("ok", false).put("error", "界面上找不到或点不掉「" + query + "」");
    }

    private static JSONObject global(int action) throws Exception {
        boolean ok = KhyAccessibilityService.Companion.getInstance().performGlobal(action);
        JSONObject r = new JSONObject().put("ok", ok).put("action", action);
        if (!ok) r.put("error", "系统拒绝了该全局动作");
        return r;
    }

    // ── 截图（AccessibilityService.takeScreenshot，API 30+） ─────────────────

    private static JSONObject shot(JSONObject a, boolean asB64) throws Exception {
        JSONObject r = new JSONObject();
        if (Build.VERSION.SDK_INT < 30) {
            return r.put("ok", false).put("error", "takeScreenshot 需要 API 30+，本机 " + Build.VERSION.SDK_INT);
        }
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<Bitmap> ref = new AtomicReference<Bitmap>();
        final AtomicReference<String> fail = new AtomicReference<String>(null);
        KhyAccessibilityService.Companion.getInstance().takeScreenshot(Display.DEFAULT_DISPLAY, new java.util.concurrent.Executor() {
            public void execute(Runnable command) { command.run(); }
        }, new android.accessibilityservice.AccessibilityService.TakeScreenshotCallback() {
            public void onSuccess(android.accessibilityservice.AccessibilityService.ScreenshotResult result) {
                try {
                    HardwareBuffer hb = result.getHardwareBuffer();
                    Bitmap b = Bitmap.wrapHardwareBuffer(hb, result.getColorSpace());
                    if (b != null) ref.set(b.copy(Bitmap.Config.ARGB_8888, false));
                    else fail.set("wrapHardwareBuffer 返回 null");
                    hb.close();
                } catch (Throwable t) {
                    fail.set(t.getClass().getSimpleName() + ": " + t.getMessage());
                } finally {
                    latch.countDown();
                }
            }
            public void onFailure(int errorCode) {
                fail.set("takeScreenshot 失败 errorCode=" + errorCode);
                latch.countDown();
            }
        });
        if (!latch.await(10, TimeUnit.SECONDS)) {
            return r.put("ok", false).put("error", "截图超时 10s");
        }
        Bitmap bmp = ref.get();
        if (bmp == null) return r.put("ok", false).put("error", "截图失败：" + fail.get());

        int origW = bmp.getWidth(), origH = bmp.getHeight();
        if (asB64) {
            int maxw = Math.max(64, Math.min(a.optInt("maxw", 480), origW));
            int quality = Math.max(10, Math.min(a.optInt("quality", 60), 100));
            int w = maxw, h = Math.max(1, Math.round(origH * (maxw / (float) origW)));
            Bitmap scaled = (w == origW && h == origH) ? bmp : Bitmap.createScaledBitmap(bmp, w, h, true);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            scaled.compress(Bitmap.CompressFormat.JPEG, quality, bo);
            if (scaled != bmp) scaled.recycle();
            byte[] bytes = bo.toByteArray();
            r.put("ok", true)
             .put("orig_w", origW).put("orig_h", origH)
             .put("w", w).put("h", h)
             .put("bytes", bytes.length)
             .put("scale", w / (float) origW)
             .put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            bmp.recycle();
            return r;
        }
        String path = a.optString("path", "");
        if (path.length() == 0) path = BridgeService.BRIDGE_DIR + "/shot_" + System.currentTimeMillis() + ".png";
        try {
            File f = new File(path);
            File parent = f.getParentFile();
            if (parent != null) parent.mkdirs();
            FileOutputStream fo = new FileOutputStream(f);
            bmp.compress(Bitmap.CompressFormat.PNG, 100, fo);
            fo.flush();
            fo.getFD().sync();
            fo.close();
            r.put("ok", true).put("path", f.getAbsolutePath()).put("w", origW).put("h", origH).put("bytes", f.length());
        } catch (Throwable t) {
            r.put("ok", false).put("error", "写文件失败：" + t.getMessage());
        }
        bmp.recycle();
        return r;
    }
}

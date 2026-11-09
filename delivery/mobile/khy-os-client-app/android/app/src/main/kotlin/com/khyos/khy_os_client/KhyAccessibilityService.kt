// khy-canary: Khy-20261101-022-1AVQKFT2
package com.khyos.khy_os_client

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * KhyAccessibilityService — AI assistant's "fingers".
 *
 * Capabilities:
 *   - tap(x, y) / swipe(x1,y1,x2,y2)
 *   - find UI elements by text/id/class
 *   - findAndClick / findAndLongClick
 *   - global actions: HOME / BACK / NOTIFICATIONS / RECENTS
 *   - dump UI tree for VLM decision making
 *   - typeText into focused input
 *   - listClickable elements
 */
class KhyAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "KhyAccessibility"
        @Volatile
        var instance: KhyAccessibilityService? = null
            private set

        fun isReady(): Boolean = instance != null

        /**
         * 最近一次确实收到无障碍事件的时间（epoch ms）。
         *
         * 为什么需要它，[isReady] 不够用：[isReady] 只说"服务对象还在"。
         * 系统把无障碍服务停掉时 onDestroy/onUnbind 会跑，instance 置空——但那
         * 不是唯一的死法。更常见的是进程被冻结/挂起：对象还在，事件却不来了。
         * 这时 [isReady] 一直返回 true，而所有依赖它的功能（手势、读气泡）已经
         * 悄悄全废。
         *
         * 所以"活着"的判据必须是**最近还在收事件**，而不是"对象非空"。
         */
        @Volatile
        var lastEventAt: Long = 0L
            private set

        /** 多久没收到事件就算"可疑"。 */
        private const val STALE_AFTER_MS = 120_000L

        /** 服务是否还在正常收事件。 */
        fun isAlive(): Boolean {
            val last = lastEventAt
            if (last == 0L) return isReady()
            return System.currentTimeMillis() - last < STALE_AFTER_MS
        }

        /**
         * Package name of the window that currently has focus, or "" when it
         * cannot be determined.
         *
         * WHY this exists. The reverse-proxy ask path (AmooLoop.ask) used to
         * find out the hard way that Amoo was not in the foreground: the prompt
         * landed in our OWN input box, no send button was found, the write-back
         * retried three times, fell through to a pending file, and the caller
         * waited out its whole budget for an answer that was never asked. A
         * pre-check turns that into an immediate coded error.
         *
         * Deliberately returns "" rather than throwing or guessing on failure:
         * the caller treats "" as "unknown" and proceeds, which is the honest
         * reading. A wrong package name would be worse than none.
         */
        fun foregroundPackage(): String {
            val svc = instance ?: return ""
            return try {
                val root = svc.rootInActiveWindow ?: return ""
                root.packageName?.toString() ?: ""
            } catch (_: Throwable) {
                ""
            }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "KhyAccessibilityService connected")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        super.onDestroy()
        instance = null
    }

    // --- Gesture dispatch ---

    fun tap(x: Int, y: Int): Boolean = dispatchGesture(x, y, x, y, 50)

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int): Boolean =
        dispatchGesture(x1, y1, x2, y2, maxOf(50, durationMs))

    private fun dispatchGesture(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int): Boolean {
        val svc = instance ?: return false
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val desc = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.toLong()))
            .build()

        val latch = CountDownLatch(1)
        val result = booleanArrayOf(false)

        val cb = object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription) {
                result[0] = true
                latch.countDown()
            }
            override fun onCancelled(gestureDescription: GestureDescription) {
                result[0] = false
                latch.countDown()
            }
        }

        svc.dispatchGesture(desc, cb, mainHandler)
        // The wait must track the gesture's own duration, not a fixed constant.
        // A hardcoded 2s made every gesture longer than ~1900ms report as
        // cancelled: the callback fires only after the stroke finishes, so a
        // 5s long press was still in flight when the latch gave up and the
        // caller saw "gesture cancelled" for a gesture that ran fine.
        // The margin covers callback delivery on a busy main thread.
        latch.await(durationMs + 500L, TimeUnit.MILLISECONDS)
        return result[0]
    }

    // --- Global actions ---

    fun performGlobal(action: Int): Boolean {
        val svc = instance ?: return false
        return try { svc.performGlobalAction(action) } catch (_: Throwable) { false }
    }

    // --- Find elements ---

    fun find(query: String): AccessibilityNodeInfo? {
        val svc = instance ?: return null
        val root = svc.rootInActiveWindow ?: return null
        if (query.isEmpty()) return root

        val q = query.trim()
        return when {
            q.startsWith("text=") -> findByText(root, q.removePrefix("text="))
            q.startsWith("id=") -> findById(root, q.removePrefix("id="))
            q.startsWith("class=") -> findByClass(root, q.removePrefix("class="))
            else -> findByText(root, q)
        }
    }

    private fun findByText(root: AccessibilityNodeInfo, text: String): AccessibilityNodeInfo? {
        for (n in root.findAccessibilityNodeInfosByText(text)) {
            if (n != null) return n
        }
        return null
    }

    private fun findById(root: AccessibilityNodeInfo, id: String): AccessibilityNodeInfo? {
        return try {
            root.findAccessibilityNodeInfosByViewId(id)?.firstOrNull()
        } catch (_: Throwable) { null }
    }

    private fun findByClass(root: AccessibilityNodeInfo, className: String): AccessibilityNodeInfo? {
        return walk(root) { it.className?.toString() == className }
    }

    private fun walk(node: AccessibilityNodeInfo?, pred: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (node == null) return null
        if (pred(node)) return node
        for (i in 0 until node.childCount) {
            val r = walk(node.getChild(i), pred)
            if (r != null) return r
        }
        return null
    }

    // --- Find + action ---

    fun findAndClick(query: String): Boolean {
        val n = find(query) ?: return false
        if (n.isClickable) return n.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        var parent = n.parent
        while (parent != null) {
            if (parent.isClickable) return parent.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            parent = parent.parent
        }
        return false
    }

    fun findAndLongClick(query: String): Boolean {
        val n = find(query) ?: return false
        if (n.isLongClickable) return n.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)
        return false
    }

    fun findCenterBounds(query: String): IntArray? {
        val n = find(query) ?: return null
        var target = n
        if (!n.isClickable) {
            var p = n.parent
            var hops = 0
            while (p != null && hops < 4) {
                if (p.isClickable) { target = p; break }
                p = p.parent
                hops++
            }
        }
        val r = android.graphics.Rect()
        target.getBoundsInScreen(r)
        if (r.isEmpty) return null
        return intArrayOf(r.centerX(), r.centerY(), r.width(), r.height())
    }

    // --- UI dump ---

    fun dumpUi(): String {
        val svc = instance ?: return ""
        val root = svc.rootInActiveWindow ?: return ""
        val sb = StringBuilder()
        walkDump(root, sb, 0, 6)
        return sb.toString()
    }

    private fun walkDump(n: AccessibilityNodeInfo, sb: StringBuilder, depth: Int, maxDepth: Int) {
        if (depth > maxDepth) return
        val text = n.text?.toString() ?: ""
        val desc = n.contentDescription?.toString() ?: ""
        val id = n.viewIdResourceName ?: ""
        val cls = n.className?.toString()?.let { shortClass(it) } ?: ""

        if (text.isNotEmpty() || desc.isNotEmpty() || id.isNotEmpty()) {
            sb.append("  ".repeat(depth))
            if (text.isNotEmpty()) sb.append("text=\"$text\" ")
            if (desc.isNotEmpty()) sb.append("desc=\"$desc\" ")
            if (id.isNotEmpty()) sb.append("id=$id ")
            if (cls.isNotEmpty()) sb.append("class=$cls")
            sb.append("\n")
        }
        for (i in 0 until n.childCount) {
            walkDump(n.getChild(i), sb, depth + 1, maxDepth)
        }
    }

    private fun shortClass(c: String): String {
        val dot = c.lastIndexOf('.')
        return if (dot >= 0) c.substring(dot + 1) else c
    }

    // --- List clickable ---

    fun listClickable(): List<Array<String>> {
        val out = mutableListOf<Array<String>>()
        val svc = instance ?: return out
        val root = svc.rootInActiveWindow ?: return out
        walkClickable(root, out, 0, 8)
        return out
    }

    private fun walkClickable(n: AccessibilityNodeInfo, out: MutableList<Array<String>>, depth: Int, maxDepth: Int) {
        if (depth > maxDepth) return
        if (n.isClickable) {
            val text = n.text?.toString() ?: ""
            val desc = n.contentDescription?.toString() ?: ""
            val cls = n.className?.toString()?.let { shortClass(it) } ?: ""
            val label = if (text.isNotEmpty()) text else desc
            val r = android.graphics.Rect()
            n.getBoundsInScreen(r)
            if (!r.isEmpty) {
                out.add(arrayOf(label, cls, n.isClickable.toString(),
                    r.centerX().toString(), r.centerY().toString(),
                    r.width().toString(), r.height().toString()))
            }
        }
        for (i in 0 until n.childCount) {
            walkClickable(n.getChild(i), out, depth + 1, maxDepth)
        }
    }

    // --- Type text ---

    fun typeText(text: String): Boolean {
        val svc = instance ?: return false
        val root = svc.rootInActiveWindow ?: return false
        var focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused == null) {
            focused = walk(root) { it.className?.toString() == "android.widget.EditText" }
        }
        focused ?: return false
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 每一次事件都是"我还活着"的心跳。见 lastEventAt 的注释：系统冻结进程时
        // 对象还在但事件停收，isReady() 会一直撒谎，只有时间戳能看出来。
        lastEventAt = System.currentTimeMillis()
    }

    // --- Screenshot ---

    /**
     * 用无障碍服务截一张图，返回 base64 JPEG 与它的几何。
     *
     * 为什么在有 MediaProjection 之外还要这一条：MediaProjection 每一次都要系统
     * 弹窗确认，而这条路除了用户已经授予的无障碍服务之外**什么都不需要**。而视觉
     * 定位本来就要无障碍——点击靠 `dispatchGesture`，那也是这个服务给的。所以走
     * 这条路是从"两个同意"降到"一个同意"，而且是消掉那个每次都会挡路的系统弹窗。
     *
     * 这不是为了绕过任何确认：无障碍服务本身就是用户显式开的，`canTakeScreenshot`
     * 写在本服务的配置里，用户在系统设置里能看到。真正被绕过的那种东西（用 a11y 去
     * 点系统的同意对话框）不在这里做。
     *
     * @param maxLongSide 长边上限，超过就等比缩小。传 0 不缩小。
     * @param quality JPEG 质量 1-100。
     * @return null 表示服务没连上或截图失败——调用方应当降级，不要把"没截到"当错误。
     */
    fun screenshotB64(maxLongSide: Int, quality: Int): Map<String, Any>? {
        val svc = instance ?: return null
        if (Build.VERSION.SDK_INT < 30) return null

        val latch = CountDownLatch(1)
        val out = AtomicReference<Map<String, Any>?>(null)

        try {
            svc.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                java.util.concurrent.Executor { it.run() },
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                        try {
                            val hb = result.hardwareBuffer ?: return
                            val bmp = Bitmap.wrapHardwareBuffer(hb, result.colorSpace)
                            hb.close()
                            if (bmp == null) return
                            val copy = bmp.copy(Bitmap.Config.ARGB_8888, false)
                            bmp.recycle()
                            val scaled = if (maxLongSide > 0 &&
                                Math.max(copy.width, copy.height) > maxLongSide
                            ) {
                                val s = maxLongSide.toDouble() /
                                    Math.max(copy.width, copy.height)
                                val w = Math.max(1, Math.round(copy.width * s).toInt())
                                val h = Math.max(1, Math.round(copy.height * s).toInt())
                                Bitmap.createScaledBitmap(copy, w, h, true)
                            } else {
                                copy
                            }
                            val bo = ByteArrayOutputStream()
                            scaled.compress(
                                Bitmap.CompressFormat.JPEG,
                                quality.coerceIn(1, 100),
                                bo,
                            )
                            if (scaled !== copy) scaled.recycle()
                            copy.recycle()
                            out.set(
                                mapOf(
                                    "b64" to Base64.encodeToString(
                                        bo.toByteArray(), Base64.NO_WRAP,
                                    ),
                                    "w" to scaled.width,
                                    "h" to scaled.height,
                                    // 原图尺寸也要给：换算坐标用的是屏幕空间，不是
                                    // 缩小后的 JPEG 空间。少了这两个数，调用方只能
                                    // 猜一个比例，而猜错的症状是"点偏了"且无从查起。
                                    "orig_w" to copy.width,
                                    "orig_h" to copy.height,
                                ),
                            )
                        } catch (t: Throwable) {
                            Log.w(TAG, "screenshotB64 encode failed: ${t.message}")
                        } finally {
                            latch.countDown()
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        Log.w(TAG, "screenshotB64 failed errorCode=$errorCode")
                        latch.countDown()
                    }
                },
            )
        } catch (t: Throwable) {
            Log.w(TAG, "screenshotB64 threw: ${t.message}")
            return null
        }

        // 10 秒：比 MediaProjection 那条路的 2 秒宽，因为系统侧这道调用本来就更慢，
        // 而超时降级到 MediaProjection 比让用户等一个必然失败的调用好。
        if (!latch.await(10, TimeUnit.SECONDS)) return null
        return out.get()
    }
}

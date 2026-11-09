// khy-canary: Khy-20261101-023-STRGYYY5
package com.khyos.khy_os_client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * ScreenCaptureService — Foreground service that holds MediaProjection handle.
 *
 * Flow:
 *   1) startForeground(id, notification)
 *   2) handleStartProjection(resultCode, data)
 *   3) captureFrame() — silent screenshot anytime
 *   4) stopProjection()
 */
class ScreenCaptureService : Service() {

    companion object {
        private const val TAG = "ScreenCapture"
        const val ACTION_START = "com.khyos.khy_os_client.action.START_PROJECTION"
        const val ACTION_STOP = "com.khyos.khy_os_client.action.STOP_PROJECTION"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val NOTIF_ID = 0x5C5C
        private const val CHANNEL_ID = "khy_screen_capture"
        private const val MAX_LONG_SIDE = 1280
        private const val JPEG_QUALITY = 80
        private const val FRAME_TIMEOUT_MS = 2000L

        @Volatile
        var instance: ScreenCaptureService? = null
            private set

        fun isReady(): Boolean = instance?.projection != null && instance?.imageReader != null
    }

    private var projection: MediaProjection? = null
    private var imageReader: ImageReader? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var width = 0
    private var height = 0
    private var density = 0

    // ── screen metrics ──
    //
    // WHY THESE FIELDS EXIST. This path used to return a JPEG and nothing
    // else, so a caller holding that image had no way to know which pixel of
    // the screen each image pixel corresponded to. Every consumer that needed
    // the answer therefore guessed, and the guess was invisible: a model
    // returning a normalised coordinate got converted with a ratio that was
    // merely close, and the tap landed near-but-not-on the target with nothing
    // in any log to explain it.
    //
    // So the projection reports its own geometry, and reports it MEASURED
    // rather than derived. `imgW`/`imgH` are read off the bitmap that was
    // actually compressed — not recomputed on the Dart side as
    // `round(w * scale)`, because `Bitmap.createScaledBitmap` rounds and a
    // one-pixel error is enough to miss a small target.
    //
    // `setupRotation` is the rotation the VirtualDisplay was created under.
    // `createVirtualDisplay` fixes the surface geometry at that moment, so a
    // later rotation leaves the image space and the gesture space disagreeing.
    // Reporting that as `stale` is deliberate: refusing to convert is
    // recoverable, converting anyway is a silent mis-tap.

    /** Surface rotation captured when the VirtualDisplay was created. */
    @Volatile private var setupRotation = -1

    /** Width of the JPEG actually returned by the last successful capture. */
    @Volatile private var imgW = 0

    /** Height of the JPEG actually returned by the last successful capture. */
    @Volatile private var imgH = 0

    override fun onCreate() {
        super.onCreate()
        instance = this
        val m = resources.displayMetrics
        width = m.widthPixels
        height = m.heightPixels
        density = m.densityDpi
        thread = HandlerThread("khy-screen-capture").also { it.start() }
        handler = Handler(thread!!.looper)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_START) {
            val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
            val data = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
            if (resultCode != 0 && data != null) {
                startForegroundWithNotification()
                setupProjection(resultCode, data)
                return START_STICKY
            }
        }
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundWithNotification()
        return START_STICKY
    }

    private fun startForegroundWithNotification() {
        val channel = NotificationChannel(CHANNEL_ID, "屏幕捕获", NotificationManager.IMPORTANCE_LOW).apply {
            description = "khy-os 看屏模式：服务运行中"
        }
        val nm = getSystemService(NOTIFICATION_SERVICE) as? NotificationManager
        nm?.createNotificationChannel(channel)

        val open = packageManager.getLaunchIntentForPackage(packageName)
        val pi = open?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
        }

        val notif = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("khy-os 看屏模式")
            .setContentText("服务运行中（点击返回）")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun createChannel() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(CHANNEL_ID, "屏幕捕获", NotificationManager.IMPORTANCE_LOW).apply {
            description = "khy-os 看屏模式：服务运行中"
        }
        nm.createNotificationChannel(channel)
    }

    private fun setupProjection(resultCode: Int, data: Intent) {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection = mpm.getMediaProjection(resultCode, data)
        projection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                handler?.post { teardownProjection() }
            }
        }, handler)
        handler?.post {
            try {
                imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
                virtualDisplay = projection?.createVirtualDisplay(
                    "khy-screen-capture",
                    width, height, density,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    imageReader?.surface, null, null
                )
                // The surface geometry is frozen here, so this is the moment
                // the image space becomes valid. Recording it (rather than the
                // rotation at onCreate) means a rotation that happened between
                // service start and projection start is not misreported as
                // staleness.
                setupRotation = currentRotation()
            } catch (e: Exception) {
                Log.e(TAG, "setupProjection failed: ${e.message}")
            }
        }
    }

    /**
     * The projection's geometry, for converting image coordinates to screen
     * coordinates.
     *
     * TWO SCREEN SIZES ARE REPORTED ON PURPOSE. `screen_w`/`screen_h` are the
     * values the VirtualDisplay was built from — what we asked for.
     * `disp_w`/`disp_h` are the display's real size, which is the space
     * `dispatchGesture` actually addresses. On most devices these are equal;
     * where they are not (display cutout accounting, multi-window), the
     * gesture space is the real one, and a caller that used the requested size
     * would be off by the difference. Reporting both lets the Dart side notice
     * the disagreement instead of inheriting it silently.
     *
     * Never throws, never blocks on the capture thread.
     */
    fun getScreenMetrics(): Map<String, Any> {
        val dm = resources.displayMetrics
        val rot = currentRotation()
        val real = displayRealSize()
        return mapOf(
            "screen_w" to dm.widthPixels,
            "screen_h" to dm.heightPixels,
            "disp_w" to real.first,
            "disp_h" to real.second,
            "img_w" to imgW,
            "img_h" to imgH,
            "rotation" to rot,
            "setup_rotation" to setupRotation,
            "stale" to (setupRotation >= 0 && rot != setupRotation),
            "density_dpi" to dm.densityDpi,
            "source" to if (projection != null) "projection" else "none"
        )
    }

    @Suppress("DEPRECATION")
    private fun defaultDisplay(): android.view.Display? =
        (getSystemService(Context.WINDOW_SERVICE) as? WindowManager)?.defaultDisplay

    private fun currentRotation(): Int = defaultDisplay()?.rotation ?: -1

    @Suppress("DEPRECATION")
    private fun displayRealSize(): Pair<Int, Int> {
        val d = defaultDisplay() ?: return 0 to 0
        val p = android.graphics.Point()
        d.getRealSize(p)
        return p.x to p.y
    }

    fun captureFrame(): String? {
        if (projection == null || imageReader == null) return null
        val result = AtomicReference<String?>(null)
        val latch = CountDownLatch(1)
        handler?.post {
            try {
                var image = imageReader?.acquireLatestImage()
                if (image == null) {
                    Thread.sleep(200)
                    image = imageReader?.acquireLatestImage()
                }
                if (image != null) {
                    try {
                        var bmp = imageToBitmap(image, width, height)
                        bmp = scaleIfTooBig(bmp, MAX_LONG_SIDE)
                        // Measured, not derived: this is the bitmap that is
                        // about to be compressed, so these are the dimensions
                        // the caller's image coordinates live in. Recomputing
                        // them on the other side of the channel would mean
                        // duplicating the rounding in scaleIfTooBig, and a
                        // one-pixel disagreement is enough to miss a target.
                        imgW = bmp.width
                        imgH = bmp.height
                        val out = ByteArrayOutputStream()
                        bmp.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
                        result.set("data:image/jpeg;base64,${Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)}")
                        bmp.recycle()
                    } finally {
                        image.close()
                    }
                }
            } catch (t: Throwable) {
                Log.e(TAG, "captureFrame error: ${t.message}")
            } finally {
                latch.countDown()
            }
        }
        latch.await(FRAME_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        return result.get()
    }

    fun isProjectionReady(): Boolean = projection != null && imageReader != null

    fun teardownProjection() {
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.close()
        imageReader = null
        projection?.stop()
        projection = null
        // The image space dies with the projection. Leaving the old numbers
        // here would make the next captureFrame look like it had metrics when
        // the geometry it describes no longer exists.
        imgW = 0
        imgH = 0
        setupRotation = -1
    }

    override fun onDestroy() {
        handler?.post { teardownProjection() }
        thread?.quitSafely()
        instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun imageToBitmap(image: Image, w: Int, h: Int): Bitmap {
        val planes = image.planes
        val buffer = planes[0].buffer
        val pixelStride = planes[0].pixelStride
        val rowStride = planes[0].rowStride
        val rowPadding = rowStride - pixelStride * w
        val bitmap = Bitmap.createBitmap(w + rowPadding / pixelStride, h, Bitmap.Config.ARGB_8888)
        bitmap.copyPixelsFromBuffer(buffer)
        return if (rowPadding != 0) {
            val cropped = Bitmap.createBitmap(bitmap, 0, 0, w, h)
            bitmap.recycle()
            cropped
        } else {
            bitmap
        }
    }

    private fun scaleIfTooBig(bmp: Bitmap, maxLongSide: Int): Bitmap {
        val w = bmp.width
        val h = bmp.height
        if (maxOf(w, h) <= maxLongSide) return bmp
        val scale = maxLongSide.toDouble() / maxOf(w, h)
        val scaled = Bitmap.createScaledBitmap(bmp, Math.round(w * scale).toInt(), Math.round(h * scale).toInt(), true)
        if (scaled !== bmp) bmp.recycle()
        return scaled
    }
}

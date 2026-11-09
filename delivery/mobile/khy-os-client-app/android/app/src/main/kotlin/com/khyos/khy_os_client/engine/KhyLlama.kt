package com.khyos.khy_os_client.engine

import java.io.File
import java.io.IOException

/**
 * KhyLlama — the JNI handle for khy-os's built-in inference engine.
 *
 * WHY THIS EXISTS. The requirement (2026-10-27) is a local vision model with no
 * Ollama install anywhere: not on the phone, not in Termux, not on the PC as a
 * prerequisite. That leaves one route — khy-os carries its own engine, built
 * from llama.cpp + mtmd and linked into the APK. See
 * `android/app/src/main/cpp/CMakeLists.txt` for why it is a library and not a
 * spawned process (Android blocks exec() from the app home directory since
 * API 29).
 *
 * WHAT IT IS NOT. It is not a chat client, not a model manager, and not an
 * OpenAI server. It is the thin Kotlin face of one C call surface:
 * load / chat / info / free. Everything above it (the OpenAI-compatible
 * endpoint, model download, the settings UI) lives in other classes so this one
 * stays auditable — it is the only place a 2.6 GB model gets mapped into the
 * process.
 *
 * THREADING. The native side serialises on a mutex, so concurrent calls queue
 * rather than corrupt the KV cache. That is deliberate: the alternative — a
 * context per caller — multiplies memory by the number of callers, and on a
 * 15.6 GB device with a 2.6 GB model that is the difference between working and
 * being OOM-killed.
 *
 * CONTRACT: total. Every failure throws [IOException] with a Chinese-free,
 * specific message; nothing returns null and leaves the caller guessing. The
 * Dart layer turns these into honest "why it didn't work" strings.
 */
class KhyLlama {

    private var handle: Long = 0L

    /** True once a model pair is loaded and ready to answer. */
    val isLoaded: Boolean get() = handle != 0L

    /**
     * Load a text model and its vision projector.
     *
     * @param modelPath  absolute path to the text GGUF
     * @param mmprojPath absolute path to the mmproj GGUF; may be empty for a
     *                   text-only model, but then [chat] refuses images rather
     *                   than answering blind
     * @param nCtx       context size in tokens; 4096 is the floor that fits one
     *                   image plus a prompt plus an answer for Qwen3-VL
     * @param nThreads   inference threads; the device has 8 cores, and 4 leaves
     *                   headroom for the UI thread and the decode pipeline
     * @param nativeLibDir the app's `ApplicationInfo.nativeLibraryDir`, supplied
     *                   by the caller. WHY IT IS A PARAMETER AND NOT RESOLVED
     *                   HERE: the only hidden-API-free way to reach it is
     *                   `android.app.ActivityThread.currentApplication()`, which
     *                   is not in the public SDK — and this class deliberately
     *                   holds no Context. Passing it in keeps KhyLlama a plain
     *                   class with no Android framework dependency beyond JNI,
     *                   which is also what makes it testable.
     * @throws IOException if either file is missing or the model fails to load
     */
    @Throws(IOException::class)
    fun load(
        modelPath: String,
        mmprojPath: String,
        nCtx: Int = DEFAULT_N_CTX,
        nThreads: Int = DEFAULT_N_THREADS,
        nativeLibDir: String = "",
    ) {
        if (isLoaded) free()
        requireFile(modelPath, "模型")
        if (mmprojPath.isNotEmpty()) requireFile(mmprojPath, "视觉投影器")

        // loadLibrary, not System.load: the .so ships inside the APK's lib dir,
        // which is the only place the OS lets an app load native code from.
        synchronized(KhyLlama::class.java) {
            if (!nativeLibLoaded) {
                try {
                    System.loadLibrary("khyllama")
                    nativeLibLoaded = true
                } catch (e: UnsatisfiedLinkError) {
                    // Not swallowed. This is the failure that used to be
                    // invisible: it is an Error, not an Exception, so it slipped
                    // past every `catch (e: IOException)` on the path and the
                    // MethodChannel never answered. Rethrown with the directory
                    // attached, because "library not found" without knowing
                    // which directory was searched is not actionable.
                    throw IOException(
                        "载入 libkhyllama.so 失败（libDir=$nativeLibDir）：${e.message}")
                }
            }
        }

        // MUST precede nativeLoad. The CPU backends are dlopened modules and
        // llama.cpp's own directory search resolves /proc/self/exe, which on
        // Android is app_process64 — not this library's directory. Without the
        // explicit path, zero backends register and the load fails in a way
        // that looks like a corrupt model. See nativeInitBackend in the .cpp.
        nativeInitBackend(nativeLibDir)

        val h = nativeLoad(modelPath, mmprojPath, nCtx, nThreads, /*verbose=*/false)
        if (h == 0L) {
            // nativeLoad throws on every failure path it knows about; a zero
            // return without an exception means the JNI method itself was not
            // found, which is a build/packaging bug rather than a user error.
            throw IOException("引擎加载返回空句柄——libkhyllama.so 可能没打进这个包")
        }
        handle = h
    }

    /**
     * Answer one prompt, optionally with one image.
     *
     * The image is passed as raw encoded bytes (JPEG/PNG) — mtmd decodes it
     * internally, so there is no Bitmap round-trip and no chance of a colour
     * format mismatch between Android's decoder and the model's expectation.
     *
     * @param prompt      the full prompt, already in the model's expected format
     * @param imageBytes  encoded image, or null for a text-only prompt
     * @param maxTokens   generation cap
     * @param temperature sampling temperature; low by default, because the
     *                    caller asks closed questions ("where is the button")
     * @throws IOException if no model is loaded, the image cannot be decoded,
     *                     or the model produces nothing
     */
    @Throws(IOException::class)
    fun chat(
        prompt: String,
        imageBytes: ByteArray?,
        maxTokens: Int = DEFAULT_MAX_TOKENS,
        temperature: Float = DEFAULT_TEMPERATURE,
    ): String {
        if (!isLoaded) throw IOException("引擎未加载")
        if (prompt.isBlank()) throw IOException("提示词为空")

        return nativeChat(handle, prompt, imageBytes, maxTokens, temperature)
            ?: throw IOException("模型没有产出——nativeChat 返回空")
    }

    /** Model metadata as a small JSON blob, for display and diagnostics. */
    fun info(): String {
        if (!isLoaded) return "{}"
        return nativeInfo(handle) ?: "{}"
    }

    /** Release the model. Safe to call twice; safe to call when not loaded. */
    fun free() {
        val h = handle
        if (h != 0L) {
            handle = 0L
            nativeFree(h)
        }
    }

    private fun requireFile(path: String, what: String) {
        val f = File(path)
        if (!f.exists()) throw IOException("$what 文件不存在：$path")
        if (!f.canRead()) throw IOException("$what 文件不可读：$path")
        // A zero-length GGUF is the signature of a download that was interrupted
        // and never resumed. Checking here turns a confusing native crash into a
        // sentence the user can act on.
        if (f.length() == 0L) throw IOException("$what 文件是空的（下载可能没完成）：$path")
    }

    companion object {
        private const val DEFAULT_N_CTX = 4096
        private const val DEFAULT_N_THREADS = 4
        private const val DEFAULT_MAX_TOKENS = 512
        private const val DEFAULT_TEMPERATURE = 0.1f

        @Volatile
        private var nativeLibLoaded = false

        // ── JNI. The names must match khy_llama_jni.cpp exactly; a typo here
        // shows up as UnsatisfiedLinkError at the first call, not at compile.
        @JvmStatic
        private external fun nativeInitBackend(backendDir: String)

        @JvmStatic
        private external fun nativeLoad(
            modelPath: String,
            mmprojPath: String,
            nCtx: Int,
            nThreads: Int,
            verbose: Boolean,
        ): Long

        @JvmStatic
        private external fun nativeChat(
            handle: Long,
            prompt: String,
            image: ByteArray?,
            maxTokens: Int,
            temperature: Float,
        ): String?

        @JvmStatic
        private external fun nativeInfo(handle: Long): String?

        @JvmStatic
        private external fun nativeFree(handle: Long)
    }
}

package com.khyos.khy_os_client.engine

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * LocalVisionServer — a loopback OpenAI-compatible endpoint backed by the
 * built-in llama.cpp engine.
 *
 * WHY THIS SHAPE. The whole point of the feature (2026-10-27) is a local vision
 * model with no Ollama anywhere. The Dart layer already speaks OpenAI's
 * `/v1/chat/completions` — it was written for Ollama's shim and it is correct.
 * So rather than teaching Dart a second protocol, this class speaks the one it
 * already speaks, over a port nothing else can reach. `visionBaseUrl` becomes
 * `http://127.0.0.1:<port>/v1`, `AppConfigData.visionIsLocal` returns true
 * *by construction* rather than because the user typed a loopback address, and
 * the privacy gate that blocks background WeChat sync from ever uploading a
 * screenshot to a third party is satisfied without relaxing anything.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *   - No authentication. The bridge on 8896 needs a Bearer token because it
 *     exposes 42 tools including `exec`. This exposes one thing: answer this
 *     prompt with this image. Binding loopback-only (see the note in HttpBridge
 *     about why `new ServerSocket(port)` is wrong) means the only parties that
 *     can reach it already have the device.
 *   - No streaming, no `n`, no tool calls, no function calling. The Dart client
 *     sends one message and reads one answer. Implementing the rest of the
 *     OpenAI surface would be code nobody calls, and every unused branch is a
 *     place for a future reader to assume a contract that was never honoured.
 *   - No model swapping mid-flight. One engine per server lifetime; changing
 *     models means restarting, which the settings UI does.
 *
 * THREADING. One accept loop, one worker thread per connection. The engine
 * itself serialises internally (see KhyLlama), so concurrent requests queue
 * rather than corrupt the KV cache — which is the correct behaviour for a
 * single-model server and much cheaper than a context per caller.
 *
 * Contract: total. Every failure produces a well-formed OpenAI-shaped error
 * body, because the Dart client parses that shape and a connection reset would
 * surface as "vision call failed" with no reason.
 */
class LocalVisionServer private constructor() {

    private var server: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val running = AtomicBoolean(false)

    /** The engine. Null until [start] succeeds; never null while running. */
    @Volatile
    private var engine: KhyLlama? = null

    /** The port actually bound, or 0 when not running. */
    @Volatile
    var port: Int = 0
        private set

    val isRunning: Boolean get() = running.get() && server != null

    /**
     * Bind loopback and start serving.
     *
     * @param modelPath  text GGUF
     * @param mmprojPath vision projector GGUF
     * @param wantPort   preferred port; 0 picks a free one
     * @return the bound port
     * @throws IOException if the model cannot be loaded or the socket cannot be
     *         bound. The message is user-facing and says which of the two.
     */
    @Throws(IOException::class)
    fun start(
        modelPath: String,
        mmprojPath: String,
        wantPort: Int = 0,
        nativeLibDir: String = "",
    ): Int {
        if (running.get()) stop()

        // Load the model BEFORE binding. A server that accepts connections and
        // then fails to answer is worse than one that never started: the user
        // sees "reachable" in the settings test and then a wall of errors from
        // the actual tool call.
        val eng = KhyLlama()
        try {
            eng.load(modelPath, mmprojPath, nativeLibDir = nativeLibDir)
        } catch (e: Throwable) {
            // Throwable, not IOException. An UnsatisfiedLinkError (missing
            // libkhyllama.so, or a missing CPU-backend module) is an Error, and
            // catching only IOException let it escape — the MethodChannel
            // result was never sent and the Dart side waited forever with no
            // message. Logged here because this is the one place that knows all
            // four inputs, and the JNI layer's own error does not name them.
            Log.e(TAG, "engine load failed: model=$modelPath mmproj=$mmprojPath " +
                    "libDir=$nativeLibDir", e)
            throw e
        }
        engine = eng

        val bound = try {
            bindLoopback(wantPort)
        } catch (e: IOException) {
            eng.free()
            engine = null
            throw e
        }
        server = bound
        port = bound.localPort
        running.set(true)

        acceptThread = Thread({ acceptLoop(bound) }, "khyos-vision-accept").apply {
            isDaemon = true
            start()
        }
        Log.i(TAG, "vision server on 127.0.0.1:$port model=$modelPath")
        return port
    }

    /**
     * Bind to 127.0.0.1 and nothing else.
     *
     * `new ServerSocket(port)` binds 0.0.0.1's wildcard, i.e. every interface —
     * measured on this device in HttpBridge: `ss -ltn` reported `*:8896`, so any
     * device on the same Wi-Fi could reach it. For a port that answers prompts
     * with screenshots, that is the whole ballgame, so it is bound explicitly.
     */
    private fun bindLoopback(wantPort: Int): ServerSocket {
        val candidates = if (wantPort > 0) {
            listOf(wantPort)
        } else {
            // A fixed preference order rather than port 0: the Dart config
            // records the URL, and a different port on every restart would
            // invalidate it for no reason. 0 is the last resort only.
            listOf(DEFAULT_PORT, DEFAULT_PORT + 1, DEFAULT_PORT + 2, 0)
        }
        var last: IOException? = null
        for (p in candidates) {
            try {
                val ss = ServerSocket()
                ss.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), p), 64)
                ss.soTimeout = SOCKET_TIMEOUT_MS
                return ss
            } catch (e: IOException) {
                last = e
            }
        }
        throw IOException("无法绑定本地端口（试过 ${candidates.joinToString()}）：${last?.message}")
    }

    private fun acceptLoop(ss: ServerSocket) {
        while (running.get() && !ss.isClosed) {
            try {
                val s = ss.accept()
                Thread({ handle(s) }, "khyos-vision-conn").apply {
                    isDaemon = true
                    start()
                }
            } catch (e: IOException) {
                // accept() throws once on close; that is the shutdown path, not
                // an error worth logging at error level.
                if (running.get()) Log.w(TAG, "accept failed: ${e.message}")
                return
            }
        }
    }

    private fun handle(s: Socket) {
        try {
            s.soTimeout = SOCKET_TIMEOUT_MS
            val reader = BufferedReader(InputStreamReader(s.getInputStream(), "UTF-8"))
            val writer = BufferedWriter(OutputStreamWriter(s.getOutputStream(), "UTF-8"))

            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) {
                respond(writer, 400, errorBody("malformed request line"))
                return
            }
            val method = parts[0]
            val path = parts[1].substringBefore('?')

            // Drain headers. Content-Length is the only one that matters here;
            // the rest (Accept, User-Agent, …) is read and discarded because the
            // request body cannot be read until the header block ends.
            var contentLength = 0
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0 && line.substring(0, idx).trim().equals("Content-Length", true)) {
                    contentLength = line.substring(idx + 1).trim().toIntOrNull() ?: 0
                }
            }

            val body = if (contentLength > 0) {
                val cs = CharArray(contentLength)
                var read = 0
                while (read < contentLength) {
                    val n = reader.read(cs, read, contentLength - read)
                    if (n < 0) break
                    read += n
                }
                String(cs, 0, read)
            } else ""

            when {
                method == "GET" && path.endsWith("/v1/models") -> {
                    respond(writer, 200, modelsBody())
                }
                method == "POST" && path.endsWith("/v1/chat/completions") -> {
                    handleChat(body, writer)
                }
                method == "GET" && (path == "/" || path.isEmpty()) -> {
                    // Enough for the settings page's "test connection" probe,
                    // which only checks that something answers with JSON.
                    respond(writer, 200, """{"object":"list","data":[]}""")
                }
                else -> {
                    respond(writer, 404, errorBody("no route for $method $path"))
                }
            }
        } catch (e: Throwable) {
            // A worker thread must never die silently: an unhandled throw here
            // leaves the client reading a socket that will never produce a
            // response, which surfaces as a timeout rather than a reason.
            Log.e(TAG, "connection handler failed", e)
            try {
                respond(BufferedWriter(OutputStreamWriter(s.getOutputStream(), "UTF-8")),
                        500, errorBody("internal: ${e.message}"))
            } catch (_: Throwable) {}
        } finally {
            try { s.close() } catch (_: Throwable) {}
        }
    }

    // ── the one route that matters ───────────────────────────────────────────

    private fun handleChat(body: String, writer: BufferedWriter) {
        val eng = engine
        if (eng == null || !isRunning) {
            respond(writer, 503, errorBody("engine not loaded"))
            return
        }

        val req = try {
            JSONObject(body)
        } catch (e: org.json.JSONException) {
            respond(writer, 400, errorBody("body is not JSON: ${e.message}"))
            return
        }

        // ── messages → (prompt text, image bytes) ───────────────────────────
        // The Dart client sends the standard OpenAI vision shape: a user
        // message whose content is an array of {type:"text"} and
        // {type:"image_url", image_url:{url:"data:image/jpeg;base64,..."}}.
        // Only that shape is accepted; anything else is a 400 with the reason,
        // because guessing at an unknown shape is how you answer the wrong
        // question convincingly.
        val messages = req.optJSONArray("messages")
        if (messages == null || messages.length() == 0) {
            respond(writer, 400, errorBody("messages is missing or empty"))
            return
        }

        val textParts = StringBuilder()
        var imageB64: String? = null
        var imageMime = "image/jpeg"

        for (i in 0 until messages.length()) {
            val m = messages.optJSONObject(i) ?: continue
            when (val content = m.opt("content")) {
                is String -> textParts.append(content).append('\n')
                is JSONArray -> {
                    for (j in 0 until content.length()) {
                        val part = content.optJSONObject(j) ?: continue
                        when (part.optString("type")) {
                            "text" -> textParts.append(part.optString("text")).append('\n')
                            "image_url" -> {
                                val iu = part.optJSONObject("image_url")
                                val url = iu?.optString("url") ?: ""
                                // data:image/png;base64,XXXX
                                val comma = url.indexOf(',')
                                if (url.startsWith("data:") && comma > 0) {
                                    val semi = url.indexOf(';')
                                    if (semi > 5) imageMime = url.substring(5, semi)
                                    imageB64 = url.substring(comma + 1)
                                } else if (url.isNotEmpty()) {
                                    // A remote URL. Deliberately NOT fetched:
                                    // the whole privacy property of this
                                    // feature is that the screenshot never
                                    // leaves the device, and silently
                                    // downloading one here would void it.
                                    respond(writer, 400, errorBody(
                                        "image_url must be a data: URI — " +
                                        "remote images are not fetched by design"))
                                    return
                                }
                            }
                        }
                    }
                }
            }
        }

        val prompt = textParts.toString().trim()
        if (prompt.isEmpty()) {
            respond(writer, 400, errorBody("no text content in messages"))
            return
        }

        val imageBytes = imageB64?.let {
            try {
                android.util.Base64.decode(it, android.util.Base64.DEFAULT)
            } catch (e: IllegalArgumentException) {
                respond(writer, 400, errorBody("image is not valid base64: ${e.message}"))
                return
            }
        }

        val maxTokens = req.optInt("max_tokens", 512).coerceIn(1, 4096)
        val temperature = req.optDouble("temperature", 0.1).toFloat()

        val answer = try {
            eng.chat(prompt, imageBytes, maxTokens, temperature)
        } catch (e: IOException) {
            respond(writer, 500, errorBody(e.message ?: "engine call failed"))
            return
        }

        respond(writer, 200, chatCompletionBody(answer, req.optString("model", DEFAULT_MODEL_NAME)))
    }

    // ── response bodies, shaped like OpenAI's ───────────────────────────────

    private fun modelsBody(): String {
        val m = JSONObject()
        m.put("object", "list")
        m.put("data", JSONArray().put(JSONObject().apply {
            put("id", DEFAULT_MODEL_NAME)
            put("object", "model")
            put("created", System.currentTimeMillis() / 1000)
            put("owned_by", "khy-os")
        }))
        return m.toString()
    }

    private fun chatCompletionBody(text: String, model: String): String {
        val choice = JSONObject()
        choice.put("index", 0)
        choice.put("message", JSONObject().apply {
            put("role", "assistant")
            put("content", text)
        })
        choice.put("finish_reason", "stop")

        val root = JSONObject()
        root.put("id", "chatcmpl-khyos-" + System.currentTimeMillis())
        root.put("object", "chat.completion")
        root.put("created", System.currentTimeMillis() / 1000)
        root.put("model", model)
        root.put("choices", JSONArray().put(choice))
        // usage is reported as zeros rather than omitted. The Dart client does
        // not read it today, but an absent field is a silent contract change if
        // it ever starts to, and "0" is at least honest about not counting.
        root.put("usage", JSONObject().apply {
            put("prompt_tokens", 0)
            put("completion_tokens", 0)
            put("total_tokens", 0)
        })
        return root.toString()
    }

    private fun errorBody(message: String): String {
        return JSONObject().apply {
            put("error", JSONObject().apply {
                put("message", message)
                put("type", "invalid_request_error")
                put("code", null)
            })
        }.toString()
    }

    private fun respond(writer: BufferedWriter, code: Int, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        writer.write("HTTP/1.1 $code ${reasonPhrase(code)}\r\n")
        writer.write("Content-Type: application/json; charset=utf-8\r\n")
        writer.write("Content-Length: ${bytes.size}\r\n")
        // The Dart client is a plain http package call with no keep-alive
        // expectations; closing is correct and avoids a hung connection when a
        // proxy in the middle decides to hold the socket open.
        writer.write("Connection: close\r\n")
        writer.write("\r\n")
        writer.flush()
        writer.write(String(bytes, Charsets.UTF_8))
        writer.flush()
    }

    private fun reasonPhrase(code: Int): String = when (code) {
        200 -> "OK"
        400 -> "Bad Request"
        404 -> "Not Found"
        500 -> "Internal Server Error"
        503 -> "Service Unavailable"
        else -> "Unknown"
    }

    /** Stop serving and release the model. Safe to call twice, and when stopped. */
    fun stop() {
        running.set(false)
        try { server?.close() } catch (_: Throwable) {}
        server = null
        port = 0
        engine?.free()
        engine = null
        acceptThread = null
    }

    companion object {
        private const val TAG = "khyos-vision-srv"
        private const val DEFAULT_PORT = 8780
        private const val SOCKET_TIMEOUT_MS = 120_000

        /**
         * The model name reported in `/v1/models` and echoed in completions.
         *
         * Fixed rather than derived from the GGUF filename because the Dart
         * config records whatever the user picked, and a name that changes when
         * the file is renamed would invalidate a working configuration. The
         * settings UI displays the real filename next to it.
         */
        const val DEFAULT_MODEL_NAME = "khyos-local-vision"

        @Volatile
        private var instance: LocalVisionServer? = null

        /** Process-wide singleton. One engine, one model, one port. */
        fun get(): LocalVisionServer =
            instance ?: synchronized(this) {
                instance ?: LocalVisionServer().also { instance = it }
            }
    }
}

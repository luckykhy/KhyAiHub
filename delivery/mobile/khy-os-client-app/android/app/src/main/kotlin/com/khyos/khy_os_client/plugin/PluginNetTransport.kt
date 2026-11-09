package com.khyos.khy_os_client.plugin

import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI

/**
 * The transport for `net.fetch`, and the reason it is an interface.
 *
 * WHY AN INTERFACE. The security-relevant behaviour — per-hop allowlist
 * re-validation, the resolved-address check, the hop cap — lives in [PluginHost]
 * and is tested against a fake. This class is deliberately the dumb part: it opens
 * one connection, sends, and reports what came back, including the redirect target
 * if there was one. It does NOT follow redirects, because a transport that follows
 * them itself would validate only the first URL and hand back the final response —
 * which is precisely the redirect bypass the allowlist exists to close.
 *
 * WHAT IT GUARANTEES ABOUT CREDENTIALS. It attaches none. No cookie jar is
 * installed, no Authorization header is added, and the app's own tokens never enter
 * this path. A plugin may send its OWN headers (its own API key for its own
 * service); what it must never get is the app's. That separation is the point.
 *
 * TIMEOUTS ARE PART OF THE CONTRACT, NOT TUNING. The host calls this from inside
 * JS_Eval, so a blocking read cannot be interrupted by the engine's deadline. An
 * unbounded read would therefore let a slow host hang a plugin's evaluations
 * forever. The connect and read timeouts below are what makes the block finite.
 */
interface PluginNetTransport {

    data class RawResponse(
        val status: Int,
        val body: String,
        val headers: Map<String, String>,
        /** The `Location` header on a redirect, if any. Null otherwise. */
        val location: String?,
    )

    /**
     * Perform ONE request. Redirects are the caller's problem.
     *
     * @throws java.io.IOException on any transport failure. The host turns this into
     *   data rather than letting it escape into JS_Eval.
     */
    fun send(
        url: String,
        method: String,
        headers: Map<String, String>,
        body: String?,
        connectTimeoutMs: Int,
        readTimeoutMs: Int,
    ): RawResponse

    companion object {
        /** Enough for a slow cellular connect, short enough not to hang a plugin. */
        const val CONNECT_TIMEOUT_MS = 10_000

        /** The same reasoning for the read side. */
        const val READ_TIMEOUT_MS = 15_000

        /** Redirect chains longer than this are refused rather than followed. */
        const val MAX_REDIRECT_HOPS = 5

        /**
         * Response bodies are capped. A plugin that can pull an unbounded body into
         * memory has a memory-exhaustion primitive regardless of the engine's own
         * per-plugin limit.
         */
        const val MAX_BODY_CHARS = 256 * 1024
    }
}

/**
 * [PluginNetTransport] over `HttpURLConnection`.
 *
 * https only — the policy already refuses cleartext, and `openConnection` on an
 * `http://` URL would silently work, so this is the second gate rather than the
 * first.
 */
class HttpPluginNetTransport(
    private val maxBodyChars: Int = PluginNetTransport.MAX_BODY_CHARS,
) : PluginNetTransport {

    override fun send(
        url: String,
        method: String,
        headers: Map<String, String>,
        body: String?,
        connectTimeoutMs: Int,
        readTimeoutMs: Int,
    ): PluginNetTransport.RawResponse {
        if (!url.lowercase().startsWith("https://")) {
            throw IllegalArgumentException("只允许 https")
        }
        val conn = (URI(url).toURL().openConnection() as HttpURLConnection).apply {
            requestMethod = method.uppercase()
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            // THE important line. Left on, HttpURLConnection follows redirects
            // internally and returns the final response — so the caller would never
            // see the intermediate URLs and could not re-validate them.
            instanceFollowRedirects = false
            doInput = true
            // No cookie jar is consulted: none is installed on the default handler,
            // and this class never sets one. Stated explicitly because "we don't
            // attach credentials" is a claim that should be visible in the code.
            setRequestProperty("Accept-Encoding", "identity")
        }

        if (body != null) {
            conn.doOutput = true
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        // Plugin-supplied headers, capped. A header map that is unbounded is a way
        // to build an enormous request line.
        val allowed = headers.entries
            .filter { (k, _) -> k.isNotBlank() && !k.contains(':') && !k.contains('\n') }
            .take(MAX_HEADERS)
        for ((k, v) in allowed) {
            conn.setRequestProperty(k, v.take(MAX_HEADER_CHARS))
        }

        val status = conn.responseCode
        val stream: InputStream? = if (status in 200..499) conn.inputStream else conn.errorStream
        val text = stream?.use { readCapped(it, maxBodyChars) } ?: ""
        val responseHeaders = conn.headerFields
            .filterKeys { it != null }
            .mapValues { (_, v) -> v.firstOrNull().orEmpty() }

        return PluginNetTransport.RawResponse(
            status = status,
            body = text,
            headers = responseHeaders,
            location = conn.getHeaderField("Location"),
        )
    }

    /**
     * Read at most [limit] characters, then stop.
     *
     * Stops rather than throws: a truncated body is more useful to a plugin than an
     * error, and the truncation is reported in the response so it is not silent.
     */
    private fun readCapped(stream: InputStream, limit: Int): String {
        val out = StringBuilder()
        val buffer = ByteArray(8 * 1024)
        var read = 0
        while (out.length < limit) {
            val n = stream.read(buffer)
            if (n <= 0) break
            out.append(String(buffer, 0, n, Charsets.UTF_8))
            read += n
        }
        if (read > 0 && out.length >= limit) {
            out.append("\n[响应体超过 $limit 字符，已截断]")
        }
        return out.toString()
    }

    private companion object {
        const val MAX_HEADERS = 32
        const val MAX_HEADER_CHARS = 512
    }
}

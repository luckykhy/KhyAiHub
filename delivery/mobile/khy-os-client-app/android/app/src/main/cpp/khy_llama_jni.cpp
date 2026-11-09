// khy_llama_jni.cpp — JNI shim over llama.cpp + mtmd for khy-os's built-in
// vision engine.
//
// WHY THIS FILE EXISTS. The requirement (2026-10-27) is a local vision model
// with no Ollama install anywhere. See android/app/CMakeLists.txt for why the
// engine has to live inside the APK: Android blocks exec() from the app's home
// directory since API 29, so "spawn llama-server as a child process" is not an
// option and the code has to be loaded as a library.
//
// WHAT IT DOES. Loads a text model (GGUF) plus its vision projector (mmproj
// GGUF), accepts one JPEG/PNG buffer and one prompt, and returns the decoded
// text. One image, one answer, then done — which is the whole shape of the
// caller: `vision_locate` sends a screenshot and wants coordinates back.
//
// WHAT IS DELIBERATELY NOT HERE.
//   - No sampling knobs beyond temperature and max_tokens. The caller asks a
//     closed question ("where is X"); a rich sampler configuration is a way to
//     make answers irreproducible without making them better.
//   - No streaming. A single-shot answer is what the Dart layer consumes, and a
//     callback across JNI for partial tokens buys nothing at this scale.
//   - No chat-template application. The prompt the Dart layer builds is already
//     in the model's expected format; applying a template here would mean
//     encoding one model's conventions into a shared shim.
//   - No image decoding by hand. mtmd owns that (stb_image), and it also owns
//     the resize/normalise/patch-embedding pipeline. Reimplementing any of it
//     is the classic way to get coordinates that are off by a scale factor.
//
// LIFETIME. One `llama_engine` per (model, mmproj) pair, held as a jlong in
// Kotlin. Everything it owns is freed in nativeFree, including on a partial
// construction failure — a leaked llama_context on a phone is GBs of RAM that
// nothing will ever give back.

#include <jni.h>

#include <android/log.h>

#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "llama.h"
#include "mtmd.h"
#include "mtmd-helper.h"

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  "khyllama", __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "khyllama", __VA_ARGS__)

namespace {

/// Everything one loaded engine owns. One instance per model pair.
struct llama_engine {
    llama_model *   model   = nullptr;
    llama_context * lctx    = nullptr;
    mtmd_context *  vision  = nullptr;

    // Guards the whole struct: llama_context is not thread-safe, and the Kotlin
    // side may be asked for an answer from more than one coroutine. Serialising
    // here is cheaper and far more debuggable than making the model thread-safe.
    std::mutex mutex;

    int n_ctx     = 0;
    int n_threads = 0;

    ~llama_engine() {
        // Order matters: mtmd holds no reference into llama, but freeing the
        // vision context first keeps the log readable if anything complains.
        if (vision) { mtmd_free(vision); vision = nullptr; }
        if (lctx)   { llama_free(lctx); lctx = nullptr; }
        if (model)  { llama_model_free(model); model = nullptr; }
    }
};

/// Global, process-wide. llama.cpp's backend registry is initialised once.
std::once_flag g_backend_once;

void init_backend_once() {
    std::call_once(g_backend_once, [] {
        llama_backend_init();
        // NOTE: the backend modules are NOT loaded here. See
        // nativeInitBackend() below for why the directory has to be supplied by
        // the caller, and what goes wrong if it is guessed.
        // Route llama.cpp's own logging into logcat instead of stderr, which on
        // Android goes nowhere the user or a bug report can see.
        llama_log_set([](ggml_log_level level, const char * text, void *) {
            if (!text) return;
            const int pri = (level == GGML_LOG_LEVEL_ERROR) ? ANDROID_LOG_ERROR
                          : (level == GGML_LOG_LEVEL_WARN)  ? ANDROID_LOG_WARN
                                                            : ANDROID_LOG_INFO;
            __android_log_print(pri, "khyllama", "%s", text);
        }, nullptr);
    });
}

/// Turns a jstring into a std::string without leaking on the early return.
std::string jstr_to_std(JNIEnv * env, jstring s) {
    if (!s) return {};
    const char * chars = env->GetStringUTFChars(s, nullptr);
    if (!chars) return {};
    std::string out(chars);
    env->ReleaseStringUTFChars(s, chars);
    return out;
}

/// Throws a Java exception carrying `msg`, so the Kotlin layer can surface it
/// verbatim rather than inferring a cause from a null return.
///
/// Also logs it. The exception crosses the JNI boundary and becomes a snackbar
/// the user sees once; logcat is the only place a *later* reader can find out
/// what actually happened, and without this the failure was completely
/// invisible — which is why the first on-device attempt produced an error with
/// no diagnosable trace anywhere.
void throw_io(JNIEnv * env, const char * what, const std::string & msg) {
    LOGE("%s: %s", what, msg.c_str());
    jclass cls = env->FindClass("java/io/IOException");
    if (!cls) return;
    std::string full = std::string(what) + ": " + msg;
    env->ThrowNew(cls, full.c_str());
}

} // namespace

static void nativeInitBackend(
    JNIEnv * env, jobject /*thiz*/, jstring backend_dir) {

    init_backend_once();

    const std::string dir = jstr_to_std(env, backend_dir);

    // WHY THE DIRECTORY IS PASSED IN RATHER THAN GUESSED. With
    // GGML_BACKEND_DL ON, the CPU backends are .so modules that get dlopened at
    // runtime. llama.cpp's default search uses /proc/self/exe to find "the
    // directory of the running program" — on Android that resolves to
    // /system/bin/app_process64, because our library is dlopened into the
    // zygote's child rather than being the executable. So the default finds
    // nothing, ggml_backend_load_all() silently registers zero backends, and
    // the model load then fails with a message that reads like a corrupt file.
    //
    // The only reliable directory is the app's own nativeLibraryDir, which
    // Kotlin knows and we do not. Hence this entry point.
    if (dir.empty()) {
        LOGI("no backend dir supplied; falling back to default search");
        ggml_backend_load_all();
        return;
    }

    ggml_backend_load_all_from_path(dir.c_str());

    // Report what actually got registered. A silent zero here is the failure
    // described above, and the only way to tell it apart from a working load is
    // to count.
    size_t n = 0;
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        ggml_backend_dev_t d = ggml_backend_dev_get(i);
        if (d && ggml_backend_dev_type(d) == GGML_BACKEND_DEVICE_TYPE_CPU) n++;
    }
    LOGI("backend dir=%s cpu devices=%zu", dir.c_str(), n);
    if (n == 0) {
        LOGE("no CPU backend registered from %s — model load will fail", dir.c_str());
    }
}

static jlong nativeLoad(
    JNIEnv * env, jobject /*thiz*/,
    jstring model_path, jstring mmproj_path,
    jint n_ctx, jint n_threads, jboolean verbose) {

    init_backend_once();

    const std::string modelFile  = jstr_to_std(env, model_path);
    const std::string mmprojFile = jstr_to_std(env, mmproj_path);

    if (modelFile.empty()) {
        throw_io(env, "load", "model path is empty");
        return 0;
    }

    auto eng = std::make_unique<llama_engine>();
    eng->n_ctx     = n_ctx > 0 ? n_ctx : 4096;
    eng->n_threads = n_threads > 0 ? n_threads : 4;

    // ── text model ──────────────────────────────────────────────────────────
    llama_model_params mparams = llama_model_default_params();
    // mmap the GGUF instead of reading it: the model is 2.6 GB and the device
    // has 15.6 GB of RAM, but the app's heap budget is far smaller. mmap keeps
    // the pages on demand and lets the kernel evict them under pressure.
    //
    // LLAMA_LOAD_MODE_MMAP and not MLOCK: MLOCK pins all 2.6 GB resident, which
    // on a phone is a direct route to the low-memory killer. The kernel evicting
    // clean file-backed pages is exactly the behaviour we want here.
    mparams.load_mode = LLAMA_LOAD_MODE_MMAP;
    mparams.n_gpu_layers = 0; // CPU only in this build

    eng->model = llama_model_load_from_file(modelFile.c_str(), mparams);
    if (!eng->model) {
        throw_io(env, "load", "llama_model_load_from_file failed for " + modelFile);
        return 0;
    }
    LOGI("text model loaded: %s", modelFile.c_str());

    // ── context ─────────────────────────────────────────────────────────────
    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx   = eng->n_ctx;
    cparams.n_batch = 512;
    // Enough for one image plus a prompt plus the answer. Qwen3-VL spends a lot
    // of context on image tokens; 4096 is the floor that still leaves room.
    cparams.n_ubatch = 512;
    cparams.n_threads        = eng->n_threads;
    cparams.n_threads_batch  = eng->n_threads;

    eng->lctx = llama_init_from_model(eng->model, cparams);
    if (!eng->lctx) {
        throw_io(env, "load", "llama_init_from_model failed");
        return 0;
    }
    LOGI("context ready: n_ctx=%d threads=%d", eng->n_ctx, eng->n_threads);

    // ── vision projector ────────────────────────────────────────────────────
    // mmproj is what turns pixels into embeddings. Without it the engine can
    // still answer text prompts, which is a trap: the caller would get
    // confident answers about a screen it cannot see. So a missing or broken
    // mmproj is a hard failure, not a degraded mode.
    if (!mmprojFile.empty()) {
        mtmd_context_params vparams = mtmd_context_params_default();
        vparams.n_threads   = eng->n_threads;
        vparams.use_gpu     = false; // no Vulkan backend in this build
        // Warmup runs one throwaway encode pass at init so the first real
        // request does not pay for lazy kernel selection and page-in. On a
        // 2.6 GB model that first-request tax is seconds, which is the whole
        // difference between "feels broken" and "feels slow but working".
        vparams.warmup      = true;
        // print_timings only affects mtmd's own debug output, which the
        // llama_log_set callback above already routes to logcat. Kept off:
        // per-request timings in a release log are noise nobody reads.
        vparams.print_timings = false;

        eng->vision = mtmd_init_from_file(mmprojFile.c_str(), eng->model, vparams);
        if (!eng->vision) {
            throw_io(env, "load",
                     "mtmd_init_from_file failed for " + mmprojFile +
                     " (vision unavailable — refusing to answer blind)");
            return 0;
        }
        if (!mtmd_support_vision(eng->vision)) {
            throw_io(env, "load", "mmproj loaded but reports no vision support");
            return 0;
        }
        LOGI("vision projector loaded: %s", mmprojFile.c_str());
    }

    LOGI("loaded model=%s ctx=%d threads=%d vision=%s",
         modelFile.c_str(), eng->n_ctx, eng->n_threads,
         eng->vision ? "yes" : "no");

    return reinterpret_cast<jlong>(eng.release());
}

static void nativeFree(
    JNIEnv * /*env*/, jobject /*thiz*/, jlong handle) {
    if (handle == 0) return;
    // unique_ptr with a no-op deleter would be cleaner, but the engine type is
    // incomplete outside this TU — so delete directly and let ~llama_engine run.
    delete reinterpret_cast<llama_engine *>(handle);
}

static jstring nativeChat(
    JNIEnv * env, jobject /*thiz*/, jlong handle,
    jstring prompt, jbyteArray image, jint max_tokens, jfloat temperature) {

    if (handle == 0) {
        throw_io(env, "chat", "engine not loaded");
        return nullptr;
    }
    auto * eng = reinterpret_cast<llama_engine *>(handle);

    const std::string promptStr = jstr_to_std(env, prompt);
    if (promptStr.empty()) {
        throw_io(env, "chat", "prompt is empty");
        return nullptr;
    }

    // The lock is held for the whole call: the context is not thread-safe, and
    // a second concurrent answer would interleave into the same KV cache.
    std::lock_guard<std::mutex> guard(eng->mutex);

    // ── decode the image (mtmd owns jpg/png decoding) ───────────────────────
    std::unique_ptr<mtmd_bitmap, void(*)(mtmd_bitmap *)> bitmap{nullptr, mtmd_bitmap_free};
    const unsigned char * imgBuf = nullptr;
    size_t imgLen = 0;

    if (image != nullptr) {
        if (!eng->vision) {
            throw_io(env, "chat", "image supplied but no vision projector is loaded");
            return nullptr;
        }
        jsize len = env->GetArrayLength(image);
        if (len <= 0) {
            throw_io(env, "chat", "image buffer is empty");
            return nullptr;
        }
        // Copy into a std::vector rather than pinning the Java array: the
        // decode can take seconds on a 4B model's preprocessing, and holding a
        // JNI direct pointer across that long is asking for a GC move.
        static std::vector<unsigned char> buf;
        buf.resize(static_cast<size_t>(len));
        env->GetByteArrayRegion(image, 0, len,
                                reinterpret_cast<jbyte *>(buf.data()));
        imgBuf = buf.data();
        imgLen = buf.size();

        mtmd_helper_init_opt opt = mtmd_helper_init_opt_default();
        auto wrapped = mtmd_helper_bitmap_init_from_buf(eng->vision, imgBuf, imgLen,
                                                       /*placeholder=*/false, opt);
        if (!wrapped.bitmap) {
            throw_io(env, "chat", "mtmd could not decode the image buffer");
            return nullptr;
        }
        bitmap.reset(wrapped.bitmap);
    } else if (!eng->vision) {
        // Text-only is allowed, but only when there is genuinely no projector.
    }

    // ── tokenize ────────────────────────────────────────────────────────────
    // The marker is how mtmd knows where the image goes in the token stream.
    // If the caller's prompt lacks it, we prepend it — an image with no marker
    // would be silently dropped, and "silently dropped" is the failure mode this
    // whole engine exists to avoid.
    const char * marker = mtmd_default_marker();
    std::string tokenizeText = promptStr;
    if (bitmap && marker && promptStr.find(marker) == std::string::npos) {
        tokenizeText = std::string(marker) + "\n" + promptStr;
    }

    mtmd_input_text text{};
    text.text          = tokenizeText.c_str();
    text.text_len      = tokenizeText.size();
    text.add_special   = true;
    text.parse_special = true;

    const mtmd_bitmap * bitmaps[1] = {bitmap.get()};
    const size_t n_bitmaps = bitmap ? 1 : 0;

    mtmd_input_chunks * chunks = mtmd_input_chunks_init();
    if (!chunks) {
        throw_io(env, "chat", "mtmd_input_chunks_init failed");
        return nullptr;
    }

    const int32_t tokRes = mtmd_tokenize(eng->vision, chunks, &text,
                                         bitmaps, n_bitmaps);
    if (tokRes != 0) {
        mtmd_input_chunks_free(chunks);
        throw_io(env, "chat", "mtmd_tokenize failed, res=" + std::to_string(tokRes));
        return nullptr;
    }

    // ── clear the KV cache, then evaluate the whole prompt ──────────────────
    // A fresh context per call: the engine is one-shot by design, so anything
    // left over from a previous answer is stale context the model would attend
    // to. Cheaper and safer than tracking n_past across calls.
    llama_memory_t mem = llama_get_memory(eng->lctx);
    if (mem) llama_memory_clear(mem, /*data=*/true);

    llama_pos n_past = 0;
    const int32_t evalRes = mtmd_helper_eval_chunks(
        eng->vision, eng->lctx, chunks, n_past, /*seq_id=*/0,
        /*n_batch=*/512, /*logits_last=*/true, &n_past);
    mtmd_input_chunks_free(chunks);

    if (evalRes != 0) {
        throw_io(env, "chat",
                 "mtmd_helper_eval_chunks failed, res=" + std::to_string(evalRes));
        return nullptr;
    }

    // ── sample ──────────────────────────────────────────────────────────────
    // llama_sampler_chain_default_params() returns PARAMS, not a sampler; the
    // sampler itself comes from llama_sampler_chain_init(). Confusing the two
    // compiles to a type error rather than failing silently, which is the one
    // good thing about this particular API shape.
    llama_sampler * sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(temperature > 0 ? temperature : 0.1f));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.95f, /*min_keep=*/1));
    // Greedy after the top-p filter: the caller wants the single best answer to
    // "where is the button", not a sample from a distribution of buttons.
    llama_sampler_chain_add(sampler, llama_sampler_init_greedy());

    const int limit = max_tokens > 0 ? max_tokens : 512;
    const llama_model * model = eng->model;
    const llama_vocab * vocab = llama_model_get_vocab(model);

    std::string out;
    out.reserve(256);

    for (int i = 0; i < limit; i++) {
        llama_token tok = llama_sampler_sample(sampler, eng->lctx, /*idx=*/-1);

        if (llama_vocab_is_eog(vocab, tok)) break;

        char piece[256];
        int n = llama_token_to_piece(vocab, tok, piece, sizeof(piece),
                                     /*lstrip=*/0, /*special=*/false);
        if (n > 0) out.append(piece, static_cast<size_t>(n));

        // Feed the token back in. batch of one is fine here — the prompt was
        // already evaluated in one go above.
        llama_batch batch = llama_batch_get_one(&tok, 1);
        if (llama_decode(eng->lctx, batch) != 0) {
            LOGE("llama_decode failed at step %d", i);
            break;
        }
        n_past += 1;
    }

    llama_sampler_free(sampler);

    if (out.empty()) {
        throw_io(env, "chat", "model produced no output");
        return nullptr;
    }

    return env->NewStringUTF(out.c_str());
}

static jstring nativeInfo(
    JNIEnv * env, jobject /*thiz*/, jlong handle) {
    if (handle == 0) return env->NewStringUTF("{}");
    auto * eng = reinterpret_cast<llama_engine *>(handle);
    std::lock_guard<std::mutex> guard(eng->mutex);

    const llama_model * model = eng->model;
    char buf[512];
    const int n = llama_model_desc(model, buf, sizeof(buf));
    const std::string desc = n > 0 ? std::string(buf, static_cast<size_t>(n)) : "";

    // A tiny JSON blob rather than a structured return: the Kotlin side only
    // forwards this to Dart for display, and inventing a JNI struct for three
    // fields is more code than the thing it describes.
    std::string json = "{";
    json += "\"desc\":\"" + desc + "\",";
    json += "\"n_ctx\":" + std::to_string(llama_n_ctx(eng->lctx)) + ",";
    json += "\"n_ctx_train\":" + std::to_string(llama_model_n_ctx_train(model)) + ",";
    json += "\"n_embd\":" + std::to_string(llama_model_n_embd(model)) + ",";
    json += "\"size_mb\":" + std::to_string(llama_model_size(model) >> 20) + ",";
    json += "\"vision\":" + std::string(eng->vision && mtmd_support_vision(eng->vision) ? "true" : "false");
    json += "}";

    return env->NewStringUTF(json.c_str());
}

// ── registration ────────────────────────────────────────────────────────────
//
// WHY RegisterNatives AND NOT `Java_com_khyos_...` SYMBOL NAMES.
//
// The package is `com.khyos.khy_os_client` — it contains underscores, and JNI
// name mangling escapes every `_` as `_1`. So the JVM looks up
// `Java_com_khyos_khy_1os_1client_engine_KhyLlama_nativeInitBackend`, while the
// hand-written symbol was `..._khy_os_client_...`. They do not match, and the
// failure is an UnsatisfiedLinkError that says "No implementation found" and
// then helpfully suggests `System.loadLibrary` — which was already called and
// succeeded. Measured on device 2026-10-27: the model had downloaded fine, the
// user tapped 启动, and got a failure whose message pointed at the one thing
// that was not wrong.
//
// RegisterNatives sidesteps mangling entirely: the table below is plain C++
// identifiers plus explicit JNI signature strings, and a mismatch becomes a
// compile error or a failed JNI_OnLoad rather than a runtime lookup miss. It
// also means the whole surface is listed in one place, which is the only way to
// notice a method that was added on one side and not the other.
//
// The signatures must match the Kotlin `external fun` declarations exactly:
//   nativeInitBackend(String)                        (Ljava/lang/String;)V
//   nativeLoad(String, String, int, int, boolean)    (…;…;IIZ)J
//   nativeChat(long, String, byte[], int, float)     (JLjava/lang/String;[BIF)Ljava/lang/String;
//   nativeInfo(long)                                 (J)Ljava/lang/String;
//   nativeFree(long)                                 (J)V
static const JNINativeMethod kMethods[] = {
    {"nativeInitBackend", "(Ljava/lang/String;)V",
     reinterpret_cast<void *>(nativeInitBackend)},
    {"nativeLoad", "(Ljava/lang/String;Ljava/lang/String;IIZ)J",
     reinterpret_cast<void *>(nativeLoad)},
    {"nativeChat", "(JLjava/lang/String;[BIF)Ljava/lang/String;",
     reinterpret_cast<void *>(nativeChat)},
    {"nativeInfo", "(J)Ljava/lang/String;",
     reinterpret_cast<void *>(nativeInfo)},
    {"nativeFree", "(J)V",
     reinterpret_cast<void *>(nativeFree)},
};

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM * vm, void * /*reserved*/) {
    JNIEnv * env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK) {
        return JNI_ERR;
    }

    // FindClass inside JNI_OnLoad resolves against the class loader that loaded
    // THIS library, which for a System.loadLibrary call from the app is the
    // app's own loader — so app classes are reachable here, unlike from a
    // thread the JVM created later.
    jclass cls = env->FindClass("com/khyos/khy_os_client/engine/KhyLlama");
    if (!cls) {
        LOGE("JNI_OnLoad: KhyLlama class not found");
        return JNI_ERR;
    }

    const jint n = sizeof(kMethods) / sizeof(kMethods[0]);
    if (env->RegisterNatives(cls, kMethods, n) != JNI_OK) {
        // Returning JNI_ERR makes System.loadLibrary throw, which surfaces as
        // an UnsatisfiedLinkError with a clear cause instead of a later call
        // failing one method at a time.
        LOGE("JNI_OnLoad: RegisterNatives failed for %d methods", n);
        return JNI_ERR;
    }

    LOGI("JNI_OnLoad: registered %d native methods", n);
    return JNI_VERSION_1_6;
}

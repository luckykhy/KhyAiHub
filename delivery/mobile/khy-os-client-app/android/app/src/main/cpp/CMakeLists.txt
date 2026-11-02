# Native build for khy-os's built-in inference engine.
#
# WHY THIS EXISTS. The user's requirement (2026-10-27) is a local vision model
# with NO Ollama install anywhere — not on the phone, not in Termux, not on the
# PC as a prerequisite. That leaves exactly one route: khy-os carries its own
# engine. This file is that engine's build.
#
# WHAT IS BUILT. `libkhyllama.so` — a JNI shim over llama.cpp + mtmd (the
# multimodal helper that owns image preprocessing and the CLIP projection). It
# is linked into the APK like any other native library, which is the only way
# to run native code on Android without root: the OS blocks `exec()` of files
# in the app's home directory since API 29, so the alternative of shipping
# llama-server as a standalone binary and spawning it is not available.
#
# WHY ONLY arm64-v8a. A 4B-class vision model needs the address space and the
# cores; a 32-bit device cannot run it usefully. Building the other ABIs would
# multiply build time and APK size for a configuration we then have to refuse
# at runtime. The Dart layer checks `Build.SUPPORTED_ABIS` and says so plainly
# rather than letting `System.loadLibrary` throw.

cmake_minimum_required(VERSION 3.21)
project(khyllama C CXX)

# Strip debug info. The NDK toolchain injects `-g` into every compile, which
# measured here as 112 MB of native libraries versus 22.5 MB with `-g0` — a
# 90 MB APK penalty for symbols nobody reads on a release build. Nothing in this
# project debugs the .so with a symboliser, so the trade is not close.
#
# Set as plain C/CXX flags rather than CMAKE_<LANG>_FLAGS_RELEASE because the
# NDK's `-g` lands in the global flag set, and a later `-g` would otherwise win
# over a release-profile `-O3 -DNDEBUG`.
set(CMAKE_C_FLAGS   "${CMAKE_C_FLAGS} -g0")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -g0")

# ── vendored llama.cpp ───────────────────────────────────────────────────────
# Kept out of git (see .gitignore) and fetched by
# scripts/bootstrap-native-llama.ps1, the same pattern the repo already uses for
# tools/deepseek-eyes/. Resolved relative to this file so the tree stays
# relocatable — the whole Portable/khy-os checkout is drive-letter independent.
#
# Depth from here (android/app/src/main/cpp):
#   ../                → src/main
#   ../../             → src
#   ../../../          → app            (android/app)
#   ../../../../       → android
#   ../../../../../    → khy-os-client-app   ← the app root that holds third_party/
set(APP_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../..")
set(LLAMA_CPP_DIR "${APP_ROOT}/third_party/llama.cpp")

if(NOT EXISTS "${LLAMA_CPP_DIR}/CMakeLists.txt")
    message(FATAL_ERROR
        "llama.cpp not found at ${LLAMA_CPP_DIR}. Run:\n"
        "  pwsh -File scripts/bootstrap-native-llama.ps1")
endif()

# ── llama.cpp build shape ────────────────────────────────────────────────────
# Every one of these is OFF by default upstream; they are set explicitly so a
# future reader can see the intent instead of inferring it from an empty build.
# SERVER matters most: it is the one that would otherwise pull in the entire
# common/ HTTP stack, which is dead weight for a library that only ever runs
# inference in-process.
set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON   OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL           OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL        OFF CACHE BOOL "" FORCE)
set(LLAMA_LLAMAFILE      OFF CACHE BOOL "" FORCE)

# OpenMP is off deliberately. The NDK can provide libomp, but pulling it in for
# the gain we get from std::thread alone is not worth the extra .so and the
# ABI coupling. Parallelism comes from the thread count passed at load time.
set(GGML_OPENMP          OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE          OFF CACHE BOOL "" FORCE)
set(GGML_CPU             ON  CACHE BOOL "" FORCE)

# libmtmd, standalone. There are two ways to get it and only one of them works:
#
#   1. LLAMA_BUILD_TOOLS ON  — mtmd comes from tools/CMakeLists.txt, but so do
#      llama-bench, completion, perplexity, quantize, tokenize and tts. Worse,
#      the tools/ subtree is only entered when `LLAMA_BUILD_COMMON AND
#      LLAMA_BUILD_TOOLS`, and the resulting mtmd target is not visible to a
#      parent scope that add_subdirectory'd llama.cpp — the link then degrades
#      to a bare `-lmtmd` that resolves to nothing and fails at link time with
#      a message that names no cause.
#   2. LLAMA_BUILD_MTMD ON  — upstream's own hook for exactly this case
#      ("Standalone libmtmd build without pulling in the rest of the tools/
#      tree"), added at CMakeLists.txt:268 specifically for packaging mtmd into
#      a library. It defines the target in a scope this file can link against.
#
# So: MTMD on, TOOLS off. This is not minimalism for its own sake — it is the
# combination where the link actually resolves.
set(LLAMA_BUILD_TOOLS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_MTMD     ON  CACHE BOOL "" FORCE)

# Dynamic backend loading is ON, and this is a performance decision rather than
# a convenience one. With GGML_BACKEND_DL OFF, llama.cpp builds ONE baseline
# armv8-a CPU backend — no dotprod, no i8mm, no fp16 vector arithmetic. Those
# instructions are what a 4B Q4 model spends its life in (quantised matmuls),
# and the target device (Snapdragon 8s Gen 3) supports all of them.
#
# The upstream CMake makes the coupling explicit: `GGML_CPU_ALL_VARIANTS
# requires GGML_BACKEND_DL` (ggml/src/CMakeLists.txt) — you cannot get the
# runtime-dispatched Android variants without it. So this was originally set OFF
# to avoid shipping one more .so, and that trade is backwards for this use:
# it saves a few hundred KB of APK and costs a multiple of the inference speed,
# which is the only unverified risk in the whole feature.
#
# Cost: libggml-cpu-*.so variants ship alongside libkhyllama.so and are dlopened
# at runtime, so the JNI shim must call ggml_backend_load_all() before loading a
# model — without it no backend is registered and the load fails with a message
# that names nothing useful.
set(GGML_BACKEND_DL      ON  CACHE BOOL "" FORCE)
# The other half of the same decision, and the half that is easy to miss:
# GGML_BACKEND_DL only makes the modules loadable, ALL_VARIANTS is what actually
# builds the seven Android feature sets (android_armv8.2_1 dotprod,
# android_armv8.6_1 dotprod+i8mm+fp16, …). It defaults to OFF upstream.
set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)

add_subdirectory(${LLAMA_CPP_DIR} llama.cpp EXCLUDE_FROM_ALL)

# ── our shim ─────────────────────────────────────────────────────────────────
add_library(khyllama SHARED
    khy_llama_jni.cpp
)

target_include_directories(khyllama PRIVATE
    ${LLAMA_CPP_DIR}/include
    ${LLAMA_CPP_DIR}/ggml/include
    ${LLAMA_CPP_DIR}/tools/mtmd
)

# mtmd's public header includes llama.h and ggml.h by relative path from its
# own directory, so the include path above is what makes it compile at all.
#
# With GGML_BACKEND_DL ON, the CPU backends are dlopened modules rather than
# linked libraries, so only the loader side is linked here. Linking ggml-cpu as
# well would pull in the baseline variant and defeat the dispatch.
target_link_libraries(khyllama
    PRIVATE
    llama
    mtmd
    ggml
    ggml-base
    android
    log
)

# The NDK's default is already position-independent for shared libs; stated
# explicitly because mtmd is built as a static-ish target in some upstream
# configurations and a non-PIC mix fails the link in a way that does not name
# the real cause.
set_target_properties(khyllama PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
)

# ── quickjs-ng ───────────────────────────────────────────────────────────────
#
# WHY THIS EXISTS. DESIGN-ARCH-195 (khyos 手机版插件架构选型) recommends an
# in-process QuickJS plugin runtime (option C) over in-process JVM plugins
# (option B). The decisive argument for C is that its attack surface is a small,
# auditable table of JNI bindings — so the engine must be compiled HERE, from
# source, with the bindings written by hand in khy_js_jni.cpp. Taking a prebuilt
# AAR would bind whatever its author chose and quietly void the argument.
#
# THIS IS THE T2 ISOLATION SPIKE. It proves quickjs-ng builds and links into this
# APK for arm64-v8a through the existing native build, and that a native function
# is reachable from JS. It is NOT the plugin runtime: no plugin loading, no
# manifest, no install flow, no per-plugin context, no capability allowlist.
#
# Source is vendored (gitignored) and fetched by scripts/bootstrap-native-quickjs.ps1,
# the same pattern as llama.cpp above.
set(QUICKJS_DIR "${APP_ROOT}/third_party/quickjs")

if(NOT EXISTS "${QUICKJS_DIR}/quickjs.c")
    message(FATAL_ERROR
        "quickjs-ng not found at ${QUICKJS_DIR}. Run:\n"
        "  pwsh -File scripts/bootstrap-native-quickjs.ps1")
endif()

# The translation units. cutils.c is deliberately absent: upstream merged it into
# cutils.h in the -ng line. dtoa.c IS required and is the one people forget — it
# is a separate TU and the link fails without it.
add_library(quickjs STATIC
    ${QUICKJS_DIR}/quickjs.c
    ${QUICKJS_DIR}/dtoa.c
    ${QUICKJS_DIR}/libregexp.c
    ${QUICKJS_DIR}/libunicode.c
    ${QUICKJS_DIR}/quickjs-libc.c
)

# Exactly upstream's own defines (their CMakeLists.txt:285 and :283) — no more.
# _GNU_SOURCE is required or the build fails on Android's bionic headers;
# QJS_BUILD_LIBC is what makes quickjs-libc.c compile its OS bindings.
target_compile_definitions(quickjs PRIVATE
    _GNU_SOURCE
    QUICKJS_NG_BUILD
    QJS_BUILD_LIBC
)

target_include_directories(quickjs PUBLIC ${QUICKJS_DIR})

# `m` for the maths quickjs uses in its number formatting; `${CMAKE_DL_LIBS}`
# because quickjs-libc references dlopen (we do not enable its module loader yet,
# but the symbol is referenced regardless and the link fails without it).
target_link_libraries(quickjs PUBLIC m ${CMAKE_DL_LIBS})

# ── our shim ─────────────────────────────────────────────────────────────────
add_library(khyjs SHARED
    khy_js_jni.cpp
)

# Delivery canary stamp. gradle passes -DKHY_CANARY_VALUE=<stamp> as a cmake
# configure argument (a configuration input, so a new stamp re-configures on
# its own); this translates it into a compile definition on the one TU that
# carries it into libkhyjs.so. The fallback keeps bare cmake invocations
# (outside gradle) building, matching build.gradle's default.
if(NOT DEFINED KHY_CANARY_VALUE)
    set(KHY_CANARY_VALUE "Khy-localbuild")
endif()
target_compile_definitions(khyjs PRIVATE KHY_CANARY=${KHY_CANARY_VALUE})

target_link_libraries(khyjs
    PRIVATE
    quickjs
    android
    log
)

set_target_properties(khyjs PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
)

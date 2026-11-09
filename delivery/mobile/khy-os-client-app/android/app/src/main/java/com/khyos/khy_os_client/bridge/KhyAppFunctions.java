package com.khyos.khy_os_client.bridge;

import android.app.appfunctions.AppFunctionException;
import android.app.appfunctions.AppFunctionService;
import android.app.appfunctions.ExecuteAppFunctionRequest;
import android.app.appfunctions.ExecuteAppFunctionResponse;
import android.app.appsearch.GenericDocument;
import android.content.pm.SigningInfo;
import android.os.CancellationSignal;
import android.os.OutcomeReceiver;
import android.util.Log;

import org.json.JSONObject;

/**
 * KhyAppFunctions — the bridge's tools exposed as Android 16 AppFunctions.
 *
 * WHY THIS EXISTS. The bridge already has three entry points (the HTTP server on
 * loopback, the Amoo reverse-proxy loop, and the file mailbox). All three need
 * something running: the loopback one needs a PC on the same host, the loop one
 * needs the target assistant in the FOREGROUND for its whole duration (measured
 * at roughly six minutes), and the mailbox needs a poller. AppFunctions is the
 * first path with none of those — the system indexes the declaration, the
 * assistant's ability router calls in, and no foreground window is involved.
 *
 * VERIFIED, NOT ASSUMED (2026-10-28, on a PZ261A): a probe APK with one
 * unprivileged AppFunctionService was installed, appeared in
 * {@code dumpsys app_function}, and executed through
 * {@code cmd app_function execute-app-function} — with the host app at
 * minSdk 24 / targetSdk 33 / compileSdk 36, i.e. exactly this app's levels. So
 * this needs no SDK-level change. {@code com.stepos.ability}, the priv-app that
 * fronts the assistant's ability routing, references
 * {@code aggregatedAppFunctionInventory_delegate} and
 * {@code ExecuteAppFunctionRequest} in its own dex.
 *
 * WHAT IS DELIBERATELY NOT EXPOSED. Only the observe-and-act surface is here.
 * {@code exec}, {@code rm}, {@code write}, {@code mv}, {@code cp} and the
 * reverse-proxy loop tools are not, and the reason is not squeamishness: an
 * AppFunction is reachable by the assistant's router with no foreground window
 * and no confirmation surface, which is precisely the shape in which a
 * destructive file operation must not be offered. Those tools stay behind the
 * HTTP bridge and the loop, where LoopModes and the confirmation floor apply.
 * {@link #EXPOSED} is the whole list; adding to it is a decision, not a drift.
 *
 * WHY THE DESCRIPTIONS COME FROM {@link Tools#ROUTING}. The description field of
 * an AppFunction is not documentation — it is the routing instruction the model
 * reads when deciding which function to call. StepOS's own first-party functions
 * ship verb normalisation, positive samples, negative samples that name the
 * function to use instead, and the return codes (read from
 * {@code dumpsys app_function} on the same device). {@link Tools#ROUTING} is
 * already written in exactly that format for the tools that need it, so this
 * class reuses it rather than growing a second copy that would drift.
 *
 * Contract: total. Every path returns an outcome; nothing throws out of
 * {@link #onExecuteFunction}.
 */
public final class KhyAppFunctions extends AppFunctionService {

    private static final String TAG = "KhyAppFunctions";

    /** Function id prefix. The part after '#' is the bridge tool name. */
    private static final String PREFIX =
            "com.khyos.khy_os_client.bridge.KhyAppFunctions#";

    /**
     * Callers allowed to execute these functions.
     *
     * The StepOS packages that front the assistant's ability routing, plus the
     * shell (uid 2000) so the route stays debuggable over adb — which is how it
     * was verified in the first place. An unknown caller is refused AND logged:
     * the log is how the real caller gets discovered, and a silent allow-all
     * would turn this into a capability any app on the device can drive.
     */
    private static final java.util.Set<String> ALLOWED_CALLERS =
            new java.util.HashSet<>(java.util.Arrays.asList(
                    "com.stepos.ability",
                    "com.stepos.agentbus",
                    "com.stepos.aiengine",
                    "com.stepos.ailauncher",
                    "com.stepos.stepclaw",
                    "com.android.shell"));

    /**
     * The whole exposed surface. Order is the order the model sees.
     *
     * Read-only observe tools first, then act tools, then the two meta tools.
     * {@code shot_b64} is absent on purpose — it inlines a full-screen base64
     * into the conversation, which is the fastest way to exhaust the context;
     * {@code shot} returns a path and the caller decides what to do with it.
     */
    static final String[] EXPOSED = {
            "ping", "info", "tools",
            "ui_dump", "ui_click", "ui_tap", "ui_swipe", "ui_type",
            "ui_back", "ui_home", "shot",
    };

    @Override
    public void onCreate() {
        super.onCreate();
        // Idempotent (it only stores the application context), and this path is
        // meant to work with no foreground bridge service running — so it cannot
        // assume BridgeService got there first.
        Tools.init(this);
    }

    @Override
    public void onExecuteFunction(
            ExecuteAppFunctionRequest request,
            String callingPackage,
            SigningInfo signingInfo,
            CancellationSignal cancellationSignal,
            OutcomeReceiver<ExecuteAppFunctionResponse, AppFunctionException> callback) {

        String id = request.getFunctionIdentifier();
        Log.i(TAG, "execute function=" + id + " caller=" + callingPackage);

        if (!ALLOWED_CALLERS.contains(callingPackage)) {
            // Refused, and the caller is named in the reason so a legitimate
            // integration can be diagnosed from the assistant's error rather
            // than from a log nobody reads.
            Log.w(TAG, "refused caller=" + callingPackage);
            callback.onError(new AppFunctionException(
                    AppFunctionException.ERROR_DENIED,
                    "调用方未在允许列表内: " + callingPackage));
            return;
        }

        if (id == null || !id.startsWith(PREFIX)) {
            callback.onError(new AppFunctionException(
                    AppFunctionException.ERROR_FUNCTION_NOT_FOUND, "未知函数: " + id));
            return;
        }
        final String tool = id.substring(PREFIX.length());

        boolean exposed = false;
        for (String e : EXPOSED) {
            if (e.equals(tool)) {
                exposed = true;
                break;
            }
        }
        if (!exposed) {
            // Not an oversight: see the class comment on what is deliberately
            // withheld. Saying so is better than a bare not-found, because the
            // assistant would otherwise conclude the tool does not exist.
            callback.onError(new AppFunctionException(
                    AppFunctionException.ERROR_DENIED,
                    "工具 " + tool + " 不经此入口开放（文件写入与 shell 类操作需走桥的其它入口）"));
            return;
        }

        final JSONObject params;
        try {
            GenericDocument doc = request.getParameters();
            params = doc == null ? new JSONObject() : paramsOf(doc);
        } catch (Throwable t) {
            callback.onError(new AppFunctionException(
                    AppFunctionException.ERROR_INVALID_ARGUMENT, "参数解析失败: " + t));
            return;
        }

        final JSONObject out;
        try {
            out = Tools.dispatch(tool, params);
        } catch (Throwable t) {
            Log.e(TAG, "dispatch failed for " + tool, t);
            callback.onError(new AppFunctionException(
                    AppFunctionException.ERROR_APP_UNKNOWN_ERROR, String.valueOf(t)));
            return;
        }

        try {
            GenericDocument result = new GenericDocument.Builder<>("", "", "")
                    .setPropertyString(
                            ExecuteAppFunctionResponse.PROPERTY_RETURN_VALUE, out.toString())
                    .build();
            callback.onResult(new ExecuteAppFunctionResponse(result));
        } catch (Throwable t) {
            callback.onError(new AppFunctionException(
                    AppFunctionException.ERROR_APP_UNKNOWN_ERROR, String.valueOf(t)));
        }
    }

    /**
     * Flatten a GenericDocument's properties into the JSONObject the bridge's
     * dispatch expects.
     *
     * WHY THE ARRAY UNWRAPPING IS NOT OPTIONAL. The framework builds the
     * parameter document itself, and AppSearch stores every property as an
     * array internally — so {@code getProperty("x1")} comes back as
     * {@code long[]}, not {@code Long}. The first version of this method tested
     * {@code instanceof String/Number/Boolean} and silently dropped every
     * parameter, which made every tool that takes an argument fail with
     * "ui_swipe 需要 x1 y1 x2 y2" while {@code ui_dump} (no parameters) worked
     * fine. A surface where the no-arg tools work and the arg tools do not is
     * exactly the kind of half-working state that survives review.
     *
     * Nested documents and non-scalar arrays are dropped rather than guessed
     * at: a tool that needs a structured argument is a tool that should not be
     * exposed through a surface whose parameter model is "one scalar per
     * name", and silently coercing would produce a call that looks well-formed
     * and is not.
     */
    private static JSONObject paramsOf(GenericDocument doc) {
        JSONObject o = new JSONObject();
        java.util.Set<String> names = doc.getPropertyNames();
        if (names == null) {
            return o;
        }
        for (String n : names) {
            Object flat = unwrap(doc.getProperty(n));
            if (flat == null) {
                continue;
            }
            if (flat instanceof String || flat instanceof Number || flat instanceof Boolean) {
                try {
                    o.put(n, flat);
                } catch (org.json.JSONException ignored) {
                    // One bad property must not fail the whole call.
                }
            }
        }
        return o;
    }

    /** First element of whatever AppSearch handed back, or null. */
    private static Object unwrap(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof Object[]) {
            Object[] arr = (Object[]) v;
            return arr.length > 0 ? unwrap(arr[0]) : null;
        }
        if (v instanceof long[]) {
            long[] a = (long[]) v;
            return a.length > 0 ? Long.valueOf(a[0]) : null;
        }
        if (v instanceof int[]) {
            int[] a = (int[]) v;
            return a.length > 0 ? Integer.valueOf(a[0]) : null;
        }
        if (v instanceof double[]) {
            double[] a = (double[]) v;
            return a.length > 0 ? Double.valueOf(a[0]) : null;
        }
        if (v instanceof boolean[]) {
            boolean[] a = (boolean[]) v;
            return a.length > 0 ? Boolean.valueOf(a[0]) : null;
        }
        if (v instanceof String[]) {
            String[] a = (String[]) v;
            return a.length > 0 ? a[0] : null;
        }
        // A GenericDocument means the caller passed a nested object; see the
        // method comment on why that is dropped.
        if (v instanceof GenericDocument) {
            return null;
        }
        return v;
    }
}

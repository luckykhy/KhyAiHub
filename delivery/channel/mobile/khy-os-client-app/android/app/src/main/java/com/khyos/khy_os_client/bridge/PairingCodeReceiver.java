// khy-canary: Khy-20261118-001-PAIRNOTIFY
package com.khyos.khy_os_client.bridge;

import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.khyos.khy_os_client.shell.ElevationBootstrap;

/**
 * PairingCodeReceiver — the pairing code arrives through the SHADE, not the app.
 *
 * WHY THE SHADE (measured 2026-11-18, on the real device). The pairing endpoint
 * exists only while the phone is showing the「使用配对码配对设备」dialog, and
 * that dialog dies the moment the user leaves the settings page: switching to
 * this app stops the settings activity, the service is unregistered, and mDNS
 * goes quiet. So the obvious flow — read the code, switch to the app, type it,
 * tap 配对 — can never work: by the time the user is back in the app there is
 * nothing left to pair with. Pulling down the notification shade, by contrast,
 * leaves the activity paused-but-visible and the endpoint alive.
 *
 * So the input lives in a notification with an inline reply, and the pairing
 * runs while the dialog is still on screen. No new permission is involved —
 * POST_NOTIFICATIONS was already required for the pairing code itself.
 *
 * The code still never lands in a log: it goes from RemoteInput straight into
 * the SPAKE2 password. The audit trail records that a pairing was attempted and
 * whether it worked, exactly like the in-app path.
 */
public class PairingCodeReceiver extends BroadcastReceiver {

    /** The RemoteInput key, and the intent action this receiver listens for. */
    public static final String ACTION = "com.khyos.khy_os_client.PAIRING_CODE";
    public static final String KEY_CODE = "khy_pairing_code";

    /** Fixed id: a new prompt replaces the previous one instead of stacking. */
    public static final int NOTIFICATION_ID = 0x70616972;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        String code = "";
        try {
            android.os.Bundle r = RemoteInput.getResultsFromIntent(intent);
            if (r != null) {
                CharSequence cs = r.getCharSequence(KEY_CODE);
                if (cs != null) code = cs.toString().trim();
            }
        } catch (Throwable ignored) {
            // No result at all is treated as an empty code below.
        }
        final String finalCode = code;
        // The pairing does mDNS discovery, a TLS handshake and a key exchange —
        // all of it off the main thread (onReceive runs on it).
        new Thread(() -> {
            ElevationBootstrap.PairOutcome out;
            try {
                out = ElevationBootstrap.INSTANCE.pairWithCode(context, finalCode);
            } catch (Throwable bad) {
                out = new ElevationBootstrap.PairOutcome(false,
                        "配对动作异常：" + bad.getClass().getSimpleName(),
                        String.valueOf(bad.getMessage()), "");
            }
            BridgeService.notifyText(
                    out.ok ? "配对成功" : "配对失败",
                    out.message + (out.ok ? "" : "（保持弹窗开着再试一次）"),
                    NOTIFICATION_ID);
        }, "pairing-notify").start();
    }
}

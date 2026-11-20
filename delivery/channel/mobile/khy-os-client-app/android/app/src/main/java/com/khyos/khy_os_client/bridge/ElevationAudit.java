// khy-canary: Khy-20261117-003-AUDITBRIDGE
package com.khyos.khy_os_client.bridge;

import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;

/**
 * ElevationAudit — the bridge-tool half of the audit trail.
 *
 * WHY a second writer. The audit file is the Dart side's
 * {@code AuditLog} ({@code <appSupport>/vfs/audit.jsonl}), and it was the only
 * writer. The bridge tool {@code elevate} — the path a PC or a script drives,
 * and the path this task's own debugging used — therefore left NO trace: the
 * file held five records, all from the UI, while pair/raise/off had been
 * driven through the bridge dozens of times (measured 2026-11-17, T10).
 *
 * The task's acceptance criterion is that pairing, connect, downgrade and
 * refused commands are all auditable with a timestamp, a source and a result.
 * A path that isn't audited isn't a smaller audit; it's a hole in it.
 *
 * THE FORMAT IS THE DART SIDE'S, NOT OURS. Same file, same field order, same
 * no-whitespace JSON: one reader must not need to know which process wrote the
 * line. If the Dart shape changes, this has to change with it — that coupling
 * is the cost of one file, and the alternative (two files) is how "the UI
 * shows a history" and "the truth" drift apart.
 *
 * NEVER PUT THE PAIRING CODE IN A RECORD. It is a 6-digit bearer credential
 * for the shell layer; the audit is the file most likely to be exported. The
 * callers here only ever pass outcome messages, and the code itself never
 * reaches them (it goes straight into the SPAKE2 password).
 */
public final class ElevationAudit {

    /** Relative to the app's files dir — the same dir the Dart side resolves. */
    private static final String RELATIVE_PATH = "vfs/audit.jsonl";

    private static final String TAG = "ElevationAudit";

    private ElevationAudit() {}

    /**
     * Append one record. Never throws: a failed audit write must not take the
     * elevation action down with it, but it is logged so the hole is visible.
     *
     * @param operation the Dart-side vocabulary: {@code elevation.pair},
     *        {@code elevation.bootstrap}, {@code elevation.toggle}
     * @param detail what happened. Outcome text only — never a credential.
     * @param ok whether it worked
     */
    public static void record(String operation, String detail, boolean ok) {
        try {
            File dir = Tools.ctxRef() == null ? null : Tools.ctxRef().getFilesDir();
            if (dir == null) {
                return;
            }
            File vfs = new File(dir, "vfs");
            if (!vfs.isDirectory() && !vfs.mkdirs()) {
                Log.w(TAG, "audit dir missing and could not be created");
                return;
            }
            String line = "{\"time\":" + System.currentTimeMillis()
                    + ",\"source\":\"user\""
                    + ",\"operation\":\"" + escape(operation) + "\""
                    + ",\"path\":\"\""
                    + ",\"detail\":\"" + escape(detail == null ? "" : detail) + "\""
                    + ",\"ok\":" + ok
                    + ",\"crossTier\":\"\"}\n";
            FileOutputStream out = new FileOutputStream(new File(vfs, "audit.jsonl"), true);
            try {
                out.write(line.getBytes(StandardCharsets.UTF_8));
                out.flush();
            } finally {
                out.close();
            }
        } catch (Throwable bad) {
            Log.w(TAG, "audit append failed: " + bad);
        }
    }

    /**
     * JSON-escape a string the way Dart's {@code jsonEncode} does for the
     * characters that can appear in an outcome message: quote, backslash, and
     * the control characters. Everything else (Chinese, full-width
     * punctuation) is written as UTF-8, which is what the Dart side emits.
     */
    private static String escape(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }
}

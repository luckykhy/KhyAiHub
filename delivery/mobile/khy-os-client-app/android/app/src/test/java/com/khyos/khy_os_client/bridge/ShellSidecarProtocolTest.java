// khy-canary: Khy-20261101-052-73NYMVKN
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.khyos.khy_os_client.shell.ShellSidecar;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Base64;

/**
 * ShellSidecarProtocolTest — the record grammar of the elevated exec path.
 *
 * WHY only the grammar. The socket, the token file and the uid-2000 process
 * cannot run on a bare JVM, so what is testable here is exactly the part a
 * malformed or hostile peer speaks: the RESULT record, and the base64 framing
 * that keeps a payload from forging one. Everything else in this path is
 * verified on the device (see the phone bridge facts record).
 *
 * The framing invariant under test is the one that matters: every variable
 * field is base64, so no command output can contain a tab or a newline and
 * therefore cannot inject an extra field or a whole extra record.
 */
public class ShellSidecarProtocolTest {

    private static final String TOKEN = "5500fae8db41cd054f45ea8834198d30";

    /** Build a RESULT record the way the sidecar does. */
    private static String record(int exit, String out, String err) {
        return "RESULT\t" + exit + "\t"
                + Base64.getEncoder().encodeToString(out.getBytes(java.nio.charset.StandardCharsets.UTF_8))
                + "\t"
                + Base64.getEncoder().encodeToString(err.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    @Test
    public void aGoodResultIsParsedIntoTheSharedEnvelope() throws Exception {
        JSONObject r = ShellSidecarClient.parseResult(record(0, "hello\nworld", ""));
        assertNotNull(r);
        assertEquals(0, r.getInt("exit"));
        assertTrue(r.getBoolean("ok"));
        assertEquals("hello\nworld", r.getString("out"));
        // An empty stderr is omitted rather than shipped as a blank field, so the
        // envelope matches what the app-uid path returns.
        assertFalse(r.has("err"));
        assertEquals("sidecar", r.getString("via"));
    }

    @Test
    public void aNonZeroExitIsOkFalseButStillParsed() throws Exception {
        JSONObject r = ShellSidecarClient.parseResult(record(127, "", "sh: nope: not found"));
        assertNotNull(r);
        assertEquals(127, r.getInt("exit"));
        assertFalse(r.getBoolean("ok"));
        assertEquals("sh: nope: not found", r.getString("err"));
    }

    @Test
    public void aTimeoutRecordCarriesItsOwnExitCode() throws Exception {
        // 124 is the shell's convention for "killed by timeout"; the client must
        // not treat a non-zero code as a protocol failure.
        JSONObject r = ShellSidecarClient.parseResult(record(124, "partial", "timeout 20s"));
        assertNotNull(r);
        assertEquals(124, r.getInt("exit"));
        assertFalse(r.getBoolean("ok"));
        assertEquals("timeout 20s", r.getString("err"));
    }

    @Test
    public void malformedRecordsAreRejectedNotTrusted() throws Exception {
        assertNull(ShellSidecarClient.parseResult("RESULT"));
        assertNull(ShellSidecarClient.parseResult("RESULT\tnotanumber\t\t"));
        assertNull(ShellSidecarClient.parseResult("OK"));
        assertNull(ShellSidecarClient.parseResult(""));
        assertNull(ShellSidecarClient.parseResult(null));
    }

    @Test
    public void aMissingStderrFieldIsTolerated() throws Exception {
        // The sidecar always emits four fields, but a shorter record must not
        // throw its way out to the bridge's error handler.
        JSONObject r = ShellSidecarClient.parseResult("RESULT\t0\t" + b64("out only"));
        assertNotNull(r);
        assertEquals("out only", r.getString("out"));
        assertFalse(r.has("err"));
    }

    /**
     * The framing invariant, stated as a test.
     *
     * This is the whole reason the protocol base64s its fields: a command whose
     * output contains a newline or a tab would otherwise split into extra fields
     * or an extra record, and the client would silently read the wrong bytes as
     * the exit code. Base64 output is [A-Za-z0-9+/=], so none of that is possible.
     */
    @Test
    public void noPayloadCanForgeARecordSeparator() throws Exception {
        String[] nasty = {
            "line1\nRESULT\t0\t\t\n",
            "a\tb\tc",
            "RESULT\t0\t\t",
            "PING\nQUIT\n",
            "\n\n\n",
            "tab\tand\nnewline\ttogether"
        };
        for (String s : nasty) {
            String encoded = b64(s);
            assertFalse("payload leaked a tab: " + s, encoded.contains("\t"));
            assertFalse("payload leaked a newline: " + s, encoded.contains("\n"));
            // And it still round-trips, so the gate costs nothing in fidelity.
            assertEquals(s, unb64(encoded));
        }
    }

    @Test
    public void theSidecarUsesTheOneTokenRuleNotASecondCopy() throws Exception {
        // Pinned because a private regex here would drift from BridgeToken, and
        // the two sides disagreeing about a token's shape is a silent lockout.
        assertTrue(ShellSidecar.isWellFormedToken(TOKEN));
        assertTrue(ShellSidecar.isWellFormedToken(TOKEN.toUpperCase()));
        assertFalse(ShellSidecar.isWellFormedToken(TOKEN.substring(0, 31)));
        assertFalse(ShellSidecar.isWellFormedToken(TOKEN + "g"));
        assertFalse(ShellSidecar.isWellFormedToken(null));
        assertFalse(ShellSidecar.isWellFormedToken(""));
    }

    @Test
    public void thePortsAreAdjacentAndDistinct() throws Exception {
        // 8896 is the HTTP bridge. A collision here would be invisible until
        // someone tried to run both at once.
        assertEquals(8896, HttpBridge.DEFAULT_PORT);
        assertEquals(8897, ShellSidecarClient.PORT);
    }

    private static String b64(String s) {
        return Base64.getEncoder().encodeToString(
                s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static String unb64(String s) {
        return new String(Base64.getDecoder().decode(s), java.nio.charset.StandardCharsets.UTF_8);
    }
}

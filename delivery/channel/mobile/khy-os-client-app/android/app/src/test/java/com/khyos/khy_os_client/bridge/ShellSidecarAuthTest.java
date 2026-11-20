// khy-canary: Khy-20261117-002-SIDECARAUTH
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import com.khyos.khy_os_client.shell.ShellSidecar;

import org.junit.Test;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.util.Base64;

/**
 * ShellSidecarAuthTest — the sidecar's gate, exercised without a phone.
 *
 * WHY this test exists (2026-11-17). The sidecar used to authenticate callers
 * with a shared token read from {@code /sdcard/bridge-amoobridge/token.txt}.
 * The bridge stopped writing that file on purpose, so the sidecar failed CLOSED
 * on every connection: it bound the port, answered nothing, and the elevated
 * exec path was silently dead. Nothing caught it, because the only test of this
 * path was the record grammar in {@link ShellSidecarProtocolTest} — the gate
 * itself had no coverage at all.
 *
 * So the gate is now run for real: a real {@link ShellSidecar#main} on a real
 * loopback port, driven over a real socket. What is asserted is the shape of
 * the claim — hold the device private key, sign a fresh challenge — and the
 * direction it fails in (closed) when the caller cannot.
 */
public class ShellSidecarAuthTest {

    private static final Base64.Encoder B64 = Base64.getEncoder();
    private static final Base64.Decoder B64D = Base64.getDecoder();

    private KeyPair device;
    private KeyPair stranger;

    private void keys() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(256);
        device = g.generateKeyPair();
        stranger = g.generateKeyPair();
    }

    private String pub(PublicKey k) {
        return B64.encodeToString(k.getEncoded());
    }

    private String sign(PrivateKey key, String text) throws Exception {
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(key);
        s.update(text.getBytes(StandardCharsets.UTF_8));
        return B64.encodeToString(s.sign());
    }

    /** One connection: read a line, write a line, close. */
    private static class Conn implements AutoCloseable {
        final Socket s;
        final PrintWriter out;
        final BufferedReader in;

        Conn(int port) throws Exception {
            s = new Socket("127.0.0.1", port);
            s.setSoTimeout(8000);
            out = new PrintWriter(new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8), false);
            in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
        }

        void send(String line) {
            out.print(line + "\n");
            out.flush();
        }

        String read() throws Exception {
            return in.readLine();
        }

        @Override
        public void close() throws Exception {
            s.close();
        }
    }

    /**
     * Start the sidecar on a free port with the device public key as its only
     * trusted caller, and return that port.
     */
    private int startSidecar(String callerPubB64) throws Exception {
        ServerSocket probe = new ServerSocket(0);
        int port = probe.getLocalPort();
        probe.close();
        Thread t = new Thread(() -> {
            try {
                ShellSidecar.main(new String[] {"--port", String.valueOf(port), "--pub", callerPubB64});
            } catch (Throwable ignored) {
                // main() only returns by throwing; the port being taken is the
                // normal end of this thread's life.
            }
        }, "sidecar-under-test");
        t.setDaemon(true);
        t.start();
        // The bind happens before the first log line, and the log line before
        // the first accept: wait for the port to answer rather than guessing.
        for (int i = 0; i < 100; i++) {
            try (Conn c = new Conn(port)) {
                c.send("PING");
                if ("PONG".equals(c.read().split("\t")[0])) {
                    return port;
                }
            } catch (Throwable retry) {
                Thread.sleep(50);
            }
        }
        throw new IllegalStateException("sidecar under test never came up");
    }

    @Test
    public void aCallerHoldingTheDeviceKeyRunsACommand() throws Exception {
        keys();
        int port = startSidecar(pub(device.getPublic()));
        try (Conn c = new Conn(port)) {
            c.send("HELLO");
            String challenge = c.read();
            assertNotNull("sidecar must answer HELLO with a challenge", challenge);
            assertTrue("challenge line: " + challenge, challenge.startsWith("CHALLENGE\t"));
            String nonce = challenge.substring("CHALLENGE\t".length()).trim();

            c.send("AUTH\t" + sign(device.getPrivate(), nonce));
            assertEquals("OK", c.read().trim());

            c.send("EXEC\t" + B64.encodeToString("echo hi".getBytes(StandardCharsets.UTF_8))
                    + "\t" + B64.encodeToString("/".getBytes(StandardCharsets.UTF_8)) + "\t5");
            String record = c.read();
            assertNotNull("sidecar must answer an authenticated EXEC", record);
            // A RESULT record with a parseable exit code is what this test is
            // about — the gate let the request through. Whether the command
            // itself succeeded is a property of /system/bin/sh, which a Windows
            // JVM does not have, so it is asserted on the device instead.
            assertTrue("record: " + record, record.startsWith("RESULT\t"));
            Integer.parseInt(record.split("\t")[1].trim());
        }
    }

    @Test
    public void aCallerWithoutTheKeyIsDenied() throws Exception {
        keys();
        int port = startSidecar(pub(device.getPublic()));
        try (Conn c = new Conn(port)) {
            c.send("HELLO");
            String nonce = c.read().substring("CHALLENGE\t".length()).trim();
            // The right shape, the wrong key.
            c.send("AUTH\t" + sign(stranger.getPrivate(), nonce));
            assertEquals("DENY", c.read().trim());

            c.send("EXEC\t" + B64.encodeToString("echo hi".getBytes(StandardCharsets.UTF_8))
                    + "\t" + B64.encodeToString("/".getBytes(StandardCharsets.UTF_8)) + "\t5");
            assertEquals("DENY", c.read().trim());
        }
    }

    @Test
    public void anExecWithoutAnyAuthIsDenied() throws Exception {
        keys();
        int port = startSidecar(pub(device.getPublic()));
        try (Conn c = new Conn(port)) {
            c.send("EXEC\t" + B64.encodeToString("echo hi".getBytes(StandardCharsets.UTF_8))
                    + "\t" + B64.encodeToString("/".getBytes(StandardCharsets.UTF_8)) + "\t5");
            assertEquals("DENY", c.read().trim());
        }
    }

    @Test
    public void aChallengeCannotBeReplayed() throws Exception {
        keys();
        int port = startSidecar(pub(device.getPublic()));
        String nonce;
        String signature;
        try (Conn c = new Conn(port)) {
            c.send("HELLO");
            nonce = c.read().substring("CHALLENGE\t".length()).trim();
            signature = sign(device.getPrivate(), nonce);
            c.send("AUTH\t" + signature);
            assertEquals("OK", c.read().trim());
        }
        // A recorded exchange, replayed on a fresh connection: the new
        // connection's challenge is a different nonce, so the old signature
        // must not open it.
        try (Conn c = new Conn(port)) {
            c.send("HELLO");
            String fresh = c.read().substring("CHALLENGE\t".length()).trim();
            assertFalse("each connection must get its own challenge", fresh.equals(nonce));
            c.send("AUTH\t" + signature);
            assertEquals("DENY", c.read().trim());
        }
    }

    @Test
    public void aSidecarStartedWithoutACallerKeyDeniesEverything() throws Exception {
        int port = startSidecar("");
        try (Conn c = new Conn(port)) {
            // PING stays open on purpose — it answers "is this port alive" and
            // nothing else.
            c.send("PING");
            assertTrue(c.read().startsWith("PONG"));
            c.send("HELLO");
            assertNotNull(c.read());
            c.send("AUTH\twhatever");
            assertEquals("DENY", c.read().trim());
        }
    }
}

package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * MailboxGcPolicyTest — S1 的 24h GC 判定与审计行（纯 JVM，不需要设备）。
 *
 * 钉住三件事：
 *   1. 保留期只有一处定义（result 24h / processing 72h / tmp 1h），判定用
 *      > 而不是 ≥ ——「超过 24h」是被测语义；
 *   2. oldest_result_age_ms 取最老一条的年龄，没有结果时为 -1（与
 *      heartbeat_age_ms 的「-1 = 还没发生过」口径一致）；
 *   3. 审计行只有 元数据（op/ts/kind/name/age_ms），不带任何回执正文——
 *      GC 是丢弃，不是消费，审计不能变成第二份内容出口。
 */
public class MailboxGcPolicyTest {

    @Test
    public void retentionIsTwentyFourHoursForResults() {
        long day = 24L * 60 * 60 * 1000;
        assertEquals(day, MailboxGcPolicy.RESULT_RETENTION_MS);
        assertFalse(MailboxGcPolicy.isDue("result", day));
        assertTrue(MailboxGcPolicy.isDue("result", day + 1));
    }

    @Test
    public void processingAndTmpHaveTheirOwnLeashes() {
        assertFalse(MailboxGcPolicy.isDue("processing", MailboxGcPolicy.PROCESSING_RETENTION_MS));
        assertTrue(MailboxGcPolicy.isDue("processing", MailboxGcPolicy.PROCESSING_RETENTION_MS + 1));
        assertFalse(MailboxGcPolicy.isDue("tmp", MailboxGcPolicy.TMP_RETENTION_MS));
        assertTrue(MailboxGcPolicy.isDue("tmp", MailboxGcPolicy.TMP_RETENTION_MS + 1));
    }

    @Test
    public void unknownKindNeverExpires() {
        assertFalse(MailboxGcPolicy.isDue("status", Long.MAX_VALUE / 2));
        assertNull(MailboxGcPolicy.kindOf("status.json"));
        assertEquals("result", MailboxGcPolicy.kindOf("result_abc123.json"));
        assertEquals("processing", MailboxGcPolicy.kindOf("processing_abc123.json"));
        assertEquals("tmp", MailboxGcPolicy.kindOf("cmd_abc123.json.tmp"));
        assertNull(MailboxGcPolicy.kindOf("result_abc123.json.bak"));
    }

    @Test
    public void oldestResultAgeIsMaxOrMinusOne() {
        assertEquals(-1L, MailboxGcPolicy.oldestResultAgeMs(new long[0]));
        assertEquals(-1L, MailboxGcPolicy.oldestResultAgeMs(null));
        assertEquals(50L, MailboxGcPolicy.oldestResultAgeMs(new long[] { 10, 50, 30 }));
    }

    @Test
    public void auditLineCarriesMetadataOnlyAndParses() throws Exception {
        String line = MailboxGcPolicy.auditJson(123456789L, "result", "result_abc123.json", 86400001L);
        JSONObject o = new JSONObject(line);
        assertEquals("gc_drop", o.getString("op"));
        assertEquals(123456789L, o.getLong("ts"));
        assertEquals("result", o.getString("kind"));
        assertEquals("result_abc123.json", o.getString("name"));
        assertEquals(86400001L, o.getLong("age_ms"));
        // 只有五个键：多一个就可能把正文带出去。
        assertEquals(5, o.length());
        assertFalse(line.contains("payload"));
    }
}

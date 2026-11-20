package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * SyncStoreCursorTest — S2 的游标推进（纯 JVM，不碰 /sdcard）。
 *
 * 背景：peer.lines/peer.last_hash 曾经全仓没有任何写入点（只有 append/delete 的
 * self 分支写这两项），于是 peer 游标停在 lines=0，读的人把 0 当成「没有数据」
 * ——其实 /sdcard/khyos-sync/peer.jsonl 里是有的，坏的是簿记。
 *
 * 这里钉住 advanceCursor 的四条语义：
 *   1. role 块缺失时按 roleCursor(0,0,0,GENESIS) 起步，四项一次写齐；
 *   2. 旧的 lines=0 会被 verify 的链真值覆盖（0 是簿记坏了，不是没数据）；
 *   3. 只动被推进的 role，self（写游标）一个字节都不能被读碰；
 *   4. lines=0 / offset=300 是**事实**也要照写——0 与「无数据」是两回事。
 */
public class SyncStoreCursorTest {

    @Test
    public void missingRoleBlockStartsFromGenesisAndWritesAllFour() throws Exception {
        JSONObject cursor = new JSONObject()
                .put("self", new JSONObject().put("segment", 0).put("offset", 0).put("lines", 0).put("last_hash", ""));

        JSONObject out = SyncStore.advanceCursor(cursor, "peer", 0, 66680L, 12L, "abc123");

        JSONObject peer = out.getJSONObject("peer");
        assertEquals(0, peer.getInt("segment"));
        assertEquals(66680L, peer.getLong("offset"));
        assertEquals(12L, peer.getLong("lines"));
        assertEquals("abc123", peer.getString("last_hash"));
        // self 是写游标：读推进不许碰它。
        assertEquals(0, out.getJSONObject("self").getLong("offset"));
        assertEquals(0L, out.getJSONObject("self").getLong("lines"));
    }

    @Test
    public void staleZeroLinesIsOverwrittenByChainTruth() throws Exception {
        // 实测形态：peer.offset 已经推进到文件尾，peer.lines 却还是 0——
        // 数据在盘上，簿记是坏的。advanceCursor 必须把 verify 的真值写回去。
        JSONObject cursor = new JSONObject()
                .put("peer", new JSONObject()
                        .put("segment", 0).put("offset", 66680L)
                        .put("lines", 0).put("last_hash", ""));

        JSONObject out = SyncStore.advanceCursor(cursor, "peer", 0, 66680L, 4L, "deadbeef");

        JSONObject peer = out.getJSONObject("peer");
        assertEquals(66680L, peer.getLong("offset"));
        assertEquals(4L, peer.getLong("lines"));
        assertEquals("deadbeef", peer.getString("last_hash"));
    }

    @Test
    public void zeroLinesWithNonZeroOffsetIsAFactAndIsKept() throws Exception {
        // 「0 行 + 有 offset」是调用方给的事实（比如刚滚段的空读），照写；
        // 任何把 0 改写成别的值的「好意」都会伪造簿记。
        JSONObject cursor = new JSONObject();
        JSONObject out = SyncStore.advanceCursor(cursor, "peer", 1, 300L, 0L, "");
        JSONObject peer = out.getJSONObject("peer");
        assertEquals(1, peer.getInt("segment"));
        assertEquals(300L, peer.getLong("offset"));
        assertEquals(0L, peer.getLong("lines"));
        assertEquals("", peer.getString("last_hash"));
    }

    @Test
    public void nullCursorAndNullHashAreHandled() throws Exception {
        JSONObject out = SyncStore.advanceCursor(null, "peer", 0, 0L, 0L, null);
        assertNotNull(out);
        JSONObject peer = out.getJSONObject("peer");
        assertEquals(0L, peer.getLong("offset"));
        assertEquals("", peer.getString("last_hash"));
        // null cursor 也必须补齐两份 role 块（与 emptyCursor 同形）。
        assertTrue(out.has("self"));
        assertTrue(out.has("peer"));
    }
}

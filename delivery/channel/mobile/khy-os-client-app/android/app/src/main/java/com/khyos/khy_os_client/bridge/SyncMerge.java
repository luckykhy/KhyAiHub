package com.khyos.khy_os_client.bridge;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;

/**
 * 共享层合并侧（断点三）：本端按 cursor 读对端那份时的消费账本。
 *
 * <h3>为什么单独一个类，而不是并进 {@link SyncStore}</h3>
 * SyncStore 是落盘真源：追加式 JSONL + 哈希链，只回答"盘上有什么"。它不保存
 * "本端消费到了什么"——那是读方自己的簿记（{@code cursor.json} 记字节读到哪，
 * 这里记哪些 id 已经交付过、哪些被墓碑作废）。并进文件层会让读写两侧的状态
 * 长在一起：对端重建文件、本端重置游标这类操作就得连消费账本一起动。
 *
 * <h3>三件事</h3>
 * <ul>
 * <li><b>seen</b>：已交付过的 id → 首次出现时的 hash。对端重发同一 id（重试/
 * 重投）只记重复，不再交付——T7 的"按 id 去重"。重发行与首发行的 hash 必然
 * 不同（prev 变了），所以按 hash 对不上，只能按 id 对。</li>
 * <li><b>deleted</b>：墓碑簿。op=delete 一到就记入，命中 id 从此不再作为活记录
 * 交付——T8"墓碑两端失效"里本端的那一端。墓碑先到也拦得住：一批里先扫墓碑
 * 再过记录，与文件顺序无关。本端 {@code sync_delete} 成功的 id 同样入簿（写进
 * self 链的那份墓碑是对端镜像的凭据，这一份是本端合并视图的凭据，两个消费方
 * 各拿各的证据）。</li>
 * <li><b>break</b>：最近一次断链（role/code/break_line/ts）。断链的"停止合并"
 * 由 sync_read 里 verify 一道闸管（每次读都重跑，链没修好就一行都不会交付）；
 * 这里落的是"报断档"——断点写进簿记，sync_status 与 merge.json 都看得到，
 * 不能只活在那一次调用的返回值里。链修好（verify 重新通过）即清闩放行，
 * 断档史留 last_break。</li>
 * </ul>
 *
 * <h3>状态文件</h3>
 * {@code /sdcard/khyos-sync/merge.json}：与 cursor.json 同类的本端簿记，不是
 * 第三份消息流——对端读不到它，也永远不该读它。整文件原子写，坏文件按空账本
 * 重开并大声记日志（空账本的最坏结果只是"重发过的行再交付一次"，比静默丢账
 * 强）。
 *
 * <h3>上限</h3>
 * seen/deleted 各 8192 条。到顶即拒绝合并（{@code merge_full}、游标不推进），
 * 绝不静默丢行——真到这个量级，该人来清账本，不该代码猜哪些 id 能忘。
 */
public final class SyncMerge {

    static final String FILE = "merge.json";

    /** 账本条目上限。到达即停（fail-stop），不做淘汰——淘汰等于静默丢账。 */
    static final int MAX_TRACKED = 8192;

    private static final String TAG = "SyncMerge";

    private SyncMerge() {
    }

    // ==================== 簿记 ====================

    static File file() {
        return new File(SyncStore.DIR, FILE);
    }

    /** 空账本。last_hash 类字段没有——账本不参与链，只管 id。 */
    static JSONObject empty() {
        JSONObject st = new JSONObject();
        try {
            st.put("version", 1)
                    .put("seen", new JSONObject())
                    .put("deleted", new JSONObject())
                    .put("merged_total", 0)
                    .put("duplicate_total", 0)
                    .put("tombstone_total", 0)
                    .put("break", JSONObject.NULL)
                    .put("last_break", JSONObject.NULL);
        } catch (Throwable t) {
            Log.w(TAG, "empty 账本构造失败: " + t);
        }
        return st;
    }

    /**
     * 读账本。坏文件按空账本重开并记日志，坏文件留在原地——空账本重开的最坏
     * 结果是"对端重发过的行再交付一次"，静默丢账才是不可逆的。
     */
    static synchronized JSONObject readState() {
        try {
            File f = file();
            if (!f.isFile()) return empty();
            String s = SyncStore.readText(f);
            if (s.trim().isEmpty()) return empty();
            JSONObject st = new JSONObject(s);
            if (!st.has("seen") || !st.has("deleted")) {
                Log.w(TAG, "merge.json 缺必备键（seen/deleted），按空账本重开");
                return empty();
            }
            return st;
        } catch (Throwable t) {
            Log.w(TAG, "merge.json 读失败，按空账本重开: " + t);
            return empty();
        }
    }

    static synchronized void writeState(JSONObject st) {
        try {
            boolean ok = SyncStore.writeAtomic(file(), st.toString());
            if (!ok) Log.w(TAG, "merge.json 写失败（保留内存态，下次操作重写）");
        } catch (Throwable t) {
            Log.w(TAG, "merge.json 写异常: " + t);
        }
    }

    // ==================== 合并 ====================

    /**
     * 一批增量行的合并判定。调用前提：调用方已过 verify（断链根本不会到这）。
     *
     * 两遍处理：先收墓碑、再过活记录——这样墓碑在本批里无论排在记录前还是后，
     * 都拦得住。返回 {@code ok=false}（账本满）时调用方必须**不推进游标**：
     * 推了这批字节就永远读不回来。
     *
     * @return {@code ok=true} + items（应交付的活记录）+ raw_count / merged_count /
     *         duplicates / tombstones / deleted_hits / invalid。
     */
    public static synchronized JSONObject apply(JSONArray items) {
        JSONObject out = new JSONObject();
        try {
            JSONObject st = readState();
            JSONObject seen = st.optJSONObject("seen");
            JSONObject deleted = st.optJSONObject("deleted");
            if (seen == null || deleted == null) {
                return out.put("ok", false).put("code", "merge_state_bad");
            }

            int tombstones = 0;
            for (int i = 0; i < items.length(); i++) {
                JSONObject o = items.optJSONObject(i);
                if (o == null) continue;
                if (!"delete".equals(o.optString("op", ""))) continue;
                String id = o.optString("id", "");
                if (id.isEmpty()) continue;
                if (!deleted.has(id)) {
                    deleted.put(id, o.optLong("ts", System.currentTimeMillis()));
                    st.put("tombstone_total", st.optInt("tombstone_total", 0) + 1);
                }
                tombstones++;
            }

            JSONArray deliver = new JSONArray();
            int duplicates = 0;
            int deletedHits = 0;
            int invalid = 0;
            for (int i = 0; i < items.length(); i++) {
                JSONObject o = items.optJSONObject(i);
                if (o == null) continue;
                if ("delete".equals(o.optString("op", ""))) continue;
                String id = o.optString("id", "");
                if (id.isEmpty()) {
                    invalid++;
                    continue;
                }
                if (deleted.has(id)) {
                    deletedHits++;
                    continue;
                }
                if (seen.has(id)) {
                    duplicates++;
                    st.put("duplicate_total", st.optInt("duplicate_total", 0) + 1);
                    continue;
                }
                if (seen.length() >= MAX_TRACKED) {
                    Log.w(TAG, "seen 账本满（" + MAX_TRACKED + "），停止合并；游标不得推进");
                    return out.put("ok", false).put("code", "merge_full")
                            .put("seen_count", seen.length()).put("stop_merge", true);
                }
                seen.put(id, o.optString("hash", ""));
                deliver.put(o);
                st.put("merged_total", st.optInt("merged_total", 0) + 1);
            }
            writeState(st);

            return out.put("ok", true)
                    .put("items", deliver)
                    .put("raw_count", items.length())
                    .put("merged_count", deliver.length())
                    .put("duplicates", duplicates)
                    .put("tombstones", tombstones)
                    .put("deleted_hits", deletedHits)
                    .put("invalid", invalid);
        } catch (Throwable t) {
            Log.w(TAG, "apply 失败: " + t);
            try {
                return out.put("ok", false).put("code", "merge_error")
                        .put("reason", String.valueOf(t));
            } catch (Throwable ignored) {
                return out;
            }
        }
    }

    /** 本端 sync_delete 成功后入簿：本端合并视图即刻失效该 id，不等下次读。 */
    public static synchronized void recordTombstone(String id) {
        try {
            if (id == null || id.trim().isEmpty()) return;
            JSONObject st = readState();
            JSONObject deleted = st.optJSONObject("deleted");
            if (deleted == null) return;
            if (!deleted.has(id)) {
                deleted.put(id, System.currentTimeMillis());
                st.put("tombstone_total", st.optInt("tombstone_total", 0) + 1);
                writeState(st);
            }
        } catch (Throwable t) {
            Log.w(TAG, "recordTombstone 失败: " + t);
        }
    }

    /** 断链入簿：sync_status 与 merge.json 都要能看到断档，不能只活在当次返回值里。 */
    public static synchronized void recordBreak(JSONObject chain) {
        try {
            if (chain == null) return;
            JSONObject b = new JSONObject()
                    .put("role", chain.optString("role", ""))
                    .put("code", chain.optString("code", "hash_chain_broken"))
                    .put("break_line", chain.optInt("break_line", 0))
                    .put("ts", System.currentTimeMillis());
            JSONObject st = readState();
            st.put("break", b);
            st.put("last_break", b);
            writeState(st);
            Log.w(TAG, "断档入簿: role=" + b.optString("role")
                    + " code=" + b.optString("code")
                    + " break_line=" + b.optInt("break_line", 0));
        } catch (Throwable t) {
            Log.w(TAG, "recordBreak 失败: " + t);
        }
    }

    /**
     * 链修好（本次读 verify 重新通过）后清闩放行。断档史不删——last_break 一直
     * 在，"这条链断过"这件事不能因为修好了就从账本上消失。
     */
    public static synchronized void clearBreak() {
        try {
            JSONObject st = readState();
            if (st.isNull("break")) return;
            st.put("break", JSONObject.NULL);
            writeState(st);
        } catch (Throwable t) {
            Log.w(TAG, "clearBreak 失败: " + t);
        }
    }

    /** sync_status 的合并侧读数。不返回任何 seen/deleted 明细——那是账本，不是状态。 */
    public static synchronized JSONObject state() {
        JSONObject out = new JSONObject();
        try {
            JSONObject st = readState();
            JSONObject seen = st.optJSONObject("seen");
            JSONObject deleted = st.optJSONObject("deleted");
            out.put("version", st.optInt("version", 1))
                    .put("seen_count", seen == null ? 0 : seen.length())
                    .put("deleted_count", deleted == null ? 0 : deleted.length())
                    .put("merged_total", st.optInt("merged_total", 0))
                    .put("duplicate_total", st.optInt("duplicate_total", 0))
                    .put("tombstone_total", st.optInt("tombstone_total", 0))
                    // isNull 对"缺席"与"显式 null"都为真：两种情况对外都回 null。
                    .put("break", st.isNull("break") ? JSONObject.NULL : st.get("break"))
                    .put("last_break", st.isNull("last_break") ? JSONObject.NULL : st.get("last_break"))
                    .put("max_tracked", MAX_TRACKED);
        } catch (Throwable t) {
            Log.w(TAG, "state 失败: " + t);
        }
        return out;
    }
}

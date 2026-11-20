// khy-canary: Khy-20261110-L4-PROMPT
package com.khyos.khy_os_client.bridge;

import android.app.Activity;
import android.graphics.Typeface;
import android.text.Editable;
import android.text.TextWatcher;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * L4 提示词输入页（[DESIGN-ARCH-208] 期 3，方案 B）。
 *
 * 为什么是独立 Activity，而不是把 EditText 塞进悬浮面板：面板与气泡共用
 * FLAG_NOT_FOCUSABLE（BridgeOverlayService.params()），摘掉它会抢输入法焦点，
 * 且 AmooLoop.ask() 的 amoo 前台预检会随之失败。把输入收进 App 内的一次界面
 * 跳转，悬浮窗就能始终保持纯展示态（F5 / F6 不被破坏）。
 *
 * 纯代码构建，不新增 res / i18n（与悬浮面板同一约束）。
 *
 * 诚实边界：从悬浮窗跳进本页会把 amoo 切到后台，因此「立即发送」很可能被
 * AmooLoop.ask() 的前台预检拒绝。这里不绕过预检：失败时把 prompt 留在队首，
 * 并把真实原因回给用户，由他在 amoo 回到前台后点面板「发送下一笔」重试。
 * 后台启动 Activity 在 Android 10+ 有系统限制（本 App 有 SYSTEM_ALERT_WINDOW
 * 权限），真机行为待验证，不写「已通过」。
 *
 * JSON 直显：粘进来的是控制台命令（{@code {"tool":…,"args":{…}}}）时，它不在
 * 本页判一次、再让 AmooLoop 判第二次——判据只有 AmooLoop.looksLikeCommand 一
 * 处。本页只把它显示出来，让人在按下去之前就知道这句话会去哪里。
 */
public class PromptInputActivity extends Activity {

    private EditText input;
    private TextView route;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF141A2E);
        int pad = dp(20);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("给 khy-os 追加一条指令");
        title.setTextColor(0xFFB7C6FF);
        title.setTextSize(16);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView hint = new TextView(this);
        hint.setText(pendingLabel());
        hint.setTextColor(0xFFC9D4F2);
        hint.setTextSize(12);
        hint.setPadding(0, dp(6), 0, dp(10));
        root.addView(hint);

        input = new EditText(this);
        input.setHint("输入提示词，或粘一条 {\"tool\":…} 命令…");
        input.setTextColor(0xFFE6ECFF);
        input.setHintTextColor(0xFF7C88A8);
        input.setTextSize(14);
        input.setGravity(Gravity.TOP | Gravity.START);
        input.setMinLines(3);
        input.setBackgroundColor(0xFF1E2540);
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        input.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
            public void onTextChanged(CharSequence s, int a, int b, int c) {}
            public void afterTextChanged(Editable s) { updateRoute(); }
        });
        root.addView(input, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        route = new TextView(this);
        route.setTextColor(0xFF8FA6E8);
        route.setTextSize(11);
        route.setPadding(0, dp(6), 0, 0);
        root.addView(route);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(14), 0, 0);
        row.addView(action("加入队列", new View.OnClickListener() {
            public void onClick(View v) { enqueue(false); }
        }));
        row.addView(action("立即发送", new View.OnClickListener() {
            public void onClick(View v) { enqueue(true); }
        }));
        row.addView(action("取消", new View.OnClickListener() {
            public void onClick(View v) { finish(); }
        }));
        root.addView(row);

        setContentView(root);
        input.requestFocus();
        updateRoute();
    }

    /**
     * 这句话会去哪里。只显示，不决定——决定在 AmooLoop.looksLikeCommand 一处。
     *
     * 为什么必须显示：同一個「立即发送」按钮，对自然语言是把 amoo 调到前台问
     * 一句，对 JSON 是在本机跑一条命令并在控制台里落一张卡片。两条路的等待时
     * 间差一个数量级（约 6 分钟 vs 就地返回），不告诉用户他按的是什么，他会
     * 以为卡死。
     */
    private void updateRoute() {
        String p = input.getText() == null ? "" : input.getText().toString();
        if (p.trim().length() == 0) {
            route.setText("等待输入…");
        } else if (AmooLoop.looksLikeCommand(p)) {
            route.setText("识别为本地命令：将在本机执行，结果落在控制台历史里，不发给 amoo");
        } else {
            route.setText("识别为提问：将发给 amoo（约 6 分钟，期间 amoo 需留在前台）");
        }
    }

    private void enqueue(boolean immediate) {
        String p = input.getText() == null ? "" : input.getText().toString();
        if (p.trim().length() == 0) {
            Toast.makeText(this, "内容为空，未加入队列", Toast.LENGTH_SHORT).show();
            return;
        }
        // 入口判定：粘进来的是一条 JSON 命令（{"tool":…,"args":{…}}）就在本机跑，
        // 是一句给 amoo 的话才送出去。
        //
        // 判定不在本页里：AmooLoop.looksLikeCommand 是唯一判据（它问
        // KhyConsole.prepare 认不认得 tool 字段），本页只按它分流。两条路一个
        // 就地返回、一个要把 amoo 调到前台等约 6 分钟——路由不说清，用户按下去
        // 之后不知道该等 3 秒还是 6 分钟，而按钮上写着的是同一个词。
        //
        // 「加入队列」两条路都一样：命令进队后由面板「发送下一笔」按同一判据
        // 分流（BridgeOverlayService.queueHeadIsCommand），这里不提前判第二次。
        String result;
        if (!immediate) {
            result = "已排入队列（第 " + AmooLoop.enqueuePrompt(p, false) + " 位）";
        } else if (AmooLoop.looksLikeCommand(p)) {
            result = AmooLoop.runCommandLocally(p);
        } else {
            // submitPrompt 内部还会经 sendPendingPrompt 再过一次同一判据——
            // 那一处是兜底：它是 public 的，任何调用方都不该因为漏判就把一条
            // 命令送进 amoo 的输入框。
            result = AmooLoop.submitPrompt(p);
        }
        Toast.makeText(this, result, Toast.LENGTH_LONG).show();
        finish();
    }

    private String pendingLabel() {
        int n = AmooLoop.pendingPromptCount();
        if (n == 0) return "待发队列：空";
        return "待发队列：" + n + " 笔 · 队首 " + abbrev(AmooLoop.pendingPromptHead(), 24);
    }

    private Button action(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(0xFFE6ECFF);
        b.setTextSize(12);
        b.setMinimumWidth(0);
        b.setMinimumHeight(0);
        b.setPadding(dp(14), dp(7), dp(14), dp(7));
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(4);
        b.setLayoutParams(lp);
        return b;
    }

    private static String abbrev(String s, int n) {
        return s.length() > n ? s.substring(0, n) + "…" : s;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }
}

package com.khyos.khy_os_client.battery;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 无障碍掉线自检的判定逻辑（纯逻辑，JVM 可测）。
 *
 * <p>为什么单独测这一段：它藏在 Android 上下文后面，JVM 跑不到；而它恰好
 * 写反过一次（原实现把"上一步是通的"当成"不通知"的条件，结果真掉线时反而
 * 静默——真机实测：服务被系统解绑后 30s 看守转了一圈，通知没发出来）。
 * 把规则抽成纯函数之后，这种错误在构建期就能被钉住。
 */
public class AccessibilitySelfCheckTest {

    @Test
    public void transitionFromEnabledToDisabledNotifies() {
        // 从通到不通 = 掉线，必须通知。
        assertTrue(AccessibilitySelfCheck.shouldNotify(Boolean.TRUE, false));
    }

    @Test
    public void stillEnabledDoesNotNotify() {
        // 现在是通的，没什么可报。
        assertFalse(AccessibilitySelfCheck.shouldNotify(Boolean.TRUE, true));
        assertFalse(AccessibilitySelfCheck.shouldNotify(Boolean.FALSE, true));
    }

    @Test
    public void alreadyDisabledDoesNotNotifyAgain() {
        // 持续失联时反复通知是骚扰：只在"从有到无"的那一刻报一次。
        assertFalse(AccessibilitySelfCheck.shouldNotify(Boolean.FALSE, false));
    }

    @Test
    public void firstObservationDoesNotNotify() {
        // 第一次看（prev 未知）：从没开过无障碍的用户不该被无缘无故通知。
        assertFalse(AccessibilitySelfCheck.shouldNotify(null, false));
        assertFalse(AccessibilitySelfCheck.shouldNotify(null, true));
    }
}

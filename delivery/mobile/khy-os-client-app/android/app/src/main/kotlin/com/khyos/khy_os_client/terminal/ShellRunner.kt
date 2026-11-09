package com.khyos.khy_os_client.terminal

import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit

/**
 * 以 App 自己的 uid 跑一条命令，一次性取回 stdout/stderr。
 *
 * 为什么单独成文件：shell（AI 与设备控制）和 terminalShell（人工终端）两条通道
 * 的**准入策略**不同，但**执行**方式完全一样。一份实现两处调用，免得两套读管道
 * 的代码各自漂移——尤其 stdout/stderr 必须并发抽干这件事，漏掉就是死锁。
 */
object ShellRunner {

    /**
     * 跑一条命令。
     *
     * @param command 命令体。**不要**把工作目录拼进来（`cd x && cmd`）——命令体里
     *   出现 `&&` 会被控制符禁令整体拒绝；工作目录走 [cwd] 参数。
     * @param cwd 工作目录；为空或空白时用进程默认目录。
     * @param timeoutSec 超时秒数。
     */
    fun run(command: String, cwd: String?, timeoutSec: Int): Map<String, Any> {
        return try {
            val builder = ProcessBuilder("sh", "-c", command)
            if (!cwd.isNullOrBlank()) {
                builder.directory(File(cwd))
            }
            val p = builder.start()
            val out = StringBuilder()
            val err = StringBuilder()
            // stdout 与 stderr 必须**并发**抽干：先读 stdout 再读 stderr 时，
            // 子进程若先把 stderr 写满管道（Linux 管道缓冲 64KB）就会阻塞在自己的
            // stderr 写上，stdout 于是永远不到 EOF —— 父进程卡在读 stdout 上，
            // 而 destroyForcibly() 排在两次读之后，永远执行不到。
            val outThread = Thread {
                BufferedReader(InputStreamReader(p.inputStream)).use { br ->
                    var line: String?
                    while (br.readLine().also { line = it } != null) {
                        synchronized(out) { out.append(line).append("\n") }
                    }
                }
            }
            val errThread = Thread {
                BufferedReader(InputStreamReader(p.errorStream)).use { br ->
                    var line: String?
                    while (br.readLine().also { line = it } != null) {
                        synchronized(err) { err.append(line).append("\n") }
                    }
                }
            }
            outThread.isDaemon = true
            errThread.isDaemon = true
            outThread.start()
            errThread.start()
            val finished = p.waitFor(timeoutSec.toLong(), TimeUnit.SECONDS)
            if (!finished) {
                p.destroyForcibly()
            }
            outThread.join(500)
            errThread.join(500)
            val code = try { p.exitValue() } catch (_: Exception) { -1 }
            mapOf(
                "success" to (finished && code == 0),
                "stdout" to out.toString(),
                "stderr" to err.toString(),
                "exitCode" to code,
                "timeout" to !finished,
            )
        } catch (e: Exception) {
            mapOf(
                "success" to false,
                "stdout" to "",
                "stderr" to (e.message ?: "unknown error"),
                "exitCode" to -1,
            )
        }
    }
}

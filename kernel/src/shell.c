/* shell.c — Serial shell task * @pattern Strategy
 */

#include "shell.h"
#include "agentask.h"
#include "agentconf.h"
#include "agentframe.h"
#include "net.h"
#include "pmm.h"
#include "process.h"
#include "console.h"
#include "sched.h"
#include "string.h"
#include "syscall.h"
#include "timer.h"
#include "vfs.h"
#include "kheap.h"

#define SHELL_LINE_MAX 256
#define SHELL_ARGV_MAX 16

static char line_buf[SHELL_LINE_MAX];
static size_t line_len;
static int prompt_shown;

static void shell_prompt(void) {
    if (!prompt_shown) {
        console_print("khy> ");
        prompt_shown = 1;
    }
}

static int is_space(char c) {
    return c == ' ' || c == '\t';
}

static int is_printable(char c) {
    return c >= 32 && c <= 126;
}

static void print_u64_hex_or_dash(uint64_t v) {
    if (v == (uint64_t)-1) {
        console_print("-");
    } else {
        console_print_hex(v);
    }
}

static void cmd_help(void) {
    console_print("Commands:\n");
    console_print("  help              - Show this help\n");
    console_print("  ps                - List processes\n");
    console_print("  mem               - Show memory and uptime\n");
    console_print("  ls [path]         - List directory (default /)\n");
    console_print("  cat <path>        - Print file\n");
    console_print("  write <p> <txt>   - Overwrite file with text\n");
    console_print("  append <p> <txt>  - Append text to file\n");
    console_print("  run <elf-path>    - Load ELF into user address space\n");
    console_print("  netstat           - Show network counters\n");
    console_print("  netsend <txt>     - Send loopback packet\n");
    console_print("  netrecv           - Receive one loopback packet\n");
    console_print("  syscalltest       - Test int 0x80 path\n");
    console_print("  ai <prose>        - Ask the agent on COM2 in natural language\n");
    console_print("  agentask <q>      - Ask the agent for an ALLOW/DENY decision\n");
}

static void cmd_ps(void) {
    struct process_info list[PROCESS_MAX];
    size_t n = process_list(list, PROCESS_MAX);
    console_print("PID   TID   TYPE   STATE    ENTRY\n");
    for (size_t i = 0; i < n; i++) {
        console_print_dec(list[i].pid);
        console_print("    ");
        print_u64_hex_or_dash(list[i].task_id);
        console_print("    ");
        console_print(list[i].is_user ? "user   " : "kern   ");
        console_print(process_state_string(list[i].state));
        console_print("   ");
        console_print_hex(list[i].entry);
        console_print("  ");
        console_print(list[i].name);
        console_print("\n");
    }
}

static void cmd_mem(void) {
    console_print("Total memory: ");
    console_print_dec(pmm_total_memory() / (1024 * 1024));
    console_print(" MB\n");
    console_print("Free memory : ");
    console_print_dec(pmm_free_memory() / 1024);
    console_print(" KB\n");
    console_print("Uptime ticks: ");
    console_print_dec(timer_get_ticks());
    console_print("\n");
}

static void cmd_ls(const char *path) {
    struct vfs_dirent ents[64];
    int n = vfs_list_dir(path, ents, 64);
    if (n < 0) {
        console_print("ls: cannot open directory\n");
        return;
    }
    for (int i = 0; i < n; i++) {
        console_print(ents[i].type == VFS_NODE_DIR ? "d " : "f ");
        console_print(ents[i].name);
        if (ents[i].type == VFS_NODE_FILE) {
            console_print(" (");
            console_print_dec(ents[i].size);
            console_print(")");
        }
        console_print("\n");
    }
}

static void cmd_cat(const char *path) {
    size_t sz = 0;
    if (vfs_get_size(path, &sz) != 0) {
        console_print("cat: file not found\n");
        return;
    }
    if (sz + 1 < sz) {
        console_print("cat: invalid size\n");
        return;
    }
    char *buf = (char *)kmalloc(sz + 1);
    if (!buf) {
        console_print("cat: out of memory\n");
        return;
    }
    int n = vfs_read_file(path, buf, sz);
    if (n < 0) {
        console_print("cat: read failed\n");
        kfree(buf);
        return;
    }
    buf[n] = '\0';
    console_print(buf);
    if (n == 0 || buf[n - 1] != '\n')
        console_print("\n");
    kfree(buf);
}

static void cmd_write_like(const char *path, const char *text, int append) {
    if (!path || !text) {
        console_print("write: bad args\n");
        return;
    }
    int rc = vfs_write_file(path, text, strlen(text), append);
    if (rc < 0) {
        console_print("write: failed\n");
        return;
    }
    console_print("ok\n");
}

static void cmd_run(const char *path) {
    if (!path) {
        console_print("run: missing path\n");
        return;
    }
    int pid = process_create_from_elf(path);
    if (pid < 0) {
        console_print("run: ELF load failed\n");
        return;
    }
    console_print("run: loaded pid=");
    console_print_dec((uint64_t)(uint32_t)pid);
    console_print(" (execution path pending user-mode switch)\n");
}

static void cmd_netstat(void) {
    struct net_stats st;
    net_get_stats(&st);
    console_print("tx_packets=");
    console_print_dec(st.tx_packets);
    console_print(" rx_packets=");
    console_print_dec(st.rx_packets);
    console_print(" tx_bytes=");
    console_print_dec(st.tx_bytes);
    console_print(" rx_bytes=");
    console_print_dec(st.rx_bytes);
    console_print(" drops=");
    console_print_dec(st.drops);
    console_print("\n");
}

static void cmd_netsend(const char *text) {
    if (!text) {
        console_print("netsend: missing payload\n");
        return;
    }
    int rc = net_send(text, strlen(text));
    if (rc < 0) {
        console_print("netsend: failed\n");
        return;
    }
    console_print("netsend: ");
    console_print_dec((uint64_t)(uint32_t)rc);
    console_print(" bytes queued\n");
}

static void cmd_netrecv(void) {
    char buf[NET_MTU + 1];
    int n = net_recv(buf, NET_MTU);
    if (n < 0) {
        console_print("netrecv: error\n");
        return;
    }
    if (n == 0) {
        console_print("netrecv: no packet\n");
        return;
    }
    buf[n] = '\0';
    console_print("netrecv: ");
    console_print_dec((uint64_t)n);
    console_print(" bytes: ");
    console_print(buf);
    console_print("\n");
}

static void cmd_syscalltest(void) {
    const char *msg = "[syscall] hello from int 0x80\n";
    long w = syscall_invoke(SYSCALL_WRITE, (uint64_t)msg, strlen(msg), 0, 0, 0, 0);
    long pid = syscall_invoke(SYSCALL_GETPID, 0, 0, 0, 0, 0, 0);
    long up = syscall_invoke(SYSCALL_UPTIME, 0, 0, 0, 0, 0, 0);
    console_print("syscalltest: write=");
    console_print_dec((uint64_t)w);
    console_print(" pid=");
    console_print_dec((uint64_t)pid);
    console_print(" ticks=");
    console_print_dec((uint64_t)up);
    console_print("\n");
}

/* ── Agent decision plane: `ai <prose>` and `agentask <question>` ────────────
 *
 * The kernel keeps only a three-verb action grammar (SAY / SET / GET) and pushes
 * every judgement call to the host agent on COM2: the intelligence lives on that
 * side, this side stays small enough to audit. Both commands block the shell
 * task inside agent_ask(), which always returns within
 * AGENTASK_DEFAULT_TIMEOUT_MS — an absent agent costs a wait, never a hang.
 *
 * These two buffers are file-scope rather than stack: they stay live for the
 * whole blocking ask, and the 8KB shell stack also carries the console frames.
 * One shell task services the line, so there is exactly one user.
 */
static char ai_question[SHELL_LINE_MAX];
static char ai_reply[AGENTFRAME_PAYLOAD_MAX + 1];

static const char *skip_spaces(const char *s) {
    while (*s == ' ' || *s == '\t')
        s++;
    return s;
}

/* Case-insensitive word compare: the action grammar is fixed, but a model may
 * answer in any case (`set` / `SET`), and folding costs nothing. */
static int word_is(const char *word, size_t len, const char *want) {
    size_t i = 0;
    for (; i < len && want[i]; i++) {
        char a = word[i];
        char b = want[i];
        if (a >= 'a' && a <= 'z')
            a = (char)(a - 32);
        if (b >= 'a' && b <= 'z')
            b = (char)(b - 32);
        if (a != b)
            return 0;
    }
    return i == len && want[i] == '\0';
}

/* Split off the next word (bounded, NUL-terminated). Returns 0 when the word is
 * missing or longer than the caller's buffer. */
static int take_word(const char **rest, char *out, size_t cap) {
    const char *p = skip_spaces(*rest);
    const char *end = p;
    while (*end && *end != ' ' && *end != '\t')
        end++;
    size_t n = (size_t)(end - p);
    *rest = end;
    if (n == 0 || n >= cap)
        return 0;
    for (size_t i = 0; i < n; i++)
        out[i] = p[i];
    out[n] = '\0';
    return 1;
}

/* Re-join the argv tail into one line: parse_line() terminates every token in
 * place, and the agent wants the human's words back as a sentence. */
static size_t join_args(int argc, char *argv[], char *out, size_t cap) {
    size_t n = 0;
    for (int i = 1; i < argc; i++) {
        if (i > 1 && n + 1 < cap)
            out[n++] = ' ';
        for (const char *p = argv[i]; *p && n + 1 < cap; p++)
            out[n++] = *p;
    }
    out[n] = '\0';
    return n;
}

/* Ask the agent and leave its answer in ai_reply (NUL-terminated). Reports the
 * failure itself and returns 0 when no answer arrived, so both callers stay a
 * single if. Never claims an answer that did not come. */
static int ai_ask(uint16_t intent, const char *question, size_t qlen) {
    uint16_t rlen = 0;
    int rc = agent_ask(intent, (const uint8_t *)question, (uint16_t)qlen,
                       (uint8_t *)ai_reply, (uint16_t)AGENTFRAME_PAYLOAD_MAX,
                       &rlen, 0);
    if (rc == AGENT_ASK_OK) {
        ai_reply[rlen] = '\0';
        return 1;
    }
    if (rc == AGENT_ASK_TIMEOUT) {
        console_print("no agent connected on COM2 (waited ");
        console_print_dec(AGENTASK_DEFAULT_TIMEOUT_MS / 1000);
        console_print("s): start one with `node kernel/bridge/khy-agent-run.js`\n");
        return 0;
    }
    if (rc == AGENT_ASK_NOSLOT) {
        console_print("agent ask table is full (");
        console_print_dec(8);
        console_print(" waiters): retry in a moment\n");
        return 0;
    }
    console_print("question rejected: too long for one frame\n");
    return 0;
}

/* Execute one action line from the agent — the whole grammar the kernel knows:
 *   SET <key> <value>   persist to /disk/etc/agent.conf (survives reboot)
 *   GET <key>           read that config back
 *   SAY <text>          just talk to the user
 * Anything outside the grammar is shown verbatim: the agent's words are still
 * the most useful thing available, and hiding them would look like a freeze. */
static void ai_apply_action(const char *action) {
    const char *rest = action;
    char verb[8];
    if (!take_word(&rest, verb, sizeof(verb))) {
        console_print("[ai] agent returned an empty action\n");
        return;
    }

    if (word_is(verb, strlen(verb), "say")) {
        const char *text = skip_spaces(rest);
        console_print("[ai] ");
        console_print(*text ? text : "(empty reply)");
        console_print("\n");
        return;
    }

    if (word_is(verb, strlen(verb), "set")) {
        char key[AGENTCONF_KEY_MAX];
        if (!take_word(&rest, key, sizeof(key))) {
            console_print("[ai] agent sent SET without a key\n");
            return;
        }
        const char *value = skip_spaces(rest);
        if (*value == '\0') {
            console_print("[ai] agent sent SET without a value\n");
            return;
        }
        int rc = agentconf_set(key, value);
        if (rc == AGENTCONF_OK) {
            console_print("[ai] set ");
            console_print(key);
            console_print(" = ");
            console_print(value);
            console_print("\n");
            return;
        }
        if (rc == AGENTCONF_ENODISK) {
            console_print("[ai] no /disk mounted: ");
            console_print(key);
            console_print(" was not persisted\n");
            return;
        }
        if (rc == AGENTCONF_EINVAL) {
            console_print("[ai] invalid value for ");
            console_print(key);
            console_print("\n");
            return;
        }
        console_print("[ai] writing /disk/etc/agent.conf failed\n");
        return;
    }

    if (word_is(verb, strlen(verb), "get")) {
        char key[AGENTCONF_KEY_MAX];
        if (!take_word(&rest, key, sizeof(key))) {
            console_print("[ai] agent sent GET without a key\n");
            return;
        }
        char value[AGENTCONF_VAL_MAX];
        int rc = agentconf_get(key, value, sizeof(value));
        if (rc >= 0) {
            console_print("[ai] ");
            console_print(key);
            console_print(" = ");
            console_print(value);
            console_print("\n");
            return;
        }
        console_print("[ai] ");
        console_print(key);
        if (rc == AGENTCONF_ENOENT)
            console_print(" is not set\n");
        else if (rc == AGENTCONF_ENODISK)
            console_print(" unavailable: no /disk mounted\n");
        else
            console_print(" could not be read\n");
        return;
    }

    console_print("[ai] agent said: ");
    console_print(action);
    console_print("\n");
}

/* `ai <natural language>` — configure or talk to the OS in prose. The agent
 * answers with one action line, which ai_apply_action executes. */
static void cmd_ai(int argc, char *argv[]) {
    if (argc < 2) {
        console_print("ai: usage ai <natural language>, e.g. ai use model claude-opus\n");
        return;
    }
    size_t qlen = join_args(argc, argv, ai_question, sizeof(ai_question));
    if (qlen == 0) {
        console_print("ai: empty request\n");
        return;
    }
    console_print("[ai] asking agent over COM2 (max ");
    console_print_dec(AGENTASK_DEFAULT_TIMEOUT_MS / 1000);
    console_print("s) ...\n");
    if (ai_ask(AGENT_INTENT_NL, ai_question, qlen))
        ai_apply_action(ai_reply);
}

/* `agentask <question>` — ask the agent for a verdict on a proposed action. */
static void cmd_agentask(int argc, char *argv[]) {
    if (argc < 2) {
        console_print("agentask: usage agentask <question>, e.g. agentask may I proceed?\n");
        return;
    }
    size_t qlen = join_args(argc, argv, ai_question, sizeof(ai_question));
    if (qlen == 0) {
        console_print("agentask: empty question\n");
        return;
    }
    console_print("agentask: asking agent over COM2 (max ");
    console_print_dec(AGENTASK_DEFAULT_TIMEOUT_MS / 1000);
    console_print("s) ...\n");
    if (!ai_ask(AGENT_INTENT_GENERIC, ai_question, qlen))
        return;
    console_print("decision: ");
    console_print(ai_reply);
    console_print("\n");
}

static int parse_line(char *line, char *argv[SHELL_ARGV_MAX]) {
    int argc = 0;
    char *p = line;
    while (*p) {
        while (*p && is_space(*p))
            p++;
        if (!*p)
            break;
        if (argc >= SHELL_ARGV_MAX)
            break;
        argv[argc++] = p;
        while (*p && !is_space(*p))
            p++;
        if (*p) {
            *p = '\0';
            p++;
        }
    }
    return argc;
}

static void execute_line(char *line) {
    char *argv[SHELL_ARGV_MAX];
    int argc = parse_line(line, argv);
    if (argc == 0)
        return;

    if (strcmp(argv[0], "help") == 0) {
        cmd_help();
        return;
    }
    if (strcmp(argv[0], "ps") == 0) {
        cmd_ps();
        return;
    }
    if (strcmp(argv[0], "mem") == 0) {
        cmd_mem();
        return;
    }
    if (strcmp(argv[0], "ls") == 0) {
        cmd_ls(argc > 1 ? argv[1] : "/");
        return;
    }
    if (strcmp(argv[0], "cat") == 0) {
        if (argc < 2) {
            console_print("cat: missing path\n");
            return;
        }
        cmd_cat(argv[1]);
        return;
    }
    if (strcmp(argv[0], "write") == 0) {
        if (argc < 3) {
            console_print("write: usage write <path> <text>\n");
            return;
        }
        cmd_write_like(argv[1], argv[2], 0);
        return;
    }
    if (strcmp(argv[0], "append") == 0) {
        if (argc < 3) {
            console_print("append: usage append <path> <text>\n");
            return;
        }
        cmd_write_like(argv[1], argv[2], 1);
        return;
    }
    if (strcmp(argv[0], "run") == 0) {
        cmd_run(argc > 1 ? argv[1] : 0);
        return;
    }
    if (strcmp(argv[0], "netstat") == 0) {
        cmd_netstat();
        return;
    }
    if (strcmp(argv[0], "netsend") == 0) {
        cmd_netsend(argc > 1 ? argv[1] : 0);
        return;
    }
    if (strcmp(argv[0], "netrecv") == 0) {
        cmd_netrecv();
        return;
    }
    if (strcmp(argv[0], "syscalltest") == 0) {
        cmd_syscalltest();
        return;
    }
    if (strcmp(argv[0], "ai") == 0) {
        cmd_ai(argc, argv);
        return;
    }
    if (strcmp(argv[0], "agentask") == 0) {
        cmd_agentask(argc, argv);
        return;
    }

    console_print("unknown command: ");
    console_print(argv[0]);
    console_print("\n");
}

static void handle_char(char c) {
    if (c == '\r' || c == '\n') {
        console_print("\n");
        line_buf[line_len] = '\0';
        execute_line(line_buf);
        line_len = 0;
        prompt_shown = 0;
        return;
    }

    if (c == 8 || c == 127) {
        if (line_len > 0) {
            line_len--;
            console_print("\b \b");
        }
        return;
    }

    if (!is_printable(c))
        return;
    if (line_len + 1 >= SHELL_LINE_MAX)
        return;

    line_buf[line_len++] = c;
    console_putchar(c);
}

void shell_task(void) {
    console_print("[SHELL] Interactive shell started. type 'help'.\n");
    line_len = 0;
    prompt_shown = 0;

    for (;;) {
        shell_prompt();
        char c;
        if (console_getchar_nonblock(&c))
            handle_char(c);
        yield();
    }
}

package com.khyos.khy_os_client.plugin

import org.junit.Test

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail

/**
 * Tests for the minimal binding table's security rules (DESIGN-ARCH-195, T3).
 *
 * These are the tests that make option C's argument real. The whole reason C beat
 * option B is that a plugin's reach is a small auditable table rather than
 * arbitrary bytecode in the app's uid. A table nobody tests is a table nobody can
 * claim is closed — so every rule that bounds a plugin is pinned here.
 *
 * The three that matter most, and why:
 *
 *  1. LOOPBACK IS DENIED EVEN WHEN DECLARED. khy-os's own bridge listens on
 *     127.0.0.1. A plugin that could fetch `https://127.0.0.1` could drive the
 *     bridge directly and reach ui_tap / ui_swipe / the restricted shell — none of
 *     which are in the capability table at all. That would make the table
 *     decorative. This is the single most important test in the file.
 *  2. EXACT HOST MATCH, NOT SUFFIX. `example.com` must not grant
 *     `evil.example.com`. Subdomains are routinely attacker-controlled.
 *  3. A PLUGIN CANNOT FORGE ANOTHER'S STORAGE NAMESPACE, by crafting either its
 *     own id or the key it passes.
 */
class PluginSecurityTest {

    // ── helpers ──────────────────────────────────────────────────────────────

    private fun manifest(
        id: String = "com.example.plugin",
        permissions: String = """["log","store"]""",
        domains: String? = null,
        entry: String = "main.js",
        version: String = "1.0.0",
    ): String = """
        {
          "id": "$id",
          "name": "Test Plugin",
          "version": "$version",
          "description": "fixture",
          "entry": "$entry",
          "permissions": $permissions
          ${if (domains == null) "" else ""","network": {"domains": $domains}"""}
        }
    """.trimIndent()

    /**
     * Serialise domains as a real JSON array.
     *
     * `list.toString()` yields `[https://a.example.com]` — no quotes — which is not
     * JSON. Every net test would then fail at manifest-parse time with a confusing
     * "not valid JSON" message that points at the fixture rather than the bug.
     */
    private fun jsonArray(items: List<String>): String =
        org.json.JSONArray(items).toString()

    private fun parseOk(json: String): PluginManifest {
        try {
            return PluginManifest.parse(json)
        } catch (e: PluginManifestException) {
            fail("预期解析成功，但被拒绝: ${e.message}")
            throw e
        }
    }

    private fun parseRejected(json: String): String = try {
        PluginManifest.parse(json)
        fail("预期被拒绝，但解析成功了")
        ""
    } catch (e: PluginManifestException) {
        e.message ?: ""
    }

    private fun netManifest(vararg domains: String): PluginManifest =
        parseOk(manifest(permissions = """["net"]""", domains = jsonArray(domains.toList())))

    private fun decide(m: PluginManifest, url: String): PluginNetPolicy.NetDecision =
        PluginNetPolicy.isAllowed(m, url)

    private fun assertDenied(url: String, vararg domains: String) {
        val d = decide(netManifest(*domains), url)
        assertTrue("预期拒绝 $url，实际 $d", d is PluginNetPolicy.NetDecision.Denied)
    }

    private fun assertAllowed(url: String, vararg domains: String) {
        val d = decide(netManifest(*domains), url)
        assertEquals("预期允许 $url", PluginNetPolicy.NetDecision.Allowed, d)
    }

    // ── manifest validation ──────────────────────────────────────────────────

    @Test
    fun minimalManifestParses() {
        val m = parseOk(manifest())
        assertEquals("com.example.plugin", m.id)
        assertEquals(setOf(PluginCapability.LOG, PluginCapability.STORE), m.permissions)
        assertFalse(m.grants(PluginCapability.NET))
    }

    @Test
    fun missingIdIsRejected() {
        assertTrue(parseRejected(manifest(id = "")).contains("id"))
    }

    @Test
    fun idWithoutDotIsRejected() {
        // A single segment is not a namespace. The store relies on the id being
        // unambiguous, and a dotless id reads like a typo for a real one.
        assertTrue(parseRejected(manifest(id = "example")).contains("id"))
    }

    @Test
    fun idContainingSeparatorIsRejected() {
        // THE FORGERY. If the id may contain `::`, plugin `com.a::b` storing key
        // `c` produces the same storage key as plugin `com.a` storing key `b::c`.
        val msg = parseRejected(manifest(id = "com.a::b"))
        assertTrue(msg.contains("id"))
    }

    @Test
    fun idWithUppercaseIsRejected() {
        assertTrue(parseRejected(manifest(id = "Com.Example")).contains("id"))
    }

    @Test
    fun badVersionIsRejected() {
        assertTrue(parseRejected(manifest(version = "1.0")).contains("version"))
    }

    @Test
    fun unknownCapabilityIsRejectedNotIgnored() {
        // Silently dropping an unknown capability installs a plugin with less than
        // its author intended, and nothing downstream can detect that.
        val msg = parseRejected(manifest(permissions = """["log","teleport"]"""))
        assertTrue(msg.contains("teleport"))
        assertTrue(msg.contains("未知"))
    }

    @Test
    fun netWithoutDomainsIsRejected() {
        val msg = parseRejected(manifest(permissions = """["net"]"""))
        assertTrue(msg.contains("domains"))
    }

    @Test
    fun domainsWithoutNetIsRejected() {
        // The manifest and the runtime disagree about what the plugin can do.
        val msg = parseRejected(manifest(permissions = """["log"]""", domains = """["https://a.example.com"]"""))
        assertTrue(msg.contains("net"))
    }

    @Test
    fun domainWithPathIsRejected() {
        val msg = parseRejected(
            manifest(permissions = """["net"]""", domains = """["https://a.example.com/v1"]""")
        )
        assertTrue(msg.contains("network.domains"))
    }

    @Test
    fun domainWithPortIsRejected() {
        assertTrue(
            parseRejected(
                manifest(permissions = """["net"]""", domains = """["https://a.example.com:8443"]""")
            ).contains("network.domains")
        )
    }

    @Test
    fun cleartextDomainDeclarationIsRejected() {
        assertTrue(
            parseRejected(
                manifest(permissions = """["net"]""", domains = """["http://a.example.com"]""")
            ).contains("network.domains")
        )
    }

    @Test
    fun entryWithTraversalIsRejected() {
        assertTrue(parseRejected(manifest(entry = "../../etc/passwd")).contains("entry"))
    }

    @Test
    fun absoluteEntryIsRejected() {
        assertTrue(parseRejected(manifest(entry = "/data/local/tmp/x.js")).contains("entry"))
    }

    @Test
    fun manifestDeclaringLoopbackIsRejectedAtInstallTime() {
        // Even though the policy would deny the request anyway, the declaration
        // itself is refused — a plugin that asks for loopback is asking for the
        // bridge, and that should never install.
        val msg = parseRejected(
            manifest(permissions = """["net"]""", domains = """["https://127.0.0.1"]""")
        )
        assertTrue(msg.contains("network.domains"))
    }

    // ── the network allowlist ────────────────────────────────────────────────

    @Test
    fun declaredHostIsAllowed() {
        assertAllowed("https://api.example.com/v1/users", "https://api.example.com")
    }

    @Test
    fun bareHostDeclarationIsAccepted() {
        // StepX's shape carries the scheme, but a bare host must work too.
        assertAllowed("https://api.example.com/x", "api.example.com")
    }

    @Test
    fun undeclaredHostIsDenied() {
        assertDenied("https://evil.com/", "https://api.example.com")
    }

    @Test
    fun subdomainOfDeclaredHostIsDenied() {
        // THE SUFFIX RULE. Granting example.com must not grant evil.example.com:
        // subdomains are frequently attacker-controlled, so a suffix match turns
        // every one of them into a bypass.
        assertDenied("https://evil.example.com/", "https://example.com")
    }

    @Test
    fun declaredSubdomainDoesNotGrantSibling() {
        assertDenied("https://other.example.com/", "https://api.example.com")
    }

    @Test
    fun caseDifferenceInHostStillMatches() {
        // Hosts are case-insensitive by RFC 3986; denying on case would be a
        // confusing failure, not a security gain.
        assertAllowed("https://API.Example.COM/x", "https://api.example.com")
    }

    @Test
    fun userinfoTrickIsDenied() {
        // `https://allowed.example.com@evil.com/` — the host is evil.com. A matcher
        // that looks for the allowed name anywhere in the string would pass this.
        assertDenied("https://api.example.com@evil.com/", "https://api.example.com")
    }

    @Test
    fun cleartextIsDenied() {
        assertDenied("http://api.example.com/", "https://api.example.com")
    }

    @Test
    fun nonDefaultPortIsDenied() {
        assertDenied("https://api.example.com:8443/", "https://api.example.com")
    }

    @Test
    fun defaultPortIsAllowed() {
        assertAllowed("https://api.example.com:443/x", "https://api.example.com")
    }

    @Test
    fun missingCapabilityIsDenied() {
        val m = parseOk(manifest(permissions = """["log"]"""))
        val d = decide(m, "https://api.example.com/")
        assertTrue(d is PluginNetPolicy.NetDecision.Denied)
    }

    // ── the loopback / private-range bypass ──────────────────────────────────

    /**
     * Build a manifest that declares [domains] WITHOUT going through validation.
     *
     * Needed because [PluginManifest.parse] already refuses to declare loopback —
     * which is the behaviour `manifestDeclaringLoopbackIsRejectedAtInstallTime`
     * pins. These tests are the SECOND layer: they prove the policy itself still
     * denies loopback even if a manifest carrying it somehow reaches it. Both layers
     * are wanted; the install-time one is the user-visible gate, this one is the
     * backstop that keeps the table honest if the first layer is ever loosened.
     */
    private fun unvalidatedNetManifest(vararg domains: String): PluginManifest =
        PluginManifest(
            id = "com.example.plugin",
            name = "Test",
            version = "1.0.0",
            description = "",
            entry = "main.js",
            permissions = setOf(PluginCapability.NET),
            networkDomains = domains.toSet(),
        )

    @Test
    fun loopbackIpv4IsDenied() {
        // 8896 is the port khy-os's own phone bridge listens on. A plugin that could
        // reach it could invoke every bridge tool — none of which are in the
        // capability table.
        val m = unvalidatedNetManifest("https://127.0.0.1")
        assertTrue(decide(m, "https://127.0.0.1:8896/") is PluginNetPolicy.NetDecision.Denied)
    }

    @Test
    fun loopbackIpv6IsDenied() {
        val m = unvalidatedNetManifest("https://[::1]")
        assertTrue(decide(m, "https://[::1]/") is PluginNetPolicy.NetDecision.Denied)
    }

    @Test
    fun privateRangesAreDeniedEvenWhenDeclared() {
        // Same backstop, for the private ranges. Declaring them is also refused at
        // install time; this proves the policy does not depend on that.
        for (host in listOf("10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1")) {
            val m = unvalidatedNetManifest("https://$host")
            assertTrue("预期拒绝 $host", decide(m, "https://$host/") is PluginNetPolicy.NetDecision.Denied)
        }
    }

    @Test
    fun cgnatAndReservedRangesAreDeniedEvenWhenDeclared() {
        // 100.64/10 is CGNAT — not site-local, so it needs its own rule.
        for (host in listOf("100.64.0.1", "100.127.255.255", "0.0.0.0", "192.0.2.1", "203.0.113.1")) {
            val m = unvalidatedNetManifest("https://$host")
            assertTrue("预期拒绝 $host", decide(m, "https://$host/") is PluginNetPolicy.NetDecision.Denied)
        }
    }

    @Test
    fun multicastIsDeniedEvenWhenDeclared() {
        val m = unvalidatedNetManifest("https://224.0.0.1")
        assertTrue(decide(m, "https://224.0.0.1/") is PluginNetPolicy.NetDecision.Denied)
    }

    @Test
    fun publicIpIsAllowedEvenWhenBuiltWithoutValidation() {
        val m = unvalidatedNetManifest("https://93.184.216.34")
        assertEquals(
            PluginNetPolicy.NetDecision.Allowed,
            decide(m, "https://93.184.216.34/")
        )
    }

    @Test
    fun hostnameIsNotClassifiedAsAnAddress() {
        // HONESTY TEST. This is a known gap, pinned so it cannot be forgotten: a
        // hostname cannot be classified without DNS, and this policy does no DNS.
        // `localhost` here is treated as a name, not as 127.0.0.1 — the HTTP client
        // must additionally check the RESOLVED address at connect time. If someone
        // later "fixes" this by resolving, this test tells them the pure function
        // deliberately does not.
        assertNull(PluginNetPolicy.classifyAddress("localhost"))
        assertNull(PluginNetPolicy.classifyAddress("api.example.com"))
    }

    @Test
    fun literalIpv6IsClassified() {
        assertEquals(
            PluginNetPolicy.AddressKind.LOOPBACK,
            PluginNetPolicy.classifyAddress("[::1]")
        )
        assertEquals(
            PluginNetPolicy.AddressKind.LOOPBACK,
            PluginNetPolicy.classifyAddress("::1")
        )
    }

    @Test
    fun denialCarriesAReason() {
        // A denial with no reason is the failure mode that makes an allowlist
        // impossible to debug.
        val d = decide(netManifest("https://api.example.com"), "https://evil.com/")
        assertTrue(d is PluginNetPolicy.NetDecision.Denied)
        assertTrue((d as PluginNetPolicy.NetDecision.Denied).reason.isNotBlank())
    }

    @Test
    fun policyIsReentrantPerRedirectHop() {
        // The redirect bypass is closed by calling this again on each hop. The
        // function holds no state, so calling it repeatedly must be stable.
        val m = netManifest("https://api.example.com")
        val first = decide(m, "https://api.example.com/redirect")
        val second = decide(m, "https://evil.com/")
        assertEquals(PluginNetPolicy.NetDecision.Allowed, first)
        assertTrue(second is PluginNetPolicy.NetDecision.Denied)
    }

    // ── store scoping ────────────────────────────────────────────────────────

    @Test
    fun scopedKeyNamespacesByPlugin() {
        assertEquals("com.a::token", PluginStoreScope.scopedKey("com.a", "token"))
    }

    @Test
    fun twoPluginsGetDifferentKeysForTheSameCallerKey() {
        val a = PluginStoreScope.scopedKey("com.a", "state")
        val b = PluginStoreScope.scopedKey("com.b", "state")
        assertFalse(a == b)
    }

    @Test
    fun keyContainingSeparatorIsRejected() {
        // THE FORGERY, from the other side: plugin com.a asking for key `b::c`
        // would otherwise land on com.a::b::c, which is exactly where com.a::b's
        // own key `c` lives.
        try {
            PluginStoreScope.scopedKey("com.a", "b::c")
            fail("预期拒绝含 :: 的键")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("非法存储键"))
        }
    }

    @Test
    fun keyWithPathTraversalIsRejected() {
        for (bad in listOf("../x", "a/b", "a\\b", "", " ", "a b", "键")) {
            try {
                PluginStoreScope.scopedKey("com.a", bad)
                fail("预期拒绝键「$bad」")
            } catch (e: IllegalArgumentException) {
                // expected
            }
        }
    }

    @Test
    fun safeKeysAreAccepted() {
        for (good in listOf("a", "A1", "a.b", "a-b", "a_b", "x".repeat(PluginStoreScope.MAX_KEY_CHARS))) {
            assertTrue(PluginStoreScope.isSafeKey(good))
        }
    }

    @Test
    fun overlongKeyIsRejected() {
        assertFalse(PluginStoreScope.isSafeKey("x".repeat(PluginStoreScope.MAX_KEY_CHARS + 1)))
    }

    @Test
    fun unsafePluginIdIsRejected() {
        for (bad in listOf("", "nodots", "Com.A", "com.a::b", "com.a/b", "com.a\\b", "com..a")) {
            try {
                PluginStoreScope.scopedKey(bad, "k")
                fail("预期拒绝插件 id「$bad」")
            } catch (e: IllegalArgumentException) {
                // expected
            }
        }
    }

    @Test
    fun storeScopeIdRuleAgreesWithManifestIdRule() {
        // Two copies of the same rule must not drift. If the manifest accepts an id
        // the store refuses, a plugin installs and then cannot store anything.
        for (id in listOf("com.example.plugin", "com.a_b.c", "com.a.b.c.d")) {
            assertTrue(PluginManifest.ID_RE.matches(id))
            assertTrue(PluginStoreScope.isSafePluginId(id))
        }
        for (id in listOf("nodots", "Com.A", "com.a::b", "com..a", "")) {
            assertFalse(PluginManifest.ID_RE.matches(id))
            assertFalse(PluginStoreScope.isSafePluginId(id))
        }
    }

    @Test
    fun valueLimitIsEnforcedAtTheBoundary() {
        assertTrue(PluginStoreScope.isValueWithinLimit(0))
        assertTrue(PluginStoreScope.isValueWithinLimit(PluginStoreScope.MAX_VALUE_CHARS))
        assertFalse(PluginStoreScope.isValueWithinLimit(PluginStoreScope.MAX_VALUE_CHARS + 1))
    }

    @Test
    fun totalLimitIsEnforcedAtTheBoundary() {
        assertTrue(PluginStoreScope.isTotalWithinLimit(PluginStoreScope.MAX_PLUGIN_TOTAL_CHARS))
        assertFalse(PluginStoreScope.isTotalWithinLimit(PluginStoreScope.MAX_PLUGIN_TOTAL_CHARS + 1))
    }

    // ── the capability table itself ──────────────────────────────────────────

    @Test
    fun everyCapabilityHasAWireNameAndAReachDescription() {
        // The reach string is what a consent screen will show. A capability without
        // one cannot be explained to the user, which means it cannot be consented to.
        for (cap in PluginCapability.values()) {
            assertTrue("${cap.name} 缺 wireName", cap.wireName.isNotBlank())
            assertTrue("${cap.name} 缺 reach 描述", cap.reach.isNotBlank())
            assertTrue("${cap.name} 没绑定任何 JS 名字", cap.bindings.isNotEmpty())
            assertEquals("${cap.name} 的 wireName 必须唯一", 1,
                PluginCapability.values().count { it.wireName == cap.wireName })
        }
    }

    @Test
    fun noCapabilityExposesACredentialOrTheBridge() {
        // PIN THE ABSENCE. This is the invariant that justifies option C over
        // option B. If someone adds a capability whose name or reach suggests it can
        // read the bridge token, an API key, or drive the device, this test fails
        // and forces the addition to be argued for explicitly.
        val forbidden = listOf("token", "secret", "key", "apikey", "password", "credential",
            "bridge", "shell", "tap", "swipe", "file", "clipboard")
        for (cap in PluginCapability.values()) {
            val hay = (cap.wireName + " " + cap.reach + " " + cap.bindings.joinToString(" ")).lowercase()
            for (word in forbidden) {
                assertTrue(
                    "capability ${cap.wireName} 提到了「$word」——它是否在暴露凭据或桥能力？" +
                        "若是刻意新增，请连同理由一起改这条测试",
                    !hay.contains(word)
                )
            }
        }
    }

    // ── the Kotlin↔C ordinal coupling ────────────────────────────────────────

    @Test
    fun pluginCapabilityOrdinalsMatchTheNativeEnum() {
        // THE COUPLING NOBODY SEES. KhyJs.load sends capability ORDINALS to the JNI
        // layer, which matches them against a hand-written C enum in
        // khy_js_jni.cpp. Two lists, two languages, coupled by position. If someone
        // inserts a capability in the middle of PluginCapability, every plugin's
        // bindings silently shift by one — a plugin granted `store` would get
        // `device`, and nothing would report an error.
        //
        // Parsing the C enum out of the source is the only check that catches it.
        // A comment would not.
        val cpp = readCpp("src/main/cpp/khy_js_jni.cpp")
        val m = Regex("enum PluginCapabilityKind \\{([^}]*)\\};").find(cpp)
        assertTrue("khy_js_jni.cpp 里找不到 PluginCapabilityKind 枚举", m != null)
        val cNames = m!!.groupValues[1].split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        assertEquals(
            "C 枚举与 PluginCapability 条目数不一致——序数会整体错位",
            PluginCapability.values().size, cNames.size
        )

        PluginCapability.values().forEachIndexed { index, cap ->
            // CAP_LOG → LOG, CAP_DEVICE_INFO → DEVICE_INFO
            val expected = "CAP_" + cap.name
            assertEquals("第 $index 位: C 枚举是 ${cNames[index]}，Kotlin 是 $expected",
                expected, cNames[index])
        }
    }

    @Test
    fun everyCapabilityHasANativeWrapper() {
        // The inverse check: a capability the Kotlin table grants must have a JS
        // wrapper in the C file. NET used to be the one deliberate exception — it
        // needed an async result path — and this test is what stopped "deliberately
        // absent" from quietly becoming "forgotten" for a second capability. NET is
        // now wired (synchronously, a stated tradeoff), so the exception list is
        // empty and any future absence has to be argued for here.
        val cpp = readCpp("src/main/cpp/khy_js_jni.cpp")
        val wrapperBlock = cpp.substring(cpp.indexOf("const WrapperSpec kWrappers[]"))
        for (cap in PluginCapability.values()) {
            assertTrue(
                "capability ${cap.wireName} 在 khy_js_jni.cpp 里没有 JS 包装器",
                wrapperBlock.contains("{CAP_${cap.name},")
            )
        }
    }

    private fun readCpp(relative: String): String {
        val cwd = System.getProperty("user.dir", ".")
        var dir: java.io.File? = java.io.File(cwd).absoluteFile
        var hops = 0
        while (dir != null && hops < 8) {
            val candidate = java.io.File(dir, relative)
            if (candidate.isFile) return String(candidate.readBytes(), Charsets.UTF_8)
            dir = dir.parentFile
            hops++
        }
        // Extracted rather than inlined: a Kotlin string template cannot contain an
        // unescaped double quote inside ${...}, which is a syntax error here.
        throw AssertionError("找不到 $relative（从 user.dir=$cwd 向上回溯）")
    }
}

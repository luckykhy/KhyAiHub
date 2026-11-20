'use strict';
const db = require('../src/tools/databaseQuery');
const assert = require('node:assert');
const http = require('../src/tools/httpRequest');
const gitLog = require('../src/tools/gitLog');
// 这些用例只覆盖「确定性」路�?不依赖真实网�?数据�?已装驱动),
// 故在任意环境下结果稳定。真实连接路径在集成环境验证�?

describe('New Tools', () => {
  test('databaseQuery:未配置方言 �?CONFIG_MISSING', async () => {
      const prevD = process.env.KHY_DB_DIALECT; const prevU = process.env.KHY_DB_URL;
      delete process.env.KHY_DB_DIALECT; delete process.env.KHY_DB_URL;
      try {
        const r = await db.execute({ query: 'SELECT 1' }, {});
        expect(r.success).toBe(false);
        expect(r.code).toBe('CONFIG_MISSING');
        expect(r.errorClass).toBe('CONFIG_MISSING');
      } finally {
        if (prevD !== undefined) process.env.KHY_DB_DIALECT = prevD;
        if (prevU !== undefined) process.env.KHY_DB_URL = prevU;
      }
  });

  test('databaseQuery:有方言无连�?�?CONFIG_MISSING', async () => {
      const r = await db.execute({ query: 'SELECT 1', dialect: 'postgres' }, {});
      expect(r.success).toBe(false);
      expect(r.code).toBe('CONFIG_MISSING');
  });

  test('databaseQuery:只读模式拒绝写语�?�?BAD_PARAM', async () => {
      const r = await db.execute(
        { query: 'DELETE FROM users', dialect: 'sqlite', connection: ':memory:' },
        {},
      );
      expect(r.success).toBe(false);
      expect(r.code).toBe('BAD_PARAM');
      expect(r.errorClass).toBe('BAD_PARAM');
  });

  test('databaseQuery:只读放行 SELECT/WITH/PRAGMA(前缀识别·容注释)', async () => {
      // 这里只验证「不被只读护栏拦下」——即不会以 readonly 返回 BAD_PARAM。
      // 真正能否执行取决于驱动是否安装, 故只断言 code !== BAD_PARAM。
      // invalid host 连不上会走 SERVICE_UNAVAILABLE;把连接超时压到 500ms
      // (flagRegistry clamp 下限), 否则 4 条查询 × 默认 10s 会撞 jest 5s 超时。
      const prevConn = process.env.KHY_DB_CONNECT_TIMEOUT_MS;
      process.env.KHY_DB_CONNECT_TIMEOUT_MS = '500';
      try {
        for (const q of ['SELECT 1', '  with t as (select 1) select * from t', '-- c\nSELECT 1', 'PRAGMA table_info(x)']) {
          const r = await db.execute({ query: q, dialect: 'postgres', connection: 'postgres://invalid:5432/x' }, {});
          assert.notEqual(r.code, 'BAD_PARAM', `只读查询不应被拦:${q}`);
        }
      } finally {
        if (prevConn === undefined) delete process.env.KHY_DB_CONNECT_TIMEOUT_MS;
        else process.env.KHY_DB_CONNECT_TIMEOUT_MS = prevConn;
      }
  });

  test('databaseQuery:postgres 驱动缺失 �?MISSING_DEPENDENCY(若未�?pg)', async () => {
      let hasPg = true;
      try { require('pg'); } catch { hasPg = false; }
      const r = await db.execute({ query: 'SELECT 1', dialect: 'postgres', connection: 'postgres://x' }, {});
      if (!hasPg) {
        expect(r.code).toBe('MISSING_DEPENDENCY');
        expect(r.errorClass).toBe('MISSING_DEPENDENCY');
        expect(r.meta && r.meta.install).toBeTruthy();
      } else {
        // 装了 pg:连不�?invalid host �?SERVICE_UNAVAILABLE(不会�?MISSING_DEPENDENCY)
        assert.notEqual(r.code, 'MISSING_DEPENDENCY');
      }
  });

  test('httpRequest:非法 URL �?BAD_PARAM', async () => {
      const r = await http.execute({ url: 'ht!tp://nope', method: 'GET' }, {});
      expect(r.success).toBe(false);
      expect(r.code).toBe('BAD_PARAM');
      expect(r.errorClass).toBe('BAD_PARAM');
  });

  test('httpRequest:不支持的方法 �?BAD_PARAM', async () => {
      const r = await http.execute({ url: 'https://example.com', method: 'TRACE' }, {});
      expect(r.success).toBe(false);
      expect(r.code).toBe('BAD_PARAM');
  });

  test('httpRequest:�?http(s) 协议 �?BAD_PARAM', async () => {
      const r = await http.execute({ url: 'file:///etc/passwd', method: 'GET' }, {});
      expect(r.success).toBe(false);
      expect(r.code).toBe('BAD_PARAM');
  });

  test('三新工具均为 defineTool 产物(有 name/execute,行为标志已归一为谓词)', async () => {
      for (const t of [db, http, gitLog]) {
        expect(typeof t.name).toBe('string');
        expect(typeof t.execute).toBe('function');
        expect(typeof t.isReadOnly).toBe('function'); // defineTool 把布尔归一成谓词
      }
      expect(gitLog.name).toBe('gitLog');
      expect(db.name).toBe('databaseQuery');
      expect(http.name).toBe('httpRequest');
  });

  // ── httpRequest 的 SSRF 守卫（AGT-02）────────────────────────────────────
  //
  // 本工具此前只校验协议：云元数据地址(169.254.169.254)、回环(127.0.0.1)、
  // RFC1918(10.x / 192.168.x) 全部可打，且**重定向后的新目标不再复查** ——
  // 公网 URL 302 到内网就被跟踪。现在每一跳都过 services/urlSafety 的守卫。
  describe('httpRequest SSRF 守卫', () => {
    const INTERNAL_TARGETS = [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:9229/json',
      'http://10.0.0.5/',
      'http://192.168.1.1/admin',
    ];

    test('内网/回环/元数据目标在输入校验阶段即被拒', async () => {
      for (const url of INTERNAL_TARGETS) {
        const v = await http.validateInput({ url });
        expect(v.valid).toBe(false);
        expect(v.message).toMatch(/private or local/);
      }
    });

    test('execute 对内网目标一律拒发(BAD_PARAM)', async () => {
      for (const url of INTERNAL_TARGETS) {
        const r = await http.execute({ url, method: 'GET' }, {});
        expect(r.success).toBe(false);
        expect(r.code).toBe('BAD_PARAM');
        expect(r.error).toMatch(/SSRF|守卫|拒绝/);
      }
    });

    test('重定向跳向内网时:第二跳被拒,且内网那一跳根本没发出去', async () => {
      const httpMod = require('http');
      const { EventEmitter } = require('events');
      const spy = jest.spyOn(httpMod, 'request').mockImplementation((target, options, cb) => {
        const req = new EventEmitter();
        req.write = () => {};
        req.destroy = () => {};
        req.end = () => {
          const res = new EventEmitter();
          res.statusCode = 302;
          res.statusMessage = 'Found';
          res.headers = { location: 'http://169.254.169.254/latest/meta-data/' };
          cb(res);
          setImmediate(() => res.emit('end'));
        };
        return req;
      });
      try {
        // 首跳用公网 IP 字面量:IP 字面量不触发 DNS 解析,整条用例离线可跑
        const r = await http.execute({ url: 'http://93.184.216.34/start', method: 'GET' }, {});
        expect(r.success).toBe(false);
        expect(r.code).toBe('BAD_PARAM');
        expect(r.error).toMatch(/SSRF|守卫|拒绝/);
        expect(spy).toHaveBeenCalledTimes(1); // 只有首跳:内网那一跳从未发出
      } finally {
        spy.mockRestore();
      }
    });
  });

});


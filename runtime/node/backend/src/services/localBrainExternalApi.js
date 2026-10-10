'use strict';

// localBrainExternalApi — 外部实时数据 API 技能（纯叶子）
// =============================================================================
// 从 localBrainService.js 抽出的一块内聚分节，用于「解开上帝文件纠缠」：把
// 8 个「查实时数据、模型做不到更好」的确定性技能（天气/汇率/加密货币/词典/
// 名言/公网 IP/冷知识/节假日）连同它们的 HTTP 取数辅助函数搬进本叶子，原文件
// 以**同名别名 re-export 保契约字节不变**（范式同 localBrainCalc/localBrainTextOps）。
//
// 契约（对 localBrainService 而言）：
//   - API_HANDLERS   : [{ type, match, detect, cooperative }]  合并进 _DETERMINISTIC_HANDLERS
//   - API_EXECUTORS  : { [type]: async (plan) => result }       合并进 _EXECUTORS
//   - API_FORMATTERS : { [type]: (result) => string }           合并进 _FORMATTERS
//   - _detectCrypto / _detectHoliday : 供 localBrainService 末尾 module.exports 原样再导出
//
// 纯叶子约束：仅依赖 node 内置 http/https，零业务耦合、零 localBrainService 反向依赖。
// 每个执行器均 fail-soft（网络不可用返回 { success:false, error }），绝不抛穿。
// =============================================================================

const http = require('http');
const https = require('https');

// 出站编码单一真源(纯叶子)。本文件此前既不发 Accept-Encoding 也不解压 —— JSON 接口
// 一旦回 gzip/br 就是解析失败 → 技能误报「无法获取」。
const _httpEncoding = require('./tool/httpEncoding');

/**
 * Generic HTTP(S) JSON fetch with timeout.
 * @param {string} url
 * @param {number} [timeout=6000]
 * @returns {Promise<any>}
 */
function _fetchJson(url, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    // 显式不协商压缩 + 按 content-encoding 兜底解压:这些 JSON 接口若回 gzip/br,
    // 旧代码会把二进制直接交给 JSON.parse → 解析失败 → 技能误报「无法获取」。
    const req = mod.get(url, { timeout, headers: _httpEncoding.withIdentityAcceptEncoding({}) }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        const data = _httpEncoding
          .decodeBody(Buffer.concat(chunks), res.headers && res.headers['content-encoding'])
          .toString('utf8');
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function _fetchText(url, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout, headers: _httpEncoding.withIdentityAcceptEncoding({}) }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () =>
        resolve(
          _httpEncoding
            .decodeBody(Buffer.concat(chunks), res.headers && res.headers['content-encoding'])
            .toString('utf8')
        )
      );
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

// ── 8. 天气查询 ─────────────────────────────────────────────────────

const _WEATHER_RE = /(天气|气温|温度|weather|forecast|气象|下雨|下雪|几度)/i;
const _CITY_EXTRACT_RE =
  /(?:天气|气温|温度|weather|forecast)\s*[:：]?\s*(\S+)|(\S+)\s*(?:的?天气|的?气温|的?温度)/i;
const _CITY_COORDS = {
  北京: [39.9, 116.4],
  beijing: [39.9, 116.4],
  上海: [31.2, 121.5],
  shanghai: [31.2, 121.5],
  广州: [23.1, 113.3],
  guangzhou: [23.1, 113.3],
  深圳: [22.5, 114.1],
  shenzhen: [22.5, 114.1],
  杭州: [30.3, 120.2],
  hangzhou: [30.3, 120.2],
  成都: [30.6, 104.1],
  chengdu: [30.6, 104.1],
  武汉: [30.6, 114.3],
  wuhan: [30.6, 114.3],
  南京: [32.1, 118.8],
  nanjing: [32.1, 118.8],
  重庆: [29.6, 106.5],
  chongqing: [29.6, 106.5],
  西安: [34.3, 108.9],
  xian: [34.3, 108.9],
  天津: [39.1, 117.2],
  tianjin: [39.1, 117.2],
  长沙: [28.2, 112.9],
  changsha: [28.2, 112.9],
  青岛: [36.1, 120.4],
  qingdao: [36.1, 120.4],
  大连: [38.9, 121.6],
  dalian: [38.9, 121.6],
  厦门: [24.5, 118.1],
  xiamen: [24.5, 118.1],
  苏州: [31.3, 120.6],
  suzhou: [31.3, 120.6],
  东京: [35.7, 139.7],
  tokyo: [35.7, 139.7],
  纽约: [40.7, -74.0],
  'new york': [40.7, -74.0],
  伦敦: [51.5, -0.1],
  london: [51.5, -0.1],
  巴黎: [48.9, 2.3],
  paris: [48.9, 2.3],
  首尔: [37.6, 127.0],
  seoul: [37.6, 127.0],
  新加坡: [1.3, 103.8],
  singapore: [1.3, 103.8],
  洛杉矶: [34.1, -118.2],
  'los angeles': [34.1, -118.2],
  旧金山: [37.8, -122.4],
  'san francisco': [37.8, -122.4],
  悉尼: [-33.9, 151.2],
  sydney: [-33.9, 151.2],
};
const _WMO_CODES = {
  0: '晴',
  1: '大部晴',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '细雨',
  53: '中雨',
  55: '大雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '中阵雨',
  82: '暴雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷暴',
  96: '冰雹雷暴',
  99: '强冰雹雷暴',
};

// ── 「信息不足 → 拒绝臆测」契约(单一真源)────────────────────────────────
// 这些实时技能此前在抽不到实体时**静默用默认值顶上**:天气→北京、币价→bitcoin、
// 节假日→CN。等于把猜测当事实答给用户 —— 用户问「今天天气怎么样」会收到北京天气,
// 模型接着复述成「你那边今天…」。契约:缺必填实体时**不猜**,返回一份把
// 「缺什么 / 为什么不能猜 / 两条出路」说清的拒绝,并带机读字段供模型分支。
//
// 同时修掉抽取出垃圾实体的情况:旧 `_CITY_EXTRACT_RE` 的第二分支是贪婪的,
// 「今天天气」会抽出 city="今天"(一个时间词),再拿它去查 wttr.in —— 与猜城市同害。
// 故实体先过 _isPlausibleEntity() 校验。

/** 时间/指代/疑问类词:长得像实体但绝不能当实体用。 */
const _NON_ENTITY_RE =
  /^(今天|今日|明天|明日|昨天|昨日|后天|前天|现在|当前|目前|最近|近期|这周|本周|下周|这月|本月|这个月|周末|早上|上午|中午|下午|晚上|夜里|今晚|实时|今天|today|tomorrow|yesterday|tonight|now|current|latest|recent|this week|this month|this weekend)$/i;

/** 疑问/语气/功能词:抽出来当城市会去查一个不存在的目标。 */
const _NON_ENTITY_INTERROGATIVE_RE =
  /^(怎么样?|怎样|咋样|如何|怎么|多少|几|几度|是什么|什么|哪些|哪个|哪里|好吗|好不好|行吗|吗|呢|吧|啊|呀|的|了|么|how|what|which|where|when)$/i;

/** 指代「我这里」而没给具体地名 —— 正确出路是取位置,不是猜一个城市。 */
const _DEICTIC_RE =
  /(我这里|我这儿|我这|我们这|我们这里|本地|当地|这边|这儿|这里|附近|当前位置|所在城市|\bhere\b|\bnearby\b|\blocal\b|\bmy location\b|\bcurrent location\b)/i;

/** 整个候选实体就是一个指代短语(与 _DEICTIC_RE 的区别:这是锚定匹配)。 */
const _DEICTIC_CANDIDATE_RE =
  /^(我这里|我这儿|我这|我们这|我们这里|本地|当地|这边|这儿|这里|附近|当前位置|所在城市|here|nearby|local|my location|current location)$/i;

/** 清洗候选实体:去首尾标点/语气词。纯函数、绝不抛。 */
function _cleanEntity(candidate) {
  return String(candidate == null ? '' : candidate)
    .replace(/[的了吗呢啊？?！!。，,、:：;；"'“”‘’\s]+$/g, '')
    .trim();
}

/**
 * 一个抽取到的实体是否「像真的实体」:非空、不是时间/疑问/指代词、长度合理、不含句内标点。
 * 纯函数、绝不抛。
 */
function _isPlausibleEntity(candidate) {
  const s = _cleanEntity(candidate);
  if (!s || s.length > 20) {
    return false;
  }
  if (_NON_ENTITY_RE.test(s) || _NON_ENTITY_INTERROGATIVE_RE.test(s) || _DEICTIC_CANDIDATE_RE.test(s)) {
    return false;
  }
  // 含句内标点 → 多半整句被吞进来了,不是实体
  return !/[，,。.；;：:、！!？?]/.test(s);
}

/**
 * 抽取实体 + 判定「够不够」的单一入口。纯函数、绝不抛。
 *
 * @param {string} text
 * @param {RegExp} extractRe 形如 (?:关键词)\s*[:：]?\s*(\S+) | (\S+)\s*(?:关键词)
 * @returns {{value:string, source:'explicit'|'deictic'|'missing'}}
 */
function _resolveEntity(text, extractRe) {
  const raw = String(text == null ? '' : text);
  const m = raw.match(extractRe);
  const candidate = m ? m[1] || m[2] || '' : '';
  const cleaned = _cleanEntity(candidate);
  // 注意:_isPlausibleEntity 已把指代词排除,故「我这里天气」不会把「我这里」当城市。
  if (_isPlausibleEntity(cleaned)) {
    return { value: cleaned, source: 'explicit' };
  }
  return { value: '', source: _DEICTIC_RE.test(raw) ? 'deictic' : 'missing' };
}

/**
 * 构造「需要用户补一个实体」的拒绝。纯函数、绝不抛。
 *
 * @param {string} field   '城市' | '币种' | '国家'
 * @param {'missing'|'deictic'} source
 * @param {string} sample  一个示例值(用于把出路写具体)
 * @param {string} locationTool  可替代的取数工具名
 */
function _needsInput(field, source, sample, locationTool) {
  const why =
    source === 'deictic'
      ? `你指的是当前位置,但位置未知 —— 不能猜测你所在的地方`
      : `未提供${field} —— 不能猜测你所在的地方`;
  return {
    field,
    source,
    why,
    options: [
      `直接说明${field}（例如「${sample}」）`,
      `先调用 ${locationTool} 取得用户所在位置,再据此查询`,
    ],
  };
}

/** 把 needsInput 渲染成面向用户/模型的一句话契约。纯函数、绝不抛。 */
function _formatNeedsInput(subject, needsInput) {
  const n = needsInput || {};
  return (
    `${subject}查询失败:${n.why || `信息不足,不能臆测`}。` +
    `请任选其一：① ${(n.options && n.options[0]) || '补充必要信息'}；` +
    `② ${(n.options && n.options[1]) || '改用可确定信息的工具'}。`
  );
}

function _isWeatherIntent(text) {
  return _WEATHER_RE.test(text) && text.length < 80;
}

function _detectWeather(text) {
  // 旧行为:抽不到城市就 `city = '北京'` —— 把北京天气当用户的答案(臆测)。
  // 新契约:抽不到就**拒绝**,并把两条出路说清(明确城市 / 先调 GetLocation)。
  const r = _resolveEntity(text, _CITY_EXTRACT_RE);
  if (!r.value) {
    return {
      type: 'api_weather',
      category: '天气',
      label: '天气',
      needsInput: _needsInput('城市', r.source, '上海天气', 'GetLocation'),
    };
  }
  const city = r.value;
  const coords = _CITY_COORDS[city.toLowerCase()] || _CITY_COORDS[city];
  if (!coords) {
    // Fallback: try wttr.in which accepts city names
    return { type: 'api_weather', category: '天气', label: city, city, useWttr: true };
  }
  return {
    type: 'api_weather',
    category: '天气',
    label: city,
    city,
    lat: coords[0],
    lon: coords[1],
  };
}

async function _executeWeather(plan) {
  if (plan && plan.needsInput) {
    return {
      type: 'api_weather',
      success: false,
      needsInput: plan.needsInput,
      error: _formatNeedsInput('天气', plan.needsInput),
    };
  }
  // Try Open-Meteo first (structured JSON)
  if (plan.lat && plan.lon) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${plan.lat}&longitude=${plan.lon}&current_weather=true&timezone=auto&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=3`;
      const data = await _fetchJson(url);
      if (data && data.current_weather) {
        const cw = data.current_weather;
        const weather = _WMO_CODES[cw.weathercode] || `代码${cw.weathercode}`;
        const result = {
          type: 'api_weather',
          success: true,
          city: plan.city,
          current: { temp: cw.temperature, weather, wind: cw.windspeed, unit: '°C' },
        };
        if (data.daily) {
          result.forecast = [];
          const d = data.daily;
          for (let i = 0; i < Math.min(3, (d.time || []).length); i++) {
            result.forecast.push({
              date: d.time[i],
              high: d.temperature_2m_max[i],
              low: d.temperature_2m_min[i],
              rain: d.precipitation_sum[i],
            });
          }
        }
        return result;
      }
    } catch {
      /* fallthrough */
    }
  }
  // Fallback: wttr.in
  try {
    const url = `https://wttr.in/${encodeURIComponent(plan.city)}?format=j1`;
    const data = await _fetchJson(url);
    if (data && data.current_condition && data.current_condition[0]) {
      const cc = data.current_condition[0];
      return {
        type: 'api_weather',
        success: true,
        city: plan.city,
        current: {
          temp: cc.temp_C,
          weather: cc.lang_zh?.[0]?.value || cc.weatherDesc?.[0]?.value || '',
          wind: cc.windspeedKmph,
          unit: '°C',
          humidity: cc.humidity,
        },
      };
    }
  } catch {
    /* fallthrough */
  }
  return {
    type: 'api_weather',
    success: false,
    error: `无法获取 ${plan.city} 天气（网络不可用或城市名无法识别）`,
  };
}

function _formatWeather(result) {
  if (!result.success) {
    // 契约类拒绝的 error 已是完整句子(含出路),不要再套一层「天气查询失败:」。
    return result.needsInput ? result.error : `天气查询失败: ${result.error}`;
  }
  const c = result.current;
  const lines = [
    `${result.city} 当前天气: ${c.weather} ${c.temp}${c.unit}，风速 ${c.wind} km/h${c.humidity ? `，湿度 ${c.humidity}%` : ''}`,
  ];
  if (result.forecast) {
    lines.push('未来三天:');
    for (const f of result.forecast) {
      lines.push(`  ${f.date}: ${f.low}~${f.high}°C${f.rain > 0 ? `，降水 ${f.rain}mm` : ''}`);
    }
  }
  return lines.join('\n');
}

// ── 9. 汇率查询 ─────────────────────────────────────────────────────

const _CURRENCY_RE = /(汇率|兑换|换算|exchange rate|convert|currency)/i;
const _CURRENCY_PAIR_RE =
  /(\d+(?:\.\d+)?)\s*(?:个|元|块)?\s*(美元|人民币|欧元|英镑|日元|韩元|港币|加元|澳元|USD|CNY|EUR|GBP|JPY|KRW|HKD|CAD|AUD|RMB|rmb)\s*(?:换|兑|转|=|to|→|->)\s*(美元|人民币|欧元|英镑|日元|韩元|港币|加元|澳元|USD|CNY|EUR|GBP|JPY|KRW|HKD|CAD|AUD|RMB|rmb)/i;
const _CURRENCY_MAP = {
  美元: 'USD',
  usd: 'USD',
  人民币: 'CNY',
  cny: 'CNY',
  rmb: 'CNY',
  欧元: 'EUR',
  eur: 'EUR',
  英镑: 'GBP',
  gbp: 'GBP',
  日元: 'JPY',
  jpy: 'JPY',
  韩元: 'KRW',
  krw: 'KRW',
  港币: 'HKD',
  hkd: 'HKD',
  加元: 'CAD',
  cad: 'CAD',
  澳元: 'AUD',
  aud: 'AUD',
};

function _isCurrencyIntent(text) {
  if (text.length > 100) {
    return false;
  }
  if (_CURRENCY_RE.test(text)) {
    return true;
  }
  // Also match direct conversion patterns like "100美元换人民币"
  return _CURRENCY_PAIR_RE.test(text);
}

function _detectCurrency(text) {
  const m = text.match(_CURRENCY_PAIR_RE);
  if (m) {
    const amount = parseFloat(m[1]) || 1;
    const from = _CURRENCY_MAP[m[2].toLowerCase()] || m[2].toUpperCase();
    const to = _CURRENCY_MAP[m[3].toLowerCase()] || m[3].toUpperCase();
    return { type: 'api_currency', category: '汇率', label: `${from}→${to}`, amount, from, to };
  }
  // Generic "汇率" query: default USD→CNY
  return {
    type: 'api_currency',
    category: '汇率',
    label: 'USD→CNY',
    amount: 1,
    from: 'USD',
    to: 'CNY',
  };
}

async function _executeCurrency(plan) {
  // Try Frankfurter first (ECB data)
  try {
    const url = `https://api.frankfurter.app/latest?from=${plan.from}&to=${plan.to}`;
    const data = await _fetchJson(url);
    if (data && data.rates && data.rates[plan.to] !== undefined) {
      const rate = data.rates[plan.to];
      return {
        type: 'api_currency',
        success: true,
        from: plan.from,
        to: plan.to,
        amount: plan.amount,
        rate,
        converted: (plan.amount * rate).toFixed(4),
        date: data.date,
      };
    }
  } catch {
    /* fallthrough */
  }
  // Fallback: ExchangeRate-API
  try {
    const url = `https://open.er-api.com/v6/latest/${plan.from}`;
    const data = await _fetchJson(url);
    if (data && data.rates && data.rates[plan.to] !== undefined) {
      const rate = data.rates[plan.to];
      return {
        type: 'api_currency',
        success: true,
        from: plan.from,
        to: plan.to,
        amount: plan.amount,
        rate,
        converted: (plan.amount * rate).toFixed(4),
        date: data.time_last_update_utc || '',
      };
    }
  } catch {
    /* fallthrough */
  }
  return { type: 'api_currency', success: false, error: `无法获取 ${plan.from}→${plan.to} 汇率` };
}

function _formatCurrency(result) {
  if (!result.success) {
    return `汇率查询失败: ${result.error}`;
  }
  return `${result.amount} ${result.from} = ${result.converted} ${result.to}\n汇率: 1 ${result.from} = ${result.rate} ${result.to}${result.date ? `\n数据日期: ${result.date}` : ''}`;
}

// ── 10. 加密货币 ────────────────────────────────────────────────────

const _CRYPTO_RE = /(比特币|以太坊|btc|eth|bitcoin|ethereum|加密货币|crypto|coin|币价|币圈)/i;
const _CRYPTO_MAP = {
  比特币: 'bitcoin',
  btc: 'bitcoin',
  bitcoin: 'bitcoin',
  以太坊: 'ethereum',
  eth: 'ethereum',
  ethereum: 'ethereum',
  狗狗币: 'dogecoin',
  doge: 'dogecoin',
  莱特币: 'litecoin',
  ltc: 'litecoin',
  瑞波: 'ripple',
  xrp: 'ripple',
  sol: 'solana',
  solana: 'solana',
};
// Precomputed once at module load (Ch2「不要每轮重建可复用结构」). _detectCrypto
// runs on every crypto-intent turn and formerly rebuilt Object.entries(_CRYPTO_MAP)
// each call. _CRYPTO_MAP is a module const, iterated read-only with a first-match
// break; insertion order is preserved so the resolved coin is byte-identical.
const _CRYPTO_MAP_ENTRIES = Object.entries(_CRYPTO_MAP);

function _isCryptoIntent(text) {
  return _CRYPTO_RE.test(text) && text.length < 80;
}

function _detectCrypto(text) {
  // 旧行为:没认出币种就 `coin = 'bitcoin'` —— 把「币价」当比特币价答(臆测)。
  // 新契约:认不出就拒绝并问清是哪一个币,而不是替用户挑一个。
  let coin = '';
  for (const [kw, id] of _CRYPTO_MAP_ENTRIES) {
    if (text.toLowerCase().includes(kw)) {
      coin = id;
      break;
    }
  }
  if (!coin) {
    return {
      type: 'api_crypto',
      category: '加密货币',
      label: '加密货币',
      needsInput: {
        field: '币种',
        source: 'missing',
        why: '未指明是哪一个币 —— 不能猜测你问的是哪个币',
        options: ['直接说明币种（例如「比特币价格」）', '先用 webSearch 确认币种名称再查询'],
      },
    };
  }
  return { type: 'api_crypto', category: '加密货币', label: coin, coin };
}

async function _executeCrypto(plan) {
  if (plan && plan.needsInput) {
    return {
      type: 'api_crypto',
      success: false,
      needsInput: plan.needsInput,
      error: _formatNeedsInput('加密货币', plan.needsInput),
    };
  }
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${plan.coin}&vs_currencies=usd,cny&include_24hr_change=true`;
    const data = await _fetchJson(url);
    if (data && data[plan.coin]) {
      const info = data[plan.coin];
      return {
        type: 'api_crypto',
        success: true,
        coin: plan.coin,
        usd: info.usd,
        cny: info.cny,
        change24h: info.usd_24h_change,
      };
    }
  } catch {
    /* fallthrough */
  }
  return { type: 'api_crypto', success: false, error: `无法获取 ${plan.coin} 价格` };
}

function _formatCrypto(result) {
  if (!result.success) {
    // 契约类拒绝的 error 已是完整句子(含出路),不再套一层前缀。
    return result.needsInput ? result.error : `加密货币查询失败: ${result.error}`;
  }
  const change =
    result.change24h != null
      ? ` (24h ${result.change24h > 0 ? '+' : ''}${result.change24h.toFixed(2)}%)`
      : '';
  return `${result.coin.toUpperCase()}\n  USD: $${Number(result.usd).toLocaleString()}${change}\n  CNY: ¥${Number(result.cny).toLocaleString()}`;
}

// ── 11. 英文词典 ────────────────────────────────────────────────────

const _DICT_RE =
  /(什么意思|翻译|定义|解释|dictionary|define|meaning of|what is|what does)\s*["'""]?\s*([a-zA-Z]{2,30})/i;
const _DICT_RE2 = /([a-zA-Z]{2,30})\s*(?:什么意思|的意思|的定义|的解释|meaning|definition)/i;

function _isDictIntent(text) {
  return _DICT_RE.test(text) || _DICT_RE2.test(text);
}

function _detectDict(text) {
  let word = '';
  const m1 = text.match(_DICT_RE);
  const m2 = text.match(_DICT_RE2);
  if (m1) {
    word = m1[2].toLowerCase();
  } else if (m2) {
    word = m2[1].toLowerCase();
  }
  if (!word) {
    return null;
  }
  return { type: 'api_dict', category: '词典', label: word, word };
}

async function _executeDict(plan) {
  try {
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(plan.word)}`;
    const data = await _fetchJson(url);
    if (Array.isArray(data) && data[0]) {
      const entry = data[0];
      const phonetic = entry.phonetic || (entry.phonetics && entry.phonetics[0]?.text) || '';
      const meanings = [];
      for (const m of (entry.meanings || []).slice(0, 3)) {
        const defs = (m.definitions || []).slice(0, 2).map((d) => d.definition);
        meanings.push({ partOfSpeech: m.partOfSpeech, definitions: defs });
      }
      return { type: 'api_dict', success: true, word: plan.word, phonetic, meanings };
    }
  } catch {
    /* fallthrough */
  }
  return { type: 'api_dict', success: false, error: `未找到 "${plan.word}" 的定义` };
}

function _formatDict(result) {
  if (!result.success) {
    return `词典查询: ${result.error}`;
  }
  const lines = [`${result.word}${result.phonetic ? ` ${result.phonetic}` : ''}`];
  for (const m of result.meanings) {
    lines.push(`  [${m.partOfSpeech}]`);
    m.definitions.forEach((d, i) => lines.push(`    ${i + 1}. ${d}`));
  }
  return lines.join('\n');
}

// ── 12. 名言/语录 ──────────────────────────────────────────────────

const _QUOTE_RE = /(名言|语录|格言|鸡汤|励志|名句|quote|wisdom|inspire|motivat)/i;

function _isQuoteIntent(text) {
  return _QUOTE_RE.test(text) && text.length < 60;
}

function _detectQuote() {
  return { type: 'api_quote', category: '名言', label: '随机名言' };
}

async function _executeQuote() {
  // Try ZenQuotes
  try {
    const data = await _fetchJson('https://zenquotes.io/api/random');
    if (Array.isArray(data) && data[0] && data[0].q) {
      return { type: 'api_quote', success: true, quote: data[0].q, author: data[0].a };
    }
  } catch {
    /* fallthrough */
  }
  // Fallback: Quotable
  try {
    const data = await _fetchJson('https://api.quotable.io/random');
    if (data && data.content) {
      return { type: 'api_quote', success: true, quote: data.content, author: data.author };
    }
  } catch {
    /* fallthrough */
  }
  return { type: 'api_quote', success: false, error: '无法获取名言（网络不可用）' };
}

function _formatQuote(result) {
  if (!result.success) {
    return result.error;
  }
  return `"${result.quote}"\n  — ${result.author || 'Unknown'}`;
}

// ── 13. 公网 IP ────────────────────────────────────────────────────

const _IP_SELF_RE = /^(我的ip|公网ip|外网ip|my ip|public ip|what is my ip|ip地址)\s*[?？]*$/i;

function _isIpSelfIntent(text) {
  return _IP_SELF_RE.test(text.trim());
}

function _detectIpSelf() {
  return { type: 'api_ip', category: 'IP', label: '公网 IP' };
}

async function _executeIpSelf() {
  // ipify → ip-api
  try {
    const data = await _fetchJson('https://api.ipify.org/?format=json');
    if (data && data.ip) {
      // Get geo info
      try {
        const geo = await _fetchJson(`http://ip-api.com/json/${data.ip}?lang=zh-CN`);
        if (geo && geo.status === 'success') {
          return {
            type: 'api_ip',
            success: true,
            ip: data.ip,
            country: geo.country,
            region: geo.regionName,
            city: geo.city,
            isp: geo.isp,
            org: geo.org,
          };
        }
      } catch {
        /* just return IP */
      }
      return { type: 'api_ip', success: true, ip: data.ip };
    }
  } catch {
    /* fallthrough */
  }
  return { type: 'api_ip', success: false, error: '无法获取公网 IP（网络不可用）' };
}

function _formatIp(result) {
  if (!result.success) {
    return result.error;
  }
  const lines = [`公网 IP: ${result.ip}`];
  if (result.country) {
    lines.push(`  位置: ${result.country} ${result.region || ''} ${result.city || ''}`);
  }
  if (result.isp) {
    lines.push(`  ISP: ${result.isp}`);
  }
  return lines.join('\n');
}

// ── 14. 随机知识/冷知识 ─────────────────────────────────────────────

const _TRIVIA_RE = /(冷知识|趣闻|趣味|random fact|fun fact|trivia|知道吗|你知道|did you know)/i;

function _isTriviaIntent(text) {
  return _TRIVIA_RE.test(text) && text.length < 60;
}

function _detectTrivia() {
  return { type: 'api_trivia', category: '冷知识', label: '随机知识' };
}

async function _executeTrivia() {
  try {
    const data = await _fetchJson('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en');
    if (data && data.text) {
      return { type: 'api_trivia', success: true, fact: data.text, source: data.source || '' };
    }
  } catch {
    /* fallthrough */
  }
  // Fallback: Numbers API
  try {
    const text = await _fetchText('http://numbersapi.com/random/trivia?json');
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    if (data && data.text) {
      return { type: 'api_trivia', success: true, fact: data.text, source: 'numbersapi.com' };
    }
  } catch {
    /* fallthrough */
  }
  return { type: 'api_trivia', success: false, error: '无法获取冷知识（网络不可用）' };
}

function _formatTrivia(result) {
  if (!result.success) {
    return result.error;
  }
  return `${result.fact}${result.source ? `\n  — ${result.source}` : ''}`;
}

// ── 15. 节假日查询 ──────────────────────────────────────────────────

const _HOLIDAY_RE = /(节假日|假期|放假|holiday|假日|法定假|什么节)/i;
const _COUNTRY_CODE_MAP = {
  中国: 'CN',
  美国: 'US',
  日本: 'JP',
  韩国: 'KR',
  英国: 'GB',
  法国: 'FR',
  德国: 'DE',
  澳大利亚: 'AU',
  china: 'CN',
  us: 'US',
  usa: 'US',
  japan: 'JP',
  uk: 'GB',
  france: 'FR',
  germany: 'DE',
};
// Precomputed once at module load (Ch2「不要每轮重建可复用结构」). _detectHoliday
// runs on every holiday-intent turn and formerly rebuilt Object.entries of this
// module const each call. Iterated read-only with a first-match break; insertion
// order is preserved so the resolved country code is byte-identical.
const _COUNTRY_CODE_MAP_ENTRIES = Object.entries(_COUNTRY_CODE_MAP);

function _isHolidayIntent(text) {
  return _HOLIDAY_RE.test(text) && text.length < 80;
}

function _detectHoliday(text) {
  // 旧行为:没认出国家就 `country = 'CN'` —— 把中国的节假日日历当用户的答案(臆测)。
  // 新契约:认不出就问清是哪个国家/地区。
  let country = '';
  for (const [kw, code] of _COUNTRY_CODE_MAP_ENTRIES) {
    if (text.toLowerCase().includes(kw)) {
      country = code;
      break;
    }
  }
  const year = new Date().getFullYear();
  if (!country) {
    return {
      type: 'api_holiday',
      category: '节假日',
      label: '节假日',
      needsInput: {
        field: '国家/地区',
        source: 'missing',
        why: '未指明国家/地区 —— 不能猜测你在哪个国家',
        options: ['直接说明国家/地区（例如「中国节假日」）', '先用 GetLocation 取得用户所在国家再查询'],
      },
    };
  }
  return { type: 'api_holiday', category: '节假日', label: `${country} ${year}`, country, year };
}

async function _executeHoliday(plan) {
  if (plan && plan.needsInput) {
    return {
      type: 'api_holiday',
      success: false,
      needsInput: plan.needsInput,
      error: _formatNeedsInput('节假日', plan.needsInput),
    };
  }
  try {
    const url = `https://date.nager.at/api/v3/PublicHolidays/${plan.year}/${plan.country}`;
    const data = await _fetchJson(url);
    if (Array.isArray(data) && data.length > 0) {
      const now = new Date().toISOString().slice(0, 10);
      const upcoming = data.filter((h) => h.date >= now).slice(0, 8);
      const past = data.filter((h) => h.date < now).slice(-3);
      return {
        type: 'api_holiday',
        success: true,
        country: plan.country,
        year: plan.year,
        upcoming,
        past,
      };
    }
  } catch {
    /* fallthrough */
  }
  return {
    type: 'api_holiday',
    success: false,
    error: `无法获取 ${plan.country} ${plan.year} 节假日数据`,
  };
}

function _formatHoliday(result) {
  if (!result.success) {
    return result.error;
  }
  const lines = [`${result.country} ${result.year} 节假日：`];
  if (result.upcoming.length > 0) {
    lines.push('即将到来:');
    result.upcoming.forEach((h) => lines.push(`  ${h.date}  ${h.localName || h.name}`));
  }
  if (result.past.length > 0) {
    lines.push('最近已过:');
    result.past.forEach((h) => lines.push(`  ${h.date}  ${h.localName || h.name}`));
  }
  return lines.join('\n');
}

// ── API Handler Registry — 合并到统一拦截管线 ─────────────────────────
// 有模型时也拦截：这些查询返回实时数据，模型做不到更好/更快，且零 token 成本。
// 执行器为 async，REPL 已用 Promise.resolve() 包裹，兼容无缝。

const _API_HANDLERS = [
  // cooperative:false — 与上方注释一致:实时数据/零成本,有模型也拦截(模型做不到更好/更快)。
  { type: 'api_weather', match: _isWeatherIntent, detect: _detectWeather, cooperative: false },
  { type: 'api_currency', match: _isCurrencyIntent, detect: _detectCurrency, cooperative: false },
  { type: 'api_crypto', match: _isCryptoIntent, detect: _detectCrypto, cooperative: false },
  { type: 'api_dict', match: _isDictIntent, detect: _detectDict, cooperative: false },
  { type: 'api_quote', match: _isQuoteIntent, detect: _detectQuote, cooperative: false },
  { type: 'api_ip', match: _isIpSelfIntent, detect: _detectIpSelf, cooperative: false },
  { type: 'api_trivia', match: _isTriviaIntent, detect: _detectTrivia, cooperative: false },
  { type: 'api_holiday', match: _isHolidayIntent, detect: _detectHoliday, cooperative: false },
];

const _API_EXECUTORS = {
  api_weather: _executeWeather,
  api_currency: _executeCurrency,
  api_crypto: _executeCrypto,
  api_dict: _executeDict,
  api_quote: _executeQuote,
  api_ip: _executeIpSelf,
  api_trivia: _executeTrivia,
  api_holiday: _executeHoliday,
};

const _API_FORMATTERS = {
  api_weather: _formatWeather,
  api_currency: _formatCurrency,
  api_crypto: _formatCrypto,
  api_dict: _formatDict,
  api_quote: _formatQuote,
  api_ip: _formatIp,
  api_trivia: _formatTrivia,
  api_holiday: _formatHoliday,
};

module.exports = {
  // 三张注册表 —— localBrainService 以同名别名取回并合入统一拦截管线（契约核心）
  API_HANDLERS: _API_HANDLERS,
  API_EXECUTORS: _API_EXECUTORS,
  API_FORMATTERS: _API_FORMATTERS,
  // 取数辅助（供叶子级单测）
  _fetchJson,
  _fetchText,
  // 8 技能三件套（match/detect/execute/format）—— 供叶子级单测与 localBrainService 再导出
  _isWeatherIntent,
  _detectWeather,
  _executeWeather,
  _formatWeather,
  _isCurrencyIntent,
  _detectCurrency,
  _executeCurrency,
  _formatCurrency,
  _isCryptoIntent,
  _detectCrypto,
  _executeCrypto,
  _formatCrypto,
  _isDictIntent,
  _detectDict,
  _executeDict,
  _formatDict,
  _isQuoteIntent,
  _detectQuote,
  _executeQuote,
  _formatQuote,
  _isIpSelfIntent,
  _detectIpSelf,
  _executeIpSelf,
  _formatIp,
  _isTriviaIntent,
  _detectTrivia,
  _executeTrivia,
  _formatTrivia,
  _isHolidayIntent,
  _detectHoliday,
  _executeHoliday,
  _formatHoliday,
  // 「信息不足 → 拒绝臆测」契约三件套(供叶子级单测)
  _isPlausibleEntity,
  _resolveEntity,
  _needsInput,
  _formatNeedsInput,
};

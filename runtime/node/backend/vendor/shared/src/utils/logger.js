/**
 * Winston logger with daily file rotation
 * @pattern Decorator
 */
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { resolveLogWriteDir } = require('./storagePaths');

const LOG_DIR = resolveLogWriteDir();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'khyos' },
  transports: [
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '7d',
      zippedArchive: true,
      level: 'info'
    }),
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      zippedArchive: true,
      level: 'error'
    })
  ]
});

// Console output in development
if (process.env.NODE_ENV !== 'production') {
  // CLI 启动静音：bin/khy.js 在路由前设这个进程级全局（不是 env——env 会被
  // spawn 的后端服务器子进程继承，把服务端控制台日志一并静音掉）。在这里于
  // **构造时**读取，CLI 就不必为了设一个级别把整套 winston 图拉进启动路径
  // （[DESIGN-PERF-007] W2-2：`khy status` 实测 ~200ms）。不设 → 行为逐字节不变。
  const _cliConsoleLevel = global.__khyCliConsoleLevel;
  logger.add(new winston.transports.Console({
    level: typeof _cliConsoleLevel === 'string' && _cliConsoleLevel ? _cliConsoleLevel : undefined,
    format: winston.format.combine(
      winston.format.colorize(),
      // defaultMeta 的 service 只对文件里的 JSON 日志有意义。控制台这一行是给人看的,
      // 把它一并 echo 出去,只会让每条日志都拖着一段 {"service":"khyos"}。
      winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
        const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${level}] ${message}${metaStr}`;
      })
    )
  }));
}

// Exposed for diagnostics and path-contract tests; transports remain the public logger API.
Object.defineProperty(logger, 'LOG_DIR', { value: LOG_DIR, enumerable: false });

module.exports = logger;

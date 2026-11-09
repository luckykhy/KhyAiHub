'use strict';

/**
 * dependency/ — Agent 依赖自愈子系统门面。
 *
 * 当工具/依赖不完整时，把「硬中断」转为「交互式修复」：探测缺失 → 询问安装 →
 * 隔离执行（命令仅来自 registry）→ 校验 → 重试原调用恰一次。
 *
 * 接入点：services/toolCalling.executeTool 在工具失败后非侵入调用 heal()。
 * 工具侧可主动用 ensure(depId) / MissingDependencyError 发出结构化缺失信号。
 *
 * 规范：docs/03_DESIGN_设计/[DESIGN-ARCH-027] Agent 依赖自愈机制.md
 */

const healingLoop = require('./healingLoop');
const installJobs = require('./installJobs');
const installRunner = require('./installRunner');
// 同 resolver.js：依赖表真源是同目录 ./registry，不是 cli/commands/registry。
const inventory = require('./inventory');
const manifestIo = require('./manifestIo');
const registry = require('./registry');
const resolver = require('./resolver');
const toolchainVersions = require('./toolchainVersions');
const versionProbe = require('./versionProbe');

module.exports = {
  // registry
  getDependency: registry.getDependency,
  listDependencyIds: registry.listDependencyIds,
  listDependencies: registry.listDependencies,
  // resolver
  probe: resolver.probe,
  ensure: resolver.ensure,
  detectFromError: resolver.detectFromError,
  buildInstallPlan: resolver.buildInstallPlan,
  MissingDependencyError: resolver.MissingDependencyError,
  defaultEnv: resolver.defaultEnv,
  // install
  runInstall: installRunner.runInstall,
  // healing loop
  isEnabled: healingLoop.isEnabled,
  heal: healingLoop.heal,
  summarizeForAgent: healingLoop.summarizeForAgent,
  createSession: healingLoop.createSession,
  resetSession: healingLoop.resetSession,
  // 按需选版本（「按客户需求」）
  parseDepSpec: toolchainVersions.parseDepSpec,
  isVersionable: toolchainVersions.isVersionable,
  supportedVersions: toolchainVersions.supportedVersions,
  listVersionable: toolchainVersions.listVersionable,
  describeVersions: toolchainVersions.describeVersions,
  // 开发环境盘点/清单（[DESIGN-ARCH-204]）：assertInstallable 是 manual/
  // informational 短路闸的单点实现，CLI/HTTP/import 三个安装入口共用。
  devCatalog: inventory.DEV_ENV_CATALOG,
  normalizeToDepId: inventory.normalizeToDepId,
  scanInventory: inventory.scanInventory,
  loadLatestSnapshot: inventory.loadLatestSnapshot,
  getSnapshotPath: inventory.getSnapshotPath,
  summarizeInventory: inventory.summarizeInventory,
  assertInstallable: inventory.assertInstallable,
  probeVersion: versionProbe.probeVersion,
  buildManifest: manifestIo.buildManifest,
  buildManifestFromLatest: manifestIo.buildManifestFromLatest,
  previewImport: manifestIo.previewImport,
  applyImport: manifestIo.applyImport,
  createDevEnvJob: installJobs.createJob,
  getDevEnvJob: installJobs.getJob,
  getDevEnvJobView: installJobs.getJobView,
  // sub-modules for advanced use / tests
  registry,
  resolver,
  installRunner,
  healingLoop,
  toolchainVersions,
  versionProbe,
  inventory,
  manifestIo,
  installJobs,
};

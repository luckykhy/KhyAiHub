<!-- 文档分类: DESIGN-LAY 附录 | 生成器: .khyos/tmp/b54-tree.js | 构建产物不得手改 -->
# [DESIGN-LAY-008] 附录A · 方案 P 全量文件去向表

> 由 git ls-files 全量 11457 个跟踪文件逐行生成。迁移 11345 · 退役 109 · 孪生 html 随 md 再生 0（不单独决策） · UNMAPPED-待议 3。
> 树 = 目标形态（目录嵌套到每个文件）；壳与 D-4 退役项单列 §B；UNMAPPED 单列 §C（P3 逐族点名时消化）。
> 本机态目录（不在 git）：.khy/.khyos/.workbuddy/.workbuddy-ai/node_modules/khy-Trajectory → 见 §16.2 行。

## §A 目标树（每个文件一行）

```text
khy-os/
├── .github
│  ├── CODEOWNERS
│  ├── CONTRIBUTING.html
│  ├── CONTRIBUTING.md
│  ├── ISSUE_TEMPLATE
│  │  ├── bug_report.yml
│  │  ├── config.yml
│  │  ├── docs_issue.yml
│  │  └── feature_request.yml
│  ├── PULL_REQUEST_TEMPLATE.html
│  ├── PULL_REQUEST_TEMPLATE.md
│  ├── SECURITY.md
│  ├── copilot-instructions.html
│  ├── copilot-instructions.md
│  ├── dependabot.yml
│  ├── labels.json
│  ├── maintainers.json
│  ├── rulesets
│  │  ├── README.html
│  │  ├── README.md
│  │  ├── default-branch-protection.json
│  │  └── release-tag-immutability.json
│  └── workflows
│     ├── build-executables.yml
│     ├── codeowners.yml
│     ├── codeql-analysis.yml
│     ├── conformance.yml
│     ├── deploy-staging.yml
│     ├── docker.yml
│     ├── dual-channel-release.yml
│     ├── frontend-ci.yml
│     ├── labels-sync.yml
│     ├── native-ci.yml
│     ├── pr-gate.yml
│     └── sync-gitee.yml
├── AGENTS.md
├── README.md
├── [分域-W3] 五域各一份
├── business
│  ├── data
│  │  ├── backup
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── backup
│  │  │  │  ├── backupAssetPlan.js
│  │  │  │  ├── backupAssetPlan.test.js
│  │  │  │  ├── backupManifest.js
│  │  │  │  ├── backupManifest.test.js
│  │  │  │  ├── backupService.js
│  │  │  │  ├── backupService.test.js
│  │  │  │  ├── coldExportService.js
│  │  │  │  ├── coldExportService.test.js
│  │  │  │  ├── restoreService.js
│  │  │  │  ├── sqliteHotCopy.js
│  │  │  │  └── sqliteHotCopy.test.js
│  │  │  ├── diskAnalyze
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── walker.js
│  │  │  │  └── walker.test.js
│  │  │  ├── diskCleanup
│  │  │  │  ├── executor.js
│  │  │  │  ├── index.js
│  │  │  │  ├── junkCatalog.js
│  │  │  │  ├── planner.js
│  │  │  │  ├── planner.test.js
│  │  │  │  ├── protectedGuard.js
│  │  │  │  └── scanner.js
│  │  │  └── restore
│  │  │     ├── agentRestorePlan.js
│  │  │     ├── hydrationHealth.js
│  │  │     ├── installIntegrity.js
│  │  │     ├── resolverPolicy.js
│  │  │     ├── resolverPolicy.test.js
│  │  │     ├── restoreConflictDetector.js
│  │  │     ├── restoreConflictResolver.js
│  │  │     ├── restoreConvergenceVerifier.js
│  │  │     └── restoreReadiness.js
│  │  ├── data
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── data
│  │  │  │  ├── DataLocation.js
│  │  │  │  └── DataLocation.test.js
│  │  │  ├── resources
│  │  │  │  ├── archiveInstaller.js
│  │  │  │  ├── archiveInstaller.test.js
│  │  │  │  ├── manifestLoader.js
│  │  │  │  ├── manifestLoader.test.js
│  │  │  │  ├── resourceManager.js
│  │  │  │  ├── resourceManager.test.js
│  │  │  │  ├── resourceStore.js
│  │  │  │  ├── resourceStore.test.js
│  │  │  │  ├── resourceTask.js
│  │  │  │  └── resourceTask.test.js
│  │  │  ├── reverseEngineer
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── artifactScanner.js
│  │  │  │  ├── artifactScanner.test.js
│  │  │  │  ├── asarArchive.js
│  │  │  │  ├── asarArchive.test.js
│  │  │  │  ├── formatRegistry.js
│  │  │  │  ├── formatRegistry.test.js
│  │  │  │  ├── genericExtractor.js
│  │  │  │  ├── genericExtractor.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── reconstructionPort.js
│  │  │  │  ├── reconstructionPort.test.js
│  │  │  │  ├── sourceRecoverer.js
│  │  │  │  ├── sourceRecoverer.test.js
│  │  │  │  ├── stringHarvester.js
│  │  │  │  ├── stringHarvester.test.js
│  │  │  │  ├── toolOrchestrator.js
│  │  │  │  ├── toolOrchestrator.test.js
│  │  │  │  ├── verificationLedger.js
│  │  │  │  └── verificationLedger.test.js
│  │  │  └── upstreamStudy
│  │  │     ├── index.js
│  │  │     └── index.test.js
│  │  ├── query
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── query
│  │  │  │  ├── activeAssist.js
│  │  │  │  ├── compactPipeline.js
│  │  │  │  ├── compactionStages.js
│  │  │  │  ├── continuation.js
│  │  │  │  ├── inertiaCompletion.js
│  │  │  │  ├── inertialContinuation.js
│  │  │  │  ├── maxTokensRecovery.js
│  │  │  │  ├── responseDebounce.js
│  │  │  │  ├── seamlessResume.js
│  │  │  │  ├── seamlessResume.test.js
│  │  │  │  ├── searchConvergence.js
│  │  │  │  ├── shortStopContinuation.js
│  │  │  │  ├── streamRepetitionGuard.js
│  │  │  │  ├── streamingToolExecutor.js
│  │  │  │  ├── taskNotification.js
│  │  │  │  └── toolResultPersistence.js
│  │  │  └── search
│  │  │     ├── crossSourceMerge.js
│  │  │     ├── mojeekEngine.js
│  │  │     ├── searchAdversarialVerifier.js
│  │  │     ├── searchClaimVerifier.js
│  │  │     ├── searchContradictionDetector.js
│  │  │     ├── searchFreshness.js
│  │  │     ├── searchNecessity.js
│  │  │     ├── searchQualityEnhancer.js
│  │  │     ├── searchSourceChainResolver.js
│  │  │     ├── searchSourceDiscovery.js
│  │  │     └── unifiedSearch.js
│  │  ├── structured
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── formatInspect
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── fileFormatData.js
│  │  │  │  ├── fileFormatData.test.js
│  │  │  │  ├── fileFormatDetector.js
│  │  │  │  ├── fileFormatDetector.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── textAddress.js
│  │  │  │  └── textAddress.test.js
│  │  │  ├── output
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── jsonSchemaValidate.js
│  │  │  │  ├── jsonSchemaValidate.test.js
│  │  │  │  └── khy.module.json
│  │  │  ├── structuredFurnace
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── anomalyHandler.js
│  │  │  │  ├── anomalyHandler.test.js
│  │  │  │  ├── chaosInterceptor.js
│  │  │  │  ├── chaosInterceptor.test.js
│  │  │  │  ├── dimensionReducer.js
│  │  │  │  ├── dimensionReducer.test.js
│  │  │  │  ├── entityRegistry.js
│  │  │  │  ├── entityRegistry.test.js
│  │  │  │  ├── entropyAssessor.js
│  │  │  │  ├── entropyAssessor.test.js
│  │  │  │  ├── forgeSchema.js
│  │  │  │  ├── forgeSchema.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── intentWeaver.js
│  │  │  │  ├── intentWeaver.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── skeletonReconstructor.js
│  │  │  │  ├── skeletonReconstructor.test.js
│  │  │  │  ├── stateMachine.js
│  │  │  │  ├── stateMachine.test.js
│  │  │  │  ├── taskGraph.js
│  │  │  │  └── taskGraph.test.js
│  │  │  ├── structuredResults
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── turnEnvelope.js
│  │  │  │  └── turnEnvelope.test.js
│  │  │  └── typeset
│  │  │     ├── README.html
│  │  │     ├── README.md
│  │  │     ├── contentSchema.js
│  │  │     ├── contentSchema.test.js
│  │  │     ├── khy.module.json
│  │  │     ├── markdownToAst.js
│  │  │     ├── markdownToAst.test.js
│  │  │     ├── styleTemplates.js
│  │  │     ├── styleTemplates.test.js
│  │  │     ├── textEmphasisPolicy.js
│  │  │     └── textEmphasisPolicy.test.js
│  │  └── trajectory
│  │     ├── README.html
│  │     ├── README.md
│  │     ├── auditTrajectory
│  │     │  ├── acceptance.js
│  │     │  ├── channel.js
│  │     │  ├── diffCapture.js
│  │     │  ├── drafter.js
│  │     │  ├── index.js
│  │     │  ├── parser.js
│  │     │  ├── recorder.js
│  │     │  ├── wire.js
│  │     │  ├── workerProcess.js
│  │     │  └── workspaceGuard.js
│  │     ├── dualTrack
│  │     │  ├── README.html
│  │     │  ├── README.md
│  │     │  ├── actionRegistry.js
│  │     │  ├── actionRegistry.test.js
│  │     │  ├── core
│  │     │  │  ├── README.html
│  │     │  │  ├── README.md
│  │     │  │  ├── coreActions.js
│  │     │  │  ├── coreActions.test.js
│  │     │  │  └── khy.module.json
│  │     │  ├── degradeStateMachine.js
│  │     │  ├── degradeStateMachine.test.js
│  │     │  ├── extensionLoader.js
│  │     │  ├── extensionLoader.test.js
│  │     │  ├── extensionWriter.js
│  │     │  ├── extensionWriter.test.js
│  │     │  ├── index.js
│  │     │  ├── index.test.js
│  │     │  ├── khy.module.json
│  │     │  ├── lenientResponseParser.js
│  │     │  ├── lenientResponseParser.test.js
│  │     │  ├── unknownActionView.js
│  │     │  ├── unknownActionView.test.js
│  │     │  ├── updateGuard.js
│  │     │  └── updateGuard.test.js
│  │     ├── dualTrackForge
│  │     │  ├── deterministicElevator.js
│  │     │  ├── deterministicElevator.test.js
│  │     │  ├── dualTrackMerger.js
│  │     │  ├── index.js
│  │     │  ├── logicalSelfAssessor.js
│  │     │  ├── physicalAssertionGate.js
│  │     │  ├── physicalCodes.js
│  │     │  └── physicalCodes.test.js
│  │     ├── trajectoryGuide
│  │     │  ├── aiBridge.js
│  │     │  ├── config.js
│  │     │  ├── config.test.js
│  │     │  ├── guideInjector.js
│  │     │  ├── guideInjector.test.js
│  │     │  ├── guideRetriever.js
│  │     │  ├── guideRetriever.test.js
│  │     │  ├── index.js
│  │     │  ├── mapAuthor.js
│  │     │  ├── mapExport.js
│  │     │  └── mapStore.js
│  │     ├── trajectoryProvenance
│  │     │  ├── README.html
│  │     │  ├── README.md
│  │     │  ├── claimNegation.js
│  │     │  ├── claimNegation.test.js
│  │     │  ├── claimReconciler.js
│  │     │  ├── claimReconciler.test.js
│  │     │  ├── index.js
│  │     │  ├── index.test.js
│  │     │  ├── khy.module.json
│  │     │  ├── khyTrace.js
│  │     │  ├── khyTrace.test.js
│  │     │  ├── provenanceClassifier.js
│  │     │  ├── provenanceClassifier.test.js
│  │     │  ├── quarantinePolicy.js
│  │     │  ├── quarantinePolicy.test.js
│  │     │  ├── traceChain.js
│  │     │  ├── traceChain.test.js
│  │     │  ├── traceProjection.js
│  │     │  └── traceProjection.test.js
│  │     └── trajectoryReplay
│  │        ├── README.html
│  │        ├── README.md
│  │        ├── artifactHash.js
│  │        ├── artifactHash.test.js
│  │        ├── envFingerprint.js
│  │        ├── envFingerprint.test.js
│  │        ├── index.js
│  │        ├── index.test.js
│  │        ├── khy.module.json
│  │        ├── replayArtifactGuards.js
│  │        ├── replayArtifactGuards.test.js
│  │        ├── replayBundle.js
│  │        ├── replayBundle.test.js
│  │        ├── replayEngine.js
│  │        ├── replayEngine.test.js
│  │        ├── replayLedger.js
│  │        ├── replayLedger.test.js
│  │        ├── replayStepPolicy.js
│  │        ├── replayStepPolicy.test.js
│  │        ├── tierRegistry.js
│  │        └── tierRegistry.test.js
│  ├── dialogue
│  │  ├── collab
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── ide
│  │  │  │  └── idePlan.js
│  │  │  ├── proactiveCollaboration
│  │  │  │  ├── constants.js
│  │  │  │  ├── delegationPlanner.js
│  │  │  │  ├── delegationPlanner.test.js
│  │  │  │  ├── index.js
│  │  │  │  └── opportunityDetector.js
│  │  │  └── weipuxiezuo
│  │  │     ├── constraints.js
│  │  │     ├── detector.js
│  │  │     ├── detector.test.js
│  │  │     ├── index.js
│  │  │     ├── rules.js
│  │  │     ├── rules.test.js
│  │  │     ├── scorer.js
│  │  │     ├── textStats.js
│  │  │     └── textStats.test.js
│  │  ├── messaging
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── channels
│  │  │  │  ├── _baseChannel.js
│  │  │  │  ├── _baseChannel.test.js
│  │  │  │  ├── dingtalkChannel.js
│  │  │  │  ├── dingtalkChannel.test.js
│  │  │  │  ├── feishuChannel.js
│  │  │  │  ├── feishuChannel.test.js
│  │  │  │  ├── ilinkChannel.js
│  │  │  │  ├── ilinkDispatchDiagnostics.js
│  │  │  │  ├── ilinkDispatcher.js
│  │  │  │  ├── ilinkExecutionLock.js
│  │  │  │  ├── ilinkExecutionLock.test.js
│  │  │  │  ├── ilinkFileDelivery.js
│  │  │  │  ├── ilinkWorkspaceRouting.js
│  │  │  │  ├── imAdapterChannel.js
│  │  │  │  ├── messageRouter.js
│  │  │  │  ├── slackChannel.js
│  │  │  │  ├── wecomChannel.js
│  │  │  │  └── wecomChannel.test.js
│  │  │  ├── mcp
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── autoConnect.js
│  │  │  │  ├── autoConnect.test.js
│  │  │  │  ├── ccMcpBridge.js
│  │  │  │  ├── ccMcpBridge.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── mcpAddSpec.js
│  │  │  │  ├── mcpAddSpec.test.js
│  │  │  │  ├── mcpConfigStore.js
│  │  │  │  ├── mcpConfigStore.test.js
│  │  │  │  ├── mcpDisclosurePlan.js
│  │  │  │  ├── mcpDisclosurePlan.test.js
│  │  │  │  ├── mcpEcosystemRegistry.js
│  │  │  │  ├── mcpEcosystemRegistry.test.js
│  │  │  │  ├── mcpGovernance.js
│  │  │  │  ├── mcpGovernance.test.js
│  │  │  │  ├── mcpHttpServer.js
│  │  │  │  ├── mcpHttpServer.test.js
│  │  │  │  ├── mcpServeToolPolicy.js
│  │  │  │  ├── mcpServeToolPolicy.test.js
│  │  │  │  ├── mcpServer.js
│  │  │  │  ├── mcpServer.test.js
│  │  │  │  ├── mcpServerPresets.js
│  │  │  │  ├── mcpServerPresets.test.js
│  │  │  │  ├── mcpServerProtocol.js
│  │  │  │  ├── mcpServerProtocol.test.js
│  │  │  │  ├── mcpServerStatus.js
│  │  │  │  ├── mcpServerStatus.test.js
│  │  │  │  ├── mcpStdioServer.js
│  │  │  │  ├── mcpStdioServer.test.js
│  │  │  │  ├── oauthTokenStore.js
│  │  │  │  ├── oauthTokenStore.test.js
│  │  │  │  ├── ocMcpBridge.js
│  │  │  │  ├── ocMcpBridge.test.js
│  │  │  │  ├── oeMcpBridge.js
│  │  │  │  ├── oeMcpBridge.test.js
│  │  │  │  ├── pythonCommandResolver.js
│  │  │  │  ├── pythonCommandResolver.test.js
│  │  │  │  ├── toolPool.js
│  │  │  │  ├── toolPool.test.js
│  │  │  │  ├── types.js
│  │  │  │  └── types.test.js
│  │  │  └── messaging
│  │  │     ├── ilinkAccountStore.js
│  │  │     ├── ilinkApi.js
│  │  │     ├── ilinkBindingStore.js
│  │  │     ├── ilinkCore.js
│  │  │     ├── ilinkCrypto.js
│  │  │     ├── ilinkCursorStore.js
│  │  │     ├── ilinkLogin.js
│  │  │     ├── ilinkMedia.js
│  │  │     ├── ilinkMessageCodec.js
│  │  │     ├── ilinkProtocol.js
│  │  │     ├── ilinkProtocol.test.js
│  │  │     ├── ilinkSendPolicy.js
│  │  │     ├── ilinkSessionState.js
│  │  │     ├── ilinkStorePaths.js
│  │  │     ├── ilinkStorePaths.test.js
│  │  │     ├── msgChannelCore.js
│  │  │     ├── msgConfigStore.js
│  │  │     ├── msgInboundCore.js
│  │  │     ├── msgReplyBridge.js
│  │  │     └── msgSender.js
│  │  ├── onboarding
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── khy.module.json
│  │  │  └── onboarding
│  │  │     ├── onboardingPlan.js
│  │  │     ├── onboardingPlan.test.js
│  │  │     ├── safetyNotice.js
│  │  │     └── safetyNotice.test.js
│  │  └── session
│  │     ├── README.html
│  │     ├── README.md
│  │     ├── chatStateIsolation
│  │     │  ├── README.html
│  │     │  ├── README.md
│  │     │  ├── index.js
│  │     │  ├── index.test.js
│  │     │  └── khy.module.json
│  │     ├── context
│  │     │  ├── contextBreakdown.js
│  │     │  ├── contextSuggestions.js
│  │     │  ├── ctxWindowStats.js
│  │     │  ├── ctxWindowStats.test.js
│  │     │  ├── messageBreakdown.js
│  │     │  └── webContextStats.js
│  │     ├── contextScope
│  │     │  ├── aiMapIndex.js
│  │     │  ├── budgetController.js
│  │     │  ├── index.js
│  │     │  ├── scopeRanker.js
│  │     │  ├── searchPlanBuilder.js
│  │     │  ├── searchPlanBuilder.test.js
│  │     │  └── taskSignalExtractor.js
│  │     ├── conversation
│  │     │  ├── README.html
│  │     │  ├── README.md
│  │     │  ├── btwNote.js
│  │     │  ├── btwNote.test.js
│  │     │  ├── btwNoteQueue.js
│  │     │  ├── btwNoteQueue.test.js
│  │     │  └── khy.module.json
│  │     └── session
│  │        ├── sessionForestService.js
│  │        └── sessionForkPlan.js
│  ├── guard
│  │  ├── maintenance
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── auditFixLoop
│  │  │  │  ├── auditParser.js
│  │  │  │  ├── index.js
│  │  │  │  ├── promptBuilder.js
│  │  │  │  └── triggerGate.js
│  │  │  ├── autofixPr
│  │  │  │  └── autofixPrPlan.js
│  │  │  ├── claimMain
│  │  │  │  ├── claimMainPlan.js
│  │  │  │  └── claimMainStore.js
│  │  │  ├── evoEngine
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── evoLedger.js
│  │  │  │  ├── evoLedger.test.js
│  │  │  │  ├── evoLevels.js
│  │  │  │  ├── evoLevels.test.js
│  │  │  │  ├── evoRequirement.js
│  │  │  │  ├── evoRequirement.test.js
│  │  │  │  ├── evoTrustBreaker.js
│  │  │  │  ├── evoTrustBreaker.test.js
│  │  │  │  ├── frictionBridge.js
│  │  │  │  ├── frictionBridge.test.js
│  │  │  │  ├── hostPatcher.js
│  │  │  │  ├── hostPatcher.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── organogenesisSandbox.js
│  │  │  │  ├── organogenesisSandbox.test.js
│  │  │  │  ├── painPointScanner.js
│  │  │  │  └── painPointScanner.test.js
│  │  │  ├── orphanSweep
│  │  │  │  ├── orphanSweep.js
│  │  │  │  └── orphanSweep.test.js
│  │  │  ├── selfHeal
│  │  │  │  ├── deadLoopDetector.js
│  │  │  │  ├── deadLoopDetector.test.js
│  │  │  │  ├── diagnosisDictionary.js
│  │  │  │  ├── errorDiagnostician.js
│  │  │  │  ├── fallbackTree.js
│  │  │  │  ├── fixActions.js
│  │  │  │  ├── index.js
│  │  │  │  ├── microLoopExecutor.js
│  │  │  │  └── types.d.ts
│  │  │  ├── selfRepair
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── primitives.js
│  │  │  │  ├── primitives.test.js
│  │  │  │  ├── transactionRunner.js
│  │  │  │  └── transactionRunner.test.js
│  │  │  ├── selfSustainingInfra
│  │  │  │  ├── autoTestScaffolder.js
│  │  │  │  ├── contractDocGenerator.js
│  │  │  │  ├── dependencyImpactScanner.js
│  │  │  │  ├── index.js
│  │  │  │  └── infraGapQuencher.js
│  │  │  └── uninstall
│  │  │     ├── README.html
│  │  │     ├── README.md
│  │  │     ├── installLedger.js
│  │  │     ├── installLedger.test.js
│  │  │     ├── khy.module.json
│  │  │     ├── ledgerWriter.js
│  │  │     ├── ledgerWriter.test.js
│  │  │     ├── uninstallPlan.js
│  │  │     └── uninstallPlan.test.js
│  │  ├── security
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── adversarial
│  │  │  │  ├── attackVectors.js
│  │  │  │  ├── forgeryBuilders.js
│  │  │  │  ├── forgeryBuilders.test.js
│  │  │  │  ├── hardeningLoop.js
│  │  │  │  ├── index.js
│  │  │  │  ├── stressHarness.js
│  │  │  │  └── survivalCriteria.js
│  │  │  ├── dataSovereignty
│  │  │  │  ├── conflictQuencher.js
│  │  │  │  ├── dataSovereigntyGateway.js
│  │  │  │  ├── ghostValueAnnotator.js
│  │  │  │  ├── ghostValueAnnotator.test.js
│  │  │  │  ├── index.js
│  │  │  │  └── sovereigntyTiers.js
│  │  │  ├── failsafe
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── classifier.js
│  │  │  │  ├── classifier.test.js
│  │  │  │  ├── classifierSignals.js
│  │  │  │  ├── classifierSignals.test.js
│  │  │  │  ├── errorCodes.js
│  │  │  │  ├── errorCodes.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── safeResponse.js
│  │  │  │  ├── safeResponse.test.js
│  │  │  │  ├── streamInjector.js
│  │  │  │  ├── streamInjector.test.js
│  │  │  │  └── types.d.ts
│  │  │  ├── marshal
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── capabilityVector.js
│  │  │  │  ├── capabilityVector.test.js
│  │  │  │  └── khy.module.json
│  │  │  ├── permissionPolicy
│  │  │  │  ├── config.js
│  │  │  │  ├── config.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── matchers.js
│  │  │  │  └── matchers.test.js
│  │  │  ├── redpass
│  │  │  │  ├── redpassCheckpoint.js
│  │  │  │  ├── redpassEngine.js
│  │  │  │  ├── redpassPrompts.js
│  │  │  │  ├── redpassStrategyScorer.js
│  │  │  │  └── redpassSynonyms.js
│  │  │  ├── resilience
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── budgetAdapters.js
│  │  │  │  ├── budgetAdapters.test.js
│  │  │  │  ├── budgetExecutor.js
│  │  │  │  ├── budgetExecutor.test.js
│  │  │  │  ├── deadLoopDetector.js
│  │  │  │  ├── deadLoopDetector.test.js
│  │  │  │  ├── errorSignature.js
│  │  │  │  ├── errorSignature.test.js
│  │  │  │  ├── fallbackTree.js
│  │  │  │  ├── fallbackTree.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── intentTrees.js
│  │  │  │  ├── intentTrees.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── salvage.js
│  │  │  │  └── salvage.test.js
│  │  │  └── security
│  │  │     ├── codeScanner
│  │  │     │  ├── README.html
│  │  │     │  ├── README.md
│  │  │     │  ├── index.js
│  │  │     │  ├── index.test.js
│  │  │     │  └── khy.module.json
│  │  │     └── skillLedger
│  │  │        ├── README.html
│  │  │        ├── README.md
│  │  │        ├── index.js
│  │  │        ├── index.test.js
│  │  │        └── khy.module.json
│  │  ├── system
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── syscallGateway
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── actionContractVerifier.js
│  │  │  │  ├── actionContractVerifier.test.js
│  │  │  │  ├── approvalRouter.js
│  │  │  │  ├── approvalRouter.test.js
│  │  │  │  ├── breachBreaker.js
│  │  │  │  ├── breachBreaker.test.js
│  │  │  │  ├── denialGuidance.js
│  │  │  │  ├── denialGuidance.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── intentSchema.js
│  │  │  │  ├── intentSchema.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── permissionCache.js
│  │  │  │  ├── permissionCache.test.js
│  │  │  │  ├── preExecutionExplainer.js
│  │  │  │  ├── preExecutionExplainer.test.js
│  │  │  │  ├── redLine.js
│  │  │  │  ├── redLine.test.js
│  │  │  │  ├── resourceClassifier.js
│  │  │  │  └── resourceClassifier.test.js
│  │  │  └── wasm-sandbox
│  │  │     ├── index.js
│  │  │     ├── index.test.js
│  │  │     ├── ipcCodec.js
│  │  │     ├── ipcCodec.test.js
│  │  │     ├── khySysHost.js
│  │  │     ├── loopbackTransport.js
│  │  │     ├── loopbackTransport.test.js
│  │  │     ├── m1Constants.js
│  │  │     ├── m1Constants.test.js
│  │  │     ├── moonbitHostBridge.js
│  │  │     └── moonbitHostBridge.test.js
│  │  └── workspace
│  │     ├── README.html
│  │     ├── README.md
│  │     └── workspace
│  │        ├── checkpointObjectStore.js
│  │        ├── checkpointObjectStore.test.js
│  │        ├── checkpointService.js
│  │        ├── checkpointService.test.js
│  │        ├── workspaceContext.js
│  │        └── workspaceContext.test.js
│  ├── intelligence
│  │  ├── agents
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── advisor
│  │  │  │  └── advisorPlan.js
│  │  │  ├── agentAssets
│  │  │  │  ├── _adapterBase.js
│  │  │  │  ├── _adapterBase.test.js
│  │  │  │  ├── adapters
│  │  │  │  │  ├── README.html
│  │  │  │  │  ├── README.md
│  │  │  │  │  ├── claudeCode.js
│  │  │  │  │  ├── claudeCode.test.js
│  │  │  │  │  ├── deepseekHarness.js
│  │  │  │  │  ├── deepseekHarness.test.js
│  │  │  │  │  ├── harness.js
│  │  │  │  │  ├── harness.test.js
│  │  │  │  │  ├── khy.module.json
│  │  │  │  │  ├── khyOs.js
│  │  │  │  │  ├── khyOs.test.js
│  │  │  │  │  ├── openclaw.js
│  │  │  │  │  ├── openclaw.test.js
│  │  │  │  │  ├── opencode.js
│  │  │  │  │  └── opencode.test.js
│  │  │  │  ├── assetModel.js
│  │  │  │  ├── assetModel.test.js
│  │  │  │  ├── registry.js
│  │  │  │  ├── registry.test.js
│  │  │  │  ├── sync.js
│  │  │  │  └── sync.test.js
│  │  │  ├── agentFs
│  │  │  │  ├── agentFsService.js
│  │  │  │  └── agentFsService.test.js
│  │  │  ├── agents
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── delegationPromptPolicy.js
│  │  │  │  ├── delegationPromptPolicy.test.js
│  │  │  │  └── khy.module.json
│  │  │  ├── agentsight
│  │  │  │  ├── genaiEvents.js
│  │  │  │  └── genaiEvents.test.js
│  │  │  ├── assistant
│  │  │  │  └── proactiveTogglePlan.js
│  │  │  └── autonomy
│  │  │     ├── autonomyInspectPlan.js
│  │  │     └── autonomyInspectPlan.test.js
│  │  ├── memory
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── cognitiveSnapshot
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── compressionEngine.js
│  │  │  │  ├── compressionEngine.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── offloadStore.js
│  │  │  │  ├── offloadStore.test.js
│  │  │  │  ├── overflowInterceptor.js
│  │  │  │  ├── overflowInterceptor.test.js
│  │  │  │  ├── snapshotManager.js
│  │  │  │  ├── snapshotManager.test.js
│  │  │  │  ├── workbench.js
│  │  │  │  └── workbench.test.js
│  │  │  ├── compact
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── prompt.js
│  │  │  │  └── prompt.test.js
│  │  │  └── memoryEngine
│  │  │     ├── distiller.js
│  │  │     ├── dreamPromote.js
│  │  │     ├── index.js
│  │  │     ├── memoryRecallTokens.js
│  │  │     ├── progressLog.js
│  │  │     ├── scoring.js
│  │  │     ├── sessionCheckpoint.js
│  │  │     ├── sessionMemory.js
│  │  │     ├── topicSwitch.js
│  │  │     ├── vectorRecall.js
│  │  │     └── vectorStore.js
│  │  ├── skills
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  └── skills
│  │  │     ├── journeyTimeline.js
│  │  │     ├── skillSourceDistiller.js
│  │  │     ├── skillThreatPatterns.js
│  │  │     ├── skillThreatScanner.js
│  │  │     └── verifierScaffoldPlan.js
│  │  └── state
│  │     ├── README.html
│  │     ├── README.md
│  │     ├── envSymbiosis
│  │     │  ├── compatibilityQuencher.js
│  │     │  ├── envFingerprintScanner.js
│  │     │  ├── index.js
│  │     │  ├── nativeAffinityRouter.js
│  │     │  ├── platformIds.js
│  │     │  ├── specialtyBreaker.js
│  │     │  └── specialtyBreaker.test.js
│  │     ├── intentArbiter
│  │     │  ├── index.js
│  │     │  ├── intentCalibration.js
│  │     │  ├── intentLexicon.js
│  │     │  ├── intentNegation.js
│  │     │  ├── intentPreprocess.js
│  │     │  ├── intentSpectrumAnalyzer.js
│  │     │  ├── misjudgmentQuencher.js
│  │     │  └── tieredResponseRouter.js
│  │     ├── orchestrator
│  │     │  ├── authzFailureLedger.js
│  │     │  ├── criticalPathSchedule.js
│  │     │  ├── dependencyWaveInjection.js
│  │     │  ├── dependencyWaveScheduler.js
│  │     │  ├── mergeEmptySuccess.js
│  │     │  ├── mergeFileConflicts.js
│  │     │  ├── mergeRoleAttribution.js
│  │     │  ├── orchestrationJournal.js
│  │     │  ├── orchestrationPlan.js
│  │     │  ├── orchestrationService.js
│  │     │  └── roleToolScope.js
│  │     └── stateMachine
│  │        ├── agentLifecycle.js
│  │        ├── debugLog.js
│  │        ├── debugLog.test.js
│  │        ├── fsm.js
│  │        ├── replPhases.js
│  │        ├── startupPhases.js
│  │        ├── startupPhases.test.js
│  │        ├── toolLoopPhases.js
│  │        └── turnPhaseTracker.js
│  ├── platform
│  │  ├── account
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── accountPool
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── candidateDetect.js
│  │  │  │  ├── candidateDetect.test.js
│  │  │  │  ├── credentialHelpers.js
│  │  │  │  ├── credentialHelpers.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── poolImporter.js
│  │  │  │  ├── poolImporter.test.js
│  │  │  │  ├── poolScheduler.js
│  │  │  │  ├── poolScheduler.test.js
│  │  │  │  ├── poolSync.js
│  │  │  │  └── poolSync.test.js
│  │  │  └── tokenless
│  │  │     ├── commandRewriter.js
│  │  │     ├── commandRewriter.test.js
│  │  │     ├── index.js
│  │  │     ├── index.test.js
│  │  │     ├── responseCompressor.js
│  │  │     ├── responseCompressor.test.js
│  │  │     ├── schemaCompressor.js
│  │  │     ├── toonCodec.js
│  │  │     ├── toonCodec.test.js
│  │  │     ├── toonDecode.js
│  │  │     ├── toonDecode.test.js
│  │  │     ├── toonEncode.js
│  │  │     └── toonEncode.test.js
│  │  ├── config
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── ccSwitch
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── apiHandlers.js
│  │  │  │  ├── apiHandlers.test.js
│  │  │  │  ├── appWriters.js
│  │  │  │  ├── appWriters.test.js
│  │  │  │  ├── codexWriter.js
│  │  │  │  ├── codexWriter.test.js
│  │  │  │  ├── connectivity.js
│  │  │  │  ├── connectivity.test.js
│  │  │  │  ├── constants.js
│  │  │  │  ├── constants.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── opencodeGoQuota.js
│  │  │  │  ├── opencodeGoQuota.test.js
│  │  │  │  ├── promptGuard.js
│  │  │  │  ├── promptGuard.test.js
│  │  │  │  ├── proxyAccess.js
│  │  │  │  ├── proxyAccess.test.js
│  │  │  │  ├── routeResolver.js
│  │  │  │  ├── routeResolver.test.js
│  │  │  │  ├── store.js
│  │  │  │  ├── store.test.js
│  │  │  │  ├── usageScan.js
│  │  │  │  └── usageScan.test.js
│  │  │  ├── config
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── langPreference.js
│  │  │  │  ├── langPreference.test.js
│  │  │  │  ├── nlActionResolver.js
│  │  │  │  ├── nlActionResolver.test.js
│  │  │  │  ├── nlConfigResolver.js
│  │  │  │  ├── nlConfigResolver.test.js
│  │  │  │  ├── nlExternalAppImportResolver.js
│  │  │  │  ├── nlExternalAppImportResolver.test.js
│  │  │  │  ├── nlExternalAppResolver.js
│  │  │  │  ├── nlExternalAppResolver.test.js
│  │  │  │  ├── nlInstallVsConfigGuard.js
│  │  │  │  ├── nlInstallVsConfigGuard.test.js
│  │  │  │  ├── nlProviderResolver.js
│  │  │  │  ├── nlProviderResolver.test.js
│  │  │  │  ├── philosophyDesignResolver.js
│  │  │  │  ├── philosophyDesignResolver.test.js
│  │  │  │  ├── sandboxToggleState.js
│  │  │  │  └── sandboxToggleState.test.js
│  │  │  ├── keybindings
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── historyReverseSearch.js
│  │  │  │  ├── historyReverseSearch.test.js
│  │  │  │  ├── keybindingCatalog.js
│  │  │  │  ├── keybindingCatalog.test.js
│  │  │  │  └── khy.module.json
│  │  │  └── khy.module.json
│  │  ├── cpa
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── cpaKeyPool.js
│  │  │  ├── cpaProtocolConverter.js
│  │  │  └── cpaService.js
│  │  ├── deploy
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── deploy
│  │  │  │  ├── deployLedger.js
│  │  │  │  ├── deployLedger.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── projectDetector.js
│  │  │  │  ├── projectDetector.test.js
│  │  │  │  ├── runners.js
│  │  │  │  ├── runners.test.js
│  │  │  │  ├── syncEngine.js
│  │  │  │  └── syncEngine.test.js
│  │  │  ├── publish
│  │  │  │  ├── bundleArtifacts.js
│  │  │  │  ├── bundleCommon.js
│  │  │  │  ├── dockerBundleBuilder.js
│  │  │  │  ├── projectState.js
│  │  │  │  └── publishUtils.js
│  │  │  └── subscribePr
│  │  │     ├── subscribePrPlan.js
│  │  │     └── subscribePrStore.js
│  │  ├── desktop
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── browser
│  │  │  │  ├── _evalTimeout.js
│  │  │  │  ├── _evalTimeout.test.js
│  │  │  │  ├── ariaSnapshot.js
│  │  │  │  ├── engine.js
│  │  │  │  ├── scrollPlan.js
│  │  │  │  └── session.js
│  │  │  ├── computerUse
│  │  │  │  ├── appTarget.js
│  │  │  │  ├── computerUseAgent.js
│  │  │  │  ├── setOfMarks.js
│  │  │  │  └── stateDetector.js
│  │  │  ├── desktopControl
│  │  │  │  ├── a11yTreeProvider.js
│  │  │  │  ├── backendDetector.js
│  │  │  │  ├── backendRegistry.js
│  │  │  │  ├── elementModel.js
│  │  │  │  ├── formFiller.js
│  │  │  │  ├── index.js
│  │  │  │  ├── inputController.js
│  │  │  │  ├── safetyGate.js
│  │  │  │  ├── screenCapture.js
│  │  │  │  ├── screenshotToContentBlocks.js
│  │  │  │  ├── scripts
│  │  │  │  │  └── win-uia-tree.ps1
│  │  │  │  ├── uiInspector.js
│  │  │  │  ├── voiceBridge.js
│  │  │  │  ├── voiceBridge.test.js
│  │  │  │  ├── windowController.js
│  │  │  │  └── workflowRecorder.js
│  │  │  ├── deviceApps
│  │  │  │  ├── deviceAppListParsers.js
│  │  │  │  ├── deviceAppManager.js
│  │  │  │  ├── deviceAppsDownloader.js
│  │  │  │  ├── deviceAppsPolicy.js
│  │  │  │  ├── nativeUninstallPolicy.js
│  │  │  │  ├── nativeUninstaller.js
│  │  │  │  ├── uninstallRoute.js
│  │  │  │  └── uninstallRoute.test.js
│  │  │  └── terminal
│  │  │     ├── terminalSetupPlan.js
│  │  │     └── terminalSetupPlan.test.js
│  │  └── network
│  │     ├── README.html
│  │     ├── README.md
│  │     ├── dependency
│  │     │  ├── README.html
│  │     │  ├── README.md
│  │     │  ├── healingLoop.js
│  │     │  ├── healingLoop.test.js
│  │     │  ├── index.js
│  │     │  ├── index.test.js
│  │     │  ├── installLocation.js
│  │     │  ├── installLocation.test.js
│  │     │  ├── installRunner.js
│  │     │  ├── installRunner.test.js
│  │     │  ├── khy.module.json
│  │     │  ├── registry.js
│  │     │  ├── registry.test.js
│  │     │  ├── resolver.js
│  │     │  ├── resolver.test.js
│  │     │  ├── toolchainVersions.js
│  │     │  └── toolchainVersions.test.js
│  │     ├── externalApps
│  │     │  ├── README.html
│  │     │  ├── README.md
│  │     │  ├── _shared.js
│  │     │  ├── _shared.test.js
│  │     │  ├── appModelImporter.js
│  │     │  ├── appModelImporter.test.js
│  │     │  ├── claudeCodeAdapter.js
│  │     │  ├── claudeCodeAdapter.test.js
│  │     │  ├── commandCodeAdapter.js
│  │     │  ├── commandCodeAdapter.test.js
│  │     │  ├── cozeAdapter.js
│  │     │  ├── cozeAdapter.test.js
│  │     │  ├── deepseekTuiAdapter.js
│  │     │  ├── deepseekTuiAdapter.test.js
│  │     │  ├── geminiCliAdapter.js
│  │     │  ├── geminiCliAdapter.test.js
│  │     │  ├── khy.module.json
│  │     │  ├── openclawAdapter.js
│  │     │  ├── openclawAdapter.test.js
│  │     │  ├── opencodeAdapter.js
│  │     │  ├── opencodeAdapter.test.js
│  │     │  ├── reasonixAdapter.js
│  │     │  ├── reasonixAdapter.test.js
│  │     │  ├── tomlLite.js
│  │     │  ├── tomlLite.test.js
│  │     │  ├── tomlLiteFormat.js
│  │     │  ├── tomlLiteFormat.test.js
│  │     │  ├── traeAppAdapter.js
│  │     │  ├── traeAppAdapter.test.js
│  │     │  ├── ycodeAdapter.js
│  │     │  ├── ycodeAdapter.test.js
│  │     │  ├── zcodeAdapter.js
│  │     │  └── zcodeAdapter.test.js
│  │     ├── proxy
│  │     │  ├── proxyCoreConfigGen.js
│  │     │  ├── proxyCoreConfigGen.test.js
│  │     │  ├── proxyCoreInstaller.js
│  │     │  ├── proxyCoreInstaller.test.js
│  │     │  └── proxyCoreManager.js
│  │     ├── remote
│  │     │  ├── README.html
│  │     │  ├── README.md
│  │     │  ├── deployOrchestrator.js
│  │     │  ├── deployOrchestrator.test.js
│  │     │  ├── index.js
│  │     │  ├── index.test.js
│  │     │  ├── khy.module.json
│  │     │  ├── remoteApprovalBridge.js
│  │     │  ├── remoteApprovalBridge.test.js
│  │     │  ├── remoteExecService.js
│  │     │  ├── remoteExecService.test.js
│  │     │  ├── remoteExecStreamStore.js
│  │     │  ├── remoteExecStreamStore.test.js
│  │     │  ├── remoteFileTransferService.js
│  │     │  ├── remoteFileTransferService.test.js
│  │     │  ├── remoteStatePersistence.js
│  │     │  ├── remoteStatePersistence.test.js
│  │     │  ├── remoteStateSyncService.js
│  │     │  ├── remoteStateSyncService.test.js
│  │     │  ├── remoteWorkspaceResolver.js
│  │     │  ├── remoteWorkspaceResolver.test.js
│  │     │  ├── sshConfigService.js
│  │     │  ├── sshConfigService.test.js
│  │     │  ├── sshConnectionManager.js
│  │     │  ├── sshConnectionManager.test.js
│  │     │  ├── sshCredentialGuard.js
│  │     │  └── sshCredentialGuard.test.js
│  │     ├── remotedev
│  │     │  ├── remoteDevService.js
│  │     │  ├── remoteDevService.test.js
│  │     │  ├── remoteDevSessionStore.js
│  │     │  ├── remoteDevSessionStore.test.js
│  │     │  ├── remoteDevState.js
│  │     │  └── remoteDevState.test.js
│  │     └── updateAdapters
│  │        ├── packageAdapter.js
│  │        ├── packageAdapter.test.js
│  │        ├── portableAdapter.js
│  │        ├── portableAdapter.test.js
│  │        ├── windowsSwapScript.js
│  │        └── windowsSwapScript.test.js
│  ├── project
│  │  ├── build
│  │  │  ├── README.md
│  │  │  ├── compile
│  │  │  │  ├── diagnostics.js
│  │  │  │  └── registry.js
│  │  │  ├── forge
│  │  │  │  ├── forgeClient.js
│  │  │  │  └── forgeCore.js
│  │  │  └── repoMap
│  │  │     ├── index.js
│  │  │     └── repoMapRenderer.js
│  │  ├── docs
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── changelog
│  │  │  │  ├── changelogParse.js
│  │  │  │  └── changelogParse.test.js
│  │  │  └── docsFreshness
│  │  │     ├── README.html
│  │  │     ├── README.md
│  │  │     ├── docMarkerSync.js
│  │  │     ├── docMarkerSync.test.js
│  │  │     ├── docPathIndex.js
│  │  │     ├── docPathIndex.test.js
│  │  │     ├── docProductPlan.js
│  │  │     ├── docProductPlan.test.js
│  │  │     ├── docSuggestDraft.js
│  │  │     ├── docSuggestDraft.test.js
│  │  │     ├── docsFreshnessRunner.js
│  │  │     ├── docsFreshnessRunner.test.js
│  │  │     └── khy.module.json
│  │  ├── eval
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── guiEval
│  │  │  │  ├── checkpointVerifier.js
│  │  │  │  ├── index.js
│  │  │  │  ├── pricingEngine.js
│  │  │  │  ├── pricingEngine.test.js
│  │  │  │  ├── recordingCollector.js
│  │  │  │  ├── reviewService.js
│  │  │  │  ├── reviewService.test.js
│  │  │  │  ├── runEngine.js
│  │  │  │  ├── scoringEngine.js
│  │  │  │  ├── scoringEngine.test.js
│  │  │  │  └── taskStore.js
│  │  │  └── webFrontendEval
│  │  │     ├── index.js
│  │  │     ├── index.test.js
│  │  │     ├── qcEngine.js
│  │  │     ├── qcEngine.test.js
│  │  │     ├── taskStore.js
│  │  │     ├── taskStore.test.js
│  │  │     ├── trajectoryPackager.js
│  │  │     └── trajectoryPackager.test.js
│  │  ├── project
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── issue
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── issueReport.js
│  │  │  │  ├── issueReport.test.js
│  │  │  │  └── khy.module.json
│  │  │  ├── management
│  │  │  │  ├── index.js
│  │  │  │  ├── managementRegistry.js
│  │  │  │  ├── parityGuard.js
│  │  │  │  ├── parityGuard.test.js
│  │  │  │  ├── resourceContract.js
│  │  │  │  ├── resourceContract.test.js
│  │  │  │  └── resources
│  │  │  │     ├── apiKeys.resource.js
│  │  │  │     ├── apiKeys.resource.test.js
│  │  │  │     ├── cron.resource.js
│  │  │  │     ├── cron.resource.test.js
│  │  │  │     ├── customProviders.resource.js
│  │  │  │     ├── dependencies.resource.js
│  │  │  │     ├── dependencies.resource.test.js
│  │  │  │     ├── modelConfig.resource.js
│  │  │  │     ├── modelOverrides.resource.js
│  │  │  │     └── users.resource.js
│  │  │  ├── metaplan
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── codeInterceptors.js
│  │  │  │  ├── codeInterceptors.test.js
│  │  │  │  ├── constitutionalRedLines.js
│  │  │  │  ├── constitutionalRedLines.test.js
│  │  │  │  ├── constraintInjection.js
│  │  │  │  ├── constraintInjection.test.js
│  │  │  │  ├── constraintStrategy.js
│  │  │  │  ├── constraintStrategy.test.js
│  │  │  │  ├── executorRegistry.js
│  │  │  │  ├── executorRegistry.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── index.test.js
│  │  │  │  ├── irreversibleSignatures.js
│  │  │  │  ├── irreversibleSignatures.test.js
│  │  │  │  ├── khy.module.json
│  │  │  │  ├── metaPlanSchema.js
│  │  │  │  ├── metaPlanSchema.test.js
│  │  │  │  ├── trustCircuitBreaker.js
│  │  │  │  └── trustCircuitBreaker.test.js
│  │  │  ├── projectBlueprint
│  │  │  │  ├── catalog.js
│  │  │  │  ├── catalog.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── milestonePlanner.js
│  │  │  │  ├── milestonePlanner.test.js
│  │  │  │  └── stackConflict.js
│  │  │  ├── projectCoherence
│  │  │  │  ├── coherenceAnalyzer.js
│  │  │  │  ├── coherenceGate.js
│  │  │  │  ├── coherenceGate.test.js
│  │  │  │  ├── deliverableClosure.js
│  │  │  │  ├── importGraph.js
│  │  │  │  ├── index.js
│  │  │  │  └── resolver.js
│  │  │  ├── projectHygiene
│  │  │  │  ├── duplicateModule.js
│  │  │  │  ├── godFile.js
│  │  │  │  ├── godFile.test.js
│  │  │  │  ├── index.js
│  │  │  │  ├── symbols.js
│  │  │  │  ├── thresholds.js
│  │  │  │  └── thresholds.test.js
│  │  │  └── workflow
│  │  │     ├── README.html
│  │  │     ├── README.md
│  │  │     ├── contractChecker.js
│  │  │     ├── contractChecker.test.js
│  │  │     ├── expandTemplate.js
│  │  │     ├── expandTemplate.test.js
│  │  │     ├── flowRegistry.js
│  │  │     ├── flowRegistry.test.js
│  │  │     ├── flowStats.js
│  │  │     ├── flowStats.test.js
│  │  │     ├── graphPatch.js
│  │  │     ├── graphPatch.test.js
│  │  │     ├── healGuard.js
│  │  │     ├── healGuard.test.js
│  │  │     ├── jsonExtract.js
│  │  │     ├── jsonExtract.test.js
│  │  │     ├── khy.module.json
│  │  │     ├── retryPrimitives.js
│  │  │     ├── retryPrimitives.test.js
│  │  │     ├── workflowCliCore.js
│  │  │     ├── workflowCliCore.test.js
│  │  │     ├── workflowExecutor.js
│  │  │     ├── workflowExecutor.test.js
│  │  │     ├── workflowRunWorker.js
│  │  │     └── workflowRunWorker.test.js
│  │  └── quality
│  │     ├── README.html
│  │     ├── README.md
│  │     ├── artifact
│  │     │  ├── README.html
│  │     │  ├── README.md
│  │     │  ├── artifactPlan.js
│  │     │  ├── artifactPlan.test.js
│  │     │  └── khy.module.json
│  │     ├── metaConstraint
│  │     │  ├── capabilityProbe.js
│  │     │  ├── constraintMatrix.js
│  │     │  ├── constraintMatrix.test.js
│  │     │  ├── index.js
│  │     │  ├── riskClassifier.js
│  │     │  └── toolFunnelGuard.js
│  │     └── perf
│  │        ├── README.html
│  │        ├── README.md
│  │        ├── khy.module.json
│  │        ├── perfReport.js
│  │        └── perfReport.test.js
│  └── tooling
│     ├── catalog
│     │  ├── README.html
│     │  ├── README.md
│     │  ├── capabilityMatrix
│     │  │  ├── README.html
│     │  │  ├── README.md
│     │  │  ├── composer.js
│     │  │  ├── composer.test.js
│     │  │  ├── descriptors.js
│     │  │  ├── descriptors.test.js
│     │  │  ├── index.js
│     │  │  ├── index.test.js
│     │  │  ├── khy.module.json
│     │  │  ├── predicates.js
│     │  │  ├── predicates.test.js
│     │  │  ├── route.js
│     │  │  ├── route.test.js
│     │  │  ├── routePresets.js
│     │  │  ├── routePresets.test.js
│     │  │  ├── seams.js
│     │  │  └── seams.test.js
│     │  ├── commandCatalog
│     │  │  ├── README.html
│     │  │  ├── README.md
│     │  │  ├── commandCatalog.js
│     │  │  ├── commandCatalog.test.js
│     │  │  └── khy.module.json
│     │  ├── toolCatalog
│     │  │  ├── README.html
│     │  │  ├── README.md
│     │  │  ├── auditRules.js
│     │  │  ├── auditRules.test.js
│     │  │  ├── khy.module.json
│     │  │  ├── toolCatalog.js
│     │  │  ├── toolCatalog.test.js
│     │  │  ├── toolContract.js
│     │  │  └── toolContract.test.js
│     │  └── toolUseLoop
│     │     ├── abortCascade.js
│     │     ├── abortCascade.test.js
│     │     ├── budgets.js
│     │     ├── budgets.test.js
│     │     ├── checkpointThrottle.js
│     │     ├── checkpointThrottle.test.js
│     │     ├── dedupLoopState.js
│     │     ├── dedupLoopState.test.js
│     │     ├── intentGuards.js
│     │     ├── intentGuards.test.js
│     │     ├── iterationJournal.js
│     │     ├── iterationJournal.test.js
│     │     ├── iterationSummary.js
│     │     ├── iterationSummary.test.js
│     │     ├── loopDetector.js
│     │     ├── loopDetector.test.js
│     │     ├── loopGuardState.js
│     │     ├── loopGuardState.test.js
│     │     ├── loopObservability.js
│     │     ├── loopObservability.test.js
│     │     ├── monitorState.js
│     │     ├── monitorState.test.js
│     │     ├── protocolContext.js
│     │     ├── protocolContext.test.js
│     │     ├── resolveToolCalls.js
│     │     └── resolveToolCalls.test.js
│     ├── extensions
│     │  ├── README.html
│     │  ├── README.md
│     │  ├── extensions
│     │  │  ├── extensionManager.js
│     │  │  ├── extensionManifest.js
│     │  │  ├── extensionRoots.js
│     │  │  ├── markdownWorkbench.js
│     │  │  ├── providerModule.js
│     │  │  ├── providerModule.test.js
│     │  │  └── quantApp.js
│     │  ├── hooks
│     │  │  ├── hookConfigSchema.js
│     │  │  ├── hookConfigSchema.test.js
│     │  │  ├── hookContribSeams.js
│     │  │  ├── hookContribSeams.test.js
│     │  │  ├── hookRegistry.js
│     │  │  ├── hookRegistry.test.js
│     │  │  ├── hookRunner.js
│     │  │  ├── hookRunner.test.js
│     │  │  ├── hookSystem.js
│     │  │  └── hookSystem.test.js
│     │  └── plugins
│     │     ├── README.html
│     │     ├── README.md
│     │     ├── khy.module.json
│     │     ├── pluginContribResolver.js
│     │     ├── pluginContribResolver.test.js
│     │     ├── pluginInvoker.js
│     │     ├── pluginInvoker.test.js
│     │     ├── pluginToolBridge.js
│     │     └── pluginToolBridge.test.js
│     └── gateway-stuff
│        ├── README.html
│        ├── README.md
│        └── gatewayLogLease
│           ├── context.js
│           ├── devLog.js
│           ├── index.js
│           ├── logLease.js
│           ├── logLease.test.js
│           ├── noiseFilter.js
│           └── sandbox.js
├── delivery
│  ├── artifact
│  │  ├── README.html
│  │  ├── README.md
│  │  ├── entries.json
│  │  └── launch.js
│  ├── channel
│  │  ├── build
│  │  │  ├── build-all.js
│  │  │  ├── dependency-map.json
│  │  │  ├── esbuild-modules.js
│  │  │  ├── native-modules.json
│  │  │  ├── pack-executable.js
│  │  │  ├── shims
│  │  │  │  └── react-devtools-core.mjs
│  │  │  └── verify-executable.js
│  │  ├── installer
│  │  │  ├── build_installer.js
│  │  │  ├── khyos_setup.nsi
│  │  │  └── khyos_uninstall.nsi
│  │  ├── khyquant
│  │  │  └── khyquant
│  │  │     ├── MANIFEST.in
│  │  │     ├── PACKAGING.html
│  │  │     ├── PACKAGING.md
│  │  │     ├── config
│  │  │     │  ├── database.js
│  │  │     │  └── referencePrices.js
│  │  │     ├── constants
│  │  │     │  └── models.js
│  │  │     ├── controllers
│  │  │     │  ├── comprehensiveDataController.js
│  │  │     │  ├── instrumentController.js
│  │  │     │  └── marketController.js
│  │  │     ├── frontend
│  │  │     │  ├── Dockerfile
│  │  │     │  ├── README.html
│  │  │     │  ├── README.md
│  │  │     │  ├── _md_test_out.txt
│  │  │     │  ├── capacitor.config.ts
│  │  │     │  ├── eslint.config.js
│  │  │     │  ├── generate-logos.cjs
│  │  │     │  ├── index.html
│  │  │     │  ├── ml-test.html
│  │  │     │  ├── nginx.conf
│  │  │     │  ├── package-lock.json
│  │  │     │  ├── package.json
│  │  │     │  ├── public
│  │  │     │  │  ├── apple-touch-icon-180x180.png
│  │  │     │  │  ├── assets
│  │  │     │  │  │  └── login-background.jpg
│  │  │     │  │  ├── dashboard-bg.jpg
│  │  │     │  │  ├── empty-state.jpg
│  │  │     │  │  ├── favicon-32x32.png
│  │  │     │  │  ├── icons
│  │  │     │  │  │  ├── book.svg
│  │  │     │  │  │  ├── chart-up.svg
│  │  │     │  │  │  ├── check.svg
│  │  │     │  │  │  ├── database.svg
│  │  │     │  │  │  ├── debug.svg
│  │  │     │  │  │  ├── error.svg
│  │  │     │  │  │  ├── info.svg
│  │  │     │  │  │  ├── success.svg
│  │  │     │  │  │  └── warning.svg
│  │  │     │  │  ├── logo.png
│  │  │     │  │  ├── logo.svg
│  │  │     │  │  ├── offline.html
│  │  │     │  │  ├── pwa-192x192.png
│  │  │     │  │  ├── pwa-512x512.png
│  │  │     │  │  ├── pwa-maskable-512x512.png
│  │  │     │  │  ├── robot-avatar.jpg
│  │  │     │  │  ├── school-badge.svg
│  │  │     │  │  └── wasm
│  │  │     │  │     └── khy-math-demo.wasm
│  │  │     │  ├── src
│  │  │     │  │  ├── App.vue
│  │  │     │  │  ├── __tests__
│  │  │     │  │  │  ├── CollapsiblePositionBar.test.js
│  │  │     │  │  │  ├── TradingAgentsBotSimple.test.js
│  │  │     │  │  │  ├── apiMarketData.test.js
│  │  │     │  │  │  ├── arrayGuards.test.js
│  │  │     │  │  │  ├── clientMode.test.js
│  │  │     │  │  │  ├── connectionMode.test.js
│  │  │     │  │  │  ├── dataSourceService.test.js
│  │  │     │  │  │  ├── device.test.js
│  │  │     │  │  │  ├── errorMessage.test.js
│  │  │     │  │  │  ├── example.test.js
│  │  │     │  │  │  ├── indicators.test.js
│  │  │     │  │  │  ├── interaction.wiring.test.js
│  │  │     │  │  │  ├── localEncrypt.test.js
│  │  │     │  │  │  ├── markdown.test.js
│  │  │     │  │  │  ├── marketDataService.test.js
│  │  │     │  │  │  ├── mobileChartConfig.test.js
│  │  │     │  │  │  ├── mobileUiCompliance.test.js
│  │  │     │  │  │  ├── networkMonitor.test.js
│  │  │     │  │  │  ├── performanceOptimizer.test.js
│  │  │     │  │  │  ├── priceDataService.test.js
│  │  │     │  │  │  ├── qrcode.test.js
│  │  │     │  │  │  ├── request.test.js
│  │  │     │  │  │  ├── requestInterceptor.test.js
│  │  │     │  │  │  ├── sandboxExecute.test.js
│  │  │     │  │  │  ├── simpleTradingHelpers.test.js
│  │  │     │  │  │  ├── simpleTradingMarketData.test.js
│  │  │     │  │  │  ├── simpleTradingSignalGenerator.test.js
│  │  │     │  │  │  ├── strategyStore.test.js
│  │  │     │  │  │  ├── tickCsvParser.test.js
│  │  │     │  │  │  ├── tvTime.test.js
│  │  │     │  │  │  ├── useChannelHealth.test.js
│  │  │     │  │  │  ├── useDashboardHandover.test.js
│  │  │     │  │  │  ├── useDashboardLanAccess.test.js
│  │  │     │  │  │  ├── useFuturesTickData.test.js
│  │  │     │  │  │  ├── useStreamChat.test.js
│  │  │     │  │  │  ├── userStore.test.js
│  │  │     │  │  │  └── websocketService.test.js
│  │  │     │  │  ├── api
│  │  │     │  │  │  ├── admin.js
│  │  │     │  │  │  ├── auth.js
│  │  │     │  │  │  ├── dependencies.js
│  │  │     │  │  │  ├── largeTasks.js
│  │  │     │  │  │  ├── manage.js
│  │  │     │  │  │  ├── marketData.js
│  │  │     │  │  │  ├── request.js
│  │  │     │  │  │  ├── strategy.js
│  │  │     │  │  │  └── trade.js
│  │  │     │  │  ├── assets
│  │  │     │  │  │  └── markdown.scss
│  │  │     │  │  ├── components
│  │  │     │  │  │  ├── ChannelHealthIndicator.vue
│  │  │     │  │  │  ├── CollapsiblePositionBar.vue
│  │  │     │  │  │  ├── DataSourceIndicator.vue
│  │  │     │  │  │  ├── EnhancedPositionsPanel.vue
│  │  │     │  │  │  ├── FirstLaunchLoader.vue
│  │  │     │  │  │  ├── GlobalErrorBoundary.vue
│  │  │     │  │  │  ├── IntelligentStrategySelector.vue
│  │  │     │  │  │  ├── JavaScriptEditor.vue
│  │  │     │  │  │  ├── LiveTradingCenter.vue
│  │  │     │  │  │  ├── MobileLayout.vue
│  │  │     │  │  │  ├── MobileNav.vue
│  │  │     │  │  │  ├── MobileToast.vue
│  │  │     │  │  │  ├── ModernTradingPanel.vue
│  │  │     │  │  │  ├── OfflineIndicator.vue
│  │  │     │  │  │  ├── ProfessionalTradeHistory.vue
│  │  │     │  │  │  ├── PwaUpdatePrompt.vue
│  │  │     │  │  │  ├── PythonEditor.vue
│  │  │     │  │  │  ├── RecentTradesPanel.vue
│  │  │     │  │  │  ├── SimpleTradingInterface.css
│  │  │     │  │  │  ├── SimpleTradingInterface.js
│  │  │     │  │  │  ├── SimpleTradingInterface.vue
│  │  │     │  │  │  ├── SyncNotification.vue
│  │  │     │  │  │  ├── TdxFormulaEditor.vue
│  │  │     │  │  │  └── TradingAgentsBotSimple.vue
│  │  │     │  │  ├── composables
│  │  │     │  │  │  ├── useChannelHealth.js
│  │  │     │  │  │  ├── useDashboardHandover.js
│  │  │     │  │  │  ├── useDashboardLanAccess.js
│  │  │     │  │  │  ├── useDashboardQuotes.js
│  │  │     │  │  │  ├── useFuturesTickData.js
│  │  │     │  │  │  ├── useOnlineStatus.js
│  │  │     │  │  │  ├── useResponsive.js
│  │  │     │  │  │  ├── useResponsive.ts
│  │  │     │  │  │  ├── useStreamChat.js
│  │  │     │  │  │  ├── useTouchGestures.js
│  │  │     │  │  │  └── useTouchGestures.ts
│  │  │     │  │  ├── config
│  │  │     │  │  │  └── api.js
│  │  │     │  │  ├── constants
│  │  │     │  │  │  └── serviceDefaults.js
│  │  │     │  │  ├── main.js
│  │  │     │  │  ├── plugins
│  │  │     │  │  │  └── pluginManager.js
│  │  │     │  │  ├── router
│  │  │     │  │  │  └── index.js
│  │  │     │  │  ├── services
│  │  │     │  │  │  ├── dataSourceService.js
│  │  │     │  │  │  ├── localAuthService.js
│  │  │     │  │  │  ├── marketDataService.js
│  │  │     │  │  │  ├── priceDataService.js
│  │  │     │  │  │  ├── wasm
│  │  │     │  │  │  │  └── wasmBridge.js
│  │  │     │  │  │  └── websocketService.js
│  │  │     │  │  ├── stores
│  │  │     │  │  │  ├── strategyStore.js
│  │  │     │  │  │  └── user.js
│  │  │     │  │  ├── styles
│  │  │     │  │  │  ├── mobile-scroll.css
│  │  │     │  │  │  ├── mobile.css
│  │  │     │  │  │  ├── responsive.css
│  │  │     │  │  │  └── theme.css
│  │  │     │  │  ├── utils
│  │  │     │  │  │  ├── aiFrontendEntry.js
│  │  │     │  │  │  ├── arrayGuards.js
│  │  │     │  │  │  ├── clientMode.js
│  │  │     │  │  │  ├── connectionMode.js
│  │  │     │  │  │  ├── device.js
│  │  │     │  │  │  ├── errorMessage.js
│  │  │     │  │  │  ├── indicators.js
│  │  │     │  │  │  ├── localEncrypt.js
│  │  │     │  │  │  ├── markdown.js
│  │  │     │  │  │  ├── mobileChartConfig.js
│  │  │     │  │  │  ├── mobileChartConfig.ts
│  │  │     │  │  │  ├── networkMonitor.js
│  │  │     │  │  │  ├── performanceOptimizer.js
│  │  │     │  │  │  ├── performanceOptimizer.ts
│  │  │     │  │  │  ├── qrcode.js
│  │  │     │  │  │  ├── request.js
│  │  │     │  │  │  ├── requestInterceptor.js
│  │  │     │  │  │  ├── sandboxExecute.js
│  │  │     │  │  │  ├── simpleTradingHelpers.js
│  │  │     │  │  │  ├── simpleTradingMarketData.js
│  │  │     │  │  │  ├── simpleTradingSignalGenerator.js
│  │  │     │  │  │  ├── tickCsvParser.js
│  │  │     │  │  │  └── tvTime.js
│  │  │     │  │  └── views
│  │  │     │  │     ├── AdminLayout.vue
│  │  │     │  │     ├── AdminLogin.vue
│  │  │     │  │     ├── Announcements.vue
│  │  │     │  │     ├── ApiKeyManage.vue
│  │  │     │  │     ├── Dashboard.vue
│  │  │     │  │     ├── Debug.vue
│  │  │     │  │     ├── DependencyManagement.vue
│  │  │     │  │     ├── Feedback.vue
│  │  │     │  │     ├── ForgotPassword.vue
│  │  │     │  │     ├── Layout.vue
│  │  │     │  │     ├── Login.vue
│  │  │     │  │     ├── Profile.vue
│  │  │     │  │     ├── Register.vue
│  │  │     │  │     ├── SystemManagement.vue
│  │  │     │  │     ├── Trading.css
│  │  │     │  │     ├── Trading.vue
│  │  │     │  │     └── admin
│  │  │     │  │        └── Dashboard.vue
│  │  │     │  ├── vite.config.js
│  │  │     │  └── vitest.config.js
│  │  │     ├── handlers
│  │  │     │  ├── bootstrap.js
│  │  │     │  ├── data.js
│  │  │     │  └── formatters.js
│  │  │     ├── indicators
│  │  │     │  └── indicators
│  │  │     │     ├── benchmark.js
│  │  │     │     ├── fastIndicators.js
│  │  │     │     └── index.js
│  │  │     ├── khy_quant
│  │  │     │  ├── __init__.py
│  │  │     │  ├── _bootstrap.py
│  │  │     │  ├── app.py
│  │  │     │  └── cli.py
│  │  │     ├── middleware
│  │  │     │  └── auth.js
│  │  │     ├── ml
│  │  │     │  ├── check_model_features.py
│  │  │     │  ├── config.yaml
│  │  │     │  ├── data_collector.py
│  │  │     │  ├── distillation
│  │  │     │  │  ├── __init__.py
│  │  │     │  │  └── generate_labels.py
│  │  │     │  ├── feature_engineer.py
│  │  │     │  ├── predict.py
│  │  │     │  ├── requirements-fixed.txt
│  │  │     │  ├── requirements.txt
│  │  │     │  ├── retrain_distilled.py
│  │  │     │  ├── retrain_with_18_features.py
│  │  │     │  ├── train_18_features.py
│  │  │     │  └── trainer.py
│  │  │     ├── models
│  │  │     │  ├── AIAccount.js
│  │  │     │  ├── AISuggestion.js
│  │  │     │  ├── Announcement.js
│  │  │     │  ├── AnnouncementRead.js
│  │  │     │  ├── ApiKey.js
│  │  │     │  ├── Backtest.js
│  │  │     │  ├── BankTransfer.js
│  │  │     │  ├── Conversation.js
│  │  │     │  ├── Feedback.js
│  │  │     │  ├── Instrument.js
│  │  │     │  ├── KlineCache.js
│  │  │     │  ├── KlineData.js
│  │  │     │  ├── MarketData.js
│  │  │     │  ├── MarketplacePlugin.js
│  │  │     │  ├── PromptTemplate.js
│  │  │     │  ├── Signal.js
│  │  │     │  ├── Strategy.js
│  │  │     │  ├── SystemSetting.js
│  │  │     │  ├── Trade.js
│  │  │     │  ├── User.js
│  │  │     │  ├── UserFavorite.js
│  │  │     │  ├── UserGatewayConfig.js
│  │  │     │  ├── UserInstalledPlugin.js
│  │  │     │  ├── UserLog.js
│  │  │     │  ├── UserProject.js
│  │  │     │  ├── UserProvider.js
│  │  │     │  ├── UserProviderModel.js
│  │  │     │  ├── UserWorkflow.js
│  │  │     │  ├── Watchlist.js
│  │  │     │  ├── WorkflowRun.js
│  │  │     │  └── index.js
│  │  │     ├── pyproject.toml
│  │  │     ├── routes
│  │  │     │  ├── backtest.js
│  │  │     │  ├── bankTransfer.js
│  │  │     │  ├── comprehensiveData.js
│  │  │     │  ├── dashboard.js
│  │  │     │  ├── favorites.js
│  │  │     │  ├── futuresTickData.js
│  │  │     │  ├── instrumentSync.js
│  │  │     │  ├── instruments.js
│  │  │     │  ├── klineData.js
│  │  │     │  ├── market.js
│  │  │     │  ├── marketData.js
│  │  │     │  ├── news.js
│  │  │     │  ├── replay.js
│  │  │     │  ├── stockProxy.js
│  │  │     │  ├── strategy.js
│  │  │     │  ├── tickBacktest.js
│  │  │     │  ├── trade.js
│  │  │     │  ├── trades.js
│  │  │     │  ├── tradingAgents.js
│  │  │     │  └── watchlist.js
│  │  │     ├── scripts
│  │  │     │  └── fetch_akshare_news.py
│  │  │     ├── services
│  │  │     │  ├── adataMarketService.py
│  │  │     │  ├── adataService.py
│  │  │     │  ├── agentDisplay.js
│  │  │     │  ├── akshareDataService.js
│  │  │     │  ├── akshareService.py
│  │  │     │  ├── akshareUpdater.js
│  │  │     │  ├── alternativeDataService.js
│  │  │     │  ├── apiKeyFormat.js
│  │  │     │  ├── backtestEngine.js
│  │  │     │  ├── cacheService.js
│  │  │     │  ├── comprehensiveDataService.js
│  │  │     │  ├── comprehensiveDataStaticConfig.js
│  │  │     │  ├── data_source.py
│  │  │     │  ├── efinanceService.py
│  │  │     │  ├── enhancedMockDataService.js
│  │  │     │  ├── finlightNewsService.js
│  │  │     │  ├── freeStockDataService.js
│  │  │     │  ├── futuresTickDataService.js
│  │  │     │  ├── gateway
│  │  │     │  │  ├── adapters
│  │  │     │  │  │  ├── _cacheUsage.js
│  │  │     │  │  │  ├── _imageCompat.js
│  │  │     │  │  │  └── _toolSchemaConverter.js
│  │  │     │  │  ├── glmVisionImageDownscale.js
│  │  │     │  │  ├── glmVisionMaxTokens.js
│  │  │     │  │  ├── glmVisionTextBudget.js
│  │  │     │  │  ├── modelToolingCapability.js
│  │  │     │  │  └── toolCapabilityStore.js
│  │  │     │  ├── get_all_index_codes.py
│  │  │     │  ├── get_all_instruments_by_type.py
│  │  │     │  ├── get_all_instruments_from_cache.py
│  │  │     │  ├── get_all_stock_codes.py
│  │  │     │  ├── get_instruments_stock_index_only.py
│  │  │     │  ├── ifindService.py
│  │  │     │  ├── instrumentService.js
│  │  │     │  ├── instrumentSyncService.js
│  │  │     │  ├── intelligentStrategyAdapter.js
│  │  │     │  ├── jsDataSources.js
│  │  │     │  ├── khyshareService.py
│  │  │     │  ├── klineDataService.js
│  │  │     │  ├── llmService.js
│  │  │     │  ├── marketDataService.js
│  │  │     │  ├── mlAgentService.js
│  │  │     │  ├── multiFreeService.js
│  │  │     │  ├── networkDetector.js
│  │  │     │  ├── notificationService.js
│  │  │     │  ├── pythonDataSourceService.js
│  │  │     │  ├── pythonStrategyEngine.js
│  │  │     │  ├── realtimeDataService.js
│  │  │     │  ├── sqliteBackupService.js
│  │  │     │  ├── stockAnalysisEngine.js
│  │  │     │  ├── strategyEngine.js
│  │  │     │  ├── strategyMonitor.js
│  │  │     │  ├── strategyRecommender.js
│  │  │     │  ├── streamUsageOptions.js
│  │  │     │  ├── tdxFormulaEngine.js
│  │  │     │  ├── tdxInterpreter.js
│  │  │     │  ├── tdxPythonBridge.js
│  │  │     │  ├── tickBacktestEngine.js
│  │  │     │  ├── tickDataAdapter.js
│  │  │     │  ├── tokenUsageService.js
│  │  │     │  ├── tradingAgentsService.js
│  │  │     │  ├── tushareService.py
│  │  │     │  └── zhipuRequestShape.js
│  │  │     ├── setup.py
│  │  │     ├── tests
│  │  │     │  ├── agentDisplay.test.js
│  │  │     │  ├── backtestEngine.test.js
│  │  │     │  └── tradingAgentsDisplay.test.js
│  │  │     ├── tools
│  │  │     │  ├── GoalTool.js
│  │  │     │  ├── LocalMemoryRecall.js
│  │  │     │  ├── MeshPeer.js
│  │  │     │  ├── PushNotify.js
│  │  │     │  ├── RecordProgress.js
│  │  │     │  ├── SaveInstruction.js
│  │  │     │  ├── SaveMemory.js
│  │  │     │  ├── SessionInsights.js
│  │  │     │  ├── VaultHttpFetch.js
│  │  │     │  ├── _baseTool.js
│  │  │     │  ├── _dbTimeout.js
│  │  │     │  ├── _execCompat.js
│  │  │     │  ├── _fileLock.js
│  │  │     │  ├── _readTracker.js
│  │  │     │  ├── _taskStore.js
│  │  │     │  ├── _toolResultNormalizer.js
│  │  │     │  ├── _toolTimeout.js
│  │  │     │  ├── _userDirs.js
│  │  │     │  ├── _walkBudget.js
│  │  │     │  ├── adoptRole.js
│  │  │     │  ├── analyzeBinary.js
│  │  │     │  ├── backgroundShellRegistry.js
│  │  │     │  ├── backtest.js
│  │  │     │  ├── bashCommentLabel.js
│  │  │     │  ├── buildProject.js
│  │  │     │  ├── ccOutputTruncate.js
│  │  │     │  ├── ccValidationError.js
│  │  │     │  ├── compileFile.js
│  │  │     │  ├── configureCapability.js
│  │  │     │  ├── configureErrorShape.js
│  │  │     │  ├── convertFile.js
│  │  │     │  ├── coverageReport.js
│  │  │     │  ├── createDocument.js
│  │  │     │  ├── dataFetch.js
│  │  │     │  ├── databaseQuery.js
│  │  │     │  ├── deploy.js
│  │  │     │  ├── docTitleStyle.js
│  │  │     │  ├── editFile.js
│  │  │     │  ├── executeCode.js
│  │  │     │  ├── exploreTool.js
│  │  │     │  ├── filePreReadHangGuard.js
│  │  │     │  ├── fileReadLimit.js
│  │  │     │  ├── forgeCodeSearch.js
│  │  │     │  ├── forgeCommits.js
│  │  │     │  ├── forgeRecon.js
│  │  │     │  ├── forgeSearch.js
│  │  │     │  ├── gitBlame.js
│  │  │     │  ├── gitClone.js
│  │  │     │  ├── gitCommit.js
│  │  │     │  ├── gitDiff.js
│  │  │     │  ├── gitLog.js
│  │  │     │  ├── gitPush.js
│  │  │     │  ├── gitStatus.js
│  │  │     │  ├── glob.js
│  │  │     │  ├── grep.js
│  │  │     │  ├── guardedReadFileSync.js
│  │  │     │  ├── httpRequest.js
│  │  │     │  ├── image2web.js
│  │  │     │  ├── imageDetect.js
│  │  │     │  ├── imageEdit.js
│  │  │     │  ├── imageGenerate.js
│  │  │     │  ├── imageOcr.js
│  │  │     │  ├── index.js
│  │  │     │  ├── inputValidators.js
│  │  │     │  ├── inspectDocument.js
│  │  │     │  ├── khyUpdate.js
│  │  │     │  ├── lintCode.js
│  │  │     │  ├── manageDeps.js
│  │  │     │  ├── news.js
│  │  │     │  ├── optimizeConfig.js
│  │  │     │  ├── pdfToWord.js
│  │  │     │  ├── platformUtils.js
│  │  │     │  ├── projectTemplate.js
│  │  │     │  ├── pseudoFileReadGuard.js
│  │  │     │  ├── pythonInvocationHint.js
│  │  │     │  ├── quote.js
│  │  │     │  ├── readBinaryGuard.js
│  │  │     │  ├── readFile.js
│  │  │     │  ├── readFileFormatRouter.js
│  │  │     │  ├── recognizeImage.js
│  │  │     │  ├── registrySearch.js
│  │  │     │  ├── renderDocument.js
│  │  │     │  ├── replaceAtLocation.js
│  │  │     │  ├── repoAudit.js
│  │  │     │  ├── reverseEngineer.js
│  │  │     │  ├── runTests.js
│  │  │     │  ├── scaffoldFiles.js
│  │  │     │  ├── search.js
│  │  │     │  ├── securityScan.js
│  │  │     │  ├── semanticNumberCoerce.js
│  │  │     │  ├── sendMessageTool.js
│  │  │     │  ├── shellClassifier.js
│  │  │     │  ├── shellCommand.js
│  │  │     │  ├── shellDiagnostics.js
│  │  │     │  ├── shellEmptyOutputNote.js
│  │  │     │  ├── shellErrorClassify.js
│  │  │     │  ├── shellExitSemantics.js
│  │  │     │  ├── shutdownTool.js
│  │  │     │  ├── specialFileReadGuard.js
│  │  │     │  ├── strategyList.js
│  │  │     │  ├── taskBlockedBySuffix.js
│  │  │     │  ├── taskMemorySection.js
│  │  │     │  ├── teammateBus.js
│  │  │     │  ├── toolProfile.js
│  │  │     │  ├── toolRecommend.js
│  │  │     │  ├── toolSearch.js
│  │  │     │  ├── unpackTool.js
│  │  │     │  ├── verifyArtifact.js
│  │  │     │  ├── videoAnalyze.js
│  │  │     │  ├── videoGenerate.js
│  │  │     │  ├── webSearch.js
│  │  │     │  ├── winCommandTranslate.js
│  │  │     │  ├── winDeviceReadGuard.js
│  │  │     │  └── writeFile.js
│  │  │     └── utils
│  │  │        ├── apiKeyHash.js
│  │  │        ├── fieldCrypto.js
│  │  │        ├── finiteNumber.js
│  │  │        ├── logger.js
│  │  │        └── pythonPath.js
│  │  ├── modules
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── entries
│  │  │  │  ├── khy-ai-entry.js
│  │  │  │  ├── khy-full-entry.js
│  │  │  │  ├── khy-gateway-entry.js
│  │  │  │  ├── khy-quant-entry.js
│  │  │  │  ├── khy-server-entry.js
│  │  │  │  ├── khy-tools-entry.js
│  │  │  │  └── standalone-info.js
│  │  │  ├── modules.json
│  │  │  └── runtime
│  │  │     ├── modeDetector.js
│  │  │     └── moduleProxy.js
│  │  ├── npm
│  │  │  ├── bin
│  │  │  │  └── khy.js
│  │  │  ├── package.json
│  │  │  ├── scripts
│  │  │  │  ├── assemble.js
│  │  │  │  ├── audit-purity.js
│  │  │  │  └── postinstall-compress.js
│  │  │  └── test
│  │  │     └── manifest-contract.test.js
│  │  └── pip
│  │     ├── MANIFEST.in
│  │     └── pyproject.toml
│  ├── desktop
│  │  └── khyos-desktop
│  │     └── khyos-desktop
│  │        ├── .build_run.cjs
│  │        ├── .launch_verify.cjs
│  │        ├── CLAUDE.html
│  │        ├── CLAUDE.md
│  │        ├── README.html
│  │        ├── README.md
│  │        ├── create-shortcut.bat
│  │        ├── create-shortcut.ps1
│  │        ├── dist-ts
│  │        │  ├── electron.vite.config.d.ts
│  │        │  ├── electron.vite.config.d.ts.map
│  │        │  ├── electron.vite.config.js
│  │        │  ├── src
│  │        │  │  ├── main
│  │        │  │  │  ├── agentItemStore.d.ts
│  │        │  │  │  ├── agentItemStore.d.ts.map
│  │        │  │  │  ├── agentItemStore.js
│  │        │  │  │  ├── automationStore.d.ts
│  │        │  │  │  ├── automationStore.d.ts.map
│  │        │  │  │  ├── automationStore.js
│  │        │  │  │  ├── index.d.ts
│  │        │  │  │  ├── index.d.ts.map
│  │        │  │  │  ├── index.js
│  │        │  │  │  ├── indexStore.d.ts
│  │        │  │  │  ├── indexStore.d.ts.map
│  │        │  │  │  ├── indexStore.js
│  │        │  │  │  ├── keyManager
│  │        │  │  │  │  ├── agentWriters.d.ts
│  │        │  │  │  │  ├── agentWriters.d.ts.map
│  │        │  │  │  │  ├── agentWriters.js
│  │        │  │  │  │  ├── audit.d.ts
│  │        │  │  │  │  ├── audit.d.ts.map
│  │        │  │  │  │  ├── audit.js
│  │        │  │  │  │  ├── health.d.ts
│  │        │  │  │  │  ├── health.d.ts.map
│  │        │  │  │  │  ├── health.js
│  │        │  │  │  │  ├── ipc.d.ts
│  │        │  │  │  │  ├── ipc.d.ts.map
│  │        │  │  │  │  ├── ipc.js
│  │        │  │  │  │  ├── keyStore.d.ts
│  │        │  │  │  │  ├── keyStore.d.ts.map
│  │        │  │  │  │  ├── keyStore.js
│  │        │  │  │  │  ├── proxyStatus.d.ts
│  │        │  │  │  │  ├── proxyStatus.d.ts.map
│  │        │  │  │  │  ├── proxyStatus.js
│  │        │  │  │  │  ├── types.d.ts
│  │        │  │  │  │  ├── types.d.ts.map
│  │        │  │  │  │  └── types.js
│  │        │  │  │  ├── keyManagerWindow.d.ts
│  │        │  │  │  ├── keyManagerWindow.d.ts.map
│  │        │  │  │  ├── keyManagerWindow.js
│  │        │  │  │  ├── mcpStore.d.ts
│  │        │  │  │  ├── mcpStore.d.ts.map
│  │        │  │  │  ├── mcpStore.js
│  │        │  │  │  ├── menu.d.ts
│  │        │  │  │  ├── menu.d.ts.map
│  │        │  │  │  ├── menu.js
│  │        │  │  │  ├── pluginStore.d.ts
│  │        │  │  │  ├── pluginStore.d.ts.map
│  │        │  │  │  ├── pluginStore.js
│  │        │  │  │  ├── settingsStore.d.ts
│  │        │  │  │  ├── settingsStore.d.ts.map
│  │        │  │  │  └── settingsStore.js
│  │        │  │  ├── preload
│  │        │  │  │  ├── index.d.ts
│  │        │  │  │  ├── index.d.ts.map
│  │        │  │  │  └── index.js
│  │        │  │  └── shared
│  │        │  │     └── rpc
│  │        │  │        ├── channels.d.ts
│  │        │  │        ├── channels.d.ts.map
│  │        │  │        └── channels.js
│  │        │  └── tsconfig.node.tsbuildinfo
│  │        ├── docs
│  │        │  ├── [DESIGN-ARCH-092] ZCode 1：1 复刻设计文档.html
│  │        │  ├── [DESIGN-ARCH-092] ZCode 1：1 复刻设计文档.md
│  │        │  ├── [ZC-ALIGN-001] ZCode 1：1 复刻失真点记录与对齐方案.html
│  │        │  ├── [ZC-ALIGN-001] ZCode 1：1 复刻失真点记录与对齐方案.md
│  │        │  ├── [ZC-ALIGN-002] ZCode 页面与弹窗穷举清单（computer-use 核对）.html
│  │        │  ├── [ZC-ALIGN-002] ZCode 页面与弹窗穷举清单（computer-use 核对）.md
│  │        │  ├── [ZC-ALIGN-003] ZCode 设置页逐项对齐补充（第四轮实测）.html
│  │        │  ├── [ZC-ALIGN-003] ZCode 设置页逐项对齐补充（第四轮实测）.md
│  │        │  ├── extract_asar.py
│  │        │  ├── parse_asar.py
│  │        │  ├── search_all_js.py
│  │        │  ├── search_complete.py
│  │        │  ├── search_context.cjs
│  │        │  ├── search_css.py
│  │        │  ├── search_detailed.py
│  │        │  ├── search_detailed2.py
│  │        │  ├── search_final.py
│  │        │  ├── search_intl.py
│  │        │  ├── search_js.py
│  │        │  ├── search_main_js.py
│  │        │  ├── search_mention_ui.py
│  │        │  ├── search_mentions.py
│  │        │  ├── search_mentions2.py
│  │        │  ├── search_patterns.cjs
│  │        │  ├── search_patterns.py
│  │        │  ├── search_subagent_ui.py
│  │        │  ├── search_targeted.py
│  │        │  ├── search_thinking.py
│  │        │  ├── search_thought_levels.py
│  │        │  ├── search_thought_levels_full.py
│  │        │  ├── search_thought_levels_full2.py
│  │        │  ├── search_thought_options.py
│  │        │  ├── search_thought_options2.py
│  │        │  ├── search_thought_options3.py
│  │        │  └── zcode-pages
│  │        │     ├── 01-常规.png
│  │        │     ├── 02-外观.png
│  │        │     ├── 03-模型设置.png
│  │        │     ├── 04-浏览器控制.png
│  │        │     ├── 05-电脑控制.png
│  │        │     ├── 06-记忆.png
│  │        │     ├── 07-子智能体.png
│  │        │     ├── 08-插件.png
│  │        │     ├── 08b-插件tab.png
│  │        │     ├── 09-MCP服务器.png
│  │        │     ├── 10-技能tab.png
│  │        │     ├── 11-命令.png
│  │        │     ├── 11b-命令列表.png
│  │        │     ├── 12-钩子.png
│  │        │     ├── 12b-钩子列表.png
│  │        │     ├── 13-索引库.png
│  │        │     ├── 14-使用统计.png
│  │        │     ├── 15-引导.png
│  │        │     ├── 15b-引导迁移向导.png
│  │        │     ├── 16-账户菜单.png
│  │        │     ├── 17-账户-语言子菜单.png
│  │        │     ├── 18-账户-缩放子菜单.png
│  │        │     └── shot.ps1
│  │        ├── electron.vite.config.ts
│  │        ├── index.html
│  │        ├── launcher
│  │        │  ├── KhyOS Desktop.lnk
│  │        │  ├── khyos.ico
│  │        │  └── start-khyos.cmd
│  │        ├── out
│  │        │  ├── host
│  │        │  │  ├── icon-512.png
│  │        │  │  ├── icon.ico
│  │        │  │  └── index.js
│  │        │  ├── main
│  │        │  │  └── index.js
│  │        │  ├── preload
│  │        │  │  └── index.js
│  │        │  ├── renderer
│  │        │  │  └── index.html
│  │        │  └── scheduler
│  │        │     ├── icon-512.png
│  │        │     ├── icon.ico
│  │        │     └── index.js
│  │        ├── package-lock.json
│  │        ├── package.json
│  │        ├── public
│  │        │  ├── icon-512.png
│  │        │  └── icon.ico
│  │        ├── resources
│  │        │  └── icon
│  │        │     └── icon.ico
│  │        ├── scripts
│  │        │  ├── ci
│  │        │  │  └── brand-replace.cjs
│  │        │  ├── dev-clean.cjs
│  │        │  ├── generate-icon.cjs
│  │        │  ├── scan-asar-utf8.cjs
│  │        │  └── scan-asar.cjs
│  │        ├── src
│  │        │  ├── host
│  │        │  │  └── index.ts
│  │        │  ├── main
│  │        │  │  ├── agentItemStore.ts
│  │        │  │  ├── automationStore.ts
│  │        │  │  ├── index.ts
│  │        │  │  ├── indexStore.ts
│  │        │  │  ├── keyManager
│  │        │  │  │  ├── agentWriters.ts
│  │        │  │  │  ├── audit.ts
│  │        │  │  │  ├── health.ts
│  │        │  │  │  ├── ipc.ts
│  │        │  │  │  ├── keyStore.ts
│  │        │  │  │  ├── proxyStatus.ts
│  │        │  │  │  └── types.ts
│  │        │  │  ├── keyManagerWindow.ts
│  │        │  │  ├── mcpStore.ts
│  │        │  │  ├── pluginStore.ts
│  │        │  │  └── settingsStore.ts
│  │        │  ├── preload
│  │        │  │  └── index.ts
│  │        │  ├── renderer
│  │        │  │  ├── App.tsx
│  │        │  │  ├── components
│  │        │  │  │  ├── auth
│  │        │  │  │  │  └── LoginPage.tsx
│  │        │  │  │  ├── automations
│  │        │  │  │  │  └── AutomationsPage.tsx
│  │        │  │  │  ├── browser
│  │        │  │  │  │  └── BrowserPane.tsx
│  │        │  │  │  ├── composer
│  │        │  │  │  │  ├── AttachmentList.tsx
│  │        │  │  │  │  ├── Composer.tsx
│  │        │  │  │  │  └── ModeSelector.tsx
│  │        │  │  │  ├── filetree
│  │        │  │  │  │  └── FileTree.tsx
│  │        │  │  │  ├── git
│  │        │  │  │  │  └── GitPanel.tsx
│  │        │  │  │  ├── keyManager
│  │        │  │  │  │  └── KeyManagerPage.tsx
│  │        │  │  │  ├── layout
│  │        │  │  │  │  ├── AppLayout.tsx
│  │        │  │  │  │  ├── ProcessMonitorDialog.tsx
│  │        │  │  │  │  ├── SidePane.tsx
│  │        │  │  │  │  ├── Sidebar.tsx
│  │        │  │  │  │  ├── StatusBar.tsx
│  │        │  │  │  │  ├── TitleBar.tsx
│  │        │  │  │  │  ├── WorkspaceSidebar.tsx
│  │        │  │  │  │  └── usePanelWidth.ts
│  │        │  │  │  ├── message
│  │        │  │  │  │  ├── AppHeader.tsx
│  │        │  │  │  │  ├── CommandCenter.tsx
│  │        │  │  │  │  ├── ContextUsage.tsx
│  │        │  │  │  │  ├── DiffViewer.tsx
│  │        │  │  │  │  ├── ElicitationPanel.tsx
│  │        │  │  │  │  ├── GoalBanner.tsx
│  │        │  │  │  │  ├── MarkdownRenderer.tsx
│  │        │  │  │  │  ├── MessageBubble.tsx
│  │        │  │  │  │  └── ToolExecutionPanel.tsx
│  │        │  │  │  ├── selection
│  │        │  │  │  │  └── SelectionChatPane.tsx
│  │        │  │  │  ├── settings
│  │        │  │  │  │  ├── AppearanceSettings.tsx
│  │        │  │  │  │  ├── BrowserCuaSettings.tsx
│  │        │  │  │  │  ├── GeneralSettings.tsx
│  │        │  │  │  │  ├── IndexSettingsPage.tsx
│  │        │  │  │  │  ├── ListSettingsPage.tsx
│  │        │  │  │  │  ├── McpSettings.tsx
│  │        │  │  │  │  ├── OnboardingDialog.tsx
│  │        │  │  │  │  ├── OnboardingSettings.tsx
│  │        │  │  │  │  ├── PluginSettings.tsx
│  │        │  │  │  │  ├── SettingsPage.tsx
│  │        │  │  │  │  └── UsageSettings.tsx
│  │        │  │  │  ├── terminal
│  │        │  │  │  │  └── Terminal.tsx
│  │        │  │  │  ├── ui
│  │        │  │  │  │  ├── EmptyState.tsx
│  │        │  │  │  │  ├── ErrorBoundary.tsx
│  │        │  │  │  │  ├── ProgressBar.tsx
│  │        │  │  │  │  ├── Spinner.tsx
│  │        │  │  │  │  ├── Toast.tsx
│  │        │  │  │  │  ├── ToastContainer.tsx
│  │        │  │  │  │  ├── Tooltip.tsx
│  │        │  │  │  │  ├── pacedProgress.ts
│  │        │  │  │  │  └── usePacedPercent.ts
│  │        │  │  │  ├── viewer
│  │        │  │  │  │  ├── CodeViewerPane.tsx
│  │        │  │  │  │  └── OpenFilePane.tsx
│  │        │  │  │  └── workspace
│  │        │  │  │     └── WorkspacePicker.tsx
│  │        │  │  ├── i18n
│  │        │  │  │  ├── index.ts
│  │        │  │  │  └── zh-CN.json
│  │        │  │  ├── index.html
│  │        │  │  ├── keyManager
│  │        │  │  │  └── api.ts
│  │        │  │  ├── main.tsx
│  │        │  │  ├── shared
│  │        │  │  │  └── keymap.ts
│  │        │  │  ├── state
│  │        │  │  │  ├── messageSlice.ts
│  │        │  │  │  ├── permissionSlice.ts
│  │        │  │  │  ├── store.ts
│  │        │  │  │  ├── toastSlice.ts
│  │        │  │  │  ├── toolExecutionSlice.ts
│  │        │  │  │  └── workspaceSlice.ts
│  │        │  │  ├── theme
│  │        │  │  │  ├── globals.css
│  │        │  │  │  └── theme.ts
│  │        │  │  └── utils
│  │        │  │     ├── openWorkspace.ts
│  │        │  │     ├── settingsMigration.ts
│  │        │  │     ├── stripSystemInjects.ts
│  │        │  │     ├── useKeyboard.ts
│  │        │  │     └── useModelCatalog.ts
│  │        │  ├── scheduler
│  │        │  │  └── index.ts
│  │        │  └── shared
│  │        │     └── rpc
│  │        │        └── channels.ts
│  │        ├── start-dev.bat
│  │        ├── tests
│  │        │  ├── agentWriters.test.mjs
│  │        │  ├── desktopUiContract.test.cjs
│  │        │  ├── health.test.mjs
│  │        │  ├── keyManagerContract.test.cjs
│  │        │  ├── keyStore.test.mjs
│  │        │  ├── keymapContract.test.mjs
│  │        │  ├── pacedProgress.test.mjs
│  │        │  └── wiringRuntime.test.mjs
│  │        ├── tsconfig.json
│  │        ├── tsconfig.node.json
│  │        ├── tsconfig.tsbuildinfo
│  │        ├── vite.config.js
│  │        ├── vite.host.config.ts
│  │        ├── vite.scheduler.config.ts
│  │        └── zcode-analysis
│  │           ├── asar-extract.cjs
│  │           ├── asar-inspect.cjs
│  │           ├── check-structure.cjs
│  │           ├── count-namespaces.cjs
│  │           ├── css-tokens.cjs
│  │           ├── extract-i18n.cjs
│  │           ├── extract-ipc.cjs
│  │           ├── extract-rpc.cjs
│  │           ├── i18n-zh.json
│  │           ├── i18n-zh.jsonl
│  │           ├── i18n-zh.tsv
│  │           ├── i18n-zh.txt
│  │           ├── ipc-channels.json
│  │           ├── ipc-channels.tsv
│  │           ├── rpc-surface.json
│  │           ├── rpc-surface.tsv
│  │           ├── show-group.cjs
│  │           ├── tokens.txt
│  │           ├── unpacked
│  │           │  ├── out
│  │           │  │  ├── host
│  │           │  │  │  └── index.js
│  │           │  │  ├── main
│  │           │  │  │  └── index.js
│  │           │  │  ├── metadata
│  │           │  │  │  └── build-meta.json
│  │           │  │  ├── preload
│  │           │  │  │  └── index.cjs
│  │           │  │  ├── renderer
│  │           │  │  │  └── assets
│  │           │  │  │     ├── IntlProvider-Db46X9QF.js
│  │           │  │  │     └── styles-t2tKjMWX.css
│  │           │  │  └── scheduler
│  │           │  │     └── index.js
│  │           │  └── package.json
│  │           └── verify-doc-claims.cjs
│  ├── extension
│  │  ├── bridges
│  │  │  └── khy-trae-bridge
│  │  │     ├── README.html
│  │  │     ├── README.md
│  │  │     ├── extension.js
│  │  │     ├── khy-trae-bridge-0.2.1.vsix
│  │  │     ├── khy.extension.json
│  │  │     ├── package-lock.json
│  │  │     └── package.json
│  │  ├── scripts
│  │  │  ├── khy-alpine-iso
│  │  │  │  ├── Dockerfile.iso-builder
│  │  │  │  ├── build-iso-docker.ps1
│  │  │  │  ├── build-iso-docker.sh
│  │  │  │  ├── build-iso-windows.ps1
│  │  │  │  ├── build-khy-os-iso.sh
│  │  │  │  ├── khy.extension.json
│  │  │  │  ├── rootfs
│  │  │  │  │  └── etc
│  │  │  │  │     ├── conf.d
│  │  │  │  │     │  └── khy-os-backend
│  │  │  │  │     ├── init.d
│  │  │  │  │     │  ├── khy-os-backend
│  │  │  │  │     │  └── khy-os-console
│  │  │  │  │     └── logrotate.d
│  │  │  │  │        └── khy-os
│  │  │  │  └── windows-iso-preflight.ps1
│  │  │  ├── khy-desktop-rd
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── chatml
│  │  │  │  │  ├── ARCHITECTURE.html
│  │  │  │  │  ├── ARCHITECTURE.md
│  │  │  │  │  ├── README.html
│  │  │  │  │  └── README.md
│  │  │  │  ├── cmdk
│  │  │  │  │  ├── README.html
│  │  │  │  │  └── README.md
│  │  │  │  ├── goose
│  │  │  │  │  ├── README.html
│  │  │  │  │  ├── README.md
│  │  │  │  │  ├── main-pattern-extract.ts
│  │  │  │  │  └── package.json
│  │  │  │  ├── khy.extension.json
│  │  │  │  ├── one-api
│  │  │  │  │  ├── App.js
│  │  │  │  │  ├── README.html
│  │  │  │  │  └── README.md
│  │  │  │  └── openflux
│  │  │  │     ├── Cargo.toml
│  │  │  │     ├── README.html
│  │  │  │     ├── README.md
│  │  │  │     ├── lib.rs
│  │  │  │     ├── package.json
│  │  │  │     ├── scripts
│  │  │  │     │  └── copy-installer.cjs
│  │  │  │     └── tauri.conf.json
│  │  │  ├── khy-diagnostics
│  │  │  │  ├── bench
│  │  │  │  │  ├── ab-compare.js
│  │  │  │  │  ├── ab-dual-dev.js
│  │  │  │  │  ├── git_spawn_bench.js
│  │  │  │  │  ├── hw_probe_spawn_bench.js
│  │  │  │  │  ├── startup_ab_bench.js
│  │  │  │  │  ├── startup_probe_cost_bench.js
│  │  │  │  │  ├── startup_spawn_bench.py
│  │  │  │  │  └── win_cost_compact.js
│  │  │  │  ├── fuzz-file-input.js
│  │  │  │  ├── fuzz-file-io.js
│  │  │  │  ├── fuzz-input-round1.js
│  │  │  │  ├── fuzz-input.js
│  │  │  │  ├── fuzz-video-io.js
│  │  │  │  ├── fuzzFileCorpus.js
│  │  │  │  ├── fuzzInputCorpus.js
│  │  │  │  ├── fuzzVideoCorpus.js
│  │  │  │  ├── hydration-doctor.js
│  │  │  │  ├── inspect-ccswitch.js
│  │  │  │  ├── khy.extension.json
│  │  │  │  ├── model-type-providers.js
│  │  │  │  ├── storage-baseline.js
│  │  │  │  └── triage.js
│  │  │  ├── khy-installer
│  │  │  │  ├── check-boot-capability.sh
│  │  │  │  ├── deploy-server.sh
│  │  │  │  ├── dev-install.py
│  │  │  │  ├── install-git-hooks.js
│  │  │  │  ├── install-khy-cli.sh
│  │  │  │  ├── install-khy.sh
│  │  │  │  ├── khy.extension.json
│  │  │  │  ├── setup
│  │  │  │  │  ├── README.html
│  │  │  │  │  ├── README.md
│  │  │  │  │  ├── diagnose-gateway.bat
│  │  │  │  │  ├── first-time-setup.bat
│  │  │  │  │  ├── fix-model-menu.bat
│  │  │  │  │  ├── setup-khy-command.ps1
│  │  │  │  │  ├── setup-khy.bat
│  │  │  │  │  ├── start-all.bat
│  │  │  │  │  └── start-backend.bat
│  │  │  │  └── verify-install.js
│  │  │  ├── khy-portable
│  │  │  │  ├── artifact-manifest.js
│  │  │  │  ├── bucket-sessions-by-project.js
│  │  │  │  ├── build-portable-artifact.js
│  │  │  │  ├── build-usb-portable.sh
│  │  │  │  ├── consolidate-khy-data.js
│  │  │  │  ├── install-path-wrappers.bat
│  │  │  │  ├── install-path-wrappers.sh
│  │  │  │  ├── install-portable-cli.sh
│  │  │  │  ├── khy.extension.json
│  │  │  │  ├── khytogo
│  │  │  │  │  └── make-khytogo.sh
│  │  │  │  ├── migrate-trajectories-to-khy-sessions.js
│  │  │  │  ├── pack-portable.js
│  │  │  │  ├── package-portable.js
│  │  │  │  ├── portable-health-check.js
│  │  │  │  ├── portable-sync.js
│  │  │  │  ├── relocate-khy-data-to-project-root.js
│  │  │  │  ├── repair-portable.js
│  │  │  │  ├── run-portable.bat
│  │  │  │  ├── run-portable.sh
│  │  │  │  └── run.ps1
│  │  │  └── khy-qoder-bridge
│  │  │     ├── install_autostart.ps1
│  │  │     ├── khy.extension.json
│  │  │     └── start_qoder_bridge.ps1
│  │  └── tools
│  │     ├── khy-dsh-compat
│  │     │  ├── index.js
│  │     │  ├── installed.json
│  │     │  ├── khy.extension.json
│  │     │  ├── lib
│  │     │  │  └── importPlugin.js
│  │     │  └── test
│  │     │     └── compat.test.js
│  │     ├── khy-markdown
│  │     │  ├── .npmignore
│  │     │  ├── KhyosMarkdown.cs
│  │     │  ├── KhyosMarkdown.exe
│  │     │  ├── README.html
│  │     │  ├── README.md
│  │     │  ├── khy.extension.json
│  │     │  ├── khyos-md-bridge.js
│  │     │  ├── khyos-md-launch.vbs
│  │     │  ├── khyos-md-mcp.js
│  │     │  ├── khyosMarkdown.html
│  │     │  ├── khyosMarkdown.ico
│  │     │  ├── khyosMarkdown.png
│  │     │  ├── khyosmarkdown
│  │     │  ├── khyosmarkdown.command
│  │     │  ├── muya-embed
│  │     │  │  ├── build.mjs
│  │     │  │  ├── ensure-vendor.mjs
│  │     │  │  ├── entry.mjs
│  │     │  │  ├── package-lock.json
│  │     │  │  ├── package.json
│  │     │  │  └── stubs
│  │     │  │     └── file-icons
│  │     │  │        ├── index.js
│  │     │  │        └── package.json
│  │     │  ├── package.json
│  │     │  ├── register-linux.sh
│  │     │  ├── register-windows.ps1
│  │     │  ├── test
│  │     │  │  ├── bridge.test.js
│  │     │  │  ├── mcp-smoke.js
│  │     │  │  └── parser.test.js
│  │     │  ├── unregister-linux.sh
│  │     │  └── unregister-windows.ps1
│  │     └── khy-notebook
│  │        ├── index.js
│  │        └── khy.extension.json
│  ├── mobile
│  │  └── khy-os-client-app
│  │     └── khy-os-client-app
│  │        ├── .gitignore
│  │        ├── .metadata
│  │        ├── README.html
│  │        ├── README.md
│  │        ├── analysis_options.yaml
│  │        ├── android
│  │        │  ├── .gitignore
│  │        │  ├── app
│  │        │  │  ├── build.gradle
│  │        │  │  └── src
│  │        │  │     ├── debug
│  │        │  │     │  └── AndroidManifest.xml
│  │        │  │     ├── main
│  │        │  │     │  ├── AndroidManifest.xml
│  │        │  │     │  ├── kotlin
│  │        │  │     │  │  └── com
│  │        │  │     │  │     └── khyos
│  │        │  │     │  │        └── khy_os_client
│  │        │  │     │  │           ├── KhyAccessibilityService.kt
│  │        │  │     │  │           ├── MainActivity.kt
│  │        │  │     │  │           ├── ScreenCaptureService.kt
│  │        │  │     │  │           └── ShizukuServiceManager.kt
│  │        │  │     │  └── res
│  │        │  │     │     ├── drawable
│  │        │  │     │     │  └── launch_background.xml
│  │        │  │     │     ├── drawable-v21
│  │        │  │     │     │  └── launch_background.xml
│  │        │  │     │     ├── mipmap-hdpi
│  │        │  │     │     │  └── ic_launcher.png
│  │        │  │     │     ├── mipmap-mdpi
│  │        │  │     │     │  └── ic_launcher.png
│  │        │  │     │     ├── mipmap-xhdpi
│  │        │  │     │     │  └── ic_launcher.png
│  │        │  │     │     ├── mipmap-xxhdpi
│  │        │  │     │     │  └── ic_launcher.png
│  │        │  │     │     ├── mipmap-xxxhdpi
│  │        │  │     │     │  └── ic_launcher.png
│  │        │  │     │     ├── values
│  │        │  │     │     │  ├── strings.xml
│  │        │  │     │     │  └── styles.xml
│  │        │  │     │     ├── values-night
│  │        │  │     │     │  └── styles.xml
│  │        │  │     │     └── xml
│  │        │  │     │        ├── accessibility_service_config.xml
│  │        │  │     │        └── file_paths.xml
│  │        │  │     └── profile
│  │        │  │        └── AndroidManifest.xml
│  │        │  ├── build.gradle.kts
│  │        │  ├── gradle
│  │        │  │  └── wrapper
│  │        │  │     └── gradle-wrapper.properties
│  │        │  ├── gradle.properties
│  │        │  └── settings.gradle.kts
│  │        ├── lib
│  │        │  ├── core
│  │        │  │  ├── agent
│  │        │  │  │  ├── agent_loop.dart
│  │        │  │  │  ├── execution_log.dart
│  │        │  │  │  └── semantic_state.dart
│  │        │  │  ├── config
│  │        │  │  │  ├── app_config.dart
│  │        │  │  │  ├── built_in_keys.dart
│  │        │  │  │  ├── model_registry.dart
│  │        │  │  │  └── provider_presets.dart
│  │        │  │  ├── gateway
│  │        │  │  │  ├── ai_gateway.dart
│  │        │  │  │  ├── khyos_api.dart
│  │        │  │  │  ├── pairing.dart
│  │        │  │  │  └── provider_adapter.dart
│  │        │  │  ├── network
│  │        │  │  │  ├── dns_resolver.dart
│  │        │  │  │  ├── network_autofix.dart
│  │        │  │  │  ├── network_diagnostic.dart
│  │        │  │  │  └── smart_dns.dart
│  │        │  │  ├── router.dart
│  │        │  │  ├── services
│  │        │  │  │  ├── app_logger.dart
│  │        │  │  │  ├── conversation_db.dart
│  │        │  │  │  ├── device_control.dart
│  │        │  │  │  ├── file_service.dart
│  │        │  │  │  ├── shell_executor.dart
│  │        │  │  │  └── vision_service.dart
│  │        │  │  └── tools
│  │        │  │     ├── android_tool.dart
│  │        │  │     ├── builtin_tools.dart
│  │        │  │     ├── retry_engine.dart
│  │        │  │     ├── skills.dart
│  │        │  │     ├── tool_engine.dart
│  │        │  │     └── tool_protocol.dart
│  │        │  ├── data
│  │        │  │  └── models
│  │        │  │     └── models.dart
│  │        │  ├── main.dart
│  │        │  └── ui
│  │        │     ├── screens
│  │        │     │  ├── agent_screen.dart
│  │        │     │  ├── agent_screen_new.dart
│  │        │     │  ├── chat_screen.dart
│  │        │     │  ├── chat_screen_new.dart
│  │        │     │  ├── connection_screen.dart
│  │        │     │  ├── device_screen_new.dart
│  │        │     │  ├── home_shell.dart
│  │        │     │  ├── independent_screen.dart
│  │        │     │  ├── log_viewer_screen.dart
│  │        │     │  ├── longcat_chat_screen.dart
│  │        │     │  ├── network_diagnostic_screen.dart
│  │        │     │  ├── qr_scan_screen.dart
│  │        │     │  ├── settings_screen.dart
│  │        │     │  ├── settings_screen_new.dart
│  │        │     │  ├── skills_screen.dart
│  │        │     │  ├── skills_screen_new.dart
│  │        │     │  └── trading_panel_screen.dart
│  │        │     ├── theme
│  │        │     │  ├── app_colors.dart
│  │        │     │  └── app_theme.dart
│  │        │     └── widgets
│  │        │        └── tool_card.dart
│  │        ├── pubspec.lock
│  │        ├── pubspec.yaml
│  │        └── test
│  │           ├── agent_loop_test.dart
│  │           ├── app_config_test.dart
│  │           ├── builtin_tools_message_test.dart
│  │           ├── device_control_test.dart
│  │           ├── network_autofix_test.dart
│  │           ├── pairing_test.dart
│  │           ├── shell_commands_test.dart
│  │           ├── shizuku_test.dart
│  │           ├── skills_test.dart
│  │           ├── tool_card_test.dart
│  │           ├── tool_engine_test.dart
│  │           ├── tool_protocol_test.dart
│  │           └── widget_test.dart
│  └── web
│     ├── ai-frontend
│     │  └── ai-frontend
│     │     ├── .env.example
│     │     ├── .eslintrc.cjs
│     │     ├── .gitignore
│     │     ├── .prettierrc
│     │     ├── COMPLETION_REPORT.html
│     │     ├── COMPLETION_REPORT.md
│     │     ├── Dockerfile
│     │     ├── README.html
│     │     ├── README.md
│     │     ├── backendDiscovery.mjs
│     │     ├── frontendRuntime.mjs
│     │     ├── index.html
│     │     ├── nginx.conf
│     │     ├── package-lock.json
│     │     ├── package.json
│     │     ├── scripts
│     │     │  ├── accept-stack.mjs
│     │     │  ├── check-env-example.mjs
│     │     │  ├── lint.mjs
│     │     │  └── sync-md-vendor.mjs
│     │     ├── src
│     │     │  ├── App.vue
│     │     │  ├── __tests__
│     │     │  │  ├── a11yContract.test.js
│     │     │  │  ├── designTokenCompliance.test.js
│     │     │  │  ├── elementPlusCompat.contract.test.js
│     │     │  │  ├── themeParity.test.js
│     │     │  │  ├── useGatewayPayments.test.js
│     │     │  │  └── vitest.sanity.test.js
│     │     │  ├── api
│     │     │  │  ├── auth.js
│     │     │  │  ├── auth.test.js
│     │     │  │  ├── authedFetch.js
│     │     │  │  ├── ccSwitch.js
│     │     │  │  ├── channelApis.js
│     │     │  │  ├── guiEval.js
│     │     │  │  ├── largeTasks.js
│     │     │  │  ├── loadError.js
│     │     │  │  ├── loadError.test.js
│     │     │  │  ├── notify.js
│     │     │  │  ├── request.js
│     │     │  │  ├── unwrap.js
│     │     │  │  ├── unwrap.test.js
│     │     │  │  ├── unwrap.wiring.test.js
│     │     │  │  ├── webFrontendEval.js
│     │     │  │  ├── webauthn.js
│     │     │  │  └── webauthn.test.js
│     │     │  ├── auth
│     │     │  │  ├── permissions.js
│     │     │  │  └── roles.js
│     │     │  ├── components
│     │     │  │  ├── ClarifyCard.vue
│     │     │  │  ├── GlobalProgressBar.vue
│     │     │  │  ├── KhyAvatar.vue
│     │     │  │  ├── KhyEmpty.vue
│     │     │  │  ├── KhyFloatBall.vue
│     │     │  │  ├── KhyIcon.test.js
│     │     │  │  ├── KhyIcon.vue
│     │     │  │  ├── KhyLogo.vue
│     │     │  │  ├── KhyPageHeader.vue
│     │     │  │  ├── LoadErrorBanner.vue
│     │     │  │  ├── __tests__
│     │     │  │  │  ├── CustomProviderCard.contract.test.js
│     │     │  │  │  ├── KhyFloatBall.contract.test.js
│     │     │  │  │  ├── ProviderConfigDialog.contract.test.js
│     │     │  │  │  └── componentContract.wiring.test.js
│     │     │  │  ├── gateway
│     │     │  │  │  ├── CcAccessCard.vue
│     │     │  │  │  ├── CustomProviderCard.vue
│     │     │  │  │  ├── GatewayOnboarding.vue
│     │     │  │  │  ├── ImageModelCard.vue
│     │     │  │  │  ├── MyModelsCard.vue
│     │     │  │  │  ├── ProviderConfigDialog.vue
│     │     │  │  │  ├── ProviderLinks.vue
│     │     │  │  │  ├── RelayConfigCard.vue
│     │     │  │  │  ├── customProviderForm.js
│     │     │  │  │  ├── customProviderForm.test.js
│     │     │  │  │  ├── gatewayGuide.js
│     │     │  │  │  └── gatewayGuide.test.js
│     │     │  │  └── workflow
│     │     │  │     ├── NodeField.vue
│     │     │  │     ├── NodePalette.vue
│     │     │  │     ├── NodePropertiesPanel.vue
│     │     │  │     ├── WorkflowCanvas.vue
│     │     │  │     ├── graphAdapters.js
│     │     │  │     └── nodes
│     │     │  │        └── BaseNode.vue
│     │     │  ├── composables
│     │     │  │  ├── gatewayInlineEdit.js
│     │     │  │  ├── gatewayInlineEdit.test.js
│     │     │  │  ├── useAIMonitor.js
│     │     │  │  ├── useAccountPool.js
│     │     │  │  ├── useAgentDashboard.js
│     │     │  │  ├── useAssetCustomer.js
│     │     │  │  ├── useAssetCustomer.test.js
│     │     │  │  ├── useCcSwitch.js
│     │     │  │  ├── useCcSwitch.test.js
│     │     │  │  ├── useChatConversations.js
│     │     │  │  ├── useConfigSync.js
│     │     │  │  ├── useConfigSync.test.js
│     │     │  │  ├── useDaemonHealth.js
│     │     │  │  ├── useFileSync.js
│     │     │  │  ├── useFileSync.test.js
│     │     │  │  ├── useGateway.js
│     │     │  │  ├── useGateway.test.js
│     │     │  │  ├── useGatewayBilling.js
│     │     │  │  ├── useGatewayPayments.js
│     │     │  │  ├── useGeolocation.js
│     │     │  │  ├── useGlobalLoading.js
│     │     │  │  ├── useMarketplace.js
│     │     │  │  ├── useMarketplace.test.js
│     │     │  │  ├── useModalFocus.js
│     │     │  │  ├── useModalFocus.test.js
│     │     │  │  ├── useModelPivots.js
│     │     │  │  ├── useModelPivots.test.js
│     │     │  │  ├── useProjects.js
│     │     │  │  ├── useProjects.wiring.test.js
│     │     │  │  ├── usePromptLibrary.js
│     │     │  │  ├── useProxies.egress.wiring.test.js
│     │     │  │  ├── useProxies.js
│     │     │  │  ├── useProxies.test.js
│     │     │  │  ├── useRoutePrefetch.js
│     │     │  │  ├── useTheme.js
│     │     │  │  ├── useUserGateway.js
│     │     │  │  ├── useUserGateway.test.js
│     │     │  │  ├── useWorkflow.js
│     │     │  │  ├── useWorkflow.wiring.test.js
│     │     │  │  ├── useWxBinding.js
│     │     │  │  └── useWxBinding.test.js
│     │     │  ├── layouts
│     │     │  │  ├── AppShell.vue
│     │     │  │  └── PublicLayout.vue
│     │     │  ├── main.js
│     │     │  ├── nav
│     │     │  │  └── index.js
│     │     │  ├── router
│     │     │  │  ├── adminBase.js
│     │     │  │  ├── index.js
│     │     │  │  └── nav.wiring.test.js
│     │     │  ├── services
│     │     │  │  └── crossPlatform
│     │     │  │     ├── crossPlatformClient.js
│     │     │  │     └── shared
│     │     │  │        ├── crossPlatformHub.cjs
│     │     │  │        ├── notifier.js
│     │     │  │        ├── protocol.cjs
│     │     │  │        ├── protocol.js
│     │     │  │        ├── sessionSyncService.cjs
│     │     │  │        ├── wsClientCore.cjs
│     │     │  │        ├── wsClientCore.js
│     │     │  │        └── wsClientCore.test.js
│     │     │  ├── stores
│     │     │  │  ├── crossPlatform.js
│     │     │  │  ├── guiEval.js
│     │     │  │  ├── user.js
│     │     │  │  ├── webFrontendEval.js
│     │     │  │  └── workflowEditor.js
│     │     │  ├── styles
│     │     │  │  └── newapi-theme.css
│     │     │  ├── utils
│     │     │  │  ├── attachmentView.js
│     │     │  │  ├── attachmentView.test.js
│     │     │  │  ├── classifyKhyError.mjs
│     │     │  │  ├── classifyKhyError.test.js
│     │     │  │  ├── describeFailure.js
│     │     │  │  ├── describeFailure.test.js
│     │     │  │  ├── formatTimestamp.js
│     │     │  │  ├── formatTimestamp.test.js
│     │     │  │  ├── modelBadges.js
│     │     │  │  ├── modelBadges.test.js
│     │     │  │  ├── safeRedirect.js
│     │     │  │  ├── safeRedirect.test.js
│     │     │  │  ├── safeStorage.js
│     │     │  │  ├── safeStorage.test.js
│     │     │  │  ├── ws.js
│     │     │  │  └── ws.test.js
│     │     │  └── views
│     │     │     ├── AIChat.vue
│     │     │     ├── AdminLayout.vue
│     │     │     ├── AgentStatePanel.vue
│     │     │     ├── CozeImportDialog.vue
│     │     │     ├── FeatureCatalog.vue
│     │     │     ├── Forbidden.vue
│     │     │     ├── ForgotPassword.vue
│     │     │     ├── KhyOsDesktop.vue
│     │     │     ├── KhyOsTerminal.vue
│     │     │     ├── Layout.vue
│     │     │     ├── Login.vue
│     │     │     ├── Markdown.vue
│     │     │     ├── Marketplace.vue
│     │     │     ├── MyGateway.vue
│     │     │     ├── NotAuthenticated.vue
│     │     │     ├── NotFound.vue
│     │     │     ├── Projects.vue
│     │     │     ├── PromptLibrary.vue
│     │     │     ├── ProxyManagement.vue
│     │     │     ├── Security.vue
│     │     │     ├── ServerError.vue
│     │     │     ├── UserHome.vue
│     │     │     ├── WorkflowEditor.vue
│     │     │     ├── Workflows.vue
│     │     │     ├── admin
│     │     │     │  ├── AIAssetsCustomers.vue
│     │     │     │  ├── AIDashboard.vue
│     │     │     │  ├── AIGateway.vue
│     │     │     │  ├── AIMonitor.vue
│     │     │     │  ├── AIPayments.vue
│     │     │     │  ├── AccountPool.vue
│     │     │     │  ├── AgentDashboard.vue
│     │     │     │  ├── BridgeChannels.vue
│     │     │     │  ├── ChannelApiEditor.vue
│     │     │     │  ├── ChannelApis.vue
│     │     │     │  ├── GuiEvalDashboard.vue
│     │     │     │  ├── GuiEvalRunDetail.vue
│     │     │     │  ├── GuiEvalRuns.vue
│     │     │     │  ├── GuiEvalTaskEditor.vue
│     │     │     │  ├── GuiEvalTasks.vue
│     │     │     │  ├── Pricing.vue
│     │     │     │  ├── Settings.vue
│     │     │     │  ├── TaskBoard.vue
│     │     │     │  ├── TrafficMonitor
│     │     │     │  │  └── index.vue
│     │     │     │  ├── UsageLogs.vue
│     │     │     │  ├── WebFrontendEvalDashboard.vue
│     │     │     │  ├── WebFrontendEvalRunDetail.vue
│     │     │     │  ├── WebFrontendEvalRuns.vue
│     │     │     │  ├── WebFrontendEvalTaskEditor.vue
│     │     │     │  ├── WebFrontendEvalTasks.vue
│     │     │     │  ├── WxBinding.vue
│     │     │     │  └── gateway
│     │     │     │     └── GatewayMonitorPanel.vue
│     │     │     ├── aiChatEventUtils.js
│     │     │     ├── aiChatEventUtils.toolEvents.test.js
│     │     │     ├── chatAttachments.wiring.test.js
│     │     │     ├── chatInputPaste.wiring.test.js
│     │     │     ├── components
│     │     │     │  ├── ChatConvRow.vue
│     │     │     │  ├── ChatInputBar.vue
│     │     │     │  ├── ChatPartsRenderer.vue
│     │     │     │  └── MessageAttachment.vue
│     │     │     ├── interaction.wiring.test.js
│     │     │     ├── toolOutputSections.js
│     │     │     └── toolOutputSections.test.js
│     │     ├── test
│     │     │  ├── adminBase.test.mjs
│     │     │  ├── backendDiscovery.test.mjs
│     │     │  ├── debug-page.cjs
│     │     │  ├── input-lag-e2e.cjs
│     │     │  ├── input-lag.test.js
│     │     │  └── webBackendDiscovery.test.mjs
│     │     ├── vite.config.js
│     │     ├── vite.config.js.timestamp-1789957335018-e8635f872fa44.mjs
│     │     ├── vite.config.js.timestamp-1790123653267-c1e736cfc7eaf.mjs
│     │     ├── vite.config.js.timestamp-1790124145320-83db522268f09.mjs
│     │     ├── vite.config.js.timestamp-1790124352831-5f4202511f4bc.mjs
│     │     └── vite.config.js.timestamp-1790124706547-65ae8d1b091a3.mjs
│     └── provider-hub
│        └── provider-hub
│           ├── .build-tmp
│           │  ├── main
│           │  │  └── index.js
│           │  ├── preload
│           │  │  └── index.cjs
│           │  └── renderer
│           │     ├── app.js
│           │     └── index.html
│           ├── electron.vite.config.1790238272970.mjs
│           ├── electron.vite.config.1790238291707.mjs
│           ├── electron.vite.config.1790238642419.mjs
│           ├── electron.vite.config.ts
│           ├── package-lock.json
│           ├── package.json
│           ├── scripts
│           │  └── acceptance.mjs
│           ├── src
│           │  ├── main
│           │  │  ├── index.ts
│           │  │  ├── ipc.ts
│           │  │  ├── modelCatalog.ts
│           │  │  ├── providers.ts
│           │  │  ├── proxyStatus.ts
│           │  │  ├── toolWriters.ts
│           │  │  ├── tray.ts
│           │  │  ├── types.ts
│           │  │  └── usage.ts
│           │  ├── preload
│           │  │  └── index.ts
│           │  └── renderer
│           │     ├── app.js
│           │     ├── index.html
│           │     └── styles.css
│           ├── tests
│           │  ├── contract.test.cjs
│           │  ├── failover.test.mjs
│           │  ├── modelCatalog.test.mjs
│           │  ├── providers.test.mjs
│           │  └── usage.test.mjs
│           └── tsconfig.json
├── runtime
│  ├── .npmrc
│  ├── .portable
│  ├── ai-backend
│  │  └── d
│  │     ├── .eslintrc.json
│  │     ├── .gitignore
│  │     ├── .npmrc
│  │     ├── .prettierrc
│  │     ├── Dockerfile
│  │     ├── package.json
│  │     ├── scripts
│  │     │  └── reset-admin-password.js
│  │     ├── server.js
│  │     ├── src
│  │     │  ├── config
│  │     │  │  ├── database.js
│  │     │  │  └── env.js
│  │     │  ├── constants
│  │     │  │  ├── models.js
│  │     │  │  └── serviceDefaults.js
│  │     │  ├── middleware
│  │     │  │  └── auth.js
│  │     │  ├── routes
│  │     │  │  ├── ai.js
│  │     │  │  ├── aiGatewayAdmin.js
│  │     │  │  ├── auth.js
│  │     │  │  ├── marketplace.js
│  │     │  │  ├── mdWorkbench.js
│  │     │  │  ├── news.js
│  │     │  │  ├── plugins.js
│  │     │  │  ├── tasks.js
│  │     │  │  ├── userGateway.js
│  │     │  │  └── workflow.js
│  │     │  ├── scripts
│  │     │  │  └── fetch_akshare_news.py
│  │     │  ├── services
│  │     │  │  ├── accountPool.js
│  │     │  │  ├── aiAssetCustomerService.js
│  │     │  │  ├── aiMonitor.js
│  │     │  │  ├── apiKeyPool.js
│  │     │  │  ├── cacheService.js
│  │     │  │  ├── cloudSync.js
│  │     │  │  ├── concurrencySlots.js
│  │     │  │  ├── cozeImportService.js
│  │     │  │  ├── customerUsageService.js
│  │     │  │  ├── gateway
│  │     │  │  │  ├── adapters
│  │     │  │  │  │  ├── apiAdapter.js
│  │     │  │  │  │  ├── claudeAdapter.js
│  │     │  │  │  │  ├── cliToolAdapter.js
│  │     │  │  │  │  ├── clipboardRelayAdapter.js
│  │     │  │  │  │  ├── codexAdapter.js
│  │     │  │  │  │  ├── cursorAdapter.js
│  │     │  │  │  │  ├── ideDetector.js
│  │     │  │  │  │  ├── ipAnonymizer.js
│  │     │  │  │  │  ├── kiroAdapter.js
│  │     │  │  │  │  ├── ollamaAdapter.js
│  │     │  │  │  │  ├── relayApiAdapter.js
│  │     │  │  │  │  ├── traeAdapter.js
│  │     │  │  │  │  ├── vscodeAdapter.js
│  │     │  │  │  │  └── webRelayAdapter.js
│  │     │  │  │  ├── aiGateway.js
│  │     │  │  │  ├── appLaunchInterceptor.js
│  │     │  │  │  ├── dataPlaneEnforcer.js
│  │     │  │  │  ├── oauthManager.js
│  │     │  │  │  ├── pluginChain.js
│  │     │  │  │  ├── protocolConverter
│  │     │  │  │  │  └── index.js
│  │     │  │  │  ├── proxyServer.js
│  │     │  │  │  ├── rateLimiter.js
│  │     │  │  │  ├── relayPage.js
│  │     │  │  │  ├── tlsSidecar
│  │     │  │  │  │  ├── index.js
│  │     │  │  │  │  ├── installer.js
│  │     │  │  │  │  └── sidecar.go
│  │     │  │  │  ├── userGatewayResolver.js
│  │     │  │  │  ├── userModelCatalogGraph.js
│  │     │  │  │  └── userModelDetectionService.js
│  │     │  │  ├── growthService.js
│  │     │  │  ├── inputPreprocessor.js
│  │     │  │  ├── knowledgeTeachingService.js
│  │     │  │  ├── llmService.js
│  │     │  │  ├── loginKeyResolver.js
│  │     │  │  ├── marketplaceService.js
│  │     │  │  ├── mcpClient.js
│  │     │  │  ├── modelTrainingService.js
│  │     │  │  ├── nvidiaModelService.js
│  │     │  │  ├── ollamaModelManager.js
│  │     │  │  ├── planModeService.js
│  │     │  │  ├── pluginImportService.js
│  │     │  │  ├── pluginService.js
│  │     │  │  ├── pricingService.js
│  │     │  │  ├── projectMemoryService.js
│  │     │  │  ├── promptLibraryService.js
│  │     │  │  ├── requestLogService.js
│  │     │  │  ├── securityGuardService.js
│  │     │  │  ├── selfOptimizer.js
│  │     │  │  ├── skillLearningService.js
│  │     │  │  ├── skillRegistry.js
│  │     │  │  ├── smartAIService.js
│  │     │  │  ├── stockAnalysisEngine.js
│  │     │  │  ├── taskSyncStore.js
│  │     │  │  ├── tokenUsageService.js
│  │     │  │  ├── toolCalling.js
│  │     │  │  ├── userGatewayConfigService.js
│  │     │  │  ├── webSearchService.js
│  │     │  │  ├── workflowExportService.js
│  │     │  │  ├── workflowGenerateService.js
│  │     │  │  ├── workflowRunService.js
│  │     │  │  └── workflowService.js
│  │     │  └── utils
│  │     │     ├── dataHome.js
│  │     │     ├── logger.js
│  │     │     ├── pythonPath.js
│  │     │     └── reqUserId.js
│  │     └── test
│  │        ├── ai.fetch.test.js
│  │        ├── catalogPrompt.test.js
│  │        ├── dataPlane.userRouting.test.js
│  │        ├── fixtures
│  │        │  └── coze
│  │        │     ├── sample-linear.zip
│  │        │     ├── sample-table.container
│  │        │     └── sample-table.json
│  │        ├── mdWorkbench.route.test.js
│  │        ├── modelTrainingService.fetch.test.js
│  │        ├── plugins.service.test.js
│  │        ├── reqUserId.test.js
│  │        ├── stockAnalysisEngine.fetch.test.js
│  │        ├── tasks.routes.test.js
│  │        ├── userGateway.routes.test.js
│  │        ├── userGatewayCatalog.route.test.js
│  │        ├── userGatewayConfigService.ensureSchema.test.js
│  │        ├── userGatewayConfigService.updateProvider.test.js
│  │        ├── userGatewayModels.route.test.js
│  │        ├── userGatewayPresets.route.test.js
│  │        ├── userModelCatalogGraph.test.js
│  │        ├── userModelDetectionService.test.js
│  │        ├── workflow.cozeGallery.test.js
│  │        ├── workflow.cozeImport.test.js
│  │        ├── workflow.routes.test.js
│  │        ├── workflowExport.test.js
│  │        ├── workflowGenerate.test.js
│  │        └── workflowRun.routes.test.js
│  ├── bin
│  │  ├── install-khy.ps1
│  │  ├── khy-cli.bat
│  │  ├── khy.bat
│  │  ├── khy.sh
│  │  ├── portable-setup.bat
│  │  └── portable-setup.sh
│  ├── boot
│  │  ├── kernel
│  │  │  ├── Dockerfile.kernel-build
│  │  │  ├── Makefile
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── boot
│  │  │  │  ├── boot.asm
│  │  │  │  ├── context_switch.asm
│  │  │  │  ├── isr.asm
│  │  │  │  ├── long_mode.asm
│  │  │  │  └── usermode.asm
│  │  │  ├── bridge
│  │  │  │  ├── README-联调.html
│  │  │  │  ├── README-联调.md
│  │  │  │  ├── index.js
│  │  │  │  ├── khy-agent-run.js
│  │  │  │  ├── khy-agent.js
│  │  │  │  ├── khy-brain-gateway.js
│  │  │  │  ├── khy-bridge.js
│  │  │  │  ├── khy-frame.js
│  │  │  │  ├── khy-mcp.js
│  │  │  │  ├── khy-protocol.js
│  │  │  │  └── khy-tools.js
│  │  │  ├── docs
│  │  │  │  ├── 小白教程-Khyos-agent协同从零精讲.html
│  │  │  │  ├── 小白教程-Khyos-agent协同从零精讲.md
│  │  │  │  ├── 架构-agent-os双向协议.html
│  │  │  │  ├── 架构-agent-os双向协议.md
│  │  │  │  ├── 进度交接-内核与agent协同pivot.html
│  │  │  │  └── 进度交接-内核与agent协同pivot.md
│  │  │  ├── iso
│  │  │  │  └── boot
│  │  │  │     ├── grub
│  │  │  │     │  └── grub.cfg
│  │  │  │     └── limine
│  │  │  │        └── limine.conf
│  │  │  ├── linker.ld
│  │  │  ├── moonbit
│  │  │  │  ├── _build
│  │  │  │  │  └── .moon-lock
│  │  │  │  ├── lib
│  │  │  │  │  └── khy_kernel
│  │  │  │  │     ├── main.mbt
│  │  │  │  │     └── moon.pkg.json
│  │  │  │  └── moon.mod.json
│  │  │  ├── src
│  │  │  │  ├── agentask.c
│  │  │  │  ├── agentask.h
│  │  │  │  ├── agentbus.c
│  │  │  │  ├── agentbus.h
│  │  │  │  ├── agentconf.c
│  │  │  │  ├── agentconf.h
│  │  │  │  ├── agentctl.c
│  │  │  │  ├── agentctl.h
│  │  │  │  ├── agentevent.c
│  │  │  │  ├── agentevent.h
│  │  │  │  ├── agentframe.c
│  │  │  │  ├── agentframe.h
│  │  │  │  ├── ata.c
│  │  │  │  ├── ata.h
│  │  │  │  ├── capability.c
│  │  │  │  ├── capability.h
│  │  │  │  ├── cjk_font16.h
│  │  │  │  ├── console.c
│  │  │  │  ├── console.h
│  │  │  │  ├── desktop.c
│  │  │  │  ├── desktop.h
│  │  │  │  ├── diskfs.c
│  │  │  │  ├── diskfs.h
│  │  │  │  ├── elf.c
│  │  │  │  ├── elf.h
│  │  │  │  ├── framebuffer.c
│  │  │  │  ├── framebuffer.h
│  │  │  │  ├── gdt.c
│  │  │  │  ├── gdt.h
│  │  │  │  ├── idt.c
│  │  │  │  ├── idt.h
│  │  │  │  ├── ipc.c
│  │  │  │  ├── ipc.h
│  │  │  │  ├── keyboard.c
│  │  │  │  ├── keyboard.h
│  │  │  │  ├── kheap.c
│  │  │  │  ├── kheap.h
│  │  │  │  ├── main.c
│  │  │  │  ├── moonbit_bridge.c
│  │  │  │  ├── moonbit_bridge.h
│  │  │  │  ├── moonbit_os_api.c
│  │  │  │  ├── moonbit_os_api.h
│  │  │  │  ├── mouse.c
│  │  │  │  ├── mouse.h
│  │  │  │  ├── net.c
│  │  │  │  ├── net.h
│  │  │  │  ├── net_service.c
│  │  │  │  ├── net_service.h
│  │  │  │  ├── pe.c
│  │  │  │  ├── pe.h
│  │  │  │  ├── persist.c
│  │  │  │  ├── persist.h
│  │  │  │  ├── pic.c
│  │  │  │  ├── pic.h
│  │  │  │  ├── pmm.c
│  │  │  │  ├── pmm.h
│  │  │  │  ├── process.c
│  │  │  │  ├── process.h
│  │  │  │  ├── ramfs.c
│  │  │  │  ├── ramfs.h
│  │  │  │  ├── rtc.c
│  │  │  │  ├── rtc.h
│  │  │  │  ├── sched.c
│  │  │  │  ├── sched.h
│  │  │  │  ├── serial.c
│  │  │  │  ├── serial.h
│  │  │  │  ├── shell.c
│  │  │  │  ├── shell.h
│  │  │  │  ├── string.c
│  │  │  │  ├── string.h
│  │  │  │  ├── syscall.c
│  │  │  │  ├── syscall.h
│  │  │  │  ├── timer.c
│  │  │  │  ├── timer.h
│  │  │  │  ├── user_argv_blob.h
│  │  │  │  ├── user_atimetest_blob.h
│  │  │  │  ├── user_badptr_blob.h
│  │  │  │  ├── user_cowtest_blob.h
│  │  │  │  ├── user_cwdtest_blob.h
│  │  │  │  ├── user_dirfdtest_blob.h
│  │  │  │  ├── user_dirtest_blob.h
│  │  │  │  ├── user_dup2test_blob.h
│  │  │  │  ├── user_exectest_blob.h
│  │  │  │  ├── user_fault_blob.h
│  │  │  │  ├── user_filetest_blob.h
│  │  │  │  ├── user_forktest_blob.h
│  │  │  │  ├── user_forkwait_blob.h
│  │  │  │  ├── user_init_blob.h
│  │  │  │  ├── user_linktest_blob.h
│  │  │  │  ├── user_lseektest_blob.h
│  │  │  │  ├── user_mmaptest_blob.h
│  │  │  │  ├── user_mtimetest_blob.h
│  │  │  │  ├── user_pipedst_blob.h
│  │  │  │  ├── user_pipesrc_blob.h
│  │  │  │  ├── user_pipetest_blob.h
│  │  │  │  ├── user_proctest_blob.h
│  │  │  │  ├── user_ptimetest_blob.h
│  │  │  │  ├── user_readtest_blob.h
│  │  │  │  ├── user_renametest_blob.h
│  │  │  │  ├── user_rmtest_blob.h
│  │  │  │  ├── user_siginttest_blob.h
│  │  │  │  ├── user_sigtest_blob.h
│  │  │  │  ├── user_spinbare_blob.h
│  │  │  │  ├── user_spintest_blob.h
│  │  │  │  ├── user_stackgrow_blob.h
│  │  │  │  ├── user_stattest_blob.h
│  │  │  │  ├── user_stdiotest_blob.h
│  │  │  │  ├── user_timetest_blob.h
│  │  │  │  ├── user_trunctest_blob.h
│  │  │  │  ├── user_usertest_blob.h
│  │  │  │  ├── user_vmtest_blob.h
│  │  │  │  ├── vfs.c
│  │  │  │  ├── vfs.h
│  │  │  │  ├── vfs_service.c
│  │  │  │  ├── vfs_service.h
│  │  │  │  ├── vga.c
│  │  │  │  ├── vga.h
│  │  │  │  ├── vmm.c
│  │  │  │  ├── vmm.h
│  │  │  │  ├── wincompat.c
│  │  │  │  ├── wincompat.h
│  │  │  │  ├── wm.c
│  │  │  │  └── wm.h
│  │  │  ├── tools
│  │  │  │  ├── agentbus_ask_test.py
│  │  │  │  ├── agentbus_brain_resolve_test.js
│  │  │  │  ├── agentbus_bridge_test.js
│  │  │  │  ├── agentbus_ctl_test.py
│  │  │  │  ├── agentbus_dualagent_test.js
│  │  │  │  ├── agentbus_echo_test.py
│  │  │  │  ├── agentbus_event_test.py
│  │  │  │  ├── agentbus_frame_test.py
│  │  │  │  ├── agentbus_gateway_brain_test.js
│  │  │  │  ├── agentbus_nl_test.js
│  │  │  │  ├── gen-cjk-font.py
│  │  │  │  ├── provision-builder-vm.sh
│  │  │  │  └── test-preemption.c
│  │  │  ├── tools_gen_blob.sh
│  │  │  ├── userland
│  │  │  │  ├── argv.asm
│  │  │  │  ├── atimetest.asm
│  │  │  │  ├── badptr.asm
│  │  │  │  ├── cowtest.asm
│  │  │  │  ├── cwdtest.asm
│  │  │  │  ├── dirfdtest.asm
│  │  │  │  ├── dirtest.asm
│  │  │  │  ├── dup2test.asm
│  │  │  │  ├── exectest.asm
│  │  │  │  ├── fault.asm
│  │  │  │  ├── filetest.asm
│  │  │  │  ├── forktest.asm
│  │  │  │  ├── forkwait.asm
│  │  │  │  ├── init.asm
│  │  │  │  ├── linktest.asm
│  │  │  │  ├── lseektest.asm
│  │  │  │  ├── mmaptest.asm
│  │  │  │  ├── mtimetest.asm
│  │  │  │  ├── pipedst.asm
│  │  │  │  ├── pipesrc.asm
│  │  │  │  ├── pipetest.asm
│  │  │  │  ├── proctest.asm
│  │  │  │  ├── ptimetest.asm
│  │  │  │  ├── readtest.asm
│  │  │  │  ├── renametest.asm
│  │  │  │  ├── rmtest.asm
│  │  │  │  ├── siginttest.asm
│  │  │  │  ├── sigtest.asm
│  │  │  │  ├── spinbare.asm
│  │  │  │  ├── spintest.asm
│  │  │  │  ├── stackgrow.asm
│  │  │  │  ├── stattest.asm
│  │  │  │  ├── stdiotest.asm
│  │  │  │  ├── timetest.asm
│  │  │  │  ├── trunctest.asm
│  │  │  │  ├── usertest.asm
│  │  │  │  └── vmtest.asm
│  │  │  └── vendor
│  │  │     └── moonbit
│  │  │        ├── PROVENANCE.html
│  │  │        ├── PROVENANCE.md
│  │  │        ├── include
│  │  │        │  ├── moonbit-fundamental.h
│  │  │        │  └── moonbit.h
│  │  │        ├── moonbit_gen.c
│  │  │        └── runtime.c
│  │  └── platform
│  │     ├── delivery
│  │     │  ├── AGENTS_PROMPT_BEST_PRACTICES.html
│  │     │  ├── AGENTS_PROMPT_BEST_PRACTICES.md
│  │     │  ├── README.html
│  │     │  ├── README.md
│  │     │  ├── adapters
│  │     │  │  ├── apiAdapter.js
│  │     │  │  ├── baseAdapter.js
│  │     │  │  ├── emailAdapter.js
│  │     │  │  ├── index.js
│  │     │  │  ├── markdownAdapter.js
│  │     │  │  ├── notionAdapter.js
│  │     │  │  ├── promiseTimeout.js
│  │     │  │  ├── prompts
│  │     │  │  │  ├── api.prompt.html
│  │     │  │  │  ├── api.prompt.md
│  │     │  │  │  ├── email.prompt.html
│  │     │  │  │  ├── email.prompt.md
│  │     │  │  │  ├── markdown.prompt.html
│  │     │  │  │  ├── markdown.prompt.md
│  │     │  │  │  ├── notion.prompt.html
│  │     │  │  │  ├── notion.prompt.md
│  │     │  │  │  ├── slack.prompt.html
│  │     │  │  │  ├── slack.prompt.md
│  │     │  │  │  ├── webhook.prompt.html
│  │     │  │  │  └── webhook.prompt.md
│  │     │  │  ├── slackAdapter.js
│  │     │  │  └── webhookAdapter.js
│  │     │  ├── deliveryController.js
│  │     │  ├── demo-output
│  │     │  │  ├── delivery_1786321542719.html
│  │     │  │  ├── delivery_1786321542719.md
│  │     │  │  ├── delivery_1786321542729.html
│  │     │  │  ├── delivery_1786321542729.md
│  │     │  │  ├── delivery_1786321660348.html
│  │     │  │  ├── delivery_1786321660348.md
│  │     │  │  ├── delivery_1786321660354.html
│  │     │  │  └── delivery_1786321660354.md
│  │     │  ├── demo.js
│  │     │  ├── diff
│  │     │  │  ├── diff.prompt.html
│  │     │  │  ├── diff.prompt.md
│  │     │  │  └── diffEngine.js
│  │     │  ├── orchestrator
│  │     │  │  ├── orchestrator.prompt.html
│  │     │  │  ├── orchestrator.prompt.md
│  │     │  │  └── orchestratorAgent.js
│  │     │  ├── routes
│  │     │  │  └── delivery.routes.js
│  │     │  ├── tasks
│  │     │  │  ├── taskQueue.js
│  │     │  │  └── taskStore.js
│  │     │  └── templates
│  │     │     └── templateRegistry.js
│  │     ├── khy_platform
│  │     │  ├── __init__.py
│  │     │  ├── __main__.py
│  │     │  ├── _bootstrap.py
│  │     │  ├── _resources
│  │     │  │  ├── __init__.py
│  │     │  │  ├── dev-constraints.txt
│  │     │  │  └── tray-icon.png
│  │     │  ├── _ui.py
│  │     │  ├── android_build.py
│  │     │  ├── app_protocol.py
│  │     │  ├── autostart.py
│  │     │  ├── bundle_tools.py
│  │     │  ├── cli.py
│  │     │  ├── cn_mirror.py
│  │     │  ├── devenv.py
│  │     │  ├── docs_site.py
│  │     │  ├── fs_compress.py
│  │     │  ├── node_provisioner.py
│  │     │  ├── portable.py
│  │     │  └── tray.py
│  │     ├── packages
│  │     │  ├── shared
│  │     │  │  ├── config
│  │     │  │  │  ├── database.js
│  │     │  │  │  ├── env.js
│  │     │  │  │  └── sqliteCompat.js
│  │     │  │  ├── package.json
│  │     │  │  ├── src
│  │     │  │  │  ├── config
│  │     │  │  │  │  ├── database.js
│  │     │  │  │  │  ├── env.js
│  │     │  │  │  │  ├── sqlite-adapter.js
│  │     │  │  │  │  └── sqliteCompat.js
│  │     │  │  │  ├── constants
│  │     │  │  │  │  └── serviceDefaults.js
│  │     │  │  │  ├── deviceIdentity.js
│  │     │  │  │  ├── errorEnvelope.js
│  │     │  │  │  ├── index.js
│  │     │  │  │  ├── middleware
│  │     │  │  │  │  ├── auth.js
│  │     │  │  │  │  ├── errorHandler.js
│  │     │  │  │  │  └── rateLimit.js
│  │     │  │  │  ├── models
│  │     │  │  │  │  ├── AIAccount.js
│  │     │  │  │  │  ├── AISuggestion.js
│  │     │  │  │  │  ├── Announcement.js
│  │     │  │  │  │  ├── AnnouncementRead.js
│  │     │  │  │  │  ├── ApiKey.js
│  │     │  │  │  │  ├── Backtest.js
│  │     │  │  │  │  ├── BankTransfer.js
│  │     │  │  │  │  ├── ChannelApi.js
│  │     │  │  │  │  ├── Conversation.js
│  │     │  │  │  │  ├── ConversationGroup.js
│  │     │  │  │  │  ├── Feedback.js
│  │     │  │  │  │  ├── GuiEvalRun.js
│  │     │  │  │  │  ├── GuiEvalTask.js
│  │     │  │  │  │  ├── Instrument.js
│  │     │  │  │  │  ├── KlineCache.js
│  │     │  │  │  │  ├── KlineData.js
│  │     │  │  │  │  ├── MarketData.js
│  │     │  │  │  │  ├── MarketplacePlugin.js
│  │     │  │  │  │  ├── PromptTemplate.js
│  │     │  │  │  │  ├── Signal.js
│  │     │  │  │  │  ├── Strategy.js
│  │     │  │  │  │  ├── SystemSetting.js
│  │     │  │  │  │  ├── Trade.js
│  │     │  │  │  │  ├── User.js
│  │     │  │  │  │  ├── UserFavorite.js
│  │     │  │  │  │  ├── UserGatewayConfig.js
│  │     │  │  │  │  ├── UserInstalledPlugin.js
│  │     │  │  │  │  ├── UserLog.js
│  │     │  │  │  │  ├── UserProject.js
│  │     │  │  │  │  ├── UserProvider.js
│  │     │  │  │  │  ├── UserProviderModel.js
│  │     │  │  │  │  ├── UserWorkflow.js
│  │     │  │  │  │  ├── Watchlist.js
│  │     │  │  │  │  ├── WebFrontendEvalRun.js
│  │     │  │  │  │  ├── WebFrontendEvalTask.js
│  │     │  │  │  │  ├── WorkflowRun.js
│  │     │  │  │  │  └── index.js
│  │     │  │  │  ├── plugins
│  │     │  │  │  │  └── openapiTools.js
│  │     │  │  │  ├── runtime
│  │     │  │  │  │  └── khyos
│  │     │  │  │  │     ├── KhyOsRunner.js
│  │     │  │  │  │     ├── _artifact.js
│  │     │  │  │  │     ├── builderProvisioner.js
│  │     │  │  │  │     ├── diskImage.js
│  │     │  │  │  │     ├── index.js
│  │     │  │  │  │     ├── isoProvisioner.js
│  │     │  │  │  │     ├── khyos-manifest.json
│  │     │  │  │  │     ├── portUtils.js
│  │     │  │  │  │     ├── ppmFrame.js
│  │     │  │  │  │     ├── qemuLocate.js
│  │     │  │  │  │     ├── rgbaToPng.js
│  │     │  │  │  │     └── toolchainProvisioner.js
│  │     │  │  │  ├── services
│  │     │  │  │  │  ├── cacheService.js
│  │     │  │  │  │  └── gateway
│  │     │  │  │  │     ├── adapters
│  │     │  │  │  │     │  └── ipAnonymizer.js
│  │     │  │  │  │     ├── example_plugins
│  │     │  │  │  │     │  ├── cache-plugin.js
│  │     │  │  │  │     │  └── cost-guard.js
│  │     │  │  │  │     ├── oauthManager.js
│  │     │  │  │  │     ├── pluginChain.js
│  │     │  │  │  │     ├── protocolConverter
│  │     │  │  │  │     │  ├── anthropic.js
│  │     │  │  │  │     │  ├── canonical.js
│  │     │  │  │  │     │  ├── codex.js
│  │     │  │  │  │     │  ├── formats.js
│  │     │  │  │  │     │  ├── gemini.js
│  │     │  │  │  │     │  ├── grok.js
│  │     │  │  │  │     │  ├── index.js
│  │     │  │  │  │     │  └── openai.js
│  │     │  │  │  │     └── responseSessionStore.js
│  │     │  │  │  ├── utils
│  │     │  │  │  │  ├── apiKeyHash.js
│  │     │  │  │  │  ├── fieldCrypto.js
│  │     │  │  │  │  ├── logger.js
│  │     │  │  │  │  └── storagePaths.js
│  │     │  │  │  └── workflow
│  │     │  │  │     ├── catalogPrompt.js
│  │     │  │  │     ├── cozeImport.js
│  │     │  │  │     ├── exportProviders.js
│  │     │  │  │     ├── nodeCatalog.js
│  │     │  │  │     └── templates.js
│  │     │  │  └── tests
│  │     │  │     └── runtime
│  │     │  │        └── khyos
│  │     │  │           ├── ppmFrame.test.js
│  │     │  │           └── rgbaToPng.test.js
│  │     │  └── ui-shared
│  │     │     ├── package.json
│  │     │     ├── src
│  │     │     │  ├── auth
│  │     │     │  │  ├── guard.js
│  │     │     │  │  ├── state.js
│  │     │     │  │  └── token.js
│  │     │     │  ├── board
│  │     │     │  │  ├── TaskBoard.vue
│  │     │     │  │  ├── TaskCard.vue
│  │     │     │  │  ├── index.js
│  │     │     │  │  └── model.js
│  │     │     │  ├── http
│  │     │     │  │  ├── authHeaders.js
│  │     │     │  │  ├── errors.js
│  │     │     │  │  ├── fetchWithTimeout.js
│  │     │     │  │  └── response.js
│  │     │     │  ├── index.js
│  │     │     │  └── progress
│  │     │     │     ├── index.js
│  │     │     │     ├── pacedProgress.js
│  │     │     │     └── usePacedProgress.js
│  │     │     └── tests
│  │     │        ├── board.test.js
│  │     │        ├── primitives.test.js
│  │     │        └── progress.test.js
│  │     └── tests
│  │        ├── test_android_build.py
│  │        ├── test_android_build_orchestration.py
│  │        ├── test_app_protocol.py
│  │        ├── test_preflight_backend_deps.py
│  │        └── test_version_detect.py
│  ├── node
│  │  ├── Tools
│  │  │  └── opencode
│  │  │     └── config
│  │  │        └── opencode.json
│  │  ├── adapters
│  │  │  └── im
│  │  │     ├── adapterRegistry.js
│  │  │     ├── baseImAdapter.js
│  │  │     ├── feishuAdapter.js
│  │  │     └── imRuntimeConfig.js
│  │  ├── agents
│  │  │  ├── built-in
│  │  │  │  ├── agentCreator.html
│  │  │  │  ├── agentCreator.md
│  │  │  │  ├── auditAgent.js
│  │  │  │  ├── browserAgent.js
│  │  │  │  ├── computerUseAgent.js
│  │  │  │  ├── coordinator.html
│  │  │  │  ├── coordinator.md
│  │  │  │  ├── debugAgent.js
│  │  │  │  ├── deployAgent.js
│  │  │  │  ├── docAgent.js
│  │  │  │  ├── editAndWriteAgent.html
│  │  │  │  ├── editAndWriteAgent.md
│  │  │  │  ├── exploreAgent.js
│  │  │  │  ├── fixAgent.js
│  │  │  │  ├── genImageAgent.js
│  │  │  │  ├── generalPurposeAgent.js
│  │  │  │  ├── initAgent.js
│  │  │  │  ├── khyGuideAgent.js
│  │  │  │  ├── knowledgeAgent.js
│  │  │  │  ├── knowledgePlanAgent.js
│  │  │  │  ├── mapAgent.js
│  │  │  │  ├── performanceAgent.js
│  │  │  │  ├── planAgent.js
│  │  │  │  ├── readAgent.html
│  │  │  │  ├── readAgent.md
│  │  │  │  ├── readingAgent.js
│  │  │  │  ├── refactorAgent.js
│  │  │  │  ├── researchAgent.js
│  │  │  │  ├── reviewAgent.js
│  │  │  │  ├── securityAgent.js
│  │  │  │  ├── statuslineSetup.js
│  │  │  │  ├── ultraPlanAgent.js
│  │  │  │  ├── ultraReviewAgent.js
│  │  │  │  └── verificationAgent.js
│  │  │  ├── builtInAgents.js
│  │  │  ├── ccAgentBridge.js
│  │  │  ├── constraints.js
│  │  │  ├── index.js
│  │  │  ├── loadAgents.js
│  │  │  ├── loadBuiltInMarkdownAgents.js
│  │  │  ├── prompt.js
│  │  │  └── types.js
│  │  ├── assistant
│  │  │  ├── autoDream.js
│  │  │  ├── consolidationLock.js
│  │  │  ├── dailyLog.js
│  │  │  ├── index.js
│  │  │  └── proactive.js
│  │  ├── backend
│  │  │  ├── .ai
│  │  │  │  ├── .metahash.json
│  │  │  │  ├── CONTEXT.yaml
│  │  │  │  ├── GUARDS.html
│  │  │  │  ├── GUARDS.md
│  │  │  │  ├── MAP.html
│  │  │  │  └── MAP.md
│  │  │  ├── .clinerules
│  │  │  ├── .cursor
│  │  │  │  └── rules
│  │  │  │     └── khy-maintainability.mdc
│  │  │  ├── .env.example
│  │  │  ├── .env.tmp.1790646792872
│  │  │  ├── .env.tmp.1790646792923
│  │  │  ├── .eslintrc.json
│  │  │  ├── .github
│  │  │  │  ├── copilot-instructions.html
│  │  │  │  └── copilot-instructions.md
│  │  │  ├── .gitignore
│  │  │  ├── .khyos-diag-tui-final.txt
│  │  │  ├── .npmrc
│  │  │  ├── .prettierignore
│  │  │  ├── .prettierrc
│  │  │  ├── .zcode-tmp-ccoverlay.txt
│  │  │  ├── AGENTS.html
│  │  │  ├── AGENTS.md
│  │  │  ├── CLAUDE.html
│  │  │  ├── CLAUDE.md
│  │  │  ├── Dockerfile
│  │  │  ├── LINT-DEBT.html
│  │  │  ├── LINT-DEBT.md
│  │  │  ├── README.html
│  │  │  ├── README.md
│  │  │  ├── TmpKoh.class
│  │  │  ├── TmpKoh.java
│  │  │  ├── _chk_app2.js
│  │  │  ├── _chk_bridge.js
│  │  │  ├── _probe_tools.js
│  │  │  ├── akshare_scripts
│  │  │  │  ├── akshare_data.py
│  │  │  │  ├── akshare_data_fixed.py
│  │  │  │  ├── akshare_data_full_history.py
│  │  │  │  ├── akshare_data_server.py
│  │  │  │  ├── akshare_data_v2.py
│  │  │  │  ├── alternative_data_sources.py
│  │  │  │  └── requirements.txt
│  │  │  ├── assets
│  │  │  │  └── mascot
│  │  │  │     └── xuanniao-original.jpg
│  │  │  ├── babel.config.json
│  │  │  ├── bin
│  │  │  │  ├── khy-os-init.js
│  │  │  │  ├── khy.cmd
│  │  │  │  └── khy.js
│  │  │  ├── check-env.js
│  │  │  ├── config
│  │  │  │  ├── models
│  │  │  │  │  ├── features.json
│  │  │  │  │  └── style_templates.js
│  │  │  │  ├── resources.json
│  │  │  │  └── runtime-binaries.json
│  │  │  ├── create-test-users.js
│  │  │  ├── data
│  │  │  │  └── .admin_initial_password
│  │  │  ├── docker-entrypoint.js
│  │  │  ├── esbuild.config.js
│  │  │  ├── eslint.config.js
│  │  │  ├── inference_server.py
│  │  │  ├── jest.config.js
│  │  │  ├── jsconfig.json
│  │  │  ├── khy-learning-progress.json
│  │  │  ├── m[0])
│  │  │  ├── m[1])
│  │  │  ├── make_proxy.py
│  │  │  ├── migrations
│  │  │  │  ├── add-close-fields-to-trades.sql
│  │  │  │  ├── add-close-fields.js
│  │  │  │  ├── add-order-type-field.js
│  │  │  │  ├── add-webauthn-to-users.js
│  │  │  │  ├── create-kline-cache-table.js
│  │  │  │  ├── create-user-favorites-table.js
│  │  │  │  └── fix-instruments-name-nullable.js
│  │  │  ├── note.txt
│  │  │  ├── pack
│  │  │  │  └── khy-os-khy-os-1.2.3.tgz
│  │  │  ├── package-lock.json
│  │  │  ├── package.json
│  │  │  ├── proxy.js
│  │  │  ├── proxy_test2.js
│  │  │  ├── reset-database.js
│  │  │  ├── scripts
│  │  │  │  ├── ai-manage-daemon.js
│  │  │  │  ├── arch-debt-baseline.json
│  │  │  │  ├── archDebtScan.js
│  │  │  │  ├── ccCommandParityAudit.js
│  │  │  │  ├── check-file-headers.js
│  │  │  │  ├── check-routes-load.js
│  │  │  │  ├── comprehensive-instruments.js
│  │  │  │  ├── create-admin.js
│  │  │  │  ├── gateBRunner.js
│  │  │  │  ├── gateCScorecard.js
│  │  │  │  ├── khyos-console.js
│  │  │  │  ├── makeSourceSnapshot.js
│  │  │  │  ├── parityScorecard.js
│  │  │  │  ├── patch_gguf_rope.py
│  │  │  │  ├── patch_gguf_tensors.py
│  │  │  │  ├── prepack.js
│  │  │  │  ├── proxy-daemon.js
│  │  │  │  ├── quick-setup.js
│  │  │  │  ├── run-ink-tui-tests.js
│  │  │  │  ├── seed.js
│  │  │  │  ├── start-ai-manage.js
│  │  │  │  ├── start-mgmt-server.js
│  │  │  │  ├── task-runner.js
│  │  │  │  ├── test-summary.js
│  │  │  │  ├── uncensor_model.py
│  │  │  │  ├── verify-remotedev.sh
│  │  │  │  └── windows-clipboard-img2file.ps1
│  │  │  ├── server.js
│  │  │  ├── setup.js
│  │  │  ├── sql
│  │  │  │  ├── add-security-questions.sql
│  │  │  │  ├── create-instruments-table.sql
│  │  │  │  ├── create-kline-data-table.sql
│  │  │  │  ├── create-user-favorites-table.sql
│  │  │  │  ├── create-user-logs-table.sql
│  │  │  │  └── 初始化数据库.sql
│  │  │  ├── start-daemon.js
│  │  │  ├── start-with-db.js
│  │  │  ├── test-data-criterion-1
│  │  │  │  └── test.db.corrupted-1786928978930
│  │  │  ├── test-db-connection.js
│  │  │  ├── tests
│  │  │  │  ├── __tests__
│  │  │  │  │  ├── create-frontend-e2e.test.js
│  │  │  │  │  └── frontend-blueprint.test.js
│  │  │  │  ├── _smoke
│  │  │  │  │  └── aiManageDaemonSmoke.js
│  │  │  │  ├── a2a.test.js
│  │  │  │  ├── acceptsZhArgHoist.test.js
│  │  │  │  ├── acpTransport.test.js
│  │  │  │  ├── actionAttribution.test.js
│  │  │  │  ├── actionContractVerifier.test.js
│  │  │  │  ├── activeAssist.test.js
│  │  │  │  ├── adapterVisionCapability.test.js
│  │  │  │  ├── agent-context.test.js
│  │  │  │  ├── agentConstraints.test.js
│  │  │  │  ├── agentFsService.test.js
│  │  │  │  ├── agents
│  │  │  │  │  ├── agentAuthz.designContract.test.js
│  │  │  │  │  ├── auditAgent.test.js
│  │  │  │  │  └── researchReadingMap.test.js
│  │  │  │  ├── agnesImage.test.js
│  │  │  │  ├── agnesProvisioner.test.js
│  │  │  │  ├── agnesVideo.test.js
│  │  │  │  ├── aiBackendDataHomeConvergence.test.js
│  │  │  │  ├── aiBackendPortResilience.test.js
│  │  │  │  ├── aiChat.controlRequest.ui.test.js
│  │  │  │  ├── aiChatCore.sideChannel.test.js
│  │  │  │  ├── aiCli.concurrentPreferredIsolation.test.js
│  │  │  │  ├── aiCli.feedback.stability.test.js
│  │  │  │  ├── aiCli.greetingFastpath.test.js
│  │  │  │  ├── aiCli.lightweightToolCuration.test.js
│  │  │  │  ├── aiCli.reactiveCompact.test.js
│  │  │  │  ├── aiCli.requestTraceForwarding.test.js
│  │  │  │  ├── aiCli.smallTaskIdleTimeout.test.js
│  │  │  │  ├── aiCli.studyModePrompt.test.js
│  │  │  │  ├── aiCli.toolPrefaceStreaming.test.js
│  │  │  │  ├── aiCli.truncationRecovery.test.js
│  │  │  │  ├── aiFrontendLocator.test.js
│  │  │  │  ├── aiGateway.apiPoolStrategy.test.js
│  │  │  │  ├── aiGateway.contextOverflowShrink.test.js
│  │  │  │  ├── aiGateway.credentialRefreshRetry.test.js
│  │  │  │  ├── aiGateway.languageConsistency.test.js
│  │  │  │  ├── aiGateway.languageRecoveryReset.test.js
│  │  │  │  ├── aiGateway.largeTask.strictIsolation.test.js
│  │  │  │  ├── aiGateway.retryBudget.test.js
│  │  │  │  ├── aiGateway.stability.regressions.test.js
│  │  │  │  ├── aiGateway.stability.test.js
│  │  │  │  ├── aiManageDaemonControlApi.test.js
│  │  │  │  ├── aiManageDaemonEarlyReadiness.test.js
│  │  │  │  ├── aiManageDaemonFrontendReuse.test.js
│  │  │  │  ├── aiManageDaemonGc.test.js
│  │  │  │  ├── aiManageDaemonLogEncoding.test.js
│  │  │  │  ├── aiManagementKhyosWsLocalActions.test.js
│  │  │  │  ├── aiManagementProxyEgress.wiring.test.js
│  │  │  │  ├── aiManagementServer.accountRoutes.test.js
│  │  │  │  ├── aiManagementServer.apiRouteDispatch.test.js
│  │  │  │  ├── aiManagementServer.commandsRoute.test.js
│  │  │  │  ├── aiManagementServer.fileSyncBusHost.test.js
│  │  │  │  ├── aiManagementServer.frontendStaticConfig.test.js
│  │  │  │  ├── aiManagementServer.gatewayCache.test.js
│  │  │  │  ├── aiManagementServer.inlineImagePath.test.js
│  │  │  │  ├── aiManagementServer.modelMeshRoute.test.js
│  │  │  │  ├── aiManagementServer.proxySubAndVendor.test.js
│  │  │  │  ├── aiManagementServer.webChannelSwitchReconcile.test.js
│  │  │  │  ├── aiRenderer.formatting.test.js
│  │  │  │  ├── aiUploadStore.test.js
│  │  │  │  ├── allCommandsCatalog.test.js
│  │  │  │  ├── analyzeBinaryTool.test.js
│  │  │  │  ├── ansiSanitizer.test.js
│  │  │  │  ├── answerEchoGuard.test.js
│  │  │  │  ├── answerVerifier.test.js
│  │  │  │  ├── anthropicBetaHeader.test.js
│  │  │  │  ├── anthropicThinking.continuity.test.js
│  │  │  │  ├── anthropicToCWExcludeHoist.test.js
│  │  │  │  ├── apiAdapter.keyOverride.test.js
│  │  │  │  ├── apiAdapter.poolMarkWiring.test.js
│  │  │  │  ├── apiKey.e2e.test.js
│  │  │  │  ├── apiKeyPoolHotReload.test.js
│  │  │  │  ├── appAliasNormHoist.test.js
│  │  │  │  ├── archDebtScanCommentStrip.test.js
│  │  │  │  ├── architectureLayering.test.js
│  │  │  │  ├── archiveInspectService.test.js
│  │  │  │  ├── archiveManifestPolicy.test.js
│  │  │  │  ├── arenaManager.test.js
│  │  │  │  ├── artifactDownload.test.js
│  │  │  │  ├── asciiBox.test.js
│  │  │  │  ├── assembleToolPoolMemo.test.js
│  │  │  │  ├── atMentionInject.test.js
│  │  │  │  ├── atPicker.test.js
│  │  │  │  ├── atomicWriteJson.test.js
│  │  │  │  ├── atomicWriteMigration.test.js
│  │  │  │  ├── attachmentFailurePolicy.test.js
│  │  │  │  ├── auditFixLoop.test.js
│  │  │  │  ├── auth.sessionSecurityRoutes.test.js
│  │  │  │  ├── autoModelSelect.test.js
│  │  │  │  ├── autonomousAgents.test.js
│  │  │  │  ├── backgroundShellAndWatchdog.test.js
│  │  │  │  ├── backgroundTaskLauncher.test.js
│  │  │  │  ├── backgroundTaskNotification.test.js
│  │  │  │  ├── backgroundTaskSpec.test.js
│  │  │  │  ├── backtestEngine.numeric-safety.test.js
│  │  │  │  ├── backupAssetPlan.test.js
│  │  │  │  ├── backupColdExport.test.js
│  │  │  │  ├── backupManifest.test.js
│  │  │  │  ├── backupNoRawDbCopy.test.js
│  │  │  │  ├── backupRestoreDrill.test.js
│  │  │  │  ├── baseSelfCheck.preferredAdapter.test.js
│  │  │  │  ├── baseTool.validationFixHints.test.js
│  │  │  │  ├── batch5-lsp-channels.test.js
│  │  │  │  ├── bin.machineReadable.test.js
│  │  │  │  ├── binaryAnalyzerCrashGuard.test.js
│  │  │  │  ├── blockedToolConstraintSetsHoist.test.js
│  │  │  │  ├── bootstrap
│  │  │  │  │  ├── __tests__
│  │  │  │  │  │  └── chalkCompat.test.js
│  │  │  │  │  ├── ensureProxyCoreEnv.test.js
│  │  │  │  │  ├── instrumentSyncOffBootChain.test.js
│  │  │  │  │  ├── prefetchRuntimeFootprint.test.js
│  │  │  │  │  ├── startupFailureExplain.test.js
│  │  │  │  │  └── windowsSpawnHardening.test.js
│  │  │  │  ├── bridge
│  │  │  │  │  ├── aiChatConsumer.test.js
│  │  │  │  │  ├── autoLogin.test.js
│  │  │  │  │  ├── bridgeAuth.paths.test.js
│  │  │  │  │  ├── bridgeStatusFooter.test.js
│  │  │  │  │  ├── deviceIdentity.test.js
│  │  │  │  │  ├── deviceNameResolver.test.js
│  │  │  │  │  ├── mobilePage.test.js
│  │  │  │  │  ├── sessionHistoryStore.test.js
│  │  │  │  │  └── uploadRoute.test.js
│  │  │  │  ├── bridgeImageDefaultPrompt.test.js
│  │  │  │  ├── bridgeServer.lifecycle.test.js
│  │  │  │  ├── buildProject.idleTimeout.test.js
│  │  │  │  ├── builtinGlmKey.test.js
│  │  │  │  ├── byteFormat.test.js
│  │  │  │  ├── cacheEconomyStore.test.js
│  │  │  │  ├── cacheGougingPenalty.test.js
│  │  │  │  ├── cachePrefixRegressionGuard.test.js
│  │  │  │  ├── cacheUsageNormalizer.test.js
│  │  │  │  ├── canonicalState.permissionMode.test.js
│  │  │  │  ├── capabilityRegistry.test.js
│  │  │  │  ├── ccAgentBridge.test.js
│  │  │  │  ├── ccMcpBridge.test.js
│  │  │  │  ├── ccOverlayLayout.test.js
│  │  │  │  ├── ccSkillBridge.test.js
│  │  │  │  ├── changeWatchService.test.js
│  │  │  │  ├── changeWatchVerdict.test.js
│  │  │  │  ├── channelApiService.test.js
│  │  │  │  ├── ci
│  │  │  │  │  ├── qualityDashboard.test.js
│  │  │  │  │  └── repoLayoutRootJunk.test.js
│  │  │  │  ├── ciStatus.test.js
│  │  │  │  ├── clampInt.test.js
│  │  │  │  ├── clarificationCards.test.js
│  │  │  │  ├── claudeAdapter.windowsSpawn.test.js
│  │  │  │  ├── claudeCompatDefsMemo.test.js
│  │  │  │  ├── cleanText.test.js
│  │  │  │  ├── cli
│  │  │  │  │  ├── __diag.test.js
│  │  │  │  │  ├── _typo-verb-driver.js
│  │  │  │  │  ├── ab_delivery_quality.test.js
│  │  │  │  │  ├── ab_interactivity_v2.test.js
│  │  │  │  │  ├── ab_test_interactivity.test.js
│  │  │  │  │  ├── adoptEnvSetHintShell.test.js
│  │  │  │  │  ├── advisorExitCode.test.js
│  │  │  │  │  ├── agentScreenZhRc.test.js
│  │  │  │  │  ├── agentStatLine.test.js
│  │  │  │  │  ├── agentTreeController.test.js
│  │  │  │  │  ├── agentTreeView.test.js
│  │  │  │  │  ├── agentTreeViewFold.test.js
│  │  │  │  │  ├── agentsCommand.test.js
│  │  │  │  │  ├── ai.subagentThinkingClamp.test.js
│  │  │  │  │  ├── aiChatCoreLeaf.test.js
│  │  │  │  │  ├── aiConversationOps.compactWriteback.test.js
│  │  │  │  │  ├── aiRendererIntegrityGuard.test.js
│  │  │  │  │  ├── aiRequestParsers.streamToolInterceptor.test.js
│  │  │  │  │  ├── aiSession.trivialGate.test.js
│  │  │  │  │  ├── aliases.test.js
│  │  │  │  │  ├── atMentionInject.references.test.js
│  │  │  │  │  ├── atProjectionCache.test.js
│  │  │  │  │  ├── autonomyExitCode.test.js
│  │  │  │  │  ├── backtest-list-empty-state.test.js
│  │  │  │  │  ├── backupAliasRouting.test.js
│  │  │  │  │  ├── backupDryRunShortFlag.test.js
│  │  │  │  │  ├── backupFmtBytes.test.js
│  │  │  │  │  ├── betaFallbackNotice.test.js
│  │  │  │  │  ├── blockquoteStyleSsot.test.js
│  │  │  │  │  ├── bootPhaseLine.test.js
│  │  │  │  │  ├── bottomDecorationRepaintMemo.test.js
│  │  │  │  │  ├── bottomDecorationWriteDedup.test.js
│  │  │  │  │  ├── breakCache.test.js
│  │  │  │  │  ├── briefTimestampSsot.test.js
│  │  │  │  │  ├── bulkLines.test.js
│  │  │  │  │  ├── busyInputClassifiers.test.js
│  │  │  │  │  ├── cacheSessionAggregate.test.js
│  │  │  │  │  ├── cacheWarning.test.js
│  │  │  │  │  ├── capability.toggles.test.js
│  │  │  │  │  ├── ccCountLines.test.js
│  │  │  │  │  ├── ccFormatCost.test.js
│  │  │  │  │  ├── ccPlural.test.js
│  │  │  │  │  ├── ccRelativePath.test.js
│  │  │  │  │  ├── ccSwitchExitCode.test.js
│  │  │  │  │  ├── ccTruncateLines.test.js
│  │  │  │  │  ├── ccUserFacingToolError.test.js
│  │  │  │  │  ├── cjkInputNormalize.test.js
│  │  │  │  │  ├── claimMainExitCode.test.js
│  │  │  │  │  ├── cleanHandler.test.js
│  │  │  │  │  ├── cliErrorReporter.test.js
│  │  │  │  │  ├── codexAdoptRouting.test.js
│  │  │  │  │  ├── commandAutoRegistryLazy.test.js
│  │  │  │  │  ├── commandCompletionIndexMemo.test.js
│  │  │  │  │  ├── commandRegistry.test.js
│  │  │  │  │  ├── commands
│  │  │  │  │  │  └── system
│  │  │  │  │  │     └── version.test.js
│  │  │  │  │  ├── compactInstructions.test.js
│  │  │  │  │  ├── compactResultSummary.test.js
│  │  │  │  │  ├── compactionDisplay.test.js
│  │  │  │  │  ├── completionDirCache.test.js
│  │  │  │  │  ├── completionKeysLazy.test.js
│  │  │  │  │  ├── config.handler.test.js
│  │  │  │  │  ├── configureCapability.test.js
│  │  │  │  │  ├── contextBreakdown.test.js
│  │  │  │  │  ├── contextPanelDetail.test.js
│  │  │  │  │  ├── contextResidentTokens.test.js
│  │  │  │  │  ├── contextSuggestions.test.js
│  │  │  │  │  ├── contextWarning.test.js
│  │  │  │  │  ├── contextZhLabels.test.js
│  │  │  │  │  ├── convertExitCode.test.js
│  │  │  │  │  ├── copyHandler.test.js
│  │  │  │  │  ├── copyReply.test.js
│  │  │  │  │  ├── costThresholdWarning.test.js
│  │  │  │  │  ├── crossSubCommandRouting.test.js
│  │  │  │  │  ├── daemon.handler.test.js
│  │  │  │  │  ├── dangerousConsentScreen.test.js
│  │  │  │  │  ├── debugToolCall.test.js
│  │  │  │  │  ├── deferredStatuses.test.js
│  │  │  │  │  ├── deliverabilityHelpers.test.js
│  │  │  │  │  ├── deploy-empty-state-hint.test.js
│  │  │  │  │  ├── deployAgentVersionSources.test.js
│  │  │  │  │  ├── desktopExportHintShell.test.js
│  │  │  │  │  ├── diffContentWidth.test.js
│  │  │  │  │  ├── diffFullWidth.test.js
│  │  │  │  │  ├── diffGutter.test.js
│  │  │  │  │  ├── diffLineNumbers.test.js
│  │  │  │  │  ├── diffOverview.test.js
│  │  │  │  │  ├── diffSpec.test.js
│  │  │  │  │  ├── dirSkip.test.js
│  │  │  │  │  ├── diskCleanExitCode.test.js
│  │  │  │  │  ├── diskCleanHandler.test.js
│  │  │  │  │  ├── displayFormatters.test.js
│  │  │  │  │  ├── displayWidthMemo.test.js
│  │  │  │  │  ├── docScreenRc.test.js
│  │  │  │  │  ├── docsTopicFallback.test.js
│  │  │  │  │  ├── doctorReport.test.js
│  │  │  │  │  ├── editStatLine.test.js
│  │  │  │  │  ├── entryExitCode.test.js
│  │  │  │  │  ├── envInfoLines.test.js
│  │  │  │  │  ├── error-remedy-not-dead-end.test.js
│  │  │  │  │  ├── escapeTimeoutDetector.test.js
│  │  │  │  │  ├── extensionCommand.test.js
│  │  │  │  │  ├── extensions
│  │  │  │  │  │  └── extensionManager.test.js
│  │  │  │  │  ├── featureCapabilityMap.test.js
│  │  │  │  │  ├── featuresLabelDedupe.test.js
│  │  │  │  │  ├── feedbackDoc.test.js
│  │  │  │  │  ├── feishuExitCode.test.js
│  │  │  │  │  ├── fenceLangCharset.test.js
│  │  │  │  │  ├── firstResponseAckVoice.test.js
│  │  │  │  │  ├── flag-hint-near-miss.test.js
│  │  │  │  │  ├── flagSlashArgRouting.test.js
│  │  │  │  │  ├── forkNoSessionExitCode.test.js
│  │  │  │  │  ├── formatters.test.js
│  │  │  │  │  ├── formatters.truncation.regression.test.js
│  │  │  │  │  ├── fullWidthInput.test.js
│  │  │  │  │  ├── gatewayPinStartupCheck.test.js
│  │  │  │  │  ├── gitDiffCollect.test.js
│  │  │  │  │  ├── gitignoreCommand.parse.test.js
│  │  │  │  │  ├── goalExitCode.test.js
│  │  │  │  │  ├── handlers
│  │  │  │  │  │  ├── accountPnlColor.test.js
│  │  │  │  │  │  ├── advisor.test.js
│  │  │  │  │  │  ├── aiGatewayGenerateHelpersLeaf.test.js
│  │  │  │  │  │  ├── aiRequestAnalysisLeaf.test.js
│  │  │  │  │  │  ├── aiRequestParsersLeaf.test.js
│  │  │  │  │  │  ├── appDataHandlerQuiet.test.js
│  │  │  │  │  │  ├── assistantStatusChinese.test.js
│  │  │  │  │  │  ├── autofixPr.test.js
│  │  │  │  │  │  ├── autonomy.test.js
│  │  │  │  │  │  ├── breakCacheHonestReceipts.test.js
│  │  │  │  │  │  ├── btw.test.js
│  │  │  │  │  │  ├── claimMain.test.js
│  │  │  │  │  │  ├── colorResetHonest.test.js
│  │  │  │  │  │  ├── commitFlagsHonest.test.js
│  │  │  │  │  │  ├── configEnvHalfWriteHonest.test.js
│  │  │  │  │  │  ├── configEnvWriteHonest.test.js
│  │  │  │  │  │  ├── createFrontend.usage.test.js
│  │  │  │  │  │  ├── createSwitchStore.test.js
│  │  │  │  │  │  ├── dbStatusHonestCounts.test.js
│  │  │  │  │  │  ├── deliveriesLedgerWiring.test.js
│  │  │  │  │  │  ├── fileSizeSsot.test.js
│  │  │  │  │  │  ├── forge.test.js
│  │  │  │  │  │  ├── fork.test.js
│  │  │  │  │  │  ├── gatewayConfigEditorLeaf.test.js
│  │  │  │  │  │  ├── gatewayKeyHealthChinese.test.js
│  │  │  │  │  │  ├── gatewayManageDaemonLeaf.test.js
│  │  │  │  │  │  ├── gatewayManageWaitPhase.test.js
│  │  │  │  │  │  ├── gatewayModelChoicesLeaf.test.js
│  │  │  │  │  │  ├── gatewayProviderKeyPoolLeaf.test.js
│  │  │  │  │  │  ├── gatewayRuntimeProbesLeaf.test.js
│  │  │  │  │  │  ├── gatewayStatusSteps.test.js
│  │  │  │  │  │  ├── gatewayStatusViewLeaf.test.js
│  │  │  │  │  │  ├── goalHandler.test.js
│  │  │  │  │  │  ├── guideHandler.test.js
│  │  │  │  │  │  ├── healthHandler.test.js
│  │  │  │  │  │  ├── ideStatus.test.js
│  │  │  │  │  │  ├── initVerifiers.test.js
│  │  │  │  │  │  ├── issue.test.js
│  │  │  │  │  │  ├── keybindings.test.js
│  │  │  │  │  │  ├── learnPreBannerProgress.test.js
│  │  │  │  │  │  ├── logCommandLines.test.js
│  │  │  │  │  │  ├── longFlagsHonest.test.js
│  │  │  │  │  │  ├── manage.matrix.test.js
│  │  │  │  │  │  ├── marketSpinnerDots.test.js
│  │  │  │  │  │  ├── mcpNoDoubleGlyph.test.js
│  │  │  │  │  │  ├── mobilePairingContract.test.js
│  │  │  │  │  │  ├── msgHandler.test.js
│  │  │  │  │  │  ├── onboarding.test.js
│  │  │  │  │  │  ├── perfIssue.test.js
│  │  │  │  │  │  ├── proactive.test.js
│  │  │  │  │  │  ├── proxySwitchProfilesLeaf.test.js
│  │  │  │  │  │  ├── recap.test.js
│  │  │  │  │  │  ├── releaseNotes.test.js
│  │  │  │  │  │  ├── releaseNotesMarkdownStrip.test.js
│  │  │  │  │  │  ├── rename.test.js
│  │  │  │  │  │  ├── replayHandler.test.js
│  │  │  │  │  │  ├── replayHandlerAi.test.js
│  │  │  │  │  │  ├── routerDispatchOpsLeaf.test.js
│  │  │  │  │  │  ├── routerDispatchSlashLeaf.test.js
│  │  │  │  │  │  ├── routerDispatchTailLeaf.test.js
│  │  │  │  │  │  ├── sandboxToggle.test.js
│  │  │  │  │  │  ├── subscribePr.test.js
│  │  │  │  │  │  ├── terminalSetup.test.js
│  │  │  │  │  │  ├── thinkbackDaysHonest.test.js
│  │  │  │  │  │  ├── toollist.test.js
│  │  │  │  │  │  ├── turnRollbackHonestRead.test.js
│  │  │  │  │  │  ├── twentyXToggleHonest.test.js
│  │  │  │  │  │  └── wxMultiAccount.test.js
│  │  │  │  │  ├── healLogRouting.test.js
│  │  │  │  │  ├── healthStatusColumnChinese.test.js
│  │  │  │  │  ├── heapDump.test.js
│  │  │  │  │  ├── helpCard.test.js
│  │  │  │  │  ├── helpVerbExempt.test.js
│  │  │  │  │  ├── hooks
│  │  │  │  │  │  └── hookRunner.test.js
│  │  │  │  │  ├── hqReviewGate.test.js
│  │  │  │  │  ├── hqStore.test.js
│  │  │  │  │  ├── hqWriteErrno.test.js
│  │  │  │  │  ├── hudDurationSsot.test.js
│  │  │  │  │  ├── hudTokensSsot.test.js
│  │  │  │  │  ├── ide.access.test.js
│  │  │  │  │  ├── ideStatusExitCode.test.js
│  │  │  │  │  ├── idleReturnNudge.test.js
│  │  │  │  │  ├── imageRecognitionIntent.test.js
│  │  │  │  │  ├── inlineOptionParse.test.js
│  │  │  │  │  ├── inputClassifiers.isEscOnly.test.js
│  │  │  │  │  ├── inputCursorMetricsMemo.test.js
│  │  │  │  │  ├── intentDebugSnapshot.test.js
│  │  │  │  │  ├── job-template-path-hint.test.js
│  │  │  │  │  ├── jobNewErrno.test.js
│  │  │  │  │  ├── keyFindings.test.js
│  │  │  │  │  ├── khySettingsLayering.test.js
│  │  │  │  │  ├── langExitCode.test.js
│  │  │  │  │  ├── langHandler.test.js
│  │  │  │  │  ├── lazy.handler.test.js
│  │  │  │  │  ├── lazyExitCode.test.js
│  │  │  │  │  ├── learnForkHelpExempt.test.js
│  │  │  │  │  ├── linuxExitCode.test.js
│  │  │  │  │  ├── liveClampFastMeasure.test.js
│  │  │  │  │  ├── liveTimelineLazyNorm.test.js
│  │  │  │  │  ├── makeSourceSnapshot.test.js
│  │  │  │  │  ├── markdownCodeWrap.test.js
│  │  │  │  │  ├── markdownColors.test.js
│  │  │  │  │  ├── markdownColsOverride.test.js
│  │  │  │  │  ├── markdownInlineCodeMath.test.js
│  │  │  │  │  ├── markdownLink.test.js
│  │  │  │  │  ├── markdownStreaming.test.js
│  │  │  │  │  ├── markdownTableCellWrap.test.js
│  │  │  │  │  ├── markdownTableGeometry.test.js
│  │  │  │  │  ├── markdownTableWrap.test.js
│  │  │  │  │  ├── markdownTighten.test.js
│  │  │  │  │  ├── mcpExportVscodeShape.test.js
│  │  │  │  │  ├── mcpSubcommandSchema.test.js
│  │  │  │  │  ├── md-env-override-warning.test.js
│  │  │  │  │  ├── mergedSlashCommandsCache.test.js
│  │  │  │  │  ├── meshExitCode.test.js
│  │  │  │  │  ├── messageBreakdown.test.js
│  │  │  │  │  ├── messagePredicates.test.js
│  │  │  │  │  ├── metadata-non-git-rc.test.js
│  │  │  │  │  ├── missingArgMarkRc.test.js
│  │  │  │  │  ├── moaPromptStrip.test.js
│  │  │  │  │  ├── mobilePairing.test.js
│  │  │  │  │  ├── modulesCatalogPath.test.js
│  │  │  │  │  ├── msgExitCode.test.js
│  │  │  │  │  ├── naturalLanguageAliasGuard.test.js
│  │  │  │  │  ├── notifyExitCode.test.js
│  │  │  │  │  ├── onboardingExitCode.test.js
│  │  │  │  │  ├── orderedListAlign.test.js
│  │  │  │  │  ├── orderedListAlignRender.test.js
│  │  │  │  │  ├── outcomeKeyFinding.test.js
│  │  │  │  │  ├── outputStyleCommand.test.js
│  │  │  │  │  ├── panels.completion.test.js
│  │  │  │  │  ├── pastedRefLines.test.js
│  │  │  │  │  ├── permissionDialogResolve.test.js
│  │  │  │  │  ├── permissionReply.test.js
│  │  │  │  │  ├── plainProcessTable.test.js
│  │  │  │  │  ├── pluginCrashExitCode.test.js
│  │  │  │  │  ├── plugins.test.js
│  │  │  │  │  ├── poolAddReceipt.test.js
│  │  │  │  │  ├── portableExitCode.test.js
│  │  │  │  │  ├── postEditDiagnosticsSummary.test.js
│  │  │  │  │  ├── prCommentsFormat.test.js
│  │  │  │  │  ├── previewOverflowMarker.test.js
│  │  │  │  │  ├── printOutputFormat.test.js
│  │  │  │  │  ├── proactiveExitCode.test.js
│  │  │  │  │  ├── processGroupClassifyMemo.test.js
│  │  │  │  │  ├── promptCaretMarginMemo.test.js
│  │  │  │  │  ├── promptFrameWrap.test.js
│  │  │  │  │  ├── promptLibraryListing.test.js
│  │  │  │  │  ├── promptOutputGuard.test.js
│  │  │  │  │  ├── proxyCoreInstallHandler.test.js
│  │  │  │  │  ├── publishDispatch.test.js
│  │  │  │  │  ├── publishStateDynamicLabel.test.js
│  │  │  │  │  ├── publishStateG1FullSet.test.js
│  │  │  │  │  ├── publishStateProjectBlock.test.js
│  │  │  │  │  ├── publishVersionAtomic.test.js
│  │  │  │  │  ├── publishVersionHonest.test.js
│  │  │  │  │  ├── qaEchoLines.test.js
│  │  │  │  │  ├── quoted-input-tokenizer.test.js
│  │  │  │  │  ├── rateLimitRetry.test.js
│  │  │  │  │  ├── rawPasteChunkClassify.test.js
│  │  │  │  │  ├── readRangeSuffix.test.js
│  │  │  │  │  ├── readSearchToolsHoist.test.js
│  │  │  │  │  ├── readableSummarySkipHoist.test.js
│  │  │  │  │  ├── receipts-orch-routing.test.js
│  │  │  │  │  ├── receiptsFmtTime.test.js
│  │  │  │  │  ├── relativeAgeSsot.test.js
│  │  │  │  │  ├── remoteHostsErrorHonest.test.js
│  │  │  │  │  ├── renderDedup.test.js
│  │  │  │  │  ├── renderThemeFormatElapsed.test.js
│  │  │  │  │  ├── renderUserMessage.test.js
│  │  │  │  │  ├── repl
│  │  │  │  │  │  ├── busyTopicShift.test.js
│  │  │  │  │  │  ├── clipboardCommands.test.js
│  │  │  │  │  │  ├── dirSkip.test.js
│  │  │  │  │  │  ├── footerLayout.test.js
│  │  │  │  │  │  ├── intentDebugSnapshot.test.js
│  │  │  │  │  │  ├── shellEscape.test.js
│  │  │  │  │  │  ├── slashCommandFilter.test.js
│  │  │  │  │  │  ├── slashRankIndexMemo.test.js
│  │  │  │  │  │  └── terminalTitle.test.js
│  │  │  │  │  ├── repl.inputFrameResize.test.js
│  │  │  │  │  ├── repl.intentAssuranceDebug.test.js
│  │  │  │  │  ├── repl.regressionGateScope.test.js
│  │  │  │  │  ├── repl.tasks.interaction.test.js
│  │  │  │  │  ├── repl.tierA.fallbackMenu.test.js
│  │  │  │  │  ├── replSessionLeaf.test.js
│  │  │  │  │  ├── replTestHarness.js
│  │  │  │  │  ├── repo.handler.test.js
│  │  │  │  │  ├── reportKhyError.test.js
│  │  │  │  │  ├── requireResolution.autoConnect.test.js
│  │  │  │  │  ├── resetTimeSsot.test.js
│  │  │  │  │  ├── restoreHintCommandsResolve.test.js
│  │  │  │  │  ├── resultGuard.test.js
│  │  │  │  │  ├── resultLineGlyph.test.js
│  │  │  │  │  ├── resumeConversationPairing.test.js
│  │  │  │  │  ├── resumeEmptyArg.test.js
│  │  │  │  │  ├── resumeHint.test.js
│  │  │  │  │  ├── resumeLastPersistedSession.test.js
│  │  │  │  │  ├── rewindCommand.test.js
│  │  │  │  │  ├── rewindNotice.test.js
│  │  │  │  │  ├── rewindToUserTurn.test.js
│  │  │  │  │  ├── roleExitCode.test.js
│  │  │  │  │  ├── rollbackFmtTime.test.js
│  │  │  │  │  ├── router.test.js
│  │  │  │  │  ├── rtkExitCode.test.js
│  │  │  │  │  ├── runningToolsSummaryMemo.test.js
│  │  │  │  │  ├── scopeSession.test.js
│  │  │  │  │  ├── scopeSessionIsolation.test.js
│  │  │  │  │  ├── scrollbackPreserve.reprintGuard.test.js
│  │  │  │  │  ├── scrollbackPreserve.test.js
│  │  │  │  │  ├── selfHealCommand.test.js
│  │  │  │  │  ├── session.handler.test.js
│  │  │  │  │  ├── sessionClear.test.js
│  │  │  │  │  ├── sessionColor.test.js
│  │  │  │  │  ├── sessionColorState.test.js
│  │  │  │  │  ├── sessionExport.test.js
│  │  │  │  │  ├── sessionRefFullWidth.test.js
│  │  │  │  │  ├── sessionRoleLabel.test.js
│  │  │  │  │  ├── sessionTag.test.js
│  │  │  │  │  ├── shellEscape.test.js
│  │  │  │  │  ├── shellEscapeContext.test.js
│  │  │  │  │  ├── shellOutputJson.test.js
│  │  │  │  │  ├── shellScreenZhRc.test.js
│  │  │  │  │  ├── shortOptionParse.test.js
│  │  │  │  │  ├── slashExtraCommands.test.js
│  │  │  │  │  ├── slashMenuFilter.test.js
│  │  │  │  │  ├── slashRankIndexMemo.test.js
│  │  │  │  │  ├── slashRankResultMemo.test.js
│  │  │  │  │  ├── slashSubcommandPassthrough.test.js
│  │  │  │  │  ├── slashSubmenu.test.js
│  │  │  │  │  ├── snipConversation.test.js
│  │  │  │  │  ├── spinnerMeta.test.js
│  │  │  │  │  ├── spinnerShimmer.test.js
│  │  │  │  │  ├── spinnerStallLine.test.js
│  │  │  │  │  ├── spinnerTokenByline.test.js
│  │  │  │  │  ├── spinnerTokenEstimate.test.js
│  │  │  │  │  ├── starEmphasisFlanking.test.js
│  │  │  │  │  ├── startupBeats.test.js
│  │  │  │  │  ├── staticItemsMemo.test.js
│  │  │  │  │  ├── statsConversationLines.test.js
│  │  │  │  │  ├── statusLabels.test.js
│  │  │  │  │  ├── storageMigrate.test.js
│  │  │  │  │  ├── streamMdCache.test.js
│  │  │  │  │  ├── streamNormCache.test.js
│  │  │  │  │  ├── streamRender.tailFlush.test.js
│  │  │  │  │  ├── streamToolInterceptor.realtime.test.js
│  │  │  │  │  ├── subscribePrExitCode.test.js
│  │  │  │  │  ├── summarizeFromUserTurn.test.js
│  │  │  │  │  ├── syncOutput.test.js
│  │  │  │  │  ├── systemPromptLeak.test.js
│  │  │  │  │  ├── tab-completion-manifest-union.test.js
│  │  │  │  │  ├── tailTruncation.test.js
│  │  │  │  │  ├── taskDifficultyScaffolding.test.js
│  │  │  │  │  ├── taskGuardConfirmLoop.test.js
│  │  │  │  │  ├── taskLineStyle.test.js
│  │  │  │  │  ├── taskLinesMemo.test.js
│  │  │  │  │  ├── taskMindMap.test.js
│  │  │  │  │  ├── taskPanelState.test.js
│  │  │  │  │  ├── tasksControl.parity.matrix.test.js
│  │  │  │  │  ├── tasksControlContract.test.js
│  │  │  │  │  ├── testKeyExitCode.test.js
│  │  │  │  │  ├── themePanelLines.test.js
│  │  │  │  │  ├── thinkTagInterceptor.test.js
│  │  │  │  │  ├── thinkbackReport.test.js
│  │  │  │  │  ├── thinkingToggleTeeth.test.js
│  │  │  │  │  ├── timelineAppendMerge.test.js
│  │  │  │  │  ├── tipScheduler.test.js
│  │  │  │  │  ├── toolCallNoise.test.js
│  │  │  │  │  ├── toolDiffRowsMemo.test.js
│  │  │  │  │  ├── toolDisplayCommentLabel.test.js
│  │  │  │  │  ├── toolDisplayLine.test.js
│  │  │  │  │  ├── toolDisplayMatrix.test.js
│  │  │  │  │  ├── toolDisplayShellJson.test.js
│  │  │  │  │  ├── toolDisplayTier.render.test.js
│  │  │  │  │  ├── toolErrorFold.test.js
│  │  │  │  │  ├── toolHeaderCap.test.js
│  │  │  │  │  ├── toolHeaderSummaryMemo.test.js
│  │  │  │  │  ├── toolLiteralOutputMemo.test.js
│  │  │  │  │  ├── toolPrefaceVoice.cot.test.js
│  │  │  │  │  ├── toolPrefaceVoice.dedup.test.js
│  │  │  │  │  ├── toolPrefaceVoice.gating.test.js
│  │  │  │  │  ├── toolPrefaceVoice.naturalVoice.test.js
│  │  │  │  │  ├── toolPrefaceVoice.scaffoldRoot.test.js
│  │  │  │  │  ├── toolPrefaceVoice.test.js
│  │  │  │  │  ├── toolPrefaceVoice.vary.test.js
│  │  │  │  │  ├── toolResultSummary.test.js
│  │  │  │  │  ├── toolResultTransparency.test.js
│  │  │  │  │  ├── toolResultVoice.test.js
│  │  │  │  │  ├── toolTargetMemo.test.js
│  │  │  │  │  ├── toolcheckExitCode.test.js
│  │  │  │  │  ├── traceProjectionSingleGlyph.test.js
│  │  │  │  │  ├── trafficFormatters.test.js
│  │  │  │  │  ├── trainExportDataEmpty.test.js
│  │  │  │  │  ├── truncateDisplayWidthBudget.test.js
│  │  │  │  │  ├── tui
│  │  │  │  │  │  ├── __tests__
│  │  │  │  │  │  │  └── outputWidthGuard.test.js
│  │  │  │  │  │  ├── arrowRouting.test.js
│  │  │  │  │  │  ├── bootLayout.test.js
│  │  │  │  │  │  ├── bootScreenVisual.test.js
│  │  │  │  │  │  ├── ccClipboard.test.js
│  │  │  │  │  │  ├── ccLayout.test.js
│  │  │  │  │  │  ├── ccMessageProjection.oracle.test.js
│  │  │  │  │  │  ├── ccMessageProjection.test.js
│  │  │  │  │  │  ├── ccMouseGuard.test.js
│  │  │  │  │  │  ├── ccSelectionWiring.test.js
│  │  │  │  │  │  ├── ccStatusBar.test.js
│  │  │  │  │  │  ├── ccTheme.test.js
│  │  │  │  │  │  ├── ccThemeBg.test.js
│  │  │  │  │  │  ├── chatChords.test.js
│  │  │  │  │  │  ├── chatChordsHelpSync.test.js
│  │  │  │  │  │  ├── chromeBudget.test.js
│  │  │  │  │  │  ├── consoleMute.test.js
│  │  │  │  │  │  ├── dragAutoScrollTimer.test.js
│  │  │  │  │  │  ├── effectiveCols.test.js
│  │  │  │  │  │  ├── effectiveDims.test.js
│  │  │  │  │  │  ├── foldModel.test.js
│  │  │  │  │  │  ├── footerStability.test.js
│  │  │  │  │  │  ├── footerWidthBudget.test.js
│  │  │  │  │  │  ├── frameBudget.test.js
│  │  │  │  │  │  ├── historyBrowseDecision.test.js
│  │  │  │  │  │  ├── ink-components
│  │  │  │  │  │  │  ├── appViewportScrollKeys.test.js
│  │  │  │  │  │  │  ├── caretGeometry.test.js
│  │  │  │  │  │  │  ├── ccPromptInput.test.js
│  │  │  │  │  │  │  ├── ccTable.test.js
│  │  │  │  │  │  │  ├── componentMemoExports.test.js
│  │  │  │  │  │  │  ├── imeCommitGuard.test.js
│  │  │  │  │  │  │  ├── progressBar.test.js
│  │  │  │  │  │  │  ├── rightPanel.test.js
│  │  │  │  │  │  │  ├── taskPanelHeader.test.js
│  │  │  │  │  │  │  ├── toolEntryRows.test.js
│  │  │  │  │  │  │  ├── toolLinesClipWidth.test.js
│  │  │  │  │  │  │  ├── userMessageCollapse.test.js
│  │  │  │  │  │  │  ├── viewportEmptyGrow.test.js
│  │  │  │  │  │  │  └── viewportSelection.test.js
│  │  │  │  │  │  ├── liveHeightClamp.test.js
│  │  │  │  │  │  ├── liveRegionBudget.test.js
│  │  │  │  │  │  ├── liveRegionClamp.test.js
│  │  │  │  │  │  ├── logoArt.test.js
│  │  │  │  │  │  ├── mouseButtons.test.js
│  │  │  │  │  │  ├── mouseNativeSelection.test.js
│  │  │  │  │  │  ├── mouseSelectEvent.test.js
│  │  │  │  │  │  ├── mouseWheel.test.js
│  │  │  │  │  │  ├── noticeInbox.test.js
│  │  │  │  │  │  ├── noticeShape.test.js
│  │  │  │  │  │  ├── overlayLiveBudget.test.js
│  │  │  │  │  │  ├── perfTunables.test.js
│  │  │  │  │  │  ├── promptPlaceholder.test.js
│  │  │  │  │  │  ├── railGhostingRegression.test.js
│  │  │  │  │  │  ├── railLayout.test.js
│  │  │  │  │  │  ├── railProxyIntegration.test.js
│  │  │  │  │  │  ├── regionLayout.test.js
│  │  │  │  │  │  ├── rewindScope.test.js
│  │  │  │  │  │  ├── scrollActions.test.js
│  │  │  │  │  │  ├── scrollbackPreserve.test.js
│  │  │  │  │  │  ├── selection.test.js
│  │  │  │  │  │  ├── selectionAnchorDrift.test.js
│  │  │  │  │  │  ├── selectionClickCancel.test.js
│  │  │  │  │  │  ├── selectionDisplayCol.test.js
│  │  │  │  │  │  ├── selectionPlainCopy.test.js
│  │  │  │  │  │  ├── selectionRelocate.test.js
│  │  │  │  │  │  ├── sidebarLayout.test.js
│  │  │  │  │  │  ├── sidebarNav.test.js
│  │  │  │  │  │  ├── sidebarNotifications.test.js
│  │  │  │  │  │  ├── sidebarPanel.test.js
│  │  │  │  │  │  ├── sidebarRailRuntime.test.js
│  │  │  │  │  │  ├── startupAnchor.test.js
│  │  │  │  │  │  ├── startupBeatsWiring.test.js
│  │  │  │  │  │  ├── taskPanelLines.test.js
│  │  │  │  │  │  ├── taskSurface.test.js
│  │  │  │  │  │  ├── thinkingMarquee.test.js
│  │  │  │  │  │  ├── transcriptLines.test.js
│  │  │  │  │  │  ├── tuiConfig.test.js
│  │  │  │  │  │  ├── uiBridgeRefs.test.js
│  │  │  │  │  │  ├── uiDesignContract.test.js
│  │  │  │  │  │  ├── updateWiring.test.js
│  │  │  │  │  │  ├── useCompletions.refRootRegression.test.js
│  │  │  │  │  │  ├── userMessageEchoStyle.test.js
│  │  │  │  │  │  ├── viewportDragEdgeScroll.test.js
│  │  │  │  │  │  ├── viewportSticky.test.js
│  │  │  │  │  │  └── wrapCell.test.js
│  │  │  │  │  ├── tuiErrorAdapter.test.js
│  │  │  │  │  ├── tuiResumeHint.test.js
│  │  │  │  │  ├── turnAckVoice.test.js
│  │  │  │  │  ├── typo-verb-not-silent.test.js
│  │  │  │  │  ├── ui
│  │  │  │  │  │  └── alwaysAllowLabel.test.js
│  │  │  │  │  ├── undeclared-verb-routing.test.js
│  │  │  │  │  ├── underscoreAbuse.test.js
│  │  │  │  │  ├── underscoreEmphasisSsot.test.js
│  │  │  │  │  ├── unknownCommandHint.router.e2e.test.js
│  │  │  │  │  ├── unknownCommandHint.test.js
│  │  │  │  │  ├── usageErrorExitCode.test.js
│  │  │  │  │  ├── useCompletionsReaddirCache.test.js
│  │  │  │  │  ├── useCompletionsSlashExtras.test.js
│  │  │  │  │  ├── userKnowledgeStoreShape.test.js
│  │  │  │  │  ├── userMessageWhiteBg.test.js
│  │  │  │  │  ├── vaultExitCode.test.js
│  │  │  │  │  ├── verbosityFlag.test.js
│  │  │  │  │  ├── verdict.handler.test.js
│  │  │  │  │  ├── visionNoticeDedup.test.js
│  │  │  │  │  ├── visionNoticeDedupRealImage.test.js
│  │  │  │  │  ├── visionNoticeDedupWiring.test.js
│  │  │  │  │  ├── weakModelGuidanceVersionSources.test.js
│  │  │  │  │  ├── webContextStats.test.js
│  │  │  │  │  ├── webToolsFormat.test.js
│  │  │  │  │  ├── whereValueColumnAlignment.test.js
│  │  │  │  │  ├── wordDiffSegments.test.js
│  │  │  │  │  ├── worktreeCommand.test.js
│  │  │  │  │  ├── wxQrSizing.test.js
│  │  │  │  │  ├── wxSlashRouting.test.js
│  │  │  │  │  └── zeroVerbReject.test.js
│  │  │  │  ├── cliAnythingService.offlineImport.test.js
│  │  │  │  ├── cliErrorReporter.test.js
│  │  │  │  ├── cloneCapabilityTasks.test.js
│  │  │  │  ├── codeChangeStats.test.js
│  │  │  │  ├── codexDirectAllowedToolsHoist.test.js
│  │  │  │  ├── codexShellControlTokensHoist.test.js
│  │  │  │  ├── codexStallPolicy.test.js
│  │  │  │  ├── collapseWhitespace.test.js
│  │  │  │  ├── collapseWhitespaceLoose.test.js
│  │  │  │  ├── collectLspDiagnostics.test.js
│  │  │  │  ├── commandAvailability.cache.test.js
│  │  │  │  ├── commandCodeAdapter.models.test.js
│  │  │  │  ├── commandCodeInvocation.test.js
│  │  │  │  ├── commands
│  │  │  │  │  └── ccCommandBridge.test.js
│  │  │  │  ├── commentGuidance.test.js
│  │  │  │  ├── commitTiming.test.js
│  │  │  │  ├── compactOrchestrator.test.js
│  │  │  │  ├── config
│  │  │  │  │  ├── database.test.js
│  │  │  │  │  ├── env.test.js
│  │  │  │  │  └── settingsWhitelist.test.js
│  │  │  │  ├── configMigration.test.js
│  │  │  │  ├── constants
│  │  │  │  │  ├── commandHelp.test.js
│  │  │  │  │  ├── commandSchema.test.js
│  │  │  │  │  ├── contextWindowDefaults.test.js
│  │  │  │  │  ├── gitCoAuthorTrailer.test.js
│  │  │  │  │  ├── gitWorkflowGuidance.test.js
│  │  │  │  │  ├── models.test.js
│  │  │  │  │  ├── nodePlatformLabel.test.js
│  │  │  │  │  ├── outputStyles.test.js
│  │  │  │  │  ├── promptCacheOrder.test.js
│  │  │  │  │  ├── promptPrefixShape.test.js
│  │  │  │  │  ├── prompts.keyConfigExecute.test.js
│  │  │  │  │  ├── prompts.keyConfigGuidance.test.js
│  │  │  │  │  ├── prompts.unknownProblemHandler.test.js
│  │  │  │  │  ├── retryBudget.test.js
│  │  │  │  │  ├── riskOrder.test.js
│  │  │  │  │  ├── shellChainStyle.test.js
│  │  │  │  │  ├── shellTransparency.test.js
│  │  │  │  │  ├── smallModelDefaults.test.js
│  │  │  │  │  └── systemClock.test.js
│  │  │  │  ├── contentBlockUtils.ensurePairing.test.js
│  │  │  │  ├── contentBlockUtils.imageDegrade.test.js
│  │  │  │  ├── contextCompressor.forceGate.test.js
│  │  │  │  ├── contextScope
│  │  │  │  │  └── taskSignalExtractorAnchorHoist.test.js
│  │  │  │  ├── contextScopePlanner.test.js
│  │  │  │  ├── contextWarningThreshold.test.js
│  │  │  │  ├── contextWindowClamp.test.js
│  │  │  │  ├── conversationStore.test.js
│  │  │  │  ├── convertFile.test.js
│  │  │  │  ├── coordinator
│  │  │  │  │  ├── ipcMailbox.test.js
│  │  │  │  │  ├── mailboxProtocol.test.js
│  │  │  │  │  └── workerRouting.test.js
│  │  │  │  ├── costByModel.test.js
│  │  │  │  ├── createAiProxy.test.js
│  │  │  │  ├── criticalPathSchedule.test.js
│  │  │  │  ├── cronListTool.test.js
│  │  │  │  ├── cronSchedulerUnification.test.js
│  │  │  │  ├── cronStepGuard.test.js
│  │  │  │  ├── cronTrioTier.test.js
│  │  │  │  ├── crossBranchSynthesis.test.js
│  │  │  │  ├── cursorGraphemeStep.test.js
│  │  │  │  ├── customProviderRegistrar.test.js
│  │  │  │  ├── customerRegistryConcurrentWrites.test.js
│  │  │  │  ├── daemonManager.runtimePort.test.js
│  │  │  │  ├── daemonSpawnLocation.test.js
│  │  │  │  ├── dbAutoMigration.test.js
│  │  │  │  ├── dbHealthService.healPrimitives.test.js
│  │  │  │  ├── dedupeText.test.js
│  │  │  │  ├── delegationPromptCoaching.test.js
│  │  │  │  ├── delegationPromptPolicy.test.js
│  │  │  │  ├── dependencyInventory.test.js
│  │  │  │  ├── deploy.detector.test.js
│  │  │  │  ├── deploy.ledger.test.js
│  │  │  │  ├── deploy.orchestrator.test.js
│  │  │  │  ├── deploy.syncEngine.test.js
│  │  │  │  ├── directiveComposer.test.js
│  │  │  │  ├── directiveRegistryGuard.test.js
│  │  │  │  ├── directiveSentinelDosGuard.test.js
│  │  │  │  ├── diskAnalyze.test.js
│  │  │  │  ├── diskAnalyzeCatalog.test.js
│  │  │  │  ├── diskAnalyzeReport.test.js
│  │  │  │  ├── diskCleanup.test.js
│  │  │  │  ├── docHelperEnabled.test.js
│  │  │  │  ├── docInspect.test.js
│  │  │  │  ├── docTitleStyle.test.js
│  │  │  │  ├── doctorConnectivity.providerProxies.test.js
│  │  │  │  ├── durableTranscript.test.js
│  │  │  │  ├── dynamicPromptAssembler.test.js
│  │  │  │  ├── enabledToolNameSetMemo.test.js
│  │  │  │  ├── enhancedModelSelector.test.js
│  │  │  │  ├── ensureAuthSecret.test.js
│  │  │  │  ├── ensureDirSync.test.js
│  │  │  │  ├── entrypoints.test.js
│  │  │  │  ├── envFlagByName.test.js
│  │  │  │  ├── envFlagEnabled.test.js
│  │  │  │  ├── envIntNonNeg.test.js
│  │  │  │  ├── envNum.test.js
│  │  │  │  ├── envOnByName.test.js
│  │  │  │  ├── ephemeralTmp.test.js
│  │  │  │  ├── errorClassifier.authIdeStability.test.js
│  │  │  │  ├── errorClassifier.extended.test.js
│  │  │  │  ├── errorEnumerationGuard.test.js
│  │  │  │  ├── errorSummary.test.js
│  │  │  │  ├── esbuildConfig.test.js
│  │  │  │  ├── escapeRegExp.test.js
│  │  │  │  ├── evolutionPolicy.test.js
│  │  │  │  ├── evolutionSafety.test.js
│  │  │  │  ├── executeCodeMultiLang.test.js
│  │  │  │  ├── executionComplexitySignals.test.js
│  │  │  │  ├── existsSyncSafe.test.js
│  │  │  │  ├── expandEnvPath.test.js
│  │  │  │  ├── extensionHandler.test.js
│  │  │  │  ├── extensionMarketplace.test.js
│  │  │  │  ├── extensions
│  │  │  │  │  ├── contribToolLifecycle.test.js
│  │  │  │  │  ├── quantAppSeam.test.js
│  │  │  │  │  └── quantAppServerMount.test.js
│  │  │  │  ├── extractEndpoint.test.js
│  │  │  │  ├── failureExplainer.test.js
│  │  │  │  ├── fileLock.test.js
│  │  │  │  ├── fileRefRedosGuard.test.js
│  │  │  │  ├── fileSalience.test.js
│  │  │  │  ├── finiteNumber.test.js
│  │  │  │  ├── firstGroup.test.js
│  │  │  │  ├── fixAgent.test.js
│  │  │  │  ├── fixtures
│  │  │  │  │  ├── khy-hello
│  │  │  │  │  │  ├── package.json
│  │  │  │  │  │  └── src
│  │  │  │  │  │     └── index.js
│  │  │  │  │  └── lockWorker.js
│  │  │  │  ├── followThroughGuard.test.js
│  │  │  │  ├── followupSuggestion.test.js
│  │  │  │  ├── footerLayout.test.js
│  │  │  │  ├── footerMemory.test.js
│  │  │  │  ├── formatInspect.test.js
│  │  │  │  ├── gateOn.test.js
│  │  │  │  ├── gateway
│  │  │  │  │  ├── _kiroGenHarness.js
│  │  │  │  │  ├── _ocrGatewayHarness.js
│  │  │  │  │  ├── _traeGenHarness.js
│  │  │  │  │  ├── _traeGenHarness.minimal.test.js
│  │  │  │  │  ├── adapters
│  │  │  │  │  │  └── retryWithBackoffRetryAfter.test.js
│  │  │  │  │  ├── aiGateway.cascadeJitterSelfHeal.test.js
│  │  │  │  │  ├── aiGateway.exports.test.js
│  │  │  │  │  ├── aiGateway.networkResume.test.js
│  │  │  │  │  ├── aiGateway.retryRecoveryEnhancements.test.js
│  │  │  │  │  ├── aiGatewayCooldownMethodsLeaf.test.js
│  │  │  │  │  ├── aiGatewayGenerateMethod.meshWiring.test.js
│  │  │  │  │  ├── aiGatewayGenerateMethodDepsFailFast.test.js
│  │  │  │  │  ├── aiGatewayGenerateMethodLeaf.test.js
│  │  │  │  │  ├── aiGatewayListModelsTruth.test.js
│  │  │  │  │  ├── aiGatewayModelMethodsLeaf.test.js
│  │  │  │  │  ├── aiGatewayRoutingMethodsLeaf.test.js
│  │  │  │  │  ├── buildChannelFailureAdvice.test.js
│  │  │  │  │  ├── circuitBreaker.management.test.js
│  │  │  │  │  ├── claudeAdapter.authHeaders.test.js
│  │  │  │  │  ├── claudeAdapter.oneMContext.test.js
│  │  │  │  │  ├── cliFailureEnvelope.test.js
│  │  │  │  │  ├── cliFailureEnvelopeZeroAttempt.test.js
│  │  │  │  │  ├── cliToolAdapter.errorEcho.test.js
│  │  │  │  │  ├── clipboardRelayAdapter.detect.test.js
│  │  │  │  │  ├── codexAdapter.execTimeouts.test.js
│  │  │  │  │  ├── codexAdapter.tomlEditing.test.js
│  │  │  │  │  ├── codexConverter.test.js
│  │  │  │  │  ├── codexSession.test.js
│  │  │  │  │  ├── codexStreaming.test.js
│  │  │  │  │  ├── contextWindowCatalogFeed.test.js
│  │  │  │  │  ├── credentialRefreshCoordinator.test.js
│  │  │  │  │  ├── cursorAdapter.strictAvailability.test.js
│  │  │  │  │  ├── customerQuotaEnforcer.http.test.js
│  │  │  │  │  ├── customerQuotaEnforcer.test.js
│  │  │  │  │  ├── envParse.test.js
│  │  │  │  │  ├── failoverOrderStore.test.js
│  │  │  │  │  ├── failurePermanenceRecovery.test.js
│  │  │  │  │  ├── glmCnModelNotFound.test.js
│  │  │  │  │  ├── imageOcrCoverageWiring.test.js
│  │  │  │  │  ├── imageOcrFallbackRealImage.test.js
│  │  │  │  │  ├── imageOcrFallbackWiring.test.js
│  │  │  │  │  ├── imageOcrLanguageWiring.test.js
│  │  │  │  │  ├── imageOcrOrientationWiring.test.js
│  │  │  │  │  ├── imageOcrResolutionWiring.test.js
│  │  │  │  │  ├── imageOcrTruncationWiring.test.js
│  │  │  │  │  ├── keySelector.exports.test.js
│  │  │  │  │  ├── kiroAdapter.proxyModels.test.js
│  │  │  │  │  ├── kiroAdapter.tokenPaths.test.js
│  │  │  │  │  ├── localOllamaProbeCatalogWiring.test.js
│  │  │  │  │  ├── mcpVisionConsumedImageWiring.test.js
│  │  │  │  │  ├── modelCuration.test.js
│  │  │  │  │  ├── modelDiscovery.exports.test.js
│  │  │  │  │  ├── modelIdParse.test.js
│  │  │  │  │  ├── modelRouter.exports.test.js
│  │  │  │  │  ├── oauthManager.test.js
│  │  │  │  │  ├── ocrConfidenceCaveat.test.js
│  │  │  │  │  ├── ocrCoverageNotice.test.js
│  │  │  │  │  ├── ocrLanguageNarrowing.test.js
│  │  │  │  │  ├── ocrLanguageNotice.test.js
│  │  │  │  │  ├── ocrOrientationNotice.test.js
│  │  │  │  │  ├── ocrOrientationRecovery.test.js
│  │  │  │  │  ├── ocrRescuePrepClosureDedupRealImage.test.js
│  │  │  │  │  ├── ocrRescuePrepClosureDedupWiring.test.js
│  │  │  │  │  ├── ocrRescueStatusNotice.test.js
│  │  │  │  │  ├── ocrRescueStatusNoticeRealImage.test.js
│  │  │  │  │  ├── ocrRescueStatusNoticeWiring.test.js
│  │  │  │  │  ├── ocrRescueStatusPrep.test.js
│  │  │  │  │  ├── ocrRescueStatusPrepRealImage.test.js
│  │  │  │  │  ├── ocrRescueStatusPrepWiring.test.js
│  │  │  │  │  ├── ocrResolutionNotice.test.js
│  │  │  │  │  ├── ocrResolutionRecovery.test.js
│  │  │  │  │  ├── ocrSnippetTruncation.test.js
│  │  │  │  │  ├── ocrTruncationNotice.test.js
│  │  │  │  │  ├── ocrUsageDisclosureRealImage.test.js
│  │  │  │  │  ├── ocrUsageDisclosureWiring.test.js
│  │  │  │  │  ├── ocrUsageFootnote.test.js
│  │  │  │  │  ├── ocrUsageFootnoteRealImage.test.js
│  │  │  │  │  ├── ocrUsageFootnoteWiring.test.js
│  │  │  │  │  ├── ocrUsageNotice.test.js
│  │  │  │  │  ├── pluginChain.test.js
│  │  │  │  │  ├── preferredAdapterIssueStrict.test.js
│  │  │  │  │  ├── preferredChannelPinning.test.js
│  │  │  │  │  ├── protocolFidelity.test.js
│  │  │  │  │  ├── proxyServer.authTokens.test.js
│  │  │  │  │  ├── proxyServer.httpRouteMatrix.test.js
│  │  │  │  │  ├── recentModelsStore.test.js
│  │  │  │  │  ├── refusalRecovery.e2e.test.js
│  │  │  │  │  ├── refusalRecovery.test.js
│  │  │  │  │  ├── relayAccessBoundary.test.js
│  │  │  │  │  ├── relayCompositeModelStrip.test.js
│  │  │  │  │  ├── relayDeadEndpointRelax.test.js
│  │  │  │  │  ├── relayErrorBodyDiag.test.js
│  │  │  │  │  ├── requestDedup.test.js
│  │  │  │  │  ├── responsesOutbound.test.js
│  │  │  │  │  ├── routeFact.test.js
│  │  │  │  │  ├── safeJsonParse.test.js
│  │  │  │  │  ├── serverErrorFastFail.test.js
│  │  │  │  │  ├── streamProcessor.apiRetryReason.test.js
│  │  │  │  │  ├── strictAvailability.test.js
│  │  │  │  │  ├── traeAdapter.generateChannels.test.js
│  │  │  │  │  ├── traeAdapter.strictAvailability.test.js
│  │  │  │  │  ├── transportResilience.test.js
│  │  │  │  │  ├── upstreamModelProbeParse.test.js
│  │  │  │  │  ├── visionCascadeAttemptNoticeRealImage.test.js
│  │  │  │  │  ├── visionCascadeAttemptNoticeWiring.test.js
│  │  │  │  │  ├── visionDenialCorrection.test.js
│  │  │  │  │  ├── visionDenialCorrectionRealImage.test.js
│  │  │  │  │  ├── visionDenialCorrectionWiring.test.js
│  │  │  │  │  ├── visionDescribeFailFloorRealImage.test.js
│  │  │  │  │  ├── visionDescribeFailFloorUserConfigRealImage.test.js
│  │  │  │  │  ├── visionDescribeFailFloorWiring.test.js
│  │  │  │  │  ├── visionFailureCauseDedup.test.js
│  │  │  │  │  ├── visionFailureSummaryDisplayName.test.js
│  │  │  │  │  ├── visionFailureSummaryOcrSuppressRealImage.test.js
│  │  │  │  │  ├── visionFailureSummaryOcrSuppressWiring.test.js
│  │  │  │  │  ├── visionModelDisplayNameRealImage.test.js
│  │  │  │  │  ├── visionModelDisplayNameWiring.test.js
│  │  │  │  │  ├── visionNetworkExhaustionRealImage.test.js
│  │  │  │  │  ├── visionOcrSuccessClosureRealImage.test.js
│  │  │  │  │  ├── visionOcrSuccessClosureWiring.test.js
│  │  │  │  │  ├── visionPoolFailStatusHumanize.test.js
│  │  │  │  │  ├── visionRescueStripFloorRealImage.test.js
│  │  │  │  │  ├── visionRescueStripFloorWiring.test.js
│  │  │  │  │  ├── visionStripImageFloorRealImage.test.js
│  │  │  │  │  ├── visionStripImageFloorWiring.test.js
│  │  │  │  │  ├── warpAdapter.strictAvailability.test.js
│  │  │  │  │  └── webSearchInterceptor.test.js
│  │  │  │  ├── gateway.detectAsyncNonBlocking.test.js
│  │  │  │  ├── gatewayAdapters.stability.test.js
│  │  │  │  ├── gatewayAutoModelWiring.test.js
│  │  │  │  ├── gatewayDebugPrompt.test.js
│  │  │  │  ├── gatewayGuide.test.js
│  │  │  │  ├── gatewayIdleTimeoutPolicy.test.js
│  │  │  │  ├── gatewayManage.apiDisplay.test.js
│  │  │  │  ├── gatewayManage.portDrift.integration.test.js
│  │  │  │  ├── gatewayModelListTruth.wiring.test.js
│  │  │  │  ├── gatewayModelPromptGuard.test.js
│  │  │  │  ├── gatewayModelSelection.strictProbe.test.js
│  │  │  │  ├── gatewayModelsView.test.js
│  │  │  │  ├── gatewaySample.test.js
│  │  │  │  ├── gatewayStatus.endpointVisibility.test.js
│  │  │  │  ├── gatewayStatus.preferredAdapterHint.test.js
│  │  │  │  ├── gatewayTrace.test.js
│  │  │  │  ├── gatewayVisionBadge.test.js
│  │  │  │  ├── getToolDefinitionsStable.test.js
│  │  │  │  ├── gitCommitTiming.test.js
│  │  │  │  ├── gitExecutableDetector.test.js
│  │  │  │  ├── gitExecutableResolver.test.js
│  │  │  │  ├── gitSoftExec.test.js
│  │  │  │  ├── gitSpawnHelper.test.js
│  │  │  │  ├── globDoublestarAnchor.test.js
│  │  │  │  ├── gracefulShutdown.test.js
│  │  │  │  ├── graphRewriteContract.test.js
│  │  │  │  ├── grep.idleTimeout.test.js
│  │  │  │  ├── grepWindowsDriveKey.test.js
│  │  │  │  ├── groundTruthRatGuard.test.js
│  │  │  │  ├── growthDataDir.test.js
│  │  │  │  ├── handlers
│  │  │  │  │  └── reviewAutoFixApproval.test.js
│  │  │  │  ├── hardwareProfile.adaptiveLimits.test.js
│  │  │  │  ├── hardwareProfile.crossPlatform.test.js
│  │  │  │  ├── hardwareProfile.localAiTuning.test.js
│  │  │  │  ├── hardwareProfile.probeCache.test.js
│  │  │  │  ├── headlessNativeLoop.routing.test.js
│  │  │  │  ├── headlessProgress.test.js
│  │  │  │  ├── healGuard.test.js
│  │  │  │  ├── historyPersist.test.js
│  │  │  │  ├── honestFailureReason.test.js
│  │  │  │  ├── hook-lifecycle.test.js
│  │  │  │  ├── hookContribSeams.test.js
│  │  │  │  ├── hooksConfig.test.js
│  │  │  │  ├── hostOfEndpoint.test.js
│  │  │  │  ├── htmlEntityCodePointGuard.test.js
│  │  │  │  ├── httpEncoding.test.js
│  │  │  │  ├── httpError.test.js
│  │  │  │  ├── i18n.test.js
│  │  │  │  ├── imAdapterFeishuGateway.test.js
│  │  │  │  ├── imAdapterFeishuOfficialProtocol.test.js
│  │  │  │  ├── imAdapterRegistry.test.js
│  │  │  │  ├── imageCompat.document.test.js
│  │  │  │  ├── imageCompatNeverThrow.test.js
│  │  │  │  ├── imageGenerate.test.js
│  │  │  │  ├── imageMetadataProbe.test.js
│  │  │  │  ├── imageOcrFallbackPolicy.test.js
│  │  │  │  ├── inertia
│  │  │  │  │  ├── inertialRunService.test.js
│  │  │  │  │  ├── momentum.test.js
│  │  │  │  │  └── planSchema.test.js
│  │  │  │  ├── inertialContinuation.test.js
│  │  │  │  ├── inferProtocolFromModelHoist.test.js
│  │  │  │  ├── initDoctor.claudeConflict.test.js
│  │  │  │  ├── initDoctor.cloudOptional.test.js
│  │  │  │  ├── initDoctor.codingAgentSmoke.test.js
│  │  │  │  ├── initDoctor.compatibilityScenarios.test.js
│  │  │  │  ├── inkComponents.test.js
│  │  │  │  ├── inlineImageOcrGuardPolicy.test.js
│  │  │  │  ├── instructionEcosystemDiscovery.test.js
│  │  │  │  ├── instructionEcosystemRegistry.test.js
│  │  │  │  ├── instructionIncludeBoundary.test.js
│  │  │  │  ├── intentCoveragePathRedos.test.js
│  │  │  │  ├── interruptHint.test.js
│  │  │  │  ├── ipcProtocol.test.js
│  │  │  │  ├── isEnabledDefaultOn.test.js
│  │  │  │  ├── isOffValue.test.js
│  │  │  │  ├── isPathWithin.test.js
│  │  │  │  ├── isPlainObject.test.js
│  │  │  │  ├── jest.gitGlobalSetup.js
│  │  │  │  ├── jest.logIsolation.setup.js
│  │  │  │  ├── jest.rtkOff.setup.js
│  │  │  │  ├── jest.taskStoreIsolation.setup.js
│  │  │  │  ├── jobs
│  │  │  │  │  └── templateJobs.test.js
│  │  │  │  ├── keyHealthProbe.test.js
│  │  │  │  ├── keySelector.test.js
│  │  │  │  ├── khyAnythingProxy.test.js
│  │  │  │  ├── khyOsRunnerProvision.test.js
│  │  │  │  ├── khyOsRunnerSerialDecode.test.js
│  │  │  │  ├── khyOsRunnerSpawnFailure.test.js
│  │  │  │  ├── khySelfUpdateService.test.js
│  │  │  │  ├── khyUpgradeRuntime.intentAssurance.test.js
│  │  │  │  ├── khyosAgentChannel.test.js
│  │  │  │  ├── khyosBuild.test.js
│  │  │  │  ├── khyosBuilderProvisioner.test.js
│  │  │  │  ├── khyosCacheDir.test.js
│  │  │  │  ├── khyosDiskImage.test.js
│  │  │  │  ├── khyosIsoDiscovery.test.js
│  │  │  │  ├── khyosIsoObtain.test.js
│  │  │  │  ├── khyosQemuHintHonesty.test.js
│  │  │  │  ├── kiroAdapter.autoLogin.test.js
│  │  │  │  ├── kiroAdapter.refreshFallback.test.js
│  │  │  │  ├── kiroAdapter.staleProfileArn.test.js
│  │  │  │  ├── kiroAdapter.tokenLifecycle.test.js
│  │  │  │  ├── kiroAdapter.tokenWarming.test.js
│  │  │  │  ├── knownToolNameSetMemo.test.js
│  │  │  │  ├── largeTaskRuntimeStoreReloadOnStale.test.js
│  │  │  │  ├── learningCurriculum.curriculumLogic.test.js
│  │  │  │  ├── learningRetrieval.test.js
│  │  │  │  ├── lintCode.idleTimeout.test.js
│  │  │  │  ├── listingParse.test.js
│  │  │  │  ├── liveClampBoundaryDecision.test.js
│  │  │  │  ├── localBrainImageView.test.js
│  │  │  │  ├── localBrainNoGuessContract.test.js
│  │  │  │  ├── localLLMService.modelDiagnostics.test.js
│  │  │  │  ├── lspClient.test.js
│  │  │  │  ├── manageDbBootstrap.test.js
│  │  │  │  ├── management.test.js
│  │  │  │  ├── manifestPins.test.js
│  │  │  │  ├── mapRuntimeErrorCategory.test.js
│  │  │  │  ├── markProcessFailure.test.js
│  │  │  │  ├── markdownEmphasis.test.js
│  │  │  │  ├── marketHandler.test.js
│  │  │  │  ├── maskSecret.test.js
│  │  │  │  ├── maskToken.test.js
│  │  │  │  ├── mathSolvePolicy.test.js
│  │  │  │  ├── maxTokensPolicy.test.js
│  │  │  │  ├── maxTokensRecovery.test.js
│  │  │  │  ├── mcp
│  │  │  │  │  └── mcpServerStatus.test.js
│  │  │  │  ├── mcpAutoConnect.test.js
│  │  │  │  ├── mcpAutoConnectWiring.test.js
│  │  │  │  ├── mcpEcosystemRegistry.test.js
│  │  │  │  ├── mcpGovernance.test.js
│  │  │  │  ├── mcpOAuthTokenStore.test.js
│  │  │  │  ├── mcpRemoteTransport.test.js
│  │  │  │  ├── mcpStdinFailSoft.test.js
│  │  │  │  ├── mcpStdioPythonResolution.test.js
│  │  │  │  ├── mcpToolPool.test.js
│  │  │  │  ├── membershipSetsHoist.test.js
│  │  │  │  ├── memdir
│  │  │  │  │  ├── memorySlug.test.js
│  │  │  │  │  ├── memoryUnify.test.js
│  │  │  │  │  └── memoryUnifyIntegration.test.js
│  │  │  │  ├── memdirExclude.test.js
│  │  │  │  ├── memdirRelevance.test.js
│  │  │  │  ├── memdirSafeWrite.test.js
│  │  │  │  ├── memdirSaveTier.test.js
│  │  │  │  ├── memdirStaleness.test.js
│  │  │  │  ├── memoryContentDedup.test.js
│  │  │  │  ├── memoryStaleness.test.js
│  │  │  │  ├── memoryWriteSafety.test.js
│  │  │  │  ├── metadataHook.test.js
│  │  │  │  ├── metadataPointers.test.js
│  │  │  │  ├── middleware
│  │  │  │  │  ├── errorHandler.test.js
│  │  │  │  │  ├── originGuard.test.js
│  │  │  │  │  ├── rateLimit.test.js
│  │  │  │  │  └── requestLogger.test.js
│  │  │  │  ├── migrations
│  │  │  │  │  └── run.test.js
│  │  │  │  ├── mkdirpSync.test.js
│  │  │  │  ├── modelAdaptationHttp.test.js
│  │  │  │  ├── modelCache.autoRefresh.test.js
│  │  │  │  ├── modelCapability.test.js
│  │  │  │  ├── modelCatalogGraph.test.js
│  │  │  │  ├── modelCatalogPivots.test.js
│  │  │  │  ├── modelConstants.test.js
│  │  │  │  ├── modelDiscoveryEngine.test.js
│  │  │  │  ├── modelFeatureRegistry.test.js
│  │  │  │  ├── modelImportService.modelFormat.test.js
│  │  │  │  ├── modelRouter.test.js
│  │  │  │  ├── modelTextNormalizer.test.js
│  │  │  │  ├── modelTier.test.js
│  │  │  │  ├── models
│  │  │  │  │  ├── ApiKey.test.js
│  │  │  │  │  ├── Backtest.test.js
│  │  │  │  │  ├── Instrument.test.js
│  │  │  │  │  ├── KlineData.test.js
│  │  │  │  │  ├── Signal.test.js
│  │  │  │  │  ├── Strategy.test.js
│  │  │  │  │  ├── Trade.test.js
│  │  │  │  │  ├── User.test.js
│  │  │  │  │  ├── UserAuthState.test.js
│  │  │  │  │  └── index.test.js
│  │  │  │  ├── modernKeyRedaction.test.js
│  │  │  │  ├── modernVisionHints.test.js
│  │  │  │  ├── mojeekEngine.test.js
│  │  │  │  ├── multiFreeService.nativeHttp.test.js
│  │  │  │  ├── multiFreeService.streamAndCatalog.test.js
│  │  │  │  ├── multiTerminalBackend.test.js
│  │  │  │  ├── nativeHttpConsumers.test.js
│  │  │  │  ├── nativeLoopFallback.test.js
│  │  │  │  ├── nearestExistingDir.test.js
│  │  │  │  ├── newTools.test.js
│  │  │  │  ├── nlActionResolver.test.js
│  │  │  │  ├── nlConfigResolver.test.js
│  │  │  │  ├── nlConfigResolverDisambiguate.test.js
│  │  │  │  ├── nlConfigResolverSystemGuard.test.js
│  │  │  │  ├── nlModelSwitchResolver.test.js
│  │  │  │  ├── normLower.test.js
│  │  │  │  ├── normalizeAlnumKey.test.js
│  │  │  │  ├── normalizeAuthToken.test.js
│  │  │  │  ├── normalizeCompatibility.test.js
│  │  │  │  ├── normalizeToolName.test.js
│  │  │  │  ├── observability
│  │  │  │  │  ├── index.test.js
│  │  │  │  │  └── observability.test.js
│  │  │  │  ├── observability.eventLoopMonitor.test.js
│  │  │  │  ├── observability.profilerCore.test.js
│  │  │  │  ├── observability.slowRequest.test.js
│  │  │  │  ├── observability.slowRequestCore.test.js
│  │  │  │  ├── ocMcpBridge.test.js
│  │  │  │  ├── ocSkillBridge.test.js
│  │  │  │  ├── onDemandCapsuleModesHoist.test.js
│  │  │  │  ├── onValueOr.test.js
│  │  │  │  ├── onboarding.test.js
│  │  │  │  ├── openaiSseStream.partial.test.js
│  │  │  │  ├── openclawHome.test.js
│  │  │  │  ├── orchestrationPlan.test.js
│  │  │  │  ├── orchestrationService.test.js
│  │  │  │  ├── osProfile.adaptive.test.js
│  │  │  │  ├── packageRegistryService.test.js
│  │  │  │  ├── packageUpdateAdapter.test.js
│  │  │  │  ├── pairProgrammingVoice.regression.test.js
│  │  │  │  ├── panelBoxWidth.test.js
│  │  │  │  ├── parseJsonObjectMap.test.js
│  │  │  │  ├── parseListToSet.test.js
│  │  │  │  ├── parseRetryAfterCooldown.test.js
│  │  │  │  ├── parseTomlTables.test.js
│  │  │  │  ├── patchEmptyParamToolNamesHoist.test.js
│  │  │  │  ├── patchEnvContent.test.js
│  │  │  │  ├── pathJoinSafe.test.js
│  │  │  │  ├── pathRegexRedosWave2.test.js
│  │  │  │  ├── paymentGateway.httpRoutes.test.js
│  │  │  │  ├── paymentGatewayService.test.js
│  │  │  │  ├── pendingImageAttachments.test.js
│  │  │  │  ├── perRequestAdaptationPipeline.test.js
│  │  │  │  ├── permissionEnumUnification.test.js
│  │  │  │  ├── permissionFallback.test.js
│  │  │  │  ├── permissionOptionOrder.test.js
│  │  │  │  ├── permissionPromptPort.test.js
│  │  │  │  ├── permissionStore.acceptEdits.test.js
│  │  │  │  ├── permissionStore.newProfiles.test.js
│  │  │  │  ├── permissions
│  │  │  │  │  ├── index.test.js
│  │  │  │  │  └── permissions.test.js
│  │  │  │  ├── permissionsPromptL2Options.test.js
│  │  │  │  ├── pgPaths.test.js
│  │  │  │  ├── philosophyDesignResolver.test.js
│  │  │  │  ├── pickLocale.test.js
│  │  │  │  ├── pickUserTextSafe.test.js
│  │  │  │  ├── pipFailurePolicy.test.js
│  │  │  │  ├── plainTextImageDegrade.test.js
│  │  │  │  ├── planMode.continuousExecution.integration.test.js
│  │  │  │  ├── planMode.continuousExecution.test.js
│  │  │  │  ├── platformCtx.test.js
│  │  │  │  ├── platformUtils.openDefault.test.js
│  │  │  │  ├── playwrightSearch.test.js
│  │  │  │  ├── plugin-sdk.test.js
│  │  │  │  ├── plugin-system.test.js
│  │  │  │  ├── pluginContribResolver.test.js
│  │  │  │  ├── pluginInvoker.test.js
│  │  │  │  ├── pluginToolBridge.test.js
│  │  │  │  ├── portableUpdateAdapter.test.js
│  │  │  │  ├── positioning.test.js
│  │  │  │  ├── prCreate.test.js
│  │  │  │  ├── prepackVendorAnchor.test.js
│  │  │  │  ├── processAgent.depthLimits.test.js
│  │  │  │  ├── processAgent.test.js
│  │  │  │  ├── progressiveProgress.test.js
│  │  │  │  ├── projectBlueprint.test.js
│  │  │  │  ├── projectBoundaryAnchor.test.js
│  │  │  │  ├── projectHygiene.test.js
│  │  │  │  ├── projectInstructions.precedence.test.js
│  │  │  │  ├── projectMemoryContract.test.js
│  │  │  │  ├── projectMemoryRecall.test.js
│  │  │  │  ├── projectMetadata.test.js
│  │  │  │  ├── projectStore.test.js
│  │  │  │  ├── promptAnchors.test.js
│  │  │  │  ├── promptAutoCapture.test.js
│  │  │  │  ├── promptCacheAndContext.test.js
│  │  │  │  ├── promptCacheService.deferred.test.js
│  │  │  │  ├── promptCacheService.test.js
│  │  │  │  ├── promptCacheStableOrder.test.js
│  │  │  │  ├── promptFreshness.test.js
│  │  │  │  ├── promptIntentRepair.test.js
│  │  │  │  ├── promptLearningRules.test.js
│  │  │  │  ├── promptOnDemandSections.test.js
│  │  │  │  ├── promptOverrideAdaptersHoist.test.js
│  │  │  │  ├── promptPrefixStability.test.js
│  │  │  │  ├── promptReuse.test.js
│  │  │  │  ├── promptSectionStaticMemo.test.js
│  │  │  │  ├── promptStore.test.js
│  │  │  │  ├── promptToolsSectionMemo.test.js
│  │  │  │  ├── prompts.closureProtocol.test.js
│  │  │  │  ├── prompts.planningDiscipline.test.js
│  │  │  │  ├── prompts.unifiedMigration.test.js
│  │  │  │  ├── providerHandler.test.js
│  │  │  │  ├── proxyCli.cert.test.js
│  │  │  │  ├── proxyConfig.routing.test.js
│  │  │  │  ├── proxyConfigService.egress.test.js
│  │  │  │  ├── proxyConfigService.socks5Compatibility.test.js
│  │  │  │  ├── proxyConfigService.subscriptionLookup.test.js
│  │  │  │  ├── proxyCoreConfigGen.test.js
│  │  │  │  ├── proxyCoreManager.test.js
│  │  │  │  ├── proxyDispatcherAgent.test.js
│  │  │  │  ├── proxyServer.https.test.js
│  │  │  │  ├── proxyServer.modelRouter.integration.test.js
│  │  │  │  ├── proxyTunnel.routeMode.test.js
│  │  │  │  ├── publish.dbPreflight.test.js
│  │  │  │  ├── publish.sourceReleaseMode.test.js
│  │  │  │  ├── qemuLocate.test.js
│  │  │  │  ├── queuePanelLines.test.js
│  │  │  │  ├── rateLimit.test.js
│  │  │  │  ├── readFileSyncSafe.test.js
│  │  │  │  ├── readJsonFileSafe.test.js
│  │  │  │  ├── readOnlyToolSetsHoist.test.js
│  │  │  │  ├── recentTurnsSplit.test.js
│  │  │  │  ├── relayApiAdapter.endpointFailover.test.js
│  │  │  │  ├── reliability
│  │  │  │  │  └── reliability.test.js
│  │  │  │  ├── remoteDevService.test.js
│  │  │  │  ├── remoteDevState.test.js
│  │  │  │  ├── replyGuard.test.js
│  │  │  │  ├── repoDisciplineRisk.test.js
│  │  │  │  ├── resolveEnv.test.js
│  │  │  │  ├── resolveGatewayEnvPaths.test.js
│  │  │  │  ├── resolveModelCostEntriesHoist.test.js
│  │  │  │  ├── resolveNumericFlag.test.js
│  │  │  │  ├── resolveToolPath.test.js
│  │  │  │  ├── resolveUserPath.test.js
│  │  │  │  ├── resourceGuard.watchdog.test.js
│  │  │  │  ├── resumeAdvisor.relativeAge.test.js
│  │  │  │  ├── retryCountdown.test.js
│  │  │  │  ├── retrySleepCleanup.test.js
│  │  │  │  ├── rewindControl.test.js
│  │  │  │  ├── riskGate.shellToolNormalize.test.js
│  │  │  │  ├── roleService.test.js
│  │  │  │  ├── root-level
│  │  │  │  │  ├── capabilityMatrixParity.test.js
│  │  │  │  │  ├── customProviderRegistrar.presets.test.js
│  │  │  │  │  ├── imageGenSelection.test.js
│  │  │  │  │  ├── localOllamaProbe.test.js
│  │  │  │  │  ├── providerPresets.test.js
│  │  │  │  │  └── upstreamModelProbe.test.js
│  │  │  │  ├── routeAuth.regression.test.js
│  │  │  │  ├── routerDispatchOps.monitorObservability.test.js
│  │  │  │  ├── routes
│  │  │  │  │  ├── adminStatsHonestNulls.test.js
│  │  │  │  │  ├── aiGatewayAdmin.modelSlots.test.js
│  │  │  │  │  ├── aiGatewayPayments.route.test.js
│  │  │  │  │  ├── aiProvider.nativeHttp.test.js
│  │  │  │  │  ├── auth.capabilities.test.js
│  │  │  │  │  ├── auth.sessions.test.js
│  │  │  │  │  ├── cache.test.js
│  │  │  │  │  ├── ccSwitch.route.test.js
│  │  │  │  │  ├── commands.test.js
│  │  │  │  │  ├── crossPlatform.auth.test.js
│  │  │  │  │  ├── daemon.test.js
│  │  │  │  │  ├── image.test.js
│  │  │  │  │  ├── largeTasks.board.route.test.js
│  │  │  │  │  ├── largeTasks.errorPathsAndWatch.test.js
│  │  │  │  │  ├── largeTasks.route.test.js
│  │  │  │  │  ├── p1MountWiring.test.js
│  │  │  │  │  ├── passwordReset.enumeration.test.js
│  │  │  │  │  ├── paymentWebhooks.test.js
│  │  │  │  │  ├── quantAppWiring.presets.marketQuotes.test.js
│  │  │  │  │  ├── remoteSsh.route.test.js
│  │  │  │  │  ├── video.test.js
│  │  │  │  │  └── wx.test.js
│  │  │  │  ├── rtkEffectiveState.test.js
│  │  │  │  ├── rtkMode.test.js
│  │  │  │  ├── runTests.idleTimeout.test.js
│  │  │  │  ├── safeArrayMinMax.test.js
│  │  │  │  ├── safeStatSync.test.js
│  │  │  │  ├── saveMemoryProactive.test.js
│  │  │  │  ├── scaffoldFiles.tool.test.js
│  │  │  │  ├── scripts
│  │  │  │  │  ├── archDebtScan.baselineStale.test.js
│  │  │  │  │  ├── archDebtScan.godReport.test.js
│  │  │  │  │  └── archDebtScan.test.js
│  │  │  │  ├── searchConvergence.test.js
│  │  │  │  ├── searchFailureSignal.test.js
│  │  │  │  ├── security
│  │  │  │  │  ├── authGuard.exports.test.js
│  │  │  │  │  ├── cooldownSanity.test.js
│  │  │  │  │  ├── credentialsHardening.test.js
│  │  │  │  │  ├── featureKeyBuilder.test.js
│  │  │  │  │  ├── fetchExecuteGuardWiring.test.js
│  │  │  │  │  ├── fileIntegrity.test.js
│  │  │  │  │  ├── securityGuardRmFlagNormalize.test.js
│  │  │  │  │  ├── shellDestructiveFlagNormalize.test.js
│  │  │  │  │  ├── shellSafetyValidator.test.js
│  │  │  │  │  ├── ssrfGuard.exports.test.js
│  │  │  │  │  └── ssrfIpv4MappedHex.test.js
│  │  │  │  ├── selfRepairTransaction.test.js
│  │  │  │  ├── selfRepairTransactionRunner.test.js
│  │  │  │  ├── semanticProjection.test.js
│  │  │  │  ├── sensitiveHomeCaseFold.test.js
│  │  │  │  ├── servicePortFallback.test.js
│  │  │  │  ├── services
│  │  │  │  │  ├── __tests__
│  │  │  │  │  │  ├── agentAssets.adapters.test.js
│  │  │  │  │  │  ├── agentAssets.model.test.js
│  │  │  │  │  │  ├── agentAssets.syncRegistry.test.js
│  │  │  │  │  │  ├── aiManageDaemonLifecycle.test.js
│  │  │  │  │  │  ├── authTimeFormat.test.js
│  │  │  │  │  │  ├── backgroundTaskManager.ledger.test.js
│  │  │  │  │  │  ├── chunk_diff.test.js
│  │  │  │  │  │  ├── crdt_engine.test.js
│  │  │  │  │  │  ├── crossAgentTasteLearner.test.js
│  │  │  │  │  │  ├── deliveryLedger.test.js
│  │  │  │  │  │  ├── detectTeaching.test.js
│  │  │  │  │  │  ├── externalAgentDirective.test.js
│  │  │  │  │  │  ├── externalAgentPanelReachability.test.js
│  │  │  │  │  │  ├── file_sync_bus.test.js
│  │  │  │  │  │  ├── file_sync_chunk_bus.test.js
│  │  │  │  │  │  ├── file_sync_cross_instance.test.js
│  │  │  │  │  │  ├── file_sync_wiring.test.js
│  │  │  │  │  │  ├── glmVisionApiPin.test.js
│  │  │  │  │  │  ├── goalCore.bounded.test.js
│  │  │  │  │  │  ├── goalStopGate.test.js
│  │  │  │  │  │  ├── goalStore.bounded.test.js
│  │  │  │  │  │  ├── keyUpdateFlow.test.js
│  │  │  │  │  │  ├── procedureCatalog.test.js
│  │  │  │  │  │  ├── promptStructurer.test.js
│  │  │  │  │  │  ├── promptTemplateCatalog.test.js
│  │  │  │  │  │  ├── referencesService.test.js
│  │  │  │  │  │  ├── roundAdvanceAssessor.test.js
│  │  │  │  │  │  ├── sessionWatchdog.test.js
│  │  │  │  │  │  ├── session_registry.test.js
│  │  │  │  │  │  ├── session_registry_merge.test.js
│  │  │  │  │  │  ├── streamingToolExecutor.test.js
│  │  │  │  │  │  ├── taskClosure.decideClosure.test.js
│  │  │  │  │  │  ├── tasteService.test.js
│  │  │  │  │  │  ├── tasteWatchService.test.js
│  │  │  │  │  │  ├── terminalLaunchCommand.test.js
│  │  │  │  │  │  ├── toolCallCorrection.test.js
│  │  │  │  │  │  ├── toolFailureRecovery.test.js
│  │  │  │  │  │  ├── toolTierCatalog.test.js
│  │  │  │  │  │  ├── toolUseLoop.streamingExecGate.test.js
│  │  │  │  │  │  ├── toolUseLoop.taskClosureGate.smoke.test.js
│  │  │  │  │  │  ├── updateCoordinatorBlockedHint.test.js
│  │  │  │  │  │  └── weakModelGuidance.test.js
│  │  │  │  │  ├── a2a
│  │  │  │  │  │  ├── agentCardSpec.test.js
│  │  │  │  │  │  └── taskStateSpec.test.js
│  │  │  │  │  ├── a2aSendHeaders.test.js
│  │  │  │  │  ├── acceptanceCriteria.test.js
│  │  │  │  │  ├── accountPool
│  │  │  │  │  │  └── candidateDetectLeaf.test.js
│  │  │  │  │  ├── accountPoolCredentialHelpers.test.js
│  │  │  │  │  ├── accountPoolSwitch.test.js
│  │  │  │  │  ├── accountSelector.test.js
│  │  │  │  │  ├── adaptiveExecution.test.js
│  │  │  │  │  ├── additionalDirectories.test.js
│  │  │  │  │  ├── adminService.test.js
│  │  │  │  │  ├── advancedDiagnostics.test.js
│  │  │  │  │  ├── adversarial
│  │  │  │  │  │  └── adversarialEngine.test.js
│  │  │  │  │  ├── advisor
│  │  │  │  │  │  └── advisorPlan.test.js
│  │  │  │  │  ├── agentDevLog.test.js
│  │  │  │  │  ├── agentFsDescribeAssets.test.js
│  │  │  │  │  ├── agentLauncherRegistry.test.js
│  │  │  │  │  ├── agentStatsService.test.js
│  │  │  │  │  ├── agenticHarnessAnalytics.test.js
│  │  │  │  │  ├── agenticHarnessFalsePositiveFix.test.js
│  │  │  │  │  ├── agenticHarnessService.test.js
│  │  │  │  │  ├── agnesImageModel.test.js
│  │  │  │  │  ├── aiBackendModuleResolve.test.js
│  │  │  │  │  ├── aiChatPort.test.js
│  │  │  │  │  ├── aiConversationPort.test.js
│  │  │  │  │  ├── aiFailureAttribution.test.js
│  │  │  │  │  ├── aiManagementChatHttpLeaf.test.js
│  │  │  │  │  ├── aiManagementConversationsPromptsLeaf.test.js
│  │  │  │  │  ├── aiManagementGatewayAdminLeaf.test.js
│  │  │  │  │  ├── aiManagementKhyosWsLeaf.test.js
│  │  │  │  │  ├── answerDirectionSynthesis.test.js
│  │  │  │  │  ├── apiKeyFormat.test.js
│  │  │  │  │  ├── apiKeyPoolWatcherEnvExpand.test.js
│  │  │  │  │  ├── approvalLedger.test.js
│  │  │  │  │  ├── archDebtScan.cycleDrift.test.js
│  │  │  │  │  ├── arenaDisplayLocalization.test.js
│  │  │  │  │  ├── artifact
│  │  │  │  │  │  └── artifactPlan.test.js
│  │  │  │  │  ├── assistant
│  │  │  │  │  │  └── proactiveTogglePlan.test.js
│  │  │  │  │  ├── auditLog.test.js
│  │  │  │  │  ├── auditParserCodes.test.js
│  │  │  │  │  ├── auditTrajectory
│  │  │  │  │  │  ├── dualProcessIsolation.test.js
│  │  │  │  │  │  ├── promptDrafter.test.js
│  │  │  │  │  │  └── trajectoryChannel.test.js
│  │  │  │  │  ├── authPolicy.test.js
│  │  │  │  │  ├── authSessionService.test.js
│  │  │  │  │  ├── authTimeFormat.test.js
│  │  │  │  │  ├── autoAnswerIntentGuard.test.js
│  │  │  │  │  ├── autofixPr
│  │  │  │  │  │  └── autofixPrPlan.test.js
│  │  │  │  │  ├── autonomy
│  │  │  │  │  │  └── autonomyInspectPlan.test.js
│  │  │  │  │  ├── backslashContinuation.test.js
│  │  │  │  │  ├── backtestEngine.numeric.test.js
│  │  │  │  │  ├── batch2Ports.test.js
│  │  │  │  │  ├── batch3Ports.test.js
│  │  │  │  │  ├── benchmarkSuite.test.js
│  │  │  │  │  ├── boulderState.resume.test.js
│  │  │  │  │  ├── boulderState.test.js
│  │  │  │  │  ├── breakerResetOnNew.test.js
│  │  │  │  │  ├── browser
│  │  │  │  │  │  ├── _evalTimeout.test.js
│  │  │  │  │  │  ├── ariaSnapshot.test.js
│  │  │  │  │  │  ├── evalTimeout.integration.test.js
│  │  │  │  │  │  └── scrollPlan.test.js
│  │  │  │  │  ├── bugSentinel.test.js
│  │  │  │  │  ├── bugfixRegressionGate.test.js
│  │  │  │  │  ├── builtinProviderConfig.test.js
│  │  │  │  │  ├── byteFormat.test.js
│  │  │  │  │  ├── cacheMetricsTruth.test.js
│  │  │  │  │  ├── cacheService.test.js
│  │  │  │  │  ├── calcRegexRedosGuard.test.js
│  │  │  │  │  ├── calcSiblingRedosGuard.test.js
│  │  │  │  │  ├── capabilityMatrix
│  │  │  │  │  │  ├── composer.test.js
│  │  │  │  │  │  ├── descriptors.contract.test.js
│  │  │  │  │  │  ├── index.test.js
│  │  │  │  │  │  ├── predicates.test.js
│  │  │  │  │  │  └── route.test.js
│  │  │  │  │  ├── capabilityRegistry.weighting.test.js
│  │  │  │  │  ├── capacityFlowDiagnostics.test.js
│  │  │  │  │  ├── ccSwitch
│  │  │  │  │  │  ├── ccSwitch.test.js
│  │  │  │  │  │  ├── index.test.js
│  │  │  │  │  │  └── proxyAccess.test.js
│  │  │  │  │  ├── changelog
│  │  │  │  │  │  └── changelogParse.test.js
│  │  │  │  │  ├── channels
│  │  │  │  │  │  ├── channels.test.js
│  │  │  │  │  │  ├── ilinkChannel.test.js
│  │  │  │  │  │  ├── ilinkDispatcher.test.js
│  │  │  │  │  │  ├── ilinkExecutionLock.test.js
│  │  │  │  │  │  ├── ilinkFileSend.test.js
│  │  │  │  │  │  ├── ilinkPermission.test.js
│  │  │  │  │  │  ├── ilinkSessionMigration.test.js
│  │  │  │  │  │  ├── ilinkStability.test.js
│  │  │  │  │  │  ├── ilinkStripToolBlocks.test.js
│  │  │  │  │  │  ├── ilinkToolLoop.test.js
│  │  │  │  │  │  ├── ilinkWorkspaceRouting.test.js
│  │  │  │  │  │  ├── imAdapterChannelWiring.test.js
│  │  │  │  │  │  ├── index.test.js
│  │  │  │  │  │  ├── messageRouterIlinkBootstrap.test.js
│  │  │  │  │  │  └── messageRouterSlackAiReply.test.js
│  │  │  │  │  ├── characterizationFpfWiring.test.js
│  │  │  │  │  ├── characterizationSnapshot.test.js
│  │  │  │  │  ├── chatErrorGuard.test.js
│  │  │  │  │  ├── chatLatencyAutoTuner.test.js
│  │  │  │  │  ├── chatStateIsolation
│  │  │  │  │  │  ├── chatStateIsolation.test.js
│  │  │  │  │  │  ├── emptyReplyRetry.test.js
│  │  │  │  │  │  ├── emptyReplySalvage.test.js
│  │  │  │  │  │  ├── orphanTurnRollback.test.js
│  │  │  │  │  │  └── sseTruncationSignal.test.js
│  │  │  │  │  ├── circuitBreakerBackoff.test.js
│  │  │  │  │  ├── claimMain
│  │  │  │  │  │  └── claimMainPlan.test.js
│  │  │  │  │  ├── claudeAdapter.controlResponse.test.js
│  │  │  │  │  ├── claudeCompatToolAliases.test.js
│  │  │  │  │  ├── cleanupService.auditRotation.test.js
│  │  │  │  │  ├── cleanupService.quarantineTrim.test.js
│  │  │  │  │  ├── cleanupService.runtimeLogs.test.js
│  │  │  │  │  ├── cleanupService.tempCleanup.test.js
│  │  │  │  │  ├── cleanupService.test.js
│  │  │  │  │  ├── cleanupService.trajectoryCleanup.test.js
│  │  │  │  │  ├── cli
│  │  │  │  │  │  └── repl
│  │  │  │  │  │     └── busyInterruptEscalation.test.js
│  │  │  │  │  ├── cliAgentRunnerClusterActivation.test.js
│  │  │  │  │  ├── cliAuthRename.test.js
│  │  │  │  │  ├── cliToolSelfHeal.test.js
│  │  │  │  │  ├── cliToolSelfHealRunnableContract.test.js
│  │  │  │  │  ├── cloudSync.test.js
│  │  │  │  │  ├── codeLaziness.test.js
│  │  │  │  │  ├── codebaseIntentClassifier.test.js
│  │  │  │  │  ├── codexAdapter.fileOps.test.js
│  │  │  │  │  ├── cognitiveSnapshot
│  │  │  │  │  │  ├── cognitiveObserverWiring.test.js
│  │  │  │  │  │  └── cognitiveSnapshot.test.js
│  │  │  │  │  ├── commandCatalog.test.js
│  │  │  │  │  ├── commandDispatchPort.test.js
│  │  │  │  │  ├── commandOverlapAudit.test.js
│  │  │  │  │  ├── commandRiskClassifier.test.js
│  │  │  │  │  ├── commandRiskClassifier.windows.test.js
│  │  │  │  │  ├── commandSubstitutionContext.test.js
│  │  │  │  │  ├── commitmentTrack.test.js
│  │  │  │  │  ├── commitmentTracker.test.js
│  │  │  │  │  ├── compactShouldCompactReserve.test.js
│  │  │  │  │  ├── compile
│  │  │  │  │  │  ├── compile.test.js
│  │  │  │  │  │  ├── compileFixContract.test.js
│  │  │  │  │  │  └── toolchainHeal.test.js
│  │  │  │  │  ├── completionContract.test.js
│  │  │  │  │  ├── completionPushPolicy.test.js
│  │  │  │  │  ├── comprehensiveDataService.test.js
│  │  │  │  │  ├── computerUse
│  │  │  │  │  │  ├── computerUseAgent.test.js
│  │  │  │  │  │  ├── crossAppTask.test.js
│  │  │  │  │  │  ├── setOfMarks.test.js
│  │  │  │  │  │  └── stateDetector.test.js
│  │  │  │  │  ├── concurrencyLimiter.test.js
│  │  │  │  │  ├── config
│  │  │  │  │  │  ├── config.test.js
│  │  │  │  │  │  ├── index.test.js
│  │  │  │  │  │  ├── langPreference.test.js
│  │  │  │  │  │  ├── nlExternalAppImportResolver.test.js
│  │  │  │  │  │  ├── nlExternalAppResolver.test.js
│  │  │  │  │  │  ├── nlInstallVsConfigGuard.test.js
│  │  │  │  │  │  ├── nlProviderResolver.replace.test.js
│  │  │  │  │  │  ├── nlProviderResolver.test.js
│  │  │  │  │  │  └── sandboxToggleState.test.js
│  │  │  │  │  ├── configRepairPolicy.test.js
│  │  │  │  │  ├── constraintLattice.test.js
│  │  │  │  │  ├── constraintLatticeStrategyDuality.test.js
│  │  │  │  │  ├── context
│  │  │  │  │  │  └── ctxWindowStats.test.js
│  │  │  │  │  ├── contextCompressor.test.js
│  │  │  │  │  ├── contextDiagnostics.test.js
│  │  │  │  │  ├── contextProfile.test.js
│  │  │  │  │  ├── contextPruner.test.js
│  │  │  │  │  ├── contextRouter.test.js
│  │  │  │  │  ├── contextRouter.toolLoopThreshold.test.js
│  │  │  │  │  ├── contextWindowGuard.test.js
│  │  │  │  │  ├── contractChecker.nativeHttp.test.js
│  │  │  │  │  ├── controlRequestGuard.test.js
│  │  │  │  │  ├── conversation
│  │  │  │  │  │  ├── btwNote.test.js
│  │  │  │  │  │  └── btwNoteQueue.test.js
│  │  │  │  │  ├── correctionPhraseS1.test.js
│  │  │  │  │  ├── crashRecoveryStdio.test.js
│  │  │  │  │  ├── credentialGeneratorCustomName.test.js
│  │  │  │  │  ├── credentialGeneratorEmail.test.js
│  │  │  │  │  ├── credentialLease.test.js
│  │  │  │  │  ├── cronScheduler.test.js
│  │  │  │  │  ├── cronStepGuard.test.js
│  │  │  │  │  ├── crossPlatform
│  │  │  │  │  │  ├── crossLauncher.unit.test.js
│  │  │  │  │  │  ├── crossPlatformHub.unit.test.js
│  │  │  │  │  │  ├── protocol.unit.test.js
│  │  │  │  │  │  └── ws
│  │  │  │  │  │     └── syncServer.unit.test.js
│  │  │  │  │  ├── crossSourceMerge.test.js
│  │  │  │  │  ├── daemonSpawnLocation.test.js
│  │  │  │  │  ├── dataLocationRemedyResolve.test.js
│  │  │  │  │  ├── dataSovereignty
│  │  │  │  │  │  └── dataSovereignty.test.js
│  │  │  │  │  ├── dbHealth.dedupeDatabases.test.js
│  │  │  │  │  ├── dbHealth.selfHeal.test.js
│  │  │  │  │  ├── dedupeCache.test.js
│  │  │  │  │  ├── degenerateShellEcho.test.js
│  │  │  │  │  ├── delegationBoundary.test.js
│  │  │  │  │  ├── deliveryFastPath.test.js
│  │  │  │  │  ├── deliveryGate.test.js
│  │  │  │  │  ├── deliveryGateReporter.test.js
│  │  │  │  │  ├── deliverySummaryFormat.test.js
│  │  │  │  │  ├── deliveryValidator.test.js
│  │  │  │  │  ├── denialGuidance.test.js
│  │  │  │  │  ├── dependency
│  │  │  │  │  │  ├── dependencyHealing.test.js
│  │  │  │  │  │  ├── depsHandler.test.js
│  │  │  │  │  │  ├── installLocation.test.js
│  │  │  │  │  │  ├── installRunnerCrossPlatform.test.js
│  │  │  │  │  │  ├── resolverVersion.test.js
│  │  │  │  │  │  ├── searchToolHealingWiring.test.js
│  │  │  │  │  │  └── toolchainVersions.test.js
│  │  │  │  │  ├── deployOrchestrator.test.js
│  │  │  │  │  ├── desktopControl
│  │  │  │  │  │  ├── desktopControl.test.js
│  │  │  │  │  │  ├── desktopOutputEncoding.test.js
│  │  │  │  │  │  ├── desktopPerception.test.js
│  │  │  │  │  │  ├── desktopWindowTargeting.test.js
│  │  │  │  │  │  └── screenshotToContentBlocks.test.js
│  │  │  │  │  ├── deterministicFacts.test.js
│  │  │  │  │  ├── deterministicFactsUnitRedosGuard.test.js
│  │  │  │  │  ├── devCourseMonitor.test.js
│  │  │  │  │  ├── deviceApps
│  │  │  │  │  │  ├── deviceAppManager.test.js
│  │  │  │  │  │  ├── deviceAppsDownloader.test.js
│  │  │  │  │  │  ├── deviceAppsPolicy.test.js
│  │  │  │  │  │  ├── nativeUninstallPolicy.test.js
│  │  │  │  │  │  ├── nativeUninstallWiring.test.js
│  │  │  │  │  │  ├── nativeUninstaller.test.js
│  │  │  │  │  │  └── uninstallRoute.test.js
│  │  │  │  │  ├── diagnosticEvents.test.js
│  │  │  │  │  ├── diagnosticGrounding.test.js
│  │  │  │  │  ├── directiveParser.test.js
│  │  │  │  │  ├── directiveRegistryAudit.guard.test.js
│  │  │  │  │  ├── diskCleanupBoxWidth.test.js
│  │  │  │  │  ├── diskCleanupClarify.test.js
│  │  │  │  │  ├── docMarkerSync.test.js
│  │  │  │  │  ├── docPathIndex.test.js
│  │  │  │  │  ├── docProductPlan.test.js
│  │  │  │  │  ├── docSuggestDraft.test.js
│  │  │  │  │  ├── docsFreshnessRunner.test.js
│  │  │  │  │  ├── documentSnippetService.test.js
│  │  │  │  │  ├── domain
│  │  │  │  │  │  ├── cpa
│  │  │  │  │  │  │  ├── cpaKeyPool.test.js
│  │  │  │  │  │  │  ├── cpaProtocolConverter.test.js
│  │  │  │  │  │  │  └── cpaService.test.js
│  │  │  │  │  │  ├── query
│  │  │  │  │  │  │  ├── query
│  │  │  │  │  │  │  │  └── responseDebounce.test.js
│  │  │  │  │  │  │  └── search
│  │  │  │  │  │  │     ├── searchFreshness.test.js
│  │  │  │  │  │  │     └── searchNecessity.test.js
│  │  │  │  │  │  ├── state
│  │  │  │  │  │  │  └── stateMachine
│  │  │  │  │  │  │     └── __tests__
│  │  │  │  │  │  │        ├── agentLifecycle.test.js
│  │  │  │  │  │  │        ├── fsm.test.js
│  │  │  │  │  │  │        └── toolLoopPhases.test.js
│  │  │  │  │  │  └── trajectory
│  │  │  │  │  │     └── trajectoryReplay
│  │  │  │  │  │        └── tierRegistry.test.js
│  │  │  │  │  ├── doomLoopGuard.test.js
│  │  │  │  │  ├── dualTrack
│  │  │  │  │  │  ├── dualTrack.test.js
│  │  │  │  │  │  └── lenientResponseParserActionKeysHoist.test.js
│  │  │  │  │  ├── dualTrackForge
│  │  │  │  │  │  └── dualTrackForge.test.js
│  │  │  │  │  ├── dynamicFreeModelService.extract.test.js
│  │  │  │  │  ├── editDiffPreview.test.js
│  │  │  │  │  ├── editReplacer.test.js
│  │  │  │  │  ├── ensureBuiltinZen.test.js
│  │  │  │  │  ├── envPlatform.test.js
│  │  │  │  │  ├── envProbes.test.js
│  │  │  │  │  ├── envRepair.test.js
│  │  │  │  │  ├── envSymbiosis
│  │  │  │  │  │  ├── envSymbiosis.test.js
│  │  │  │  │  │  └── osProfileSymbiosisWiring.test.js
│  │  │  │  │  ├── errorClassifier.contextOverflow.test.js
│  │  │  │  │  ├── errorClassifier.test.js
│  │  │  │  │  ├── errorSolutionAdvisor.test.js
│  │  │  │  │  ├── evoEngine
│  │  │  │  │  │  ├── evoEngine.test.js
│  │  │  │  │  │  └── frictionBridge.test.js
│  │  │  │  │  ├── execApproval.resolve.test.js
│  │  │  │  │  ├── externalApps
│  │  │  │  │  │  ├── adapters.test.js
│  │  │  │  │  │  ├── appModelImporter.test.js
│  │  │  │  │  │  ├── externalApps.test.js
│  │  │  │  │  │  ├── index.test.js
│  │  │  │  │  │  ├── opencodeConfigHeal.test.js
│  │  │  │  │  │  └── tomlLite.test.js
│  │  │  │  │  ├── fableVoiceProfile.test.js
│  │  │  │  │  ├── fableVoiceWiring.test.js
│  │  │  │  │  ├── failsafe
│  │  │  │  │  │  ├── failsafe.test.js
│  │  │  │  │  │  └── resumable.test.js
│  │  │  │  │  ├── falsePositiveFixGuard.test.js
│  │  │  │  │  ├── featureFlags.claudeDelegation.test.js
│  │  │  │  │  ├── featureFlags.test.js
│  │  │  │  │  ├── fetchTimeout.test.js
│  │  │  │  │  ├── fileExtractionD7.test.js
│  │  │  │  │  ├── fileSizeImageSsot.test.js
│  │  │  │  │  ├── fileSizeMediaSsot.test.js
│  │  │  │  │  ├── fixtures-clip-read.ps1
│  │  │  │  │  ├── flagRegistry.test.js
│  │  │  │  │  ├── forge
│  │  │  │  │  │  ├── forgeClient.test.js
│  │  │  │  │  │  └── forgeCore.test.js
│  │  │  │  │  ├── freeModelChannels.test.js
│  │  │  │  │  ├── freshInstallDoctor.test.js
│  │  │  │  │  ├── fsReadErrorGuard.test.js
│  │  │  │  │  ├── functionTagToolCall.test.js
│  │  │  │  │  ├── futureProofing.test.js
│  │  │  │  │  ├── gateway
│  │  │  │  │  │  ├── _aiGatewayHelpers.test.js
│  │  │  │  │  │  ├── abortInterruptWiring.test.js
│  │  │  │  │  │  ├── abortRaceArm.test.js
│  │  │  │  │  │  ├── adapters
│  │  │  │  │  │  │  ├── _endpointResolver.test.js
│  │  │  │  │  │  │  ├── anthropicRelayPresets.test.js
│  │  │  │  │  │  │  ├── anthropicSseStreamPartial.test.js
│  │  │  │  │  │  │  ├── codexEventStreamLeaf.test.js
│  │  │  │  │  │  │  ├── openaiRelayPresets.test.js
│  │  │  │  │  │  │  ├── opencodeBinResolver.test.js
│  │  │  │  │  │  │  ├── portableCli.test.js
│  │  │  │  │  │  │  ├── sseTextDecoder.test.js
│  │  │  │  │  │  │  └── streamErrorPartial.test.js
│  │  │  │  │  │  ├── adaptiveParamStrip.test.js
│  │  │  │  │  │  ├── agentModelProjection.test.js
│  │  │  │  │  │  ├── aiGateway.localAdapterSelection.test.js
│  │  │  │  │  │  ├── anthropicRelayPresets.test.js
│  │  │  │  │  │  ├── autoModelRouting.test.js
│  │  │  │  │  │  ├── capabilityModelKey.test.js
│  │  │  │  │  │  ├── cascadeModelScope.test.js
│  │  │  │  │  │  ├── ccEnvAdoptPolicy.test.js
│  │  │  │  │  │  ├── channelLifecycle.test.js
│  │  │  │  │  │  ├── channelLogGating.test.js
│  │  │  │  │  │  ├── claudeAuthScheme.test.js
│  │  │  │  │  │  ├── cliToolAbortWiring.test.js
│  │  │  │  │  │  ├── cliToolAdapterImages.test.js
│  │  │  │  │  │  ├── codexEnvAdoptPolicy.test.js
│  │  │  │  │  │  ├── corsUtils.test.js
│  │  │  │  │  │  ├── cwStreamStall.integration.test.js
│  │  │  │  │  │  ├── endpointResolver.test.js
│  │  │  │  │  │  ├── failureReasonRanking.test.js
│  │  │  │  │  │  ├── gatewayIdleProgressPolicy.test.js
│  │  │  │  │  │  ├── gatewayPublicGetters.test.js
│  │  │  │  │  │  ├── generateWithAdapterMaxTokensPreflight.test.js
│  │  │  │  │  │  ├── glmVisionImageDownscale.test.js
│  │  │  │  │  │  ├── glmVisionMaxTokens.test.js
│  │  │  │  │  │  ├── glmVisionModel.test.js
│  │  │  │  │  │  ├── glmVisionTextBudget.test.js
│  │  │  │  │  │  ├── glmVisionWiring.test.js
│  │  │  │  │  │  ├── idleProgressWiring.test.js
│  │  │  │  │  │  ├── imageCompatMime.test.js
│  │  │  │  │  │  ├── imageTranscode.test.js
│  │  │  │  │  │  ├── localOllamaProbe.test.js
│  │  │  │  │  │  ├── manualRelayAutoFallbackPolicy.test.js
│  │  │  │  │  │  ├── modelExistenceEvidence.test.js
│  │  │  │  │  │  ├── modelHealthLedger.test.js
│  │  │  │  │  │  ├── modelListTruth.test.js
│  │  │  │  │  │  ├── modelNotFoundCooldownScope.test.js
│  │  │  │  │  │  ├── modelNotFoundRecovery.test.js
│  │  │  │  │  │  ├── modelSubstitutionNotice.test.js
│  │  │  │  │  │  ├── modelToolingCapability.test.js
│  │  │  │  │  │  ├── ocrOrientationNotice.test.js
│  │  │  │  │  │  ├── ocrRescueStatusNotice.test.js
│  │  │  │  │  │  ├── ocrResolutionNotice.test.js
│  │  │  │  │  │  ├── ocrUsageNotice.test.js
│  │  │  │  │  │  ├── openaiRelayPresets.test.js
│  │  │  │  │  │  ├── opencodeInvocation.test.js
│  │  │  │  │  │  ├── providerConnectivitySpec.test.js
│  │  │  │  │  │  ├── qoderProxyModels.test.js
│  │  │  │  │  │  ├── relayModelGuard.test.js
│  │  │  │  │  │  ├── relayVendorMismatchGuard.test.js
│  │  │  │  │  │  ├── routeLatencyAware.e2e.test.js
│  │  │  │  │  │  ├── routeLatencyPenalty.test.js
│  │  │  │  │  │  ├── routeLatencyStore.test.js
│  │  │  │  │  │  ├── scaleToZeroPolicy.test.js
│  │  │  │  │  │  ├── streamStallPolicy.test.js
│  │  │  │  │  │  ├── streamStallTeardown.integration.test.js
│  │  │  │  │  │  ├── tlsSidecarDownloadHint.test.js
│  │  │  │  │  │  ├── toolCallingProbe.test.js
│  │  │  │  │  │  ├── toolCapabilityFalsenegRegression.test.js
│  │  │  │  │  │  ├── toolCapabilityStore.test.js
│  │  │  │  │  │  ├── toolChallengeCadence.test.js
│  │  │  │  │  │  ├── vertexHandlerWiring.test.js
│  │  │  │  │  │  ├── vertexRequestShaping.test.js
│  │  │  │  │  │  ├── visionCapabilityProbe.test.js
│  │  │  │  │  │  ├── visionCapabilityStore.test.js
│  │  │  │  │  │  ├── visionCascadeAttemptNotice.test.js
│  │  │  │  │  │  ├── visionDescribeCooldownBypass.test.js
│  │  │  │  │  │  ├── visionDescribePinApiAdapter.test.js
│  │  │  │  │  │  ├── visionDescribeReturn.test.js
│  │  │  │  │  │  ├── visionFailureSummary.test.js
│  │  │  │  │  │  ├── visionFallbackCandidates.test.js
│  │  │  │  │  │  ├── visionGenerationExclusion.test.js
│  │  │  │  │  │  ├── visionIntermediateMessage.test.js
│  │  │  │  │  │  ├── visionModelDisplayName.test.js
│  │  │  │  │  │  ├── visionOcrSuccessClosure.test.js
│  │  │  │  │  │  ├── visionPoolFailStatus.test.js
│  │  │  │  │  │  ├── wildcardPoolGuard.test.js
│  │  │  │  │  │  ├── wildcardPoolGuard.wiring.test.js
│  │  │  │  │  │  └── zhipuFreeModels.test.js
│  │  │  │  │  ├── gatewayHardDeadline.test.js
│  │  │  │  │  ├── gatewayLogLease
│  │  │  │  │  │  ├── gatewayLogLease.test.js
│  │  │  │  │  │  └── wiring.test.js
│  │  │  │  │  ├── gatewayReadCache.test.js
│  │  │  │  │  ├── gatewayResetHonestError.test.js
│  │  │  │  │  ├── gatewayResetPolicy.test.js
│  │  │  │  │  ├── git
│  │  │  │  │  │  ├── gitContextShellFree.test.js
│  │  │  │  │  │  ├── gitSpawnPlan.test.js
│  │  │  │  │  │  └── workspaceGitInitShellFree.test.js
│  │  │  │  │  ├── gitContextAsyncRefresh.test.js
│  │  │  │  │  ├── gitPush.tool.test.js
│  │  │  │  │  ├── gitSpawnPlan.test.js
│  │  │  │  │  ├── gitTrackWhitelistWiring.test.js
│  │  │  │  │  ├── gitignoreAdvisor.test.js
│  │  │  │  │  ├── gitignoreReviewStore.test.js
│  │  │  │  │  ├── gitignoreService.test.js
│  │  │  │  │  ├── glmAdaptationWiring.test.js
│  │  │  │  │  ├── goalCore.test.js
│  │  │  │  │  ├── goalEndurance.test.js
│  │  │  │  │  ├── goalEnduranceWiring.test.js
│  │  │  │  │  ├── goalKickoff.test.js
│  │  │  │  │  ├── goalModeService.report.test.js
│  │  │  │  │  ├── goalModeService.test.js
│  │  │  │  │  ├── goalReconcileIdle.test.js
│  │  │  │  │  ├── goalStopGateVerifyRan.test.js
│  │  │  │  │  ├── goalStore.test.js
│  │  │  │  │  ├── groundTruth.test.js
│  │  │  │  │  ├── growthService.test.js
│  │  │  │  │  ├── guardApproval.test.js
│  │  │  │  │  ├── healEscalationService.test.js
│  │  │  │  │  ├── heartbeatCooldown.test.js
│  │  │  │  │  ├── heartbeatService.test.js
│  │  │  │  │  ├── heuristic.test.js
│  │  │  │  │  ├── historyReverseSearch.test.js
│  │  │  │  │  ├── honestFailureReason.test.js
│  │  │  │  │  ├── hookApprovableMetadata.test.js
│  │  │  │  │  ├── hookFaultIsolation.test.js
│  │  │  │  │  ├── hookTelemetry.test.js
│  │  │  │  │  ├── ide
│  │  │  │  │  │  └── idePlan.test.js
│  │  │  │  │  ├── imageContextCard.test.js
│  │  │  │  │  ├── imageFileCards.test.js
│  │  │  │  │  ├── imageGenFailureSummary.test.js
│  │  │  │  │  ├── imageGenPoolBridge.test.js
│  │  │  │  │  ├── imageGenUserPref.test.js
│  │  │  │  │  ├── imageMixedFormatLink.test.js
│  │  │  │  │  ├── imageService.pathQuote.test.js
│  │  │  │  │  ├── inertiaCompletion.test.js
│  │  │  │  │  ├── inputPreprocessor.test.js
│  │  │  │  │  ├── inputSanitizer.test.js
│  │  │  │  │  ├── inputSanitizerTrimRedosGuard.test.js
│  │  │  │  │  ├── installLedger.test.js
│  │  │  │  │  ├── instructionExternalIncludes.test.js
│  │  │  │  │  ├── instructionQuickMemory.test.js
│  │  │  │  │  ├── instructionReviewStore.test.js
│  │  │  │  │  ├── instrumentSyncService.test.js
│  │  │  │  │  ├── integration.test.js
│  │  │  │  │  ├── intentArbiter
│  │  │  │  │  │  ├── intentArbiter.test.js
│  │  │  │  │  │  ├── intentArbiterWiring.test.js
│  │  │  │  │  │  ├── intentCalibration.test.js
│  │  │  │  │  │  ├── intentNegation.test.js
│  │  │  │  │  │  └── intentPreprocess.test.js
│  │  │  │  │  ├── intentCoverage.test.js
│  │  │  │  │  ├── intentGate.loopBoost.test.js
│  │  │  │  │  ├── intentGate.teaching.test.js
│  │  │  │  │  ├── intentGate.teachingInterrogative.test.js
│  │  │  │  │  ├── intentGate.teachingRoleFraming.test.js
│  │  │  │  │  ├── intentGate.test.js
│  │  │  │  │  ├── intentHeuristics.classifiers.test.js
│  │  │  │  │  ├── interactiveMenuPort.test.js
│  │  │  │  │  ├── interruptionMarker.test.js
│  │  │  │  │  ├── issue
│  │  │  │  │  │  └── issueReport.test.js
│  │  │  │  │  ├── keyUpdateFlowCasePreserve.test.js
│  │  │  │  │  ├── keybindings
│  │  │  │  │  │  └── keybindingCatalog.test.js
│  │  │  │  │  ├── klineDataService.test.js
│  │  │  │  │  ├── knowledgeTeachingService.selfAwareness.test.js
│  │  │  │  │  ├── largeTaskOrchestrator.test.js
│  │  │  │  │  ├── largeTaskRuntimeStore.concurrency.test.js
│  │  │  │  │  ├── largeTaskRuntimeStore.persistence.test.js
│  │  │  │  │  ├── largeTaskRuntimeStore.test.js
│  │  │  │  │  ├── largeTaskWorkerService.test.js
│  │  │  │  │  ├── latestUserText.test.js
│  │  │  │  │  ├── latestVersionResolver.test.js
│  │  │  │  │  ├── launchOutcome.test.js
│  │  │  │  │  ├── lazyLoader.test.js
│  │  │  │  │  ├── learningCurriculum.rank.test.js
│  │  │  │  │  ├── learningCurriculumDynamic.test.js
│  │  │  │  │  ├── learningImprove.test.js
│  │  │  │  │  ├── learningProfile.test.js
│  │  │  │  │  ├── ledgerWriter.test.js
│  │  │  │  │  ├── liveModelSwitch.test.js
│  │  │  │  │  ├── llmGenerateSink.test.js
│  │  │  │  │  ├── localBrainBareKeyWithModel.test.js
│  │  │  │  │  ├── localBrainCalc.test.js
│  │  │  │  │  ├── localBrainEnvOptimize.test.js
│  │  │  │  │  ├── localBrainFileLookup.test.js
│  │  │  │  │  ├── localBrainFileOpGlued.test.js
│  │  │  │  │  ├── localBrainJokeSearch.test.js
│  │  │  │  │  ├── localBrainListDir.test.js
│  │  │  │  │  ├── localBrainMapEntriesHoist.test.js
│  │  │  │  │  ├── localBrainMkdirDelete.test.js
│  │  │  │  │  ├── localBrainProviderConfig.test.js
│  │  │  │  │  ├── localBrainProviderConfigLeaf.test.js
│  │  │  │  │  ├── localBrainSafeEval.test.js
│  │  │  │  │  ├── localBrainSessionContext.test.js
│  │  │  │  │  ├── localBrainStopwordsHoist.test.js
│  │  │  │  │  ├── localBrainTextOps.test.js
│  │  │  │  │  ├── localBrainTextOpsHoist.test.js
│  │  │  │  │  ├── localChatAdapters.test.js
│  │  │  │  │  ├── localDataCleanup.test.js
│  │  │  │  │  ├── localExecutionPlanner.test.js
│  │  │  │  │  ├── localFirstAppLaunch.test.js
│  │  │  │  │  ├── localFormat.test.js
│  │  │  │  │  ├── localMemoryRecall.test.js
│  │  │  │  │  ├── localModelLoadDiagnosis.test.js
│  │  │  │  │  ├── localNlp.test.js
│  │  │  │  │  ├── localReasoning.test.js
│  │  │  │  │  ├── localSearchFormatting.test.js
│  │  │  │  │  ├── localTemplates.test.js
│  │  │  │  │  ├── localToolLoop.test.js
│  │  │  │  │  ├── localToolLoopStructured.test.js
│  │  │  │  │  ├── localWebSolver.test.js
│  │  │  │  │  ├── lrtaBackfill.test.js
│  │  │  │  │  ├── maintainerCockpit.test.js
│  │  │  │  │  ├── makeSystemPromptShortContext.test.js
│  │  │  │  │  ├── management
│  │  │  │  │  │  └── parityGuardWiring.test.js
│  │  │  │  │  ├── marketDataService.test.js
│  │  │  │  │  ├── marshal
│  │  │  │  │  │  └── capabilityVector.test.js
│  │  │  │  │  ├── mcp
│  │  │  │  │  │  ├── mcpAddSpec.test.js
│  │  │  │  │  │  ├── mcpClientCapabilities.test.js
│  │  │  │  │  │  ├── mcpConfigStore.test.js
│  │  │  │  │  │  ├── mcpHttpServer.test.js
│  │  │  │  │  │  ├── mcpProtocolNegotiation.test.js
│  │  │  │  │  │  ├── mcpServeToolPolicy.test.js
│  │  │  │  │  │  ├── mcpServer.test.js
│  │  │  │  │  │  ├── mcpServerPresets.test.js
│  │  │  │  │  │  └── mcpServerProtocol.test.js
│  │  │  │  │  ├── mcpDisclosure.test.js
│  │  │  │  │  ├── md.test.js
│  │  │  │  │  ├── mdEditor
│  │  │  │  │  │  └── mdEditorRegister.test.js
│  │  │  │  │  ├── mdSuggestedAppsPlan.test.js
│  │  │  │  │  ├── mediaTranscriptionService.test.js
│  │  │  │  │  ├── memoryBridge.test.js
│  │  │  │  │  ├── memoryDreamEnhancer.test.js
│  │  │  │  │  ├── memoryEngine
│  │  │  │  │  │  ├── distiller.test.js
│  │  │  │  │  │  ├── dreamPromote.test.js
│  │  │  │  │  │  ├── embeddingDegrade.test.js
│  │  │  │  │  │  ├── memoryEngine.test.js
│  │  │  │  │  │  ├── memoryRecallEnrich.test.js
│  │  │  │  │  │  ├── priming.test.js
│  │  │  │  │  │  ├── progressLog.test.js
│  │  │  │  │  │  ├── rankForPriming.test.js
│  │  │  │  │  │  ├── recallUnified.test.js
│  │  │  │  │  │  ├── sessionCheckpoint.test.js
│  │  │  │  │  │  ├── topicSwitch.test.js
│  │  │  │  │  │  ├── vectorRecallQuality.test.js
│  │  │  │  │  │  └── vectorStore.test.js
│  │  │  │  │  ├── memoryLifecycle.test.js
│  │  │  │  │  ├── memoryNoticeDelivery.test.js
│  │  │  │  │  ├── memoryOpsNotice.test.js
│  │  │  │  │  ├── memoryRecallProcessWiring.test.js
│  │  │  │  │  ├── memoryTier.test.js
│  │  │  │  │  ├── memoryTrigger.instruction.test.js
│  │  │  │  │  ├── memoryTrigger.test.js
│  │  │  │  │  ├── mergeResultsSkipDistinct.test.js
│  │  │  │  │  ├── meshCore.test.js
│  │  │  │  │  ├── meshStore.test.js
│  │  │  │  │  ├── messageTokenTally.test.js
│  │  │  │  │  ├── messaging
│  │  │  │  │  │  ├── ilinkAccountStore.test.js
│  │  │  │  │  │  ├── ilinkApi.test.js
│  │  │  │  │  │  ├── ilinkBindingStore.test.js
│  │  │  │  │  │  ├── ilinkCore.test.js
│  │  │  │  │  │  ├── ilinkCrypto.test.js
│  │  │  │  │  │  ├── ilinkLogin.dataurl.test.js
│  │  │  │  │  │  ├── ilinkLogin.test.js
│  │  │  │  │  │  ├── index.test.js
│  │  │  │  │  │  ├── messaging.test.js
│  │  │  │  │  │  ├── msgChannelCore.test.js
│  │  │  │  │  │  ├── msgConfigStore.test.js
│  │  │  │  │  │  ├── msgInboundCore.test.js
│  │  │  │  │  │  ├── msgReplyBridge.test.js
│  │  │  │  │  │  ├── msgReplyRoundtrip.test.js
│  │  │  │  │  │  ├── msgSenderAndChannels.test.js
│  │  │  │  │  │  ├── msgSenderRetry.test.js
│  │  │  │  │  │  └── webhookRoutes.test.js
│  │  │  │  │  ├── metaConstraint
│  │  │  │  │  │  ├── metaConstraint.test.js
│  │  │  │  │  │  └── toolFunnelGuard.test.js
│  │  │  │  │  ├── metaToolEngine.test.js
│  │  │  │  │  ├── metaplan
│  │  │  │  │  │  └── metaPlanSubsystem.test.js
│  │  │  │  │  ├── moaAggregation.test.js
│  │  │  │  │  ├── moaService.test.js
│  │  │  │  │  ├── modelAdaptationHttp.test.js
│  │  │  │  │  ├── modelIdentityTruth.test.js
│  │  │  │  │  ├── modelImportService.formatDetection.test.js
│  │  │  │  │  ├── modelImportService.searchDirs.test.js
│  │  │  │  │  ├── modelMesh.test.js
│  │  │  │  │  ├── modelTrainingService.fetch.test.js
│  │  │  │  │  ├── multiFreeService.emptyErrorType.test.js
│  │  │  │  │  ├── multiFreeService.finishReason.test.js
│  │  │  │  │  ├── multiFreeService.providerProxyUnreachable.test.js
│  │  │  │  │  ├── multiFreeService.streamUsage.test.js
│  │  │  │  │  ├── multiFreeService.zenGate.test.js
│  │  │  │  │  ├── multimodalInputService.test.js
│  │  │  │  │  ├── multimodalIntentRouter.test.js
│  │  │  │  │  ├── ndjsonStream.test.js
│  │  │  │  │  ├── networkDetector.test.js
│  │  │  │  │  ├── news.test.js
│  │  │  │  │  ├── newsContentFetcher.test.js
│  │  │  │  │  ├── notificationPort.test.js
│  │  │  │  │  ├── ocrSnippetService.test.js
│  │  │  │  │  ├── offlineHttpStatusNl.test.js
│  │  │  │  │  ├── ollamaAdapterStreaming.test.js
│  │  │  │  │  ├── ollamaModelDiagnosis.test.js
│  │  │  │  │  ├── ollamaModelManager.importSource.test.js
│  │  │  │  │  ├── onboarding
│  │  │  │  │  │  ├── onboardingPlan.test.js
│  │  │  │  │  │  └── safetyNotice.test.js
│  │  │  │  │  ├── orchestrationFlow.test.js
│  │  │  │  │  ├── orchestrator
│  │  │  │  │  │  ├── dependencyWaveScheduler.test.js
│  │  │  │  │  │  ├── index.test.js
│  │  │  │  │  │  ├── mergeEmptySuccess.test.js
│  │  │  │  │  │  ├── mergeFileConflicts.test.js
│  │  │  │  │  │  ├── mergeRoleAttribution.test.js
│  │  │  │  │  │  ├── orchestrator.test.js
│  │  │  │  │  │  └── roleToolScope.test.js
│  │  │  │  │  ├── orphanSweep.test.js
│  │  │  │  │  ├── output
│  │  │  │  │  │  └── jsonSchemaValidate.test.js
│  │  │  │  │  ├── outputIntegrityMonitor.test.js
│  │  │  │  │  ├── ownerControlService.test.js
│  │  │  │  │  ├── patchEmptyToolNames.test.js
│  │  │  │  │  ├── patternMatcher.test.js
│  │  │  │  │  ├── payloadProvisioner.test.js
│  │  │  │  │  ├── perf
│  │  │  │  │  │  └── perfReport.test.js
│  │  │  │  │  ├── performanceSampler.test.js
│  │  │  │  │  ├── permissionBroker.test.js
│  │  │  │  │  ├── permissionModesAndHookFloor.test.js
│  │  │  │  │  ├── permissionPolicy
│  │  │  │  │  │  └── permissionPolicy.test.js
│  │  │  │  │  ├── permissionPromptPort.test.js
│  │  │  │  │  ├── permissionStore.learned.test.js
│  │  │  │  │  ├── permissionStore.patternRules.test.js
│  │  │  │  │  ├── permissionStore.test.js
│  │  │  │  │  ├── pipResiduePolicy.test.js
│  │  │  │  │  ├── pipResiduePurgeWiring.test.js
│  │  │  │  │  ├── pipVersionSanity.test.js
│  │  │  │  │  ├── pipVersionSanityWiring.test.js
│  │  │  │  │  ├── planModeDirective.test.js
│  │  │  │  │  ├── planModeService.approval.test.js
│  │  │  │  │  ├── planModeService.idleTimeout.test.js
│  │  │  │  │  ├── planModeService.richPlan.test.js
│  │  │  │  │  ├── planModeService.stepType.test.js
│  │  │  │  │  ├── planModeService.verifyGate.test.js
│  │  │  │  │  ├── planModeSink.test.js
│  │  │  │  │  ├── planModeStepAnchor.test.js
│  │  │  │  │  ├── platformCapabilities.branchGuidance.test.js
│  │  │  │  │  ├── playwrightSearchHardTimeout.test.js
│  │  │  │  │  ├── pluginDoctorPort.test.js
│  │  │  │  │  ├── portableSyncRules.test.js
│  │  │  │  │  ├── postEditDiagnostics.test.js
│  │  │  │  │  ├── preExecutionExplainer.gitHazard.test.js
│  │  │  │  │  ├── preExecutionExplainer.test.js
│  │  │  │  │  ├── preferenceSignals.test.js
│  │  │  │  │  ├── priorReadGuard.newFile.test.js
│  │  │  │  │  ├── priorityTaxonomy.test.js
│  │  │  │  │  ├── proactiveCollaboration
│  │  │  │  │  │  └── proactiveCollaboration.test.js
│  │  │  │  │  ├── projectBlueprintBoxWidth.test.js
│  │  │  │  │  ├── projectCoherence.test.js
│  │  │  │  │  ├── projectHygiene.scaffold.test.js
│  │  │  │  │  ├── projectMemory.test.js
│  │  │  │  │  ├── promptCacheOptimizer.test.js
│  │  │  │  │  ├── promptComposer.test.js
│  │  │  │  │  ├── promptComposerService.test.js
│  │  │  │  │  ├── protocolArbitration.test.js
│  │  │  │  │  ├── proxyBaseUrl.test.js
│  │  │  │  │  ├── proxyCoreInstaller.test.js
│  │  │  │  │  ├── proxyNodeParse.test.js
│  │  │  │  │  ├── proxyUriHelpers.test.js
│  │  │  │  │  ├── proxyUriParsers.test.js
│  │  │  │  │  ├── publishBundleArtifacts.test.js
│  │  │  │  │  ├── publishDockerBundleBuilder.test.js
│  │  │  │  │  ├── publishProjectState.test.js
│  │  │  │  │  ├── publishUtils.test.js
│  │  │  │  │  ├── pushConfigStore.test.js
│  │  │  │  │  ├── pushNotifyCore.test.js
│  │  │  │  │  ├── query
│  │  │  │  │  │  ├── continuation.test.js
│  │  │  │  │  │  └── seamlessResume.test.js
│  │  │  │  │  ├── queryEngine.controlRequest.test.js
│  │  │  │  │  ├── queryEngine.intentAssurance.test.js
│  │  │  │  │  ├── queryEngine.intentAssuranceHarness.test.js
│  │  │  │  │  ├── queryEngine.toolLoopFeatures.test.js
│  │  │  │  │  ├── queryEngine.toolLoopParity.test.js
│  │  │  │  │  ├── questionQuality.test.js
│  │  │  │  │  ├── quickTaskService.test.js
│  │  │  │  │  ├── ragRetrievalService.test.js
│  │  │  │  │  ├── rateLimiter.test.js
│  │  │  │  │  ├── receiptService.test.js
│  │  │  │  │  ├── referenceDisambiguation.test.js
│  │  │  │  │  ├── remoteApprovalBridge.test.js
│  │  │  │  │  ├── remoteExecService.liveExec.test.js
│  │  │  │  │  ├── remoteExecStreamStore.test.js
│  │  │  │  │  ├── remoteFileTransferService.test.js
│  │  │  │  │  ├── remotePersistenceAlerts.test.js
│  │  │  │  │  ├── remoteStateHydration.integration.test.js
│  │  │  │  │  ├── remoteStatePersistence.test.js
│  │  │  │  │  ├── repeatedPromptRounds.test.js
│  │  │  │  │  ├── replyDedup.test.js
│  │  │  │  │  ├── repoMap
│  │  │  │  │  │  ├── index.test.js
│  │  │  │  │  │  └── repoMapRenderer.test.js
│  │  │  │  │  ├── resilience
│  │  │  │  │  │  └── resilience.test.js
│  │  │  │  │  ├── resources
│  │  │  │  │  │  ├── archiveInstaller.test.js
│  │  │  │  │  │  ├── resourceManager.test.js
│  │  │  │  │  │  └── resourceTask.test.js
│  │  │  │  │  ├── restore
│  │  │  │  │  │  ├── index.test.js
│  │  │  │  │  │  └── restore.test.js
│  │  │  │  │  ├── restoreArchiveExtractCheck.test.js
│  │  │  │  │  ├── restoreCompletenessCheck.test.js
│  │  │  │  │  ├── restorePathPortabilityCheck.test.js
│  │  │  │  │  ├── restorePreflightCheck.test.js
│  │  │  │  │  ├── restoreProvenanceCheck.test.js
│  │  │  │  │  ├── resumeAdvisor
│  │  │  │  │  │  └── resumeAdvisor.test.js
│  │  │  │  │  ├── retryRoundCap.test.js
│  │  │  │  │  ├── retryWithBackoff.test.js
│  │  │  │  │  ├── retryableLoopOutcomeHoist.test.js
│  │  │  │  │  ├── reverseEngineer
│  │  │  │  │  │  ├── asarArchive.test.js
│  │  │  │  │  │  └── reverseEngineer.test.js
│  │  │  │  │  ├── reversibility.test.js
│  │  │  │  │  ├── rewindResume.test.js
│  │  │  │  │  ├── rewindResumePersistence.test.js
│  │  │  │  │  ├── riskGate.test.js
│  │  │  │  │  ├── riskOrder.test.js
│  │  │  │  │  ├── riskVocabulary.test.js
│  │  │  │  │  ├── rollbackService.test.js
│  │  │  │  │  ├── runtimeProvisioner.test.js
│  │  │  │  │  ├── salvageSummaryFocus.test.js
│  │  │  │  │  ├── samplingPolicy.test.js
│  │  │  │  │  ├── searchFreshness.test.js
│  │  │  │  │  ├── searchNecessity.test.js
│  │  │  │  │  ├── searchSourceDiscovery.test.js
│  │  │  │  │  ├── searchTokenizer.test.js
│  │  │  │  │  ├── selfAuditRegistry.test.js
│  │  │  │  │  ├── selfAuditVerifier.test.js
│  │  │  │  │  ├── selfEditAdvisory.test.js
│  │  │  │  │  ├── selfEditAdvisoryService.test.js
│  │  │  │  │  ├── selfEditWatcher.test.js
│  │  │  │  │  ├── selfHeal
│  │  │  │  │  │  ├── selfHeal.test.js
│  │  │  │  │  │  └── wiring.test.js
│  │  │  │  │  ├── selfLocation.test.js
│  │  │  │  │  ├── selfSustainingInfra
│  │  │  │  │  │  └── selfSustainingInfra.test.js
│  │  │  │  │  ├── sequentialChainDecompose.test.js
│  │  │  │  │  ├── sequentialQueue.test.js
│  │  │  │  │  ├── serviceDefaults.test.js
│  │  │  │  │  ├── serviceLifecyclePolicy.test.js
│  │  │  │  │  ├── serviceRegistry.test.js
│  │  │  │  │  ├── serviceRegistryDescriptionsChinese.test.js
│  │  │  │  │  ├── serviceStatsSink.test.js
│  │  │  │  │  ├── session
│  │  │  │  │  │  └── sessionForkPlan.test.js
│  │  │  │  │  ├── sessionChecklistResetPolicy.test.js
│  │  │  │  │  ├── sessionChecklistResetService.test.js
│  │  │  │  │  ├── sessionFileRepair.test.js
│  │  │  │  │  ├── sessionFileRepairWiring.test.js
│  │  │  │  │  ├── sessionImagePersistD3.test.js
│  │  │  │  │  ├── sessionInsights.test.js
│  │  │  │  │  ├── sessionMemory.test.js
│  │  │  │  │  ├── sessionPersistFast.test.js
│  │  │  │  │  ├── sessionPersistence.rename.test.js
│  │  │  │  │  ├── sessionPersistence.sidecar.test.js
│  │  │  │  │  ├── sessionPersistence.title.test.js
│  │  │  │  │  ├── sessionPersistence.turnArtifacts.test.js
│  │  │  │  │  ├── sessionRecapCjk.test.js
│  │  │  │  │  ├── sessionRecapContentBlocks.test.js
│  │  │  │  │  ├── sessionRecapService.cjk.test.js
│  │  │  │  │  ├── skillCuratorService.test.js
│  │  │  │  │  ├── skillInstallService.test.js
│  │  │  │  │  ├── skillLearningServiceLearnFromSource.test.js
│  │  │  │  │  ├── skillPackageService.test.js
│  │  │  │  │  ├── skillSearch.test.js
│  │  │  │  │  ├── skillStateService.test.js
│  │  │  │  │  ├── skillTrendComparison.test.js
│  │  │  │  │  ├── skillVersionSync.test.js
│  │  │  │  │  ├── skillVersionSyncPruning.test.js
│  │  │  │  │  ├── skills
│  │  │  │  │  │  ├── journeyTimeline.test.js
│  │  │  │  │  │  ├── skillSourceDistiller.test.js
│  │  │  │  │  │  ├── skillThreatScanner.test.js
│  │  │  │  │  │  └── verifierScaffoldPlan.test.js
│  │  │  │  │  ├── skillsManifestCompat.test.js
│  │  │  │  │  ├── smartTruncation.lossReduction.test.js
│  │  │  │  │  ├── sourceHealPolicy.test.js
│  │  │  │  │  ├── sourceHealService.test.js
│  │  │  │  │  ├── sourceSnapshotCrypto.test.js
│  │  │  │  │  ├── sseKeepalive.test.js
│  │  │  │  │  ├── stackConflict.test.js
│  │  │  │  │  ├── stateMachine
│  │  │  │  │  │  ├── index.test.js
│  │  │  │  │  │  └── stateMachine.test.js
│  │  │  │  │  ├── stepAnchorStore.test.js
│  │  │  │  │  ├── stockAnalysisEngine.test.js
│  │  │  │  │  ├── strategyEngine.test.js
│  │  │  │  │  ├── streamHealthSink.test.js
│  │  │  │  │  ├── streamUsageOptions.test.js
│  │  │  │  │  ├── structuredFurnace
│  │  │  │  │  │  ├── intentWeaverConnectorHoist.test.js
│  │  │  │  │  │  └── structuredFurnace.test.js
│  │  │  │  │  ├── subAgentModelSelect.test.js
│  │  │  │  │  ├── subAgentTextStream.test.js
│  │  │  │  │  ├── subscribePr
│  │  │  │  │  │  └── subscribePrPlan.test.js
│  │  │  │  │  ├── subscriptionUserinfo.test.js
│  │  │  │  │  ├── syscallGateway.bypassScope.test.js
│  │  │  │  │  ├── syscallGateway.explanation.test.js
│  │  │  │  │  ├── syscallGateway.redLine.test.js
│  │  │  │  │  ├── syscallGateway.scenarios.test.js
│  │  │  │  │  ├── systemIntegration.test.js
│  │  │  │  │  ├── systemPromptBoundary.test.js
│  │  │  │  │  ├── systemSettingService.test.js
│  │  │  │  │  ├── taskCleanupPolicy.test.js
│  │  │  │  │  ├── taskCleanupService.test.js
│  │  │  │  │  ├── taskClosure.test.js
│  │  │  │  │  ├── taskComplexity.decomposition.test.js
│  │  │  │  │  ├── taskControlService.test.js
│  │  │  │  │  ├── taskScaleDecomposeThreshold.test.js
│  │  │  │  │  ├── taskScaleMultiTargetRedosGuard.test.js
│  │  │  │  │  ├── taskScheduler.test.js
│  │  │  │  │  ├── taskTemplateHintWiring.test.js
│  │  │  │  │  ├── taskTemplates.test.js
│  │  │  │  │  ├── teachingService.test.js
│  │  │  │  │  ├── terminal
│  │  │  │  │  │  └── terminalSetupPlan.test.js
│  │  │  │  │  ├── textHeuristics.test.js
│  │  │  │  │  ├── timeFormat.test.js
│  │  │  │  │  ├── todoStateStorePaths.test.js
│  │  │  │  │  ├── todoStorePath.test.js
│  │  │  │  │  ├── tokenBudget.test.js
│  │  │  │  │  ├── tokenBudgetNudge.test.js
│  │  │  │  │  ├── tokenCountReportSsot.test.js
│  │  │  │  │  ├── tokenPricing.test.js
│  │  │  │  │  ├── tokenUsageService.test.js
│  │  │  │  │  ├── tool
│  │  │  │  │  │  └── toolCallParser.explicitSyntax.test.js
│  │  │  │  │  ├── toolAccessGateway.test.js
│  │  │  │  │  ├── toolCallParser.bracketMarker.test.js
│  │  │  │  │  ├── toolCallParser.duplicateCollapse.test.js
│  │  │  │  │  ├── toolCallParser.functionTag.test.js
│  │  │  │  │  ├── toolCallParser.nameJsonDialect.test.js
│  │  │  │  │  ├── toolCallParser.truncatedBareRegistryNames.test.js
│  │  │  │  │  ├── toolCallParser.truncatedFunctionTag.test.js
│  │  │  │  │  ├── toolCallParser.truncatedMutationRefusal.test.js
│  │  │  │  │  ├── toolCallParser.truncatedXmlToolCall.test.js
│  │  │  │  │  ├── toolCallParser.xmlDialect.test.js
│  │  │  │  │  ├── toolCalling.intentArbiterWiring.test.js
│  │  │  │  │  ├── toolCalling.readonlyApprove.test.js
│  │  │  │  │  ├── toolCalling.sandboxEscape.test.js
│  │  │  │  │  ├── toolCalling.semanticNumber.test.js
│  │  │  │  │  ├── toolCallingPermissions.leaf.test.js
│  │  │  │  │  ├── toolCatalog.test.js
│  │  │  │  │  ├── toolClusterActivation.test.js
│  │  │  │  │  ├── toolContract.test.js
│  │  │  │  │  ├── toolDataSummary.test.js
│  │  │  │  │  ├── toolError.test.js
│  │  │  │  │  ├── toolExecutionEngine.parallelDedup.test.js
│  │  │  │  │  ├── toolExecutionEngine.partition.test.js
│  │  │  │  │  ├── toolGuards.test.js
│  │  │  │  │  ├── toolGuardsExtended.test.js
│  │  │  │  │  ├── toolHeaderDisplayName.test.js
│  │  │  │  │  ├── toolLoopDetector.test.js
│  │  │  │  │  ├── toolLoopDetector.toolCallSignature.test.js
│  │  │  │  │  ├── toolLoopInterrupt.test.js
│  │  │  │  │  ├── toolLoopJournal.test.js
│  │  │  │  │  ├── toolPolicyLiveness.test.js
│  │  │  │  │  ├── toolProtocolAdapter.parity.test.js
│  │  │  │  │  ├── toolProtocolAdapter.textInterception.test.js
│  │  │  │  │  ├── toolResultSanitization.test.js
│  │  │  │  │  ├── toolSandbox.sandboxEscape.test.js
│  │  │  │  │  ├── toolSpec.test.js
│  │  │  │  │  ├── toolUseLoop.bareRefusal.test.js
│  │  │  │  │  ├── toolUseLoop.intentTextWiring.test.js
│  │  │  │  │  ├── toolUseLoop.interruptBehavior.test.js
│  │  │  │  │  ├── toolUseLoop.keyFindings.test.js
│  │  │  │  │  ├── toolUseLoop.outcomeReflectionHint.test.js
│  │  │  │  │  ├── toolUseLoop.postHookStop.test.js
│  │  │  │  │  ├── toolUseLoop.pseudoRefusal.test.js
│  │  │  │  │  ├── toolUseLoop.searchDedupRetry.test.js
│  │  │  │  │  ├── toolUseLoop.stopHook.test.js
│  │  │  │  │  ├── toolUseLoop.stopReason.test.js
│  │  │  │  │  ├── toolUseLoop.terminalNotice.test.js
│  │  │  │  │  ├── toolUseLoop.turnCancel.test.js
│  │  │  │  │  ├── toolUseLoopBudgets.test.js
│  │  │  │  │  ├── toolUseLoopCourse.test.js
│  │  │  │  │  ├── toolUseLoopFalsePositiveFix.test.js
│  │  │  │  │  ├── toolUseLoopHabitThread.test.js
│  │  │  │  │  ├── toolUseLoopHelpersDelegation.test.js
│  │  │  │  │  ├── toolUseLoopHelpersLeaf.test.js
│  │  │  │  │  ├── toolUseLoopInertia.test.js
│  │  │  │  │  ├── toolUseLoopIntentCoverage.test.js
│  │  │  │  │  ├── toolUseLoopIntentGuards.test.js
│  │  │  │  │  ├── toolUseLoopMonitorStates.test.js
│  │  │  │  │  ├── toolUseLoopSentinel.test.js
│  │  │  │  │  ├── toolUseLoopTransientBudget.test.js
│  │  │  │  │  ├── toolUseLoopTransientErrorTypes.test.js
│  │  │  │  │  ├── toolUseLoopUrgentSteer.test.js
│  │  │  │  │  ├── traceAuditService.requestId.test.js
│  │  │  │  │  ├── traceAuditService.retention.test.js
│  │  │  │  │  ├── tradingAgentsService.test.js
│  │  │  │  │  ├── trajectoryGuide
│  │  │  │  │  │  ├── aiBridge.test.js
│  │  │  │  │  │  ├── config.test.js
│  │  │  │  │  │  ├── guideInjector.test.js
│  │  │  │  │  │  ├── guideRetriever.test.js
│  │  │  │  │  │  ├── mapAuthor.test.js
│  │  │  │  │  │  └── mapExport.test.js
│  │  │  │  │  ├── trajectoryProvenance
│  │  │  │  │  │  ├── p1Labels.test.js
│  │  │  │  │  │  ├── p2Chain.test.js
│  │  │  │  │  │  ├── p3Quarantine.test.js
│  │  │  │  │  │  ├── p4Reconcile.test.js
│  │  │  │  │  │  └── p5Trace.test.js
│  │  │  │  │  ├── trajectoryReplay
│  │  │  │  │  │  ├── e2eReplay.test.js
│  │  │  │  │  │  ├── g2EngineRepairSeam.test.js
│  │  │  │  │  │  ├── p1Ledger.test.js
│  │  │  │  │  │  ├── p2EnvFingerprint.test.js
│  │  │  │  │  │  ├── p3Bundle.test.js
│  │  │  │  │  │  └── p4Engine.test.js
│  │  │  │  │  ├── transcriptRepair.test.js
│  │  │  │  │  ├── transparencyDisplayLocalization.test.js
│  │  │  │  │  ├── transparencySessionRecapLocalization.test.js
│  │  │  │  │  ├── tuiBareKeyIntercept.test.js
│  │  │  │  │  ├── turnCheckpointService.test.js
│  │  │  │  │  ├── turnPhaseTracker.test.js
│  │  │  │  │  ├── turnRollbackWiring.test.js
│  │  │  │  │  ├── twentyXMode.test.js
│  │  │  │  │  ├── typeset
│  │  │  │  │  │  ├── contentSchema.test.js
│  │  │  │  │  │  ├── markdownToAst.test.js
│  │  │  │  │  │  └── styleTemplates.test.js
│  │  │  │  │  ├── ucbRouter.test.js
│  │  │  │  │  ├── unattendedAutoAnswer.test.js
│  │  │  │  │  ├── unifiedSearch.test.js
│  │  │  │  │  ├── uninstallLedgerWiring.test.js
│  │  │  │  │  ├── uninstallPlan.test.js
│  │  │  │  │  ├── unknownProblemHandler.test.js
│  │  │  │  │  ├── unsupportedGuideD7.test.js
│  │  │  │  │  ├── updateProgressRenderer.test.js
│  │  │  │  │  ├── updateStreamAndLockRetryWiring.test.js
│  │  │  │  │  ├── updateVersionsNpmChannel.test.js
│  │  │  │  │  ├── urlSafetyTiers.test.js
│  │  │  │  │  ├── usageFormatter.test.js
│  │  │  │  │  ├── usageTracker.test.js
│  │  │  │  │  ├── userProfile.test.js
│  │  │  │  │  ├── userSkillMenu.test.js
│  │  │  │  │  ├── vaultCore.test.js
│  │  │  │  │  ├── vaultStore.test.js
│  │  │  │  │  ├── verificationAgent.ensemble.test.js
│  │  │  │  │  ├── versionService.test.js
│  │  │  │  │  ├── videoGenPoolBridge.test.js
│  │  │  │  │  ├── visionExhaustionDiagnostic.test.js
│  │  │  │  │  ├── visionNativeAdapterProbe.test.js
│  │  │  │  │  ├── visionRoutingTruth.test.js
│  │  │  │  │  ├── watchdogService.test.js
│  │  │  │  │  ├── weakModelChangeGuard.test.js
│  │  │  │  │  ├── webSearchDigest.test.js
│  │  │  │  │  ├── webSearchProxyHintShellSyntax.test.js
│  │  │  │  │  ├── webSearchTransport.test.js
│  │  │  │  │  ├── winAppPaths.test.js
│  │  │  │  │  ├── windowsClipboardImg2FileService.test.js
│  │  │  │  │  ├── workflow
│  │  │  │  │  │  ├── index.test.js
│  │  │  │  │  │  └── workflow.test.js
│  │  │  │  │  ├── workspaceContext.test.js
│  │  │  │  │  ├── workspaceGitInit.test.js
│  │  │  │  │  ├── workspaceGitInit.wizard.test.js
│  │  │  │  │  ├── workspaceGitInitWizardPolicy.test.js
│  │  │  │  │  ├── worktreeSessionCwd.test.js
│  │  │  │  │  ├── zenGatekeeper.test.js
│  │  │  │  │  ├── zhipuGlmModel.test.js
│  │  │  │  │  └── zhipuRetiredRemap.test.js
│  │  │  │  ├── session.relativeTime.test.js
│  │  │  │  ├── sessionRecapService.test.js
│  │  │  │  ├── sessionSearchIndex.test.js
│  │  │  │  ├── sessionSlots.test.js
│  │  │  │  ├── sessionTitleService.test.js
│  │  │  │  ├── sessionTopology.test.js
│  │  │  │  ├── shellClassifier.test.js
│  │  │  │  ├── shellCommand.exitSemantics.test.js
│  │  │  │  ├── shellCommand.idleTimeout.test.js
│  │  │  │  ├── shellDiagnostics.test.js
│  │  │  │  ├── shellTimeoutClamp.test.js
│  │  │  │  ├── shortStopContinuation.test.js
│  │  │  │  ├── skillCatalogInjection.test.js
│  │  │  │  ├── skillLoaderNativeSkillMd.test.js
│  │  │  │  ├── skills
│  │  │  │  │  └── skillSourceSpec.test.js
│  │  │  │  ├── skills-conditional.test.js
│  │  │  │  ├── slashCommandFilter.test.js
│  │  │  │  ├── slashExtraCommands.test.js
│  │  │  │  ├── slashLearnSkillAlias.test.js
│  │  │  │  ├── slugifyToken.test.js
│  │  │  │  ├── spawnWithIdleTimeout.cmdVerbatim.test.js
│  │  │  │  ├── spawnWithIdleTimeout.encoding.test.js
│  │  │  │  ├── spinnerActivityLabel.test.js
│  │  │  │  ├── sqliteHotCopy.test.js
│  │  │  │  ├── statusLineConfig.test.js
│  │  │  │  ├── statusLineRunner.test.js
│  │  │  │  ├── streamRepetitionGuard.test.js
│  │  │  │  ├── streamStaleThresholdHoist.test.js
│  │  │  │  ├── streamToolInputRecovery.test.js
│  │  │  │  ├── stripAnsi.test.js
│  │  │  │  ├── stripCodeSpans.test.js
│  │  │  │  ├── structuredResults.test.js
│  │  │  │  ├── structuredResults.turnEnvelope.test.js
│  │  │  │  ├── subAgentResultFooter.test.js
│  │  │  │  ├── subagentContextSummary.test.js
│  │  │  │  ├── submitPaintYield.test.js
│  │  │  │  ├── symbolInputGuard.test.js
│  │  │  │  ├── syscallGateway
│  │  │  │  │  ├── approvalRouterL2Session.test.js
│  │  │  │  │  └── permissionCacheL2Session.test.js
│  │  │  │  ├── systemPromptSectionCache.test.js
│  │  │  │  ├── systemPromptSplit.test.js
│  │  │  │  ├── systemPromptTier.test.js
│  │  │  │  ├── taskBoardBusyRetry.test.js
│  │  │  │  ├── taskDependencyGate.test.js
│  │  │  │  ├── taskMemoryRecall.test.js
│  │  │  │  ├── tasks
│  │  │  │  │  ├── diskOutput.paths.test.js
│  │  │  │  │  ├── largeTaskBoard.test.js
│  │  │  │  │  └── largeTaskRuntimeStability.test.js
│  │  │  │  ├── teamProtocols.test.js
│  │  │  │  ├── teammateBus.test.js
│  │  │  │  ├── telemetryService.appRunLatency.test.js
│  │  │  │  ├── telemetryService.slowRequest.test.js
│  │  │  │  ├── testWritingComposer.test.js
│  │  │  │  ├── testWritingPolicy.test.js
│  │  │  │  ├── textEmphasisPolicy.test.js
│  │  │  │  ├── themeRegistry.test.js
│  │  │  │  ├── thinkingBudget.test.js
│  │  │  │  ├── timeFormat.test.js
│  │  │  │  ├── toLowerCaseSafe.test.js
│  │  │  │  ├── toNonNegInt.test.js
│  │  │  │  ├── toStr.test.js
│  │  │  │  ├── todoSnapshot.test.js
│  │  │  │  ├── toolCallColonKvAnchor.test.js
│  │  │  │  ├── toolCallEqualsKvGuard.test.js
│  │  │  │  ├── toolCallEqualsKvSplit.test.js
│  │  │  │  ├── toolCallNudges.test.js
│  │  │  │  ├── toolCallTally.test.js
│  │  │  │  ├── toolCalling.abortSignalWiring.test.js
│  │  │  │  ├── toolCalling.autonomousL1RedLine.test.js
│  │  │  │  ├── toolCalling.builtinSchemaValidation.test.js
│  │  │  │  ├── toolCalling.maxResultSizeChars.test.js
│  │  │  │  ├── toolCalling.mcpResultShape.test.js
│  │  │  │  ├── toolCalling.openAppAlias.test.js
│  │  │  │  ├── toolCalling.permissionControlChannel.test.js
│  │  │  │  ├── toolCalling.planReadOnly.test.js
│  │  │  │  ├── toolCalling.pureHelpers.test.js
│  │  │  │  ├── toolCalling.registerMcpIdempotent.test.js
│  │  │  │  ├── toolCalling.shellForkClassify.test.js
│  │  │  │  ├── toolErrorCodes.test.js
│  │  │  │  ├── toolErrorDetails.test.js
│  │  │  │  ├── toolFunctionDefMemo.test.js
│  │  │  │  ├── toolLoopDetector.searchIntent.test.js
│  │  │  │  ├── toolLoopUsage.test.js
│  │  │  │  ├── toolMetricsAggregator.test.js
│  │  │  │  ├── toolNameVariants.test.js
│  │  │  │  ├── toolOutcomeSeverity.test.js
│  │  │  │  ├── toolParamNaming.test.js
│  │  │  │  ├── toolParamPath.test.js
│  │  │  │  ├── toolProfile.aliasCompatibility.test.js
│  │  │  │  ├── toolRecommend.test.js
│  │  │  │  ├── toolRegistryDedup.test.js
│  │  │  │  ├── toolRegistryMcp.test.js
│  │  │  │  ├── toolRegistryMemo.test.js
│  │  │  │  ├── toolResultPersistence.test.js
│  │  │  │  ├── toolResultSummary.test.js
│  │  │  │  ├── toolUseLoop.appLaunchIntentFilter.test.js
│  │  │  │  ├── toolUseLoop.appLaunchInterruptFallback.test.js
│  │  │  │  ├── toolUseLoop.appLaunchRecovery.test.js
│  │  │  │  ├── toolUseLoop.appLaunchRewrite.test.js
│  │  │  │  ├── toolUseLoop.askNoChannelStrict.test.js
│  │  │  │  ├── toolUseLoop.chatErrorGuard.test.js
│  │  │  │  ├── toolUseLoop.circuitBreakerNoTools.test.js
│  │  │  │  ├── toolUseLoop.coreContracts.test.js
│  │  │  │  ├── toolUseLoop.crossTurnRepeat.test.js
│  │  │  │  ├── toolUseLoop.deliveryConclusion.test.js
│  │  │  │  ├── toolUseLoop.emptyTextToolLoop.test.js
│  │  │  │  ├── toolUseLoop.execComplexity.test.js
│  │  │  │  ├── toolUseLoop.externalAgentNudge.integration.test.js
│  │  │  │  ├── toolUseLoop.guardrails.test.js
│  │  │  │  ├── toolUseLoop.harnessProfile.test.js
│  │  │  │  ├── toolUseLoop.intentGate.test.js
│  │  │  │  ├── toolUseLoop.localTextProtocol.integration.test.js
│  │  │  │  ├── toolUseLoop.loopEndFallback.test.js
│  │  │  │  ├── toolUseLoop.oneshotToolBlocks.test.js
│  │  │  │  ├── toolUseLoop.progressPrefaceDefault.test.js
│  │  │  │  ├── toolUseLoop.pureGreeting.test.js
│  │  │  │  ├── toolUseLoop.resolveToolCallsNoTools.test.js
│  │  │  │  ├── toolUseLoop.scaffoldSkillHint.test.js
│  │  │  │  ├── toolUseLoop.structuredContext.test.js
│  │  │  │  ├── toolUseLoop.summaryClosure.test.js
│  │  │  │  ├── toolUseLoop.symbolParsingRegression.test.js
│  │  │  │  ├── toolUseLoop.toolUseEmptyText.test.js
│  │  │  │  ├── toolUseLoop.truncationStopReason.test.js
│  │  │  │  ├── toolUseLoop.unattendedAutoAnswer.test.js
│  │  │  │  ├── toolUseLoop.unfulfilledIntent.test.js
│  │  │  │  ├── toolUseLoop.unknownExploration.test.js
│  │  │  │  ├── toolUseLoop.unknownProblemHandler.test.js
│  │  │  │  ├── toolUseLoop.verificationGate.test.js
│  │  │  │  ├── toolUseLoop.verifyNonEdit.test.js
│  │  │  │  ├── toolUseLoop.webNoUsableData.test.js
│  │  │  │  ├── toolUseLoop.webSearchNoToolNudge.test.js
│  │  │  │  ├── toolUseLoop.webSearchRecovery.test.js
│  │  │  │  ├── toolUseLoopReplyGuard.test.js
│  │  │  │  ├── toolchainProvisioner.test.js
│  │  │  │  ├── tools
│  │  │  │  │  ├── AgentTool.claudeDelegation.test.js
│  │  │  │  │  ├── AgentTool.controlRequest.test.js
│  │  │  │  │  ├── AgentTool.fmtElapsed.test.js
│  │  │  │  │  ├── AgentTool.recursionGuard.test.js
│  │  │  │  │  ├── AgentTool.subagentCommonFloor.test.js
│  │  │  │  │  ├── AgentTool.subagentScope.test.js
│  │  │  │  │  ├── AgentTool.toolSurfaceDeclaration.test.js
│  │  │  │  │  ├── ApplyPatchTool
│  │  │  │  │  │  └── index.test.js
│  │  │  │  │  ├── ArtifactTool
│  │  │  │  │  │  └── index.test.js
│  │  │  │  │  ├── BackgroundAgentOutputTool.test.js
│  │  │  │  │  ├── BashOutputTool.test.js
│  │  │  │  │  ├── FileEditTool
│  │  │  │  │  │  └── index.test.js
│  │  │  │  │  ├── KillShellTool.test.js
│  │  │  │  │  ├── MonitorTool.test.js
│  │  │  │  │  ├── MultiEditTool
│  │  │  │  │  │  └── index.test.js
│  │  │  │  │  ├── SaveInstruction.test.js
│  │  │  │  │  ├── SkillTool.skillLoading.test.js
│  │  │  │  │  ├── _dbTimeout.test.js
│  │  │  │  │  ├── _execCompat.test.js
│  │  │  │  │  ├── _walkBudget.test.js
│  │  │  │  │  ├── askUserQuestion.alignment.test.js
│  │  │  │  │  ├── assembleToolPool.stability.test.js
│  │  │  │  │  ├── bashCommentLabel.test.js
│  │  │  │  │  ├── ccOutputTruncate.test.js
│  │  │  │  │  ├── ccValidationError.test.js
│  │  │  │  │  ├── claudeDelegation.test.js
│  │  │  │  │  ├── compileRegistryBinding.test.js
│  │  │  │  │  ├── configTool.keyConfigRedirect.test.js
│  │  │  │  │  ├── configureErrorShape.test.js
│  │  │  │  │  ├── configureExternalAppRepair.test.js
│  │  │  │  │  ├── configureModelProvider.test.js
│  │  │  │  │  ├── configureModelProviderActions.test.js
│  │  │  │  │  ├── configureModelProviderBuiltinList.test.js
│  │  │  │  │  ├── coverageReport.test.js
│  │  │  │  │  ├── ctxInspectTool.test.js
│  │  │  │  │  ├── dbTimeout.integration.test.js
│  │  │  │  │  ├── deploy.test.js
│  │  │  │  │  ├── editFileHealHint.test.js
│  │  │  │  │  ├── filePreReadHangGuard.test.js
│  │  │  │  │  ├── fileReadImageExtsHoist.test.js
│  │  │  │  │  ├── fileReadLimit.test.js
│  │  │  │  │  ├── fileReadLimitIntegration.test.js
│  │  │  │  │  ├── fileReadListDirHint.test.js
│  │  │  │  │  ├── fileReadToolGuardParity.test.js
│  │  │  │  │  ├── fsWalkBudget.integration.test.js
│  │  │  │  │  ├── gitBlame.test.js
│  │  │  │  │  ├── gitCommit.precheck.test.js
│  │  │  │  │  ├── gitToolsNonBlocking.integration.test.js
│  │  │  │  │  ├── grepNonBlocking.integration.test.js
│  │  │  │  │  ├── grepWalkBudget.integration.test.js
│  │  │  │  │  ├── guardedReadFileSync.test.js
│  │  │  │  │  ├── imageDetect.test.js
│  │  │  │  │  ├── imageOcr.noCascade.test.js
│  │  │  │  │  ├── inputValidators.test.js
│  │  │  │  │  ├── khySelfAlignment.test.js
│  │  │  │  │  ├── khySelfCapabilityGrounding.test.js
│  │  │  │  │  ├── khySelfTool.test.js
│  │  │  │  │  ├── listDirTool.test.js
│  │  │  │  │  ├── planRetryStepLookup.test.js
│  │  │  │  │  ├── pseudoFileReadGuard.test.js
│  │  │  │  │  ├── pythonInvocationHint.test.js
│  │  │  │  │  ├── readAccessPolicy.test.js
│  │  │  │  │  ├── readBinaryGuard.test.js
│  │  │  │  │  ├── readFileFormatRouter.test.js
│  │  │  │  │  ├── recognizeImage.defaultModel.test.js
│  │  │  │  │  ├── renderDocument.test.js
│  │  │  │  │  ├── saveMemory.test.js
│  │  │  │  │  ├── searchHintCoverage.test.js
│  │  │  │  │  ├── securityScan.test.js
│  │  │  │  │  ├── semanticNumberCoerce.test.js
│  │  │  │  │  ├── shellClassifier.test.js
│  │  │  │  │  ├── shellCommandListingSummary.test.js
│  │  │  │  │  ├── shellEmptyOutputNote.test.js
│  │  │  │  │  ├── shellErrorClassify.test.js
│  │  │  │  │  ├── shellExitSemantics.test.js
│  │  │  │  │  ├── shellFallbackNonBlocking.integration.test.js
│  │  │  │  │  ├── specialFileReadGuard.test.js
│  │  │  │  │  ├── structuredOutputTool.test.js
│  │  │  │  │  ├── taskBlockedBySuffix.test.js
│  │  │  │  │  ├── toolAbortSignal.test.js
│  │  │  │  │  ├── toolContract.sweep.test.js
│  │  │  │  │  ├── toolHealer.test.js
│  │  │  │  │  ├── toolRegistryHeaderUsage.test.js
│  │  │  │  │  ├── toolResultTriPath.test.js
│  │  │  │  │  ├── toolSyntaxHealer.integration.test.js
│  │  │  │  │  ├── toolSyntaxHealer.test.js
│  │  │  │  │  ├── toolTimeout.test.js
│  │  │  │  │  ├── unpackAsar.test.js
│  │  │  │  │  ├── unpackGeneric.test.js
│  │  │  │  │  ├── userDirs.desktop.test.js
│  │  │  │  │  ├── videoAnalyze.test.js
│  │  │  │  │  ├── webFetchDeadline.test.js
│  │  │  │  │  └── winDeviceReadGuard.test.js
│  │  │  │  ├── tools.gitBashCompat.test.js
│  │  │  │  ├── tools.winCommandTranslate.test.js
│  │  │  │  ├── tools.windowsShellCompat.test.js
│  │  │  │  ├── toolsCategoryConsistency.test.js
│  │  │  │  ├── toonDecodeDepthCap.test.js
│  │  │  │  ├── traeOfficialArtifacts.blobDecode.test.js
│  │  │  │  ├── traeOfficialArtifacts.pipeline.test.js
│  │  │  │  ├── treeRenderDepthCap.test.js
│  │  │  │  ├── trimIfString.test.js
│  │  │  │  ├── trimLowerCase.test.js
│  │  │  │  ├── trimLowerNullish.test.js
│  │  │  │  ├── trimLowerStripUnderscores.test.js
│  │  │  │  ├── truncateEllipsis.test.js
│  │  │  │  ├── truncateToWidthAnsiGuard.test.js
│  │  │  │  ├── trustGate.test.js
│  │  │  │  ├── tryOr.test.js
│  │  │  │  ├── tryOrAsync.test.js
│  │  │  │  ├── tui
│  │  │  │  │  ├── agentTreeBridge.test.js
│  │  │  │  │  ├── agentTreeRender.test.js
│  │  │  │  │  ├── altScreenRestore.test.js
│  │  │  │  │  ├── appHostHelpersLeaf.test.js
│  │  │  │  │  ├── bug120MergedEnter.test.js
│  │  │  │  │  ├── buildDecisionRecord.test.js
│  │  │  │  │  ├── buildResumedTranscript.test.js
│  │  │  │  │  ├── busyRenderSpinTdz.test.js
│  │  │  │  │  ├── busySubmitUserEcho.test.js
│  │  │  │  │  ├── cardClick.test.js
│  │  │  │  │  ├── cardLayout.test.js
│  │  │  │  │  ├── ccFormat.test.js
│  │  │  │  │  ├── ccHelpMenuOverlay.test.js
│  │  │  │  │  ├── ccModelName.test.js
│  │  │  │  │  ├── ccOverlayFit.test.js
│  │  │  │  │  ├── clearResetsHistory.test.js
│  │  │  │  │  ├── collapseConsecutiveDuplicates.test.js
│  │  │  │  │  ├── completionBell.test.js
│  │  │  │  │  ├── completionMenuColumns.test.js
│  │  │  │  │  ├── completionMenuSize.test.js
│  │  │  │  │  ├── computeToolPreface.test.js
│  │  │  │  │  ├── diffLineNumbers.test.js
│  │  │  │  │  ├── expandLastFoldable.test.js
│  │  │  │  │  ├── foldOutputMarker.test.js
│  │  │  │  │  ├── helpMenuSize.test.js
│  │  │  │  │  ├── inkRenderSmoke.test.js
│  │  │  │  │  ├── keyHandlerFreshClosure.test.js
│  │  │  │  │  ├── khyOsFeedDecode.test.js
│  │  │  │  │  ├── lfEnterNewline.test.js
│  │  │  │  │  ├── liveFrameGeometry.test.js
│  │  │  │  │  ├── liveSealThreshold.test.js
│  │  │  │  │  ├── loopAutoContinue.test.js
│  │  │  │  │  ├── modelPickerSize.test.js
│  │  │  │  │  ├── pasteArchiveExpand.test.js
│  │  │  │  │  ├── perfEntryReaper.test.js
│  │  │  │  │  ├── permissionFieldRows.test.js
│  │  │  │  │  ├── permissionNotice.test.js
│  │  │  │  │  ├── permissionsPromptDigitFooter.test.js
│  │  │  │  │  ├── permissionsPromptHangingIndent.test.js
│  │  │  │  │  ├── permissionsPromptNoticeFrame.test.js
│  │  │  │  │  ├── planStageFlush.test.js
│  │  │  │  │  ├── processGroup.test.js
│  │  │  │  │  ├── projectToolResult.test.js
│  │  │  │  │  ├── promptFrameBilling.test.js
│  │  │  │  │  ├── promptLayoutMemo.test.js
│  │  │  │  │  ├── queryBridgeStreamReset.test.js
│  │  │  │  │  ├── queryBridgeTimeline.buildTurnArtifacts.test.js
│  │  │  │  │  ├── queryBridgeTimelineLeaf.test.js
│  │  │  │  │  ├── questionCardModel.test.js
│  │  │  │  │  ├── questionPromptSize.test.js
│  │  │  │  │  ├── resultLineGlyph.test.js
│  │  │  │  │  ├── rewindPickerPreviewWidth.test.js
│  │  │  │  │  ├── selectMenu.test.js
│  │  │  │  │  ├── shouldFlushTerminalOutcome.test.js
│  │  │  │  │  ├── spinnerTokenLazy.test.js
│  │  │  │  │  ├── splitSealedText.test.js
│  │  │  │  │  ├── splitSealedTextSoftSeal.test.js
│  │  │  │  │  ├── statusBroadcast.test.js
│  │  │  │  │  ├── statusPanelExtras.test.js
│  │  │  │  │  ├── streamErrorClassification.test.js
│  │  │  │  │  ├── submitGateBusy.test.js
│  │  │  │  │  ├── summarizeArgsPathTruncate.test.js
│  │  │  │  │  ├── taskListPanel.test.js
│  │  │  │  │  ├── thinkingDuration.test.js
│  │  │  │  │  ├── toolIdPairing.test.js
│  │  │  │  │  ├── toolLinesAgentTreeNotice.test.js
│  │  │  │  │  ├── toolLinesColumnAlignment.test.js
│  │  │  │  │  ├── toolLinesErrorFaithful.test.js
│  │  │  │  │  ├── toolLinesWordDiff.test.js
│  │  │  │  │  ├── toolLinesWriteDiff.test.js
│  │  │  │  │  ├── toolResultTransparency.test.js
│  │  │  │  │  ├── toolTruncationTag.test.js
│  │  │  │  │  ├── topicBarOscInjection.test.js
│  │  │  │  │  ├── topicBarWorking.test.js
│  │  │  │  │  ├── topicBarWorkingIndicator.test.js
│  │  │  │  │  ├── topologyPanel.test.js
│  │  │  │  │  ├── turnStats.test.js
│  │  │  │  │  ├── uiPrompt.test.js
│  │  │  │  │  ├── viewportIndicatorRowBudget.test.js
│  │  │  │  │  ├── vtScreen.js
│  │  │  │  │  └── wordMotionKeys.test.js
│  │  │  │  ├── tui.inlineImageSubmit.test.js
│  │  │  │  ├── tuiCommandReports.test.js
│  │  │  │  ├── tuiFrameLedger.test.js
│  │  │  │  ├── tuiHistoryPersist.test.js
│  │  │  │  ├── unknownExploration.test.js
│  │  │  │  ├── unpackZipFamily.test.js
│  │  │  │  ├── updateChannelRouter.test.js
│  │  │  │  ├── updateCoordinator.test.js
│  │  │  │  ├── updateProgressRenderer.test.js
│  │  │  │  ├── upstreamStudy.test.js
│  │  │  │  ├── upstreamStudyCatalog.test.js
│  │  │  │  ├── upstreamStudyPlan.test.js
│  │  │  │  ├── upstreamStudyReport.test.js
│  │  │  │  ├── urlSafety.test.js
│  │  │  │  ├── usageTokenCountShape.test.js
│  │  │  │  ├── utils
│  │  │  │  │  ├── clampInt.test.js
│  │  │  │  │  ├── classifyKhyError.test.js
│  │  │  │  │  ├── cleanText.test.js
│  │  │  │  │  ├── collapseWhitespace.test.js
│  │  │  │  │  ├── collapseWhitespaceLoose.test.js
│  │  │  │  │  ├── cryptoRandom.test.js
│  │  │  │  │  ├── dailyScheduler.test.js
│  │  │  │  │  ├── dataHome.appHome.test.js
│  │  │  │  │  ├── dataHome.baseHome.test.js
│  │  │  │  │  ├── dataHome.visibleAlias.test.js
│  │  │  │  │  ├── dataHomePointer.test.js
│  │  │  │  │  ├── dedupeText.test.js
│  │  │  │  │  ├── deepClone.test.js
│  │  │  │  │  ├── ensureDirSync.test.js
│  │  │  │  │  ├── envFlagByName.test.js
│  │  │  │  │  ├── envFlagEnabled.test.js
│  │  │  │  │  ├── envInt.test.js
│  │  │  │  │  ├── envIntNonNeg.test.js
│  │  │  │  │  ├── envNum.test.js
│  │  │  │  │  ├── envOnByName.test.js
│  │  │  │  │  ├── ephemeralTmp.test.js
│  │  │  │  │  ├── escapeRegExp.test.js
│  │  │  │  │  ├── existsSyncSafe.test.js
│  │  │  │  │  ├── expandEnvPath.test.js
│  │  │  │  │  ├── expressAsyncPatch.test.js
│  │  │  │  │  ├── extractEndpoint.test.js
│  │  │  │  │  ├── fileEncoding.test.js
│  │  │  │  │  ├── finiteNumber.edge.test.js
│  │  │  │  │  ├── finiteNumber.test.js
│  │  │  │  │  ├── firstGroup.test.js
│  │  │  │  │  ├── formatBytes.test.js
│  │  │  │  │  ├── gateOn.test.js
│  │  │  │  │  ├── gitSoftExec.test.js
│  │  │  │  │  ├── growthDataDir.test.js
│  │  │  │  │  ├── hostOfEndpoint.test.js
│  │  │  │  │  ├── httpError.test.js
│  │  │  │  │  ├── humanBytes.test.js
│  │  │  │  │  ├── isEnabledDefaultOn.test.js
│  │  │  │  │  ├── isOffValue.test.js
│  │  │  │  │  ├── isPathWithin.test.js
│  │  │  │  │  ├── isPlainObject.test.js
│  │  │  │  │  ├── javaEncoding.test.js
│  │  │  │  │  ├── khyError.test.js
│  │  │  │  │  ├── khyErrorCategory.test.js
│  │  │  │  │  ├── logger.test.js
│  │  │  │  │  ├── markProcessFailure.test.js
│  │  │  │  │  ├── maskSecret.test.js
│  │  │  │  │  ├── maskToken.test.js
│  │  │  │  │  ├── nearestExistingDir.test.js
│  │  │  │  │  ├── normLower.test.js
│  │  │  │  │  ├── normalizeAlnumKey.test.js
│  │  │  │  │  ├── normalizeAuthToken.test.js
│  │  │  │  │  ├── normalizeCompatibility.test.js
│  │  │  │  │  ├── normalizeToolName.test.js
│  │  │  │  │  ├── notifier.fetch.test.js
│  │  │  │  │  ├── notifier.test.js
│  │  │  │  │  ├── onValueOr.test.js
│  │  │  │  │  ├── openclawHome.test.js
│  │  │  │  │  ├── oscSafeText.test.js
│  │  │  │  │  ├── parseBoolean.test.js
│  │  │  │  │  ├── parseJsonObjectMap.test.js
│  │  │  │  │  ├── parseListToSet.test.js
│  │  │  │  │  ├── parseRetryAfterCooldown.test.js
│  │  │  │  │  ├── parseTomlTables.test.js
│  │  │  │  │  ├── patchEnvContent.test.js
│  │  │  │  │  ├── pathCompat.test.js
│  │  │  │  │  ├── pathJoinSafe.test.js
│  │  │  │  │  ├── pickLocale.test.js
│  │  │  │  │  ├── pickUserTextSafe.test.js
│  │  │  │  │  ├── platformCtx.test.js
│  │  │  │  │  ├── platformUtils.test.js
│  │  │  │  │  ├── proxyBaseUrl.test.js
│  │  │  │  │  ├── pythonAvailable.test.js
│  │  │  │  │  ├── pythonPathCacheLifetime.test.js
│  │  │  │  │  ├── pythonPathQuiet.test.js
│  │  │  │  │  ├── readFileSyncSafe.test.js
│  │  │  │  │  ├── readJsonFileSafe.test.js
│  │  │  │  │  ├── response.test.js
│  │  │  │  │  ├── retry.test.js
│  │  │  │  │  ├── safeJsonParse.test.js
│  │  │  │  │  ├── safeStatSync.test.js
│  │  │  │  │  ├── sharedPortablePaths.test.js
│  │  │  │  │  ├── simpleTokenEstimate.test.js
│  │  │  │  │  ├── sleep.test.js
│  │  │  │  │  ├── slugifyToken.test.js
│  │  │  │  │  ├── sourceTextCompressor.test.js
│  │  │  │  │  ├── spawnWithIdleTimeout.test.js
│  │  │  │  │  ├── storageRoots.test.js
│  │  │  │  │  ├── stripCodeSpans.test.js
│  │  │  │  │  ├── styleMatchers.test.js
│  │  │  │  │  ├── systemEncoding.test.js
│  │  │  │  │  ├── toLowerCaseSafe.test.js
│  │  │  │  │  ├── toNonNegInt.test.js
│  │  │  │  │  ├── toStr.test.js
│  │  │  │  │  ├── toolResultSanitizer.test.js
│  │  │  │  │  ├── trimIfString.test.js
│  │  │  │  │  ├── trimLowerStripUnderscores.test.js
│  │  │  │  │  ├── truncateEllipsis.test.js
│  │  │  │  │  ├── tryOr.test.js
│  │  │  │  │  ├── tryOrAsync.test.js
│  │  │  │  │  ├── userFeedback.test.js
│  │  │  │  │  ├── userFriendlyError.test.js
│  │  │  │  │  ├── winMojibakeDecode.test.js
│  │  │  │  │  ├── withTimeout.test.js
│  │  │  │  │  └── worktreeName.test.js
│  │  │  │  ├── videoIngestionFuzz.test.js
│  │  │  │  ├── vim
│  │  │  │  │  └── textObjects.test.js
│  │  │  │  ├── vimCountClamp.test.js
│  │  │  │  ├── vimGraphemeOperators.test.js
│  │  │  │  ├── vimPasteBlowupGuard.test.js
│  │  │  │  ├── vimTuiCursorGrapheme.test.js
│  │  │  │  ├── visionCapability.test.js
│  │  │  │  ├── visionDirectTurnPolicy.test.js
│  │  │  │  ├── visionFailureSummaryModernKey.test.js
│  │  │  │  ├── visionOcrFallback.test.js
│  │  │  │  ├── visionRateLimitOcrRescue.test.js
│  │  │  │  ├── visionRouting.test.js
│  │  │  │  ├── wasmSandbox.appRegisterGuard.test.js
│  │  │  │  ├── wasmSandbox.appRunLatencyOutput.test.js
│  │  │  │  ├── wasmSandbox.khySysHost.test.js
│  │  │  │  ├── wasmSandbox.loopbackTransport.test.js
│  │  │  │  ├── wasmSandbox.m1Bridge.test.js
│  │  │  │  ├── wasmSandbox.moonbitWasmGcAbi.test.js
│  │  │  │  ├── wasmSandbox.wasmAppServicePerf.test.js
│  │  │  │  ├── wasmSandbox.wasmAppServicePreflight.test.js
│  │  │  │  ├── webBrowserTool.test.js
│  │  │  │  ├── webFetchDecode.test.js
│  │  │  │  ├── webFetchToolCharset.test.js
│  │  │  │  ├── webSearchCheerioDegradation.test.js
│  │  │  │  ├── webSearchParsers.test.js
│  │  │  │  ├── webSearchService.digestPipeline.test.js
│  │  │  │  ├── webSearchService.queueRetry.test.js
│  │  │  │  ├── weipuxiezuo.test.js
│  │  │  │  ├── withTimeout.test.js
│  │  │  │  ├── workerAgent.commonFloor.test.js
│  │  │  │  ├── workerAgent.depthLimits.test.js
│  │  │  │  ├── workflowCliCore.test.js
│  │  │  │  ├── workflowCliHandler.test.js
│  │  │  │  ├── workflowExecutor.expand.test.js
│  │  │  │  ├── workflowExecutor.failClosed.test.js
│  │  │  │  ├── workflowExecutor.graphPatch.test.js
│  │  │  │  ├── workflowExecutor.onVar.test.js
│  │  │  │  ├── workflowExecutor.quantum.test.js
│  │  │  │  ├── workflowExecutor.test.js
│  │  │  │  ├── workflowExecutor.userThreading.test.js
│  │  │  │  ├── workflowRunWorker.quantum.test.js
│  │  │  │  ├── workflowRunWorker.starvation.test.js
│  │  │  │  ├── workflowRunWorker.test.js
│  │  │  │  ├── workspaceCheckpointCas.test.js
│  │  │  │  ├── workspaceTrust.test.js
│  │  │  │  ├── worktreeIsolation.test.js
│  │  │  │  ├── writeDiff.test.js
│  │  │  │  └── zhipuRequestShape.test.js
│  │  │  ├── vendor
│  │  │  │  └── shared
│  │  │  │     ├── config
│  │  │  │     │  ├── database.js
│  │  │  │     │  ├── env.js
│  │  │  │     │  └── sqliteCompat.js
│  │  │  │     ├── package.json
│  │  │  │     ├── src
│  │  │  │     │  ├── config
│  │  │  │     │  │  ├── database.js
│  │  │  │     │  │  ├── env.js
│  │  │  │     │  │  ├── sqlite-adapter.js
│  │  │  │     │  │  └── sqliteCompat.js
│  │  │  │     │  ├── deviceIdentity.js
│  │  │  │     │  ├── errorEnvelope.js
│  │  │  │     │  ├── index.js
│  │  │  │     │  ├── middleware
│  │  │  │     │  │  ├── auth.js
│  │  │  │     │  │  ├── errorHandler.js
│  │  │  │     │  │  └── rateLimit.js
│  │  │  │     │  ├── models
│  │  │  │     │  │  ├── AIAccount.js
│  │  │  │     │  │  ├── AISuggestion.js
│  │  │  │     │  │  ├── Announcement.js
│  │  │  │     │  │  ├── AnnouncementRead.js
│  │  │  │     │  │  ├── ApiKey.js
│  │  │  │     │  │  ├── Backtest.js
│  │  │  │     │  │  ├── BankTransfer.js
│  │  │  │     │  │  ├── ChannelApi.js
│  │  │  │     │  │  ├── Conversation.js
│  │  │  │     │  │  ├── Feedback.js
│  │  │  │     │  │  ├── GuiEvalRun.js
│  │  │  │     │  │  ├── GuiEvalTask.js
│  │  │  │     │  │  ├── Instrument.js
│  │  │  │     │  │  ├── KlineCache.js
│  │  │  │     │  │  ├── KlineData.js
│  │  │  │     │  │  ├── MarketData.js
│  │  │  │     │  │  ├── MarketplacePlugin.js
│  │  │  │     │  │  ├── PromptTemplate.js
│  │  │  │     │  │  ├── Signal.js
│  │  │  │     │  │  ├── Strategy.js
│  │  │  │     │  │  ├── SystemSetting.js
│  │  │  │     │  │  ├── Trade.js
│  │  │  │     │  │  ├── User.js
│  │  │  │     │  │  ├── UserFavorite.js
│  │  │  │     │  │  ├── UserGatewayConfig.js
│  │  │  │     │  │  ├── UserInstalledPlugin.js
│  │  │  │     │  │  ├── UserLog.js
│  │  │  │     │  │  ├── UserProject.js
│  │  │  │     │  │  ├── UserProvider.js
│  │  │  │     │  │  ├── UserProviderModel.js
│  │  │  │     │  │  ├── UserWorkflow.js
│  │  │  │     │  │  ├── Watchlist.js
│  │  │  │     │  │  ├── WebFrontendEvalRun.js
│  │  │  │     │  │  ├── WebFrontendEvalTask.js
│  │  │  │     │  │  ├── WorkflowRun.js
│  │  │  │     │  │  └── index.js
│  │  │  │     │  ├── plugins
│  │  │  │     │  │  └── openapiTools.js
│  │  │  │     │  ├── runtime
│  │  │  │     │  │  └── khyos
│  │  │  │     │  │     ├── KhyOsRunner.js
│  │  │  │     │  │     ├── _artifact.js
│  │  │  │     │  │     ├── builderProvisioner.js
│  │  │  │     │  │     ├── diskImage.js
│  │  │  │     │  │     ├── index.js
│  │  │  │     │  │     ├── isoProvisioner.js
│  │  │  │     │  │     ├── khyos-manifest.json
│  │  │  │     │  │     ├── portUtils.js
│  │  │  │     │  │     ├── ppmFrame.js
│  │  │  │     │  │     ├── qemuLocate.js
│  │  │  │     │  │     ├── rgbaToPng.js
│  │  │  │     │  │     └── toolchainProvisioner.js
│  │  │  │     │  ├── services
│  │  │  │     │  │  ├── cacheService.js
│  │  │  │     │  │  └── gateway
│  │  │  │     │  │     ├── adapters
│  │  │  │     │  │     │  └── ipAnonymizer.js
│  │  │  │     │  │     ├── example_plugins
│  │  │  │     │  │     │  ├── cache-plugin.js
│  │  │  │     │  │     │  └── cost-guard.js
│  │  │  │     │  │     ├── oauthManager.js
│  │  │  │     │  │     ├── pluginChain.js
│  │  │  │     │  │     ├── protocolConverter
│  │  │  │     │  │     │  ├── anthropic.js
│  │  │  │     │  │     │  ├── canonical.js
│  │  │  │     │  │     │  ├── codex.js
│  │  │  │     │  │     │  ├── formats.js
│  │  │  │     │  │     │  ├── gemini.js
│  │  │  │     │  │     │  ├── grok.js
│  │  │  │     │  │     │  ├── index.js
│  │  │  │     │  │     │  └── openai.js
│  │  │  │     │  │     └── responseSessionStore.js
│  │  │  │     │  ├── utils
│  │  │  │     │  │  ├── apiKeyHash.js
│  │  │  │     │  │  ├── fieldCrypto.js
│  │  │  │     │  │  ├── logger.js
│  │  │  │     │  │  └── storagePaths.js
│  │  │  │     │  └── workflow
│  │  │  │     │     ├── catalogPrompt.js
│  │  │  │     │     ├── cozeImport.js
│  │  │  │     │     ├── exportProviders.js
│  │  │  │     │     ├── nodeCatalog.js
│  │  │  │     │     └── templates.js
│  │  │  │     └── tests
│  │  │  │        └── runtime
│  │  │  │           └── khyos
│  │  │  │              ├── ppmFrame.test.js
│  │  │  │              └── rgbaToPng.test.js
│  │  │  ├── wasm-chain
│  │  │  │  ├── chain.mbt
│  │  │  │  ├── chain_test.mbt
│  │  │  │  ├── cmd
│  │  │  │  │  └── main
│  │  │  │  │     ├── main.mbt
│  │  │  │  │     └── moon.pkg.json
│  │  │  │  ├── moon.mod.json
│  │  │  │  └── moon.pkg
│  │  │  ├── wasm-context
│  │  │  │  ├── cmd
│  │  │  │  │  └── main
│  │  │  │  │     ├── main.mbt
│  │  │  │  │     └── moon.pkg.json
│  │  │  │  ├── context_utils.mbt
│  │  │  │  ├── moon.mod.json
│  │  │  │  └── moon.pkg
│  │  │  └── wasm-indicators
│  │  │     ├── AGENTS.html
│  │  │     ├── AGENTS.md
│  │  │     ├── LICENSE
│  │  │     ├── README.html
│  │  │     ├── README.mbt.html
│  │  │     ├── README.mbt.md
│  │  │     ├── README.md
│  │  │     ├── cmd
│  │  │     │  └── main
│  │  │     │     ├── main.mbt
│  │  │     │     └── moon.pkg
│  │  │     ├── indicators.mbt
│  │  │     ├── indicators.mbt.ast
│  │  │     ├── indicators.mbt.typedtree
│  │  │     ├── indicators_test.mbt
│  │  │     ├── indicators_wbtest.mbt
│  │  │     ├── moon.mod.json
│  │  │     ├── moon.pkg
│  │  │     └── trace.json
│  │  ├── blueprints
│  │  │  ├── archetypes
│  │  │  │  ├── ssm.json
│  │  │  │  └── vue-multipage.json
│  │  │  └── concepts
│  │  │     ├── apig.json
│  │  │     ├── bff.json
│  │  │     ├── cdc.json
│  │  │     ├── cqrs.json
│  │  │     ├── ddd.json
│  │  │     ├── eda.json
│  │  │     ├── etl.json
│  │  │     ├── jam.json
│  │  │     ├── lora.json
│  │  │     ├── mvc.json
│  │  │     ├── mvvm.json
│  │  │     ├── olap.json
│  │  │     ├── oltp.json
│  │  │     ├── rag.json
│  │  │     ├── rlhf.json
│  │  │     ├── soa.json
│  │  │     ├── spa.json
│  │  │     ├── ssg.json
│  │  │     └── ssr.json
│  │  ├── bootstrap
│  │  │  ├── adminAutoInit.js
│  │  │  ├── aiBackendModuleResolve.js
│  │  │  ├── chalkCompat.js
│  │  │  ├── dbAutoMigration.js
│  │  │  ├── ensureAuthSecret.js
│  │  │  ├── ensureProxyCoreEnv.js
│  │  │  ├── expandEnvPlaceholders.js
│  │  │  ├── init.js
│  │  │  ├── migrations.js
│  │  │  ├── moduleSelfHeal.js
│  │  │  ├── prefetch.js
│  │  │  ├── setup.js
│  │  │  ├── shutdown.js
│  │  │  ├── startupFailureExplain.js
│  │  │  ├── startupProfiler.js
│  │  │  ├── startupSqliteProbe.js
│  │  │  ├── state.js
│  │  │  └── windowsSpawnHardening.js
│  │  ├── bridge
│  │  │  ├── aiChatConsumer.js
│  │  │  ├── bridgeAuth.js
│  │  │  ├── bridgeServer.js
│  │  │  ├── bridgeUrlHint.js
│  │  │  ├── deviceNameResolver.js
│  │  │  ├── mobilePage.chat.js
│  │  │  ├── mobilePage.js
│  │  │  └── sessionHistoryStore.js
│  │  ├── buddy
│  │  │  ├── companion.js
│  │  │  ├── index.js
│  │  │  ├── renderer.js
│  │  │  ├── sprites.js
│  │  │  └── types.js
│  │  ├── classic
│  │  │  └── uiAdapter.js
│  │  ├── cli
│  │  │  ├── COMMAND_AUTHORING.html
│  │  │  ├── COMMAND_AUTHORING.md
│  │  │  ├── agentRenderer.js
│  │  │  ├── agentStatLine.js
│  │  │  ├── agentTreeController.js
│  │  │  ├── agentTreeView.js
│  │  │  ├── ai.js
│  │  │  ├── aiChatCore.js
│  │  │  ├── aiChatState.js
│  │  │  ├── aiContextFlow.js
│  │  │  ├── aiConversationOps.js
│  │  │  ├── aiGatewayClient.js
│  │  │  ├── aiGatewayGenerateHelpers.js
│  │  │  ├── aiLocalState.js
│  │  │  ├── aiMessageBuilder.js
│  │  │  ├── aiRenderer.js
│  │  │  ├── aiRequestAnalysis.js
│  │  │  ├── aiRequestParsers.js
│  │  │  ├── aiSession.js
│  │  │  ├── aiTaskClassifier.js
│  │  │  ├── aliases.js
│  │  │  ├── ansiSanitizer.js
│  │  │  ├── atMentionInject.js
│  │  │  ├── autoConnect.js
│  │  │  ├── bannerDataService.js
│  │  │  ├── betaFallbackNotice.js
│  │  │  ├── blockquoteStyle.js
│  │  │  ├── bootPhaseLine.js
│  │  │  ├── bootstrap.js
│  │  │  ├── breakCache.js
│  │  │  ├── bulkLines.js
│  │  │  ├── cacheWarning.js
│  │  │  ├── ccCountLines.js
│  │  │  ├── ccFormat.js
│  │  │  ├── ccModelName.js
│  │  │  ├── ccPlural.js
│  │  │  ├── ccRelativePath.js
│  │  │  ├── ccTruncateLines.js
│  │  │  ├── ccUserFacingToolError.js
│  │  │  ├── cjkInputNormalize.js
│  │  │  ├── cliErrorReporter.js
│  │  │  ├── commandAutoRegistry.js
│  │  │  ├── commandCatalogUi.js
│  │  │  ├── commandCompletionIndexMemo.js
│  │  │  ├── commandManifest.js
│  │  │  ├── commandRegistry.js
│  │  │  ├── commands
│  │  │  │  ├── registry.js
│  │  │  │  ├── registry.json
│  │  │  │  └── system
│  │  │  │     └── version.js
│  │  │  ├── commitTiming.js
│  │  │  ├── compactInstructions.js
│  │  │  ├── compactOrchestrator.js
│  │  │  ├── compactResultSummary.js
│  │  │  ├── compactionDisplay.js
│  │  │  ├── completionKeysLazy.js
│  │  │  ├── completionManifestUnion.js
│  │  │  ├── configSyncClient.js
│  │  │  ├── contextPanelDetail.js
│  │  │  ├── contextResidentTokens.js
│  │  │  ├── contextWarning.js
│  │  │  ├── copyReply.js
│  │  │  ├── costThresholdWarning.js
│  │  │  ├── crossBranchSynthesis.js
│  │  │  ├── debugToolCall.js
│  │  │  ├── diffContentWidth.js
│  │  │  ├── diffFullWidth.js
│  │  │  ├── diffGutter.js
│  │  │  ├── diffLineNumbers.js
│  │  │  ├── diffRenderer.js
│  │  │  ├── diffSpec.js
│  │  │  ├── displayWidthMemo.js
│  │  │  ├── doctorReport.js
│  │  │  ├── editStatLine.js
│  │  │  ├── envInfoLines.js
│  │  │  ├── errorSummary.js
│  │  │  ├── escapeTimeoutDetector.js
│  │  │  ├── extensions
│  │  │  │  └── extensionManager.js
│  │  │  ├── featureCapabilityMap.js
│  │  │  ├── feedbackDoc.js
│  │  │  ├── fenceLangCharset.js
│  │  │  ├── firstResponseAckVoice.js
│  │  │  ├── flagHint.js
│  │  │  ├── formatters.js
│  │  │  ├── fullWidthInput.js
│  │  │  ├── ghostBorder.js
│  │  │  ├── gitDiffCollect.js
│  │  │  ├── handlers
│  │  │  │  ├── _portableAutoInstall.js
│  │  │  │  ├── about.js
│  │  │  │  ├── advisor.js
│  │  │  │  ├── agentAssets.js
│  │  │  │  ├── app.js
│  │  │  │  ├── arena.js
│  │  │  │  ├── assistant.js
│  │  │  │  ├── autofixPr.js
│  │  │  │  ├── autonomy.js
│  │  │  │  ├── backtest.js
│  │  │  │  ├── backup.js
│  │  │  │  ├── breakCache.js
│  │  │  │  ├── btw.js
│  │  │  │  ├── capability.js
│  │  │  │  ├── ccSwitch.js
│  │  │  │  ├── channels.js
│  │  │  │  ├── ci.js
│  │  │  │  ├── claimMain.js
│  │  │  │  ├── claudeAdopt.js
│  │  │  │  ├── clean.js
│  │  │  │  ├── cleanup.js
│  │  │  │  ├── codexAdopt.js
│  │  │  │  ├── color.js
│  │  │  │  ├── commands.js
│  │  │  │  ├── commit.js
│  │  │  │  ├── companion.js
│  │  │  │  ├── config.js
│  │  │  │  ├── convert.js
│  │  │  │  ├── copy.js
│  │  │  │  ├── createFrontend.js
│  │  │  │  ├── credentials.js
│  │  │  │  ├── cron.js
│  │  │  │  ├── crossPlatform.js
│  │  │  │  ├── daemon.js
│  │  │  │  ├── data.js
│  │  │  │  ├── debugToolCall.js
│  │  │  │  ├── deliveries.js
│  │  │  │  ├── deploy.js
│  │  │  │  ├── deps.js
│  │  │  │  ├── desktop.js
│  │  │  │  ├── device.js
│  │  │  │  ├── diskClean.js
│  │  │  │  ├── doc.js
│  │  │  │  ├── docs.js
│  │  │  │  ├── doctorCmdc.js
│  │  │  │  ├── doctorConnectivity.js
│  │  │  │  ├── entrypoints.js
│  │  │  │  ├── evolve.js
│  │  │  │  ├── extension.js
│  │  │  │  ├── features.js
│  │  │  │  ├── feedback.js
│  │  │  │  ├── feishu.js
│  │  │  │  ├── forge.js
│  │  │  │  ├── fork.js
│  │  │  │  ├── gateway.js
│  │  │  │  ├── gatewayConfigEditor.js
│  │  │  │  ├── gatewayManageDaemon.js
│  │  │  │  ├── gatewayModelChoices.js
│  │  │  │  ├── gatewayProviderKeyPool.js
│  │  │  │  ├── gatewayRuntimeProbes.js
│  │  │  │  ├── gatewayStatusView.js
│  │  │  │  ├── goal.js
│  │  │  │  ├── guide.js
│  │  │  │  ├── heal.js
│  │  │  │  ├── health.js
│  │  │  │  ├── heapdump.js
│  │  │  │  ├── hq.js
│  │  │  │  ├── ide.js
│  │  │  │  ├── ideStatus.js
│  │  │  │  ├── init.js
│  │  │  │  ├── initVerifiers.js
│  │  │  │  ├── insights.js
│  │  │  │  ├── issue.js
│  │  │  │  ├── job.js
│  │  │  │  ├── keybindings.js
│  │  │  │  ├── khyos.js
│  │  │  │  ├── lang.js
│  │  │  │  ├── lazy.js
│  │  │  │  ├── learn.js
│  │  │  │  ├── linux.js
│  │  │  │  ├── maintain.js
│  │  │  │  ├── manage.js
│  │  │  │  ├── market.js
│  │  │  │  ├── mcp.js
│  │  │  │  ├── mcpExport.js
│  │  │  │  ├── md.js
│  │  │  │  ├── mesh.js
│  │  │  │  ├── metadata.js
│  │  │  │  ├── moa.js
│  │  │  │  ├── mobile.js
│  │  │  │  ├── modules.js
│  │  │  │  ├── msg.js
│  │  │  │  ├── notify.js
│  │  │  │  ├── onboarding.js
│  │  │  │  ├── orchestrate.js
│  │  │  │  ├── perfIssue.js
│  │  │  │  ├── persona.js
│  │  │  │  ├── plugin-dev.js
│  │  │  │  ├── pool.js
│  │  │  │  ├── portable.js
│  │  │  │  ├── portableSync.js
│  │  │  │  ├── pr.js
│  │  │  │  ├── prComments.js
│  │  │  │  ├── proactive.js
│  │  │  │  ├── project.js
│  │  │  │  ├── provider.js
│  │  │  │  ├── proxy.js
│  │  │  │  ├── proxyCoreInstallHandler.js
│  │  │  │  ├── proxySwitchProfiles.js
│  │  │  │  ├── publish.js
│  │  │  │  ├── publishCmd.js
│  │  │  │  ├── recap.js
│  │  │  │  ├── receipts.js
│  │  │  │  ├── releaseNotes.js
│  │  │  │  ├── remote.js
│  │  │  │  ├── remotedev.js
│  │  │  │  ├── rename.js
│  │  │  │  ├── replay.js
│  │  │  │  ├── repo.js
│  │  │  │  ├── resource.js
│  │  │  │  ├── review.js
│  │  │  │  ├── role.js
│  │  │  │  ├── rollback.js
│  │  │  │  ├── rtk.js
│  │  │  │  ├── runtime.js
│  │  │  │  ├── sandboxToggle.js
│  │  │  │  ├── selfHeal.js
│  │  │  │  ├── service.js
│  │  │  │  ├── session.js
│  │  │  │  ├── skill.js
│  │  │  │  ├── state.js
│  │  │  │  ├── statusline.js
│  │  │  │  ├── storage.js
│  │  │  │  ├── subscribePr.js
│  │  │  │  ├── tag.js
│  │  │  │  ├── taste.js
│  │  │  │  ├── terminalSetup.js
│  │  │  │  ├── testKey.js
│  │  │  │  ├── thinkback.js
│  │  │  │  ├── toolcheck.js
│  │  │  │  ├── toollist.js
│  │  │  │  ├── tools.js
│  │  │  │  ├── topology.js
│  │  │  │  ├── trace.js
│  │  │  │  ├── traffic.js
│  │  │  │  ├── turnRollback.js
│  │  │  │  ├── twentyX.js
│  │  │  │  ├── ultraplan.js
│  │  │  │  ├── uninstall.js
│  │  │  │  ├── vault.js
│  │  │  │  ├── verdict.js
│  │  │  │  ├── verify.js
│  │  │  │  ├── webTools.js
│  │  │  │  ├── where.js
│  │  │  │  ├── workflow.js
│  │  │  │  ├── workspace.js
│  │  │  │  └── wx.js
│  │  │  ├── headlessProgress.js
│  │  │  ├── heapDump.js
│  │  │  ├── helpCard.js
│  │  │  ├── hooks
│  │  │  │  ├── hookRegistry.js
│  │  │  │  ├── hookRunner.js
│  │  │  │  └── hookSystem.js
│  │  │  ├── hqStore.js
│  │  │  ├── hudRenderer.js
│  │  │  ├── idleReturnNudge.js
│  │  │  ├── inertiaCommand.js
│  │  │  ├── inlineOptionParse.js
│  │  │  ├── keyFindings.js
│  │  │  ├── lineBuffer.js
│  │  │  ├── markdownLink.js
│  │  │  ├── markdownRenderer.js
│  │  │  ├── markdownTableWrap.js
│  │  │  ├── menu.js
│  │  │  ├── mermaid.js
│  │  │  ├── messagePredicates.js
│  │  │  ├── modelChoiceGrouping.js
│  │  │  ├── modelTextNormalizer.js
│  │  │  ├── naturalLanguageAliasGuard.js
│  │  │  ├── nearVerb.js
│  │  │  ├── nlModelSwitchResolver.js
│  │  │  ├── onboarding.js
│  │  │  ├── optionValueGuard.js
│  │  │  ├── orderedListAlign.js
│  │  │  ├── outcomeKeyFinding.js
│  │  │  ├── palette.js
│  │  │  ├── panels.js
│  │  │  ├── pastedRefLines.js
│  │  │  ├── permissionReply.js
│  │  │  ├── plainProcessTable.js
│  │  │  ├── plugins.js
│  │  │  ├── prCommentsFormat.js
│  │  │  ├── previewOverflowMarker.js
│  │  │  ├── printOutputFormat.js
│  │  │  ├── promptOutputGuard.js
│  │  │  ├── pty.js
│  │  │  ├── qaEchoLines.js
│  │  │  ├── rateLimitRetry.js
│  │  │  ├── readRangeSuffix.js
│  │  │  ├── renderDedup.js
│  │  │  ├── renderTheme.js
│  │  │  ├── repl
│  │  │  │  ├── atPicker.js
│  │  │  │  ├── atProjectionCache.js
│  │  │  │  ├── bottomDecorationRepaintMemo.js
│  │  │  │  ├── bottomDecorationWriteDedup.js
│  │  │  │  ├── busyInputClassifiers.js
│  │  │  │  ├── busyInterruptEscalation.js
│  │  │  │  ├── busyTopicShift.js
│  │  │  │  ├── ccUserCommands.js
│  │  │  │  ├── clipboardCommands.js
│  │  │  │  ├── configTomlOverlay.js
│  │  │  │  ├── deferredStatuses.js
│  │  │  │  ├── dirSkip.js
│  │  │  │  ├── displayFormatters.js
│  │  │  │  ├── errorReporting.js
│  │  │  │  ├── foldedErrorHelpers.js
│  │  │  │  ├── footerLayout.js
│  │  │  │  ├── history.js
│  │  │  │  ├── imageIntent.js
│  │  │  │  ├── imageRecognitionIntent.js
│  │  │  │  ├── inlineFileRefs.js
│  │  │  │  ├── inputClassifiers.js
│  │  │  │  ├── inputCursorMetricsMemo.js
│  │  │  │  ├── intentDebugSnapshot.js
│  │  │  │  ├── khySettings.js
│  │  │  │  ├── mergedSlashCommandsCache.js
│  │  │  │  ├── permissionBar.js
│  │  │  │  ├── rawPasteChunkClassify.js
│  │  │  │  ├── shellEscape.js
│  │  │  │  ├── slashCommandFilter.js
│  │  │  │  ├── slashRankIndexMemo.js
│  │  │  │  ├── startup.js
│  │  │  │  ├── startupHeader.js
│  │  │  │  ├── startupNotices.js
│  │  │  │  ├── statusLabels.js
│  │  │  │  ├── statusLiveActivity.js
│  │  │  │  ├── streamRender.js
│  │  │  │  ├── tasksCommand.js
│  │  │  │  ├── terminalTitle.js
│  │  │  │  ├── thinkingRender.js
│  │  │  │  ├── toolOutputRender.js
│  │  │  │  ├── userSkillCommands.js
│  │  │  │  └── worktreeCommand.js
│  │  │  ├── repl.js
│  │  │  ├── replSession.js
│  │  │  ├── reportKhyError.js
│  │  │  ├── resultGuard.js
│  │  │  ├── resultLineGlyph.js
│  │  │  ├── resumeHint.js
│  │  │  ├── retryCountdown.js
│  │  │  ├── rewindNotice.js
│  │  │  ├── router.js
│  │  │  ├── routerDispatchOps.js
│  │  │  ├── routerDispatchSlash.js
│  │  │  ├── routerDispatchTail.js
│  │  │  ├── routerHandlers.js
│  │  │  ├── safeArrayMinMax.js
│  │  │  ├── sessionClear.js
│  │  │  ├── sessionColor.js
│  │  │  ├── sessionColorState.js
│  │  │  ├── sessionSlots.js
│  │  │  ├── sessionTag.js
│  │  │  ├── sessionTopology.js
│  │  │  ├── shellEscapeContext.js
│  │  │  ├── shellOutputJson.js
│  │  │  ├── shortOptionSpec.js
│  │  │  ├── slashExtraCommands.js
│  │  │  ├── softWrap.js
│  │  │  ├── spinner.js
│  │  │  ├── spinnerMeta.js
│  │  │  ├── spinnerShimmer.js
│  │  │  ├── starEmphasisFlanking.js
│  │  │  ├── startupBeats.js
│  │  │  ├── statsConversationLines.js
│  │  │  ├── statusBroadcast.js
│  │  │  ├── statusLine
│  │  │  │  ├── statusLineConfig.js
│  │  │  │  ├── statusLineGates.js
│  │  │  │  └── statusLineRunner.js
│  │  │  ├── statusMessageFormatter.js
│  │  │  ├── statusPanelExtras.js
│  │  │  ├── steps.js
│  │  │  ├── streamingMarkdown.js
│  │  │  ├── symbolResolver.js
│  │  │  ├── syncOutput.js
│  │  │  ├── tableStyle.js
│  │  │  ├── taskMindMap.js
│  │  │  ├── taskPanelState.js
│  │  │  ├── tasksControlContract.js
│  │  │  ├── themePanelLines.js
│  │  │  ├── themeRegistry.js
│  │  │  ├── themes
│  │  │  │  ├── default.json
│  │  │  │  ├── dracula.json
│  │  │  │  ├── forest.json
│  │  │  │  ├── mono.json
│  │  │  │  ├── nord.json
│  │  │  │  ├── ocean.json
│  │  │  │  ├── solarized.json
│  │  │  │  └── sunset.json
│  │  │  ├── thinkbackReport.js
│  │  │  ├── thinkingDuration.js
│  │  │  ├── toolCallNoise.js
│  │  │  ├── toolDisplay.js
│  │  │  ├── toolDisplayLine.js
│  │  │  ├── toolDisplayPolicy.js
│  │  │  ├── toolErrorFold.js
│  │  │  ├── toolHeaderCap.js
│  │  │  ├── toolHeaderDisplayName.js
│  │  │  ├── toolParamPath.js
│  │  │  ├── toolPrefaceVoice.js
│  │  │  ├── toolResultSummary.js
│  │  │  ├── toolResultTransparency.js
│  │  │  ├── toolResultVoice.js
│  │  │  ├── transparency.js
│  │  │  ├── truncateDisplayWidthBudget.js
│  │  │  ├── trustGate.js
│  │  │  ├── tui
│  │  │  │  ├── AGENTS.html
│  │  │  │  ├── AGENTS.md
│  │  │  │  ├── app.js
│  │  │  │  ├── arrowRouting.js
│  │  │  │  ├── bootLayout.js
│  │  │  │  ├── cardLayout.js
│  │  │  │  ├── chatChords.js
│  │  │  │  ├── chromeBudget.js
│  │  │  │  ├── chromeRegistry.js
│  │  │  │  ├── completionDirCache.js
│  │  │  │  ├── components
│  │  │  │  │  ├── CcMessageBar.js
│  │  │  │  │  ├── CcScrollIndicators.js
│  │  │  │  │  └── CcToast.js
│  │  │  │  ├── consoleMute.js
│  │  │  │  ├── dragAutoScrollTimer.js
│  │  │  │  ├── effectiveCols.js
│  │  │  │  ├── effectiveDims.js
│  │  │  │  ├── foldLongLines.js
│  │  │  │  ├── foldModel.js
│  │  │  │  ├── footerMemory.js
│  │  │  │  ├── footerStability.js
│  │  │  │  ├── footerWidthBudget.js
│  │  │  │  ├── frameBudget.js
│  │  │  │  ├── frameDivergence.js
│  │  │  │  ├── framePlan.js
│  │  │  │  ├── healthScorecard.js
│  │  │  │  ├── historyBrowseDecision.js
│  │  │  │  ├── hooks
│  │  │  │  │  ├── historyPersist.js
│  │  │  │  │  ├── liveSealThreshold.js
│  │  │  │  │  ├── queryBridgeTimeline.js
│  │  │  │  │  ├── useCompletions.js
│  │  │  │  │  ├── useMcpStatus.js
│  │  │  │  │  ├── useQueryBridge.js
│  │  │  │  │  ├── useSidebarNav.js
│  │  │  │  │  ├── useSidebarState.js
│  │  │  │  │  ├── useTextInput.js
│  │  │  │  │  ├── useTopic.js
│  │  │  │  │  └── useVimInput.js
│  │  │  │  ├── imeCommitGuard.js
│  │  │  │  ├── ink-components
│  │  │  │  │  ├── AgentTree.js
│  │  │  │  │  ├── App.js
│  │  │  │  │  ├── BootScreen.js
│  │  │  │  │  ├── CcApp.js
│  │  │  │  │  ├── CcAssistantMessage.js
│  │  │  │  │  ├── CcCollapsible.js
│  │  │  │  │  ├── CcFuzzyPicker.js
│  │  │  │  │  ├── CcHelpMenu.js
│  │  │  │  │  ├── CcLogo.js
│  │  │  │  │  ├── CcMcpStatus.js
│  │  │  │  │  ├── CcPermissionPrompt.js
│  │  │  │  │  ├── CcPromptInput.js
│  │  │  │  │  ├── CcSelectable.js
│  │  │  │  │  ├── CcSidebarPanel.js
│  │  │  │  │  ├── CcStatusLine.js
│  │  │  │  │  ├── CcTable.js
│  │  │  │  │  ├── CcTranscriptView.js
│  │  │  │  │  ├── CcViewStack.js
│  │  │  │  │  ├── ChatColumn.js
│  │  │  │  │  ├── CompactionProgress.js
│  │  │  │  │  ├── CompletionMenu.js
│  │  │  │  │  ├── FooterBar.js
│  │  │  │  │  ├── FormFlow.js
│  │  │  │  │  ├── HelpMenu.js
│  │  │  │  │  ├── HistorySearchOverlay.js
│  │  │  │  │  ├── KhyOsView.js
│  │  │  │  │  ├── ModelPicker.js
│  │  │  │  │  ├── PermissionsPrompt.js
│  │  │  │  │  ├── PlanApproval.js
│  │  │  │  │  ├── PreviewLayout.js
│  │  │  │  │  ├── ProcessGroup.js
│  │  │  │  │  ├── ProgressBar.js
│  │  │  │  │  ├── PromptFrame.js
│  │  │  │  │  ├── QuestionPrompt.js
│  │  │  │  │  ├── RewindPicker.js
│  │  │  │  │  ├── RightPanel.js
│  │  │  │  │  ├── SessionSidebar.js
│  │  │  │  │  ├── ShellView.js
│  │  │  │  │  ├── SidebarPanel.js
│  │  │  │  │  ├── Spinner.js
│  │  │  │  │  ├── Statusbar.js
│  │  │  │  │  ├── StreamingBlock.js
│  │  │  │  │  ├── TaskListPanel.js
│  │  │  │  │  ├── ThreeColumnLayout.js
│  │  │  │  │  ├── ToolLines.js
│  │  │  │  │  ├── Topbar.js
│  │  │  │  │  ├── TopologyPanel.js
│  │  │  │  │  ├── Transcript.js
│  │  │  │  │  ├── TranscriptView.js
│  │  │  │  │  ├── Viewport.js
│  │  │  │  │  ├── WelcomeBanner.js
│  │  │  │  │  ├── appHostHelpers.js
│  │  │  │  │  ├── cardClick.js
│  │  │  │  │  ├── caretGeometry.js
│  │  │  │  │  ├── ccMessageProjection.js
│  │  │  │  │  ├── ccOverlayLayout.js
│  │  │  │  │  ├── liveHeightClamp.js
│  │  │  │  │  ├── liveRegionBudget.js
│  │  │  │  │  ├── liveTimelineLazyNorm.js
│  │  │  │  │  ├── overlayLiveBudget.js
│  │  │  │  │  ├── processGroupClassifyMemo.js
│  │  │  │  │  ├── promptCaretMarginMemo.js
│  │  │  │  │  ├── promptLayoutMemo.js
│  │  │  │  │  ├── questionCardModel.js
│  │  │  │  │  ├── regionLayout.js
│  │  │  │  │  ├── runningToolsSummaryMemo.js
│  │  │  │  │  ├── sectionGap.js
│  │  │  │  │  ├── spinnerTokenEstimate.js
│  │  │  │  │  ├── spinnerTokenLazy.js
│  │  │  │  │  ├── streamMdCache.js
│  │  │  │  │  ├── streamNormCache.js
│  │  │  │  │  ├── tailTruncation.js
│  │  │  │  │  ├── taskLineStyle.js
│  │  │  │  │  ├── taskLinesMemo.js
│  │  │  │  │  ├── taskPanelHeader.js
│  │  │  │  │  ├── taskPanelLines.js
│  │  │  │  │  ├── taskSurface.js
│  │  │  │  │  ├── toolDiffRowsMemo.js
│  │  │  │  │  ├── toolEntryRows.js
│  │  │  │  │  ├── toolHeaderSummaryMemo.js
│  │  │  │  │  ├── toolLiteralOutputMemo.js
│  │  │  │  │  ├── toolTargetMemo.js
│  │  │  │  │  └── userMessageCollapse.js
│  │  │  │  ├── inkRuntime.js
│  │  │  │  ├── inlineImageSubmit.js
│  │  │  │  ├── interruptHint.js
│  │  │  │  ├── logoArt.js
│  │  │  │  ├── mouseButtons.js
│  │  │  │  ├── noticeInbox.js
│  │  │  │  ├── pendingImageAttachments.js
│  │  │  │  ├── perfEntryReaper.js
│  │  │  │  ├── perfTunables.js
│  │  │  │  ├── permissionFieldRows.js
│  │  │  │  ├── permissionNotice.js
│  │  │  │  ├── promptPlaceholder.js
│  │  │  │  ├── railLayout.js
│  │  │  │  ├── rewindControl.js
│  │  │  │  ├── rewindScope.js
│  │  │  │  ├── runtime
│  │  │  │  │  ├── outputWidthGuard.js
│  │  │  │  │  ├── sidebarRail.js
│  │  │  │  │  ├── terminalCapabilities.js
│  │  │  │  │  ├── textMeasure.js
│  │  │  │  │  ├── topicBar.js
│  │  │  │  │  └── topicBarWorkingIndicator.js
│  │  │  │  ├── scrollActions.js
│  │  │  │  ├── scrollbackPreserve.js
│  │  │  │  ├── selection.js
│  │  │  │  ├── sidebarLayout.js
│  │  │  │  ├── slashMenuFilter.js
│  │  │  │  ├── slashRankResultMemo.js
│  │  │  │  ├── startupAnchor.js
│  │  │  │  ├── staticItemsMemo.js
│  │  │  │  ├── theme
│  │  │  │  │  ├── ccTheme.js
│  │  │  │  │  ├── ccThemeBg.js
│  │  │  │  │  └── themeRegistry.js
│  │  │  │  ├── thinkingMarquee.js
│  │  │  │  ├── timelineAppendMerge.js
│  │  │  │  ├── transcriptLines.js
│  │  │  │  ├── tuiCommandReports.js
│  │  │  │  ├── tuiConfig.js
│  │  │  │  ├── tuiErrorAdapter.js
│  │  │  │  ├── uiAdapter.js
│  │  │  │  ├── uiBridge.js
│  │  │  │  ├── uiStdinFallbacks.js
│  │  │  │  ├── userMessageStyle.js
│  │  │  │  ├── utils
│  │  │  │  │  ├── Cursor.js
│  │  │  │  │  ├── ccBrand.js
│  │  │  │  │  ├── ccClipboard.js
│  │  │  │  │  ├── ccContextWindows.js
│  │  │  │  │  ├── ccExecutionMonitor.js
│  │  │  │  │  ├── ccFeedback.js
│  │  │  │  │  ├── ccFormatters.js
│  │  │  │  │  ├── ccHistory.js
│  │  │  │  │  ├── ccKeyRegistry.js
│  │  │  │  │  ├── ccLayout.js
│  │  │  │  │  ├── ccMode.js
│  │  │  │  │  ├── ccPricing.js
│  │  │  │  │  ├── ccRenderStrategy.js
│  │  │  │  │  ├── ccStatusBar.js
│  │  │  │  │  ├── ccTaskEstimate.js
│  │  │  │  │  ├── ccTimers.js
│  │  │  │  │  ├── ccToolFormat.js
│  │  │  │  │  ├── ccUndoStack.js
│  │  │  │  │  └── selectGates.js
│  │  │  │  ├── vim
│  │  │  │  │  ├── cursor.js
│  │  │  │  │  ├── motions.js
│  │  │  │  │  ├── operators.js
│  │  │  │  │  ├── textObjects.js
│  │  │  │  │  ├── transitions.js
│  │  │  │  │  ├── types.js
│  │  │  │  │  └── vimPasteGuard.js
│  │  │  │  └── wrapCell.js
│  │  │  ├── turnAckVoice.js
│  │  │  ├── turnStats.js
│  │  │  ├── ui
│  │  │  │  ├── alwaysAllowLabel.js
│  │  │  │  ├── diffViewer.js
│  │  │  │  ├── inkComponents.js
│  │  │  │  └── permissionDialog.js
│  │  │  ├── ui.js
│  │  │  ├── uiAdapter.js
│  │  │  ├── uiFacade.js
│  │  │  ├── uiPrompt.js
│  │  │  ├── uiResponse.js
│  │  │  ├── underscoreEmphasis.js
│  │  │  ├── unknownCommandHint.js
│  │  │  ├── utils
│  │  │  │  └── lruCache.js
│  │  │  ├── visionNoticeDedup.js
│  │  │  ├── webToolsFormat.js
│  │  │  ├── wordDiff.js
│  │  │  ├── writeDiffRows.js
│  │  │  └── x[1])
│  │  ├── commands
│  │  │  └── ccCommandBridge.js
│  │  ├── config
│  │  │  ├── a2aConfig.js
│  │  │  ├── database.js
│  │  │  ├── env.js
│  │  │  ├── settingsWhitelist.js
│  │  │  ├── sqlite-adapter.js
│  │  │  └── sqliteCompat.js
│  │  ├── contracts
│  │  │  ├── a2a
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── agent-card.schema.json
│  │  │  │  ├── message.schema.json
│  │  │  │  └── task.schema.json
│  │  │  ├── acp
│  │  │  │  └── acp-message.schema.json
│  │  │  └── mobile
│  │  │     ├── README.html
│  │  │     ├── README.md
│  │  │     ├── approval-ticket.schema.json
│  │  │     ├── device-handover-snapshot.schema.json
│  │  │     └── mobile-stream-event.schema.json
│  │  ├── controllers
│  │  │  ├── cacheController.js
│  │  │  ├── comprehensiveDataController.js
│  │  │  ├── instrumentController.js
│  │  │  └── marketController.js
│  │  ├── coordinator
│  │  │  ├── agentWorkerEntry.js
│  │  │  ├── coordinatorMode.js
│  │  │  ├── ipcProtocol.js
│  │  │  ├── processAgent.js
│  │  │  ├── taskBoard.js
│  │  │  └── workerAgent.js
│  │  ├── data
│  │  │  ├── bugCases.js
│  │  │  ├── cliAnythingRegistry
│  │  │  │  ├── public_registry.json
│  │  │  │  ├── registry.json
│  │  │  │  └── skills
│  │  │  │     ├── README.html
│  │  │  │     ├── README.md
│  │  │  │     ├── cli-anything-adguardhome
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-anygen
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-audacity
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-blender
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-browser
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-calibre
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-chromadb
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-cloudanalyzer
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-cloudcompare
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-comfyui
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-dify-workflow
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-drawio
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-eth2-quickstart
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-exa
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-firefly-iii
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-freecad
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-gimp
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-godot
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-inkscape
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-intelwatch
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-iterm2
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-iterm2-ctl
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-kdenlive
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-krita
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-libreoffice
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-lldb
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-macrocli
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-mailchimp
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-mermaid
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-minimax
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-mubu
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-musescore
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-n8n
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-notebooklm
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-novita
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-nsight-graphics
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-nslogger
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-obs-studio
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-obsidian
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-ollama
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-openscreen
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-pm2
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-qgis
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-quietshrink
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-rekordbox
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-renderdoc
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-rms
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-safari
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-sbox
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-seaclip
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-shotcut
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-slay-the-spire-ii
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-threemf
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-unimol-tools
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-unrealinsights
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-videocaptioner
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-wiremock
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-zoom
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     ├── cli-anything-zotero
│  │  │  │     │  ├── SKILL.html
│  │  │  │     │  └── SKILL.md
│  │  │  │     └── cli-hub-meta-skill
│  │  │  │        ├── SKILL.html
│  │  │  │        └── SKILL.md
│  │  │  ├── cliAnythingTemplates
│  │  │  │  ├── HARNESS_PROMPT.html
│  │  │  │  ├── HARNESS_PROMPT.md
│  │  │  │  ├── STAGE_0_ACQUIRE.html
│  │  │  │  ├── STAGE_0_ACQUIRE.md
│  │  │  │  ├── STAGE_1_ANALYZE.html
│  │  │  │  ├── STAGE_1_ANALYZE.md
│  │  │  │  ├── STAGE_2_DESIGN.html
│  │  │  │  ├── STAGE_2_DESIGN.md
│  │  │  │  ├── STAGE_3_IMPLEMENT.html
│  │  │  │  ├── STAGE_3_IMPLEMENT.md
│  │  │  │  ├── STAGE_4_TESTPLAN.html
│  │  │  │  ├── STAGE_4_TESTPLAN.md
│  │  │  │  ├── STAGE_5_TESTCODE.html
│  │  │  │  ├── STAGE_5_TESTCODE.md
│  │  │  │  ├── STAGE_6_DOCS.html
│  │  │  │  ├── STAGE_6_DOCS.md
│  │  │  │  ├── STAGE_7_PACKAGE.html
│  │  │  │  ├── STAGE_7_PACKAGE.md
│  │  │  │  ├── node_skeleton
│  │  │  │  │  ├── backend.js
│  │  │  │  │  ├── index.js
│  │  │  │  │  ├── openclaw.plugin.json
│  │  │  │  │  ├── package.json
│  │  │  │  │  └── session.js
│  │  │  │  └── python_skeleton
│  │  │  │     ├── __init__.py
│  │  │  │     ├── __main__.py
│  │  │  │     ├── backend.py
│  │  │  │     ├── cli_template.py
│  │  │  │     ├── session.py
│  │  │  │     └── setup.py
│  │  │  ├── curriculum.json
│  │  │  └── publicApis.json
│  │  ├── i18n
│  │  │  ├── index.js
│  │  │  └── locales
│  │  │     ├── de.json
│  │  │     ├── en.json
│  │  │     ├── fr.json
│  │  │     ├── ja.json
│  │  │     └── zh.json
│  │  ├── index.js
│  │  ├── jobs
│  │  │  ├── cronScheduler.js
│  │  │  ├── jobStore.js
│  │  │  └── jobTemplates.js
│  │  ├── main.js
│  │  ├── memdir
│  │  │  ├── index.js
│  │  │  ├── memdir.js
│  │  │  ├── memorySlug.js
│  │  │  ├── memoryUnify.js
│  │  │  ├── paths.js
│  │  │  └── projectMemoryContract.js
│  │  ├── middleware
│  │  │  ├── auditLog.js
│  │  │  ├── auth.js
│  │  │  ├── errorHandler.js
│  │  │  ├── originGuard.js
│  │  │  ├── rateLimit.js
│  │  │  └── requestLogger.js
│  │  ├── migrations
│  │  │  └── run.js
│  │  ├── models
│  │  │  ├── AISuggestion.js
│  │  │  ├── Announcement.js
│  │  │  ├── AnnouncementRead.js
│  │  │  ├── ApiKey.js
│  │  │  ├── AuthSession.js
│  │  │  ├── Backtest.js
│  │  │  ├── BankTransfer.js
│  │  │  ├── Feedback.js
│  │  │  ├── Instrument.js
│  │  │  ├── KlineCache.js
│  │  │  ├── KlineData.js
│  │  │  ├── MarketData.js
│  │  │  ├── Signal.js
│  │  │  ├── Strategy.js
│  │  │  ├── SystemSetting.js
│  │  │  ├── Trade.js
│  │  │  ├── User.js
│  │  │  ├── UserAuthState.js
│  │  │  ├── UserFavorite.js
│  │  │  ├── UserLog.js
│  │  │  ├── Watchlist.js
│  │  │  └── index.js
│  │  ├── observability
│  │  │  ├── cpuProfiler.js
│  │  │  ├── eventBus.js
│  │  │  ├── eventLog.js
│  │  │  ├── eventLoopMonitor.js
│  │  │  ├── index.js
│  │  │  ├── metrics.js
│  │  │  ├── otel.js
│  │  │  ├── profilerCore.js
│  │  │  ├── slowRequest.js
│  │  │  └── slowRequestCore.js
│  │  ├── permissions
│  │  │  ├── bashSecurity.js
│  │  │  ├── bashSecurityPatterns.js
│  │  │  ├── index.js
│  │  │  ├── patternMatcher.js
│  │  │  └── rules.js
│  │  ├── plugin-loader
│  │  │  ├── contextFactory.js
│  │  │  ├── index.js
│  │  │  └── sdkCompat.js
│  │  ├── routes
│  │  │  ├── a2a.js
│  │  │  ├── admin.js
│  │  │  ├── ai.js
│  │  │  ├── aiGatewayAdmin.js
│  │  │  ├── aiGatewayPayments.js
│  │  │  ├── announcement.js
│  │  │  ├── apiKey.js
│  │  │  ├── auth.js
│  │  │  ├── backtest.js
│  │  │  ├── bankTransfer.js
│  │  │  ├── cache.js
│  │  │  ├── ccSwitch.js
│  │  │  ├── chain.js
│  │  │  ├── channelApis.js
│  │  │  ├── commands.js
│  │  │  ├── comprehensiveData.js
│  │  │  ├── configSync.js
│  │  │  ├── crossPlatform.js
│  │  │  ├── daemon.js
│  │  │  ├── dashboard.js
│  │  │  ├── downloads.js
│  │  │  ├── external.js
│  │  │  ├── favorites.js
│  │  │  ├── feedback.js
│  │  │  ├── freeLLM.js
│  │  │  ├── futuresTickData.js
│  │  │  ├── guiEval.js
│  │  │  ├── image.js
│  │  │  ├── instrumentSync.js
│  │  │  ├── instruments.js
│  │  │  ├── khySessions.js
│  │  │  ├── klineData.js
│  │  │  ├── largeTasks
│  │  │  │  ├── retryPolicy.js
│  │  │  │  ├── retryPolicyValidation.js
│  │  │  │  └── routeHelpers.js
│  │  │  ├── largeTasks.js
│  │  │  ├── market.js
│  │  │  ├── marketData.js
│  │  │  ├── modelMesh.js
│  │  │  ├── news.js
│  │  │  ├── passwordReset.js
│  │  │  ├── paymentWebhooks.js
│  │  │  ├── proxySubscription.js
│  │  │  ├── remoteSsh.js
│  │  │  ├── replay.js
│  │  │  ├── settings.js
│  │  │  ├── stockProxy.js
│  │  │  ├── strategy.js
│  │  │  ├── system.js
│  │  │  ├── tickBacktest.js
│  │  │  ├── trade.js
│  │  │  ├── trades.js
│  │  │  ├── tradingAgents.js
│  │  │  ├── user.js
│  │  │  ├── video.js
│  │  │  ├── watchlist.js
│  │  │  ├── webFrontendEval.js
│  │  │  ├── webauthn.js
│  │  │  ├── webhooks.js
│  │  │  ├── wellKnown.js
│  │  │  └── wx.js
│  │  ├── seeds
│  │  │  └── rebarStrategy.js
│  │  ├── services
│  │  │  ├── __tests__
│  │  │  │  ├── dataCuration.test.js
│  │  │  │  ├── modelTrainingService.trainLog.test.js
│  │  │  │  └── requirementIntake.test.js
│  │  │  ├── _llmDecomposer.js
│  │  │  ├── a2a
│  │  │  │  ├── agentCardSpec.js
│  │  │  │  ├── builtinAgentManifest.js
│  │  │  │  ├── index.js
│  │  │  │  ├── serverMethods.js
│  │  │  │  ├── taskStateSpec.js
│  │  │  │  └── taskStore.js
│  │  │  ├── a2aAgentLifecycle.js
│  │  │  ├── a2aFacade.js
│  │  │  ├── a2aMessageRouter.js
│  │  │  ├── a2aRegistry.js
│  │  │  ├── acceptanceCriteria.js
│  │  │  ├── accountPool.js
│  │  │  ├── accountSelector.js
│  │  │  ├── acpTransport.js
│  │  │  ├── actionAttribution.js
│  │  │  ├── activeSkillContext.js
│  │  │  ├── adaptiveConfig.js
│  │  │  ├── adaptiveExecution.js
│  │  │  ├── adaptiveOutput.js
│  │  │  ├── additionalDirectories.js
│  │  │  ├── adminService.js
│  │  │  ├── advancedDiagnostics.js
│  │  │  ├── agentCommunicationService.js
│  │  │  ├── agentContext.js
│  │  │  ├── agentDevLog.js
│  │  │  ├── agentFeedbackService.js
│  │  │  ├── agentLauncherRegistry.js
│  │  │  ├── agentStatsService.js
│  │  │  ├── agenticHarnessService.js
│  │  │  ├── agnesImageModel.js
│  │  │  ├── agnesProvisioner.js
│  │  │  ├── aiChatPort.js
│  │  │  ├── aiConversationPort.js
│  │  │  ├── aiFrontendLocator.js
│  │  │  ├── aiLocalState.js
│  │  │  ├── aiManageDaemonLifecycle.js
│  │  │  ├── aiManagementChatHttp.js
│  │  │  ├── aiManagementConversationsPrompts.js
│  │  │  ├── aiManagementGatewayAdmin.js
│  │  │  ├── aiManagementKhyosWs.js
│  │  │  ├── aiManagementOpenaiCompat.js
│  │  │  ├── aiManagementProjects.js
│  │  │  ├── aiManagementProxyEgress.js
│  │  │  ├── aiManagementServer.js
│  │  │  ├── aiMonitor.js
│  │  │  ├── aiSessionPort.js
│  │  │  ├── aiUploadStore.js
│  │  │  ├── akshareDataService.js
│  │  │  ├── akshareUpdater.js
│  │  │  ├── alternativeDataService.js
│  │  │  ├── answerDirectionSynthesis.js
│  │  │  ├── answerEchoGuard.js
│  │  │  ├── answerVerifier.js
│  │  │  ├── anthropic
│  │  │  │  └── index.js
│  │  │  ├── anthropicProxyService.js
│  │  │  ├── antivirusService.js
│  │  │  ├── apiErrorFormatter.js
│  │  │  ├── apiKeyFormat.js
│  │  │  ├── apiKeyPool.js
│  │  │  ├── apiKeyPoolWatcher.js
│  │  │  ├── appLaunchRecovery.js
│  │  │  ├── appRegistry.js
│  │  │  ├── approvalLedger.js
│  │  │  ├── archiveInspectService.js
│  │  │  ├── archiveManifestPolicy.js
│  │  │  ├── arenaManager.js
│  │  │  ├── arenaResultStore.js
│  │  │  ├── asciiBox.js
│  │  │  ├── assistants
│  │  │  │  └── index.js
│  │  │  ├── auditLog.js
│  │  │  ├── authGuard.js
│  │  │  ├── authPolicy.js
│  │  │  ├── authSessionService.js
│  │  │  ├── authTimeFormat.js
│  │  │  ├── autoAnswerIntentGuard.js
│  │  │  ├── autoReasoning.js
│  │  │  ├── backgroundTaskLauncher.js
│  │  │  ├── backgroundTaskManager.js
│  │  │  ├── backgroundTaskSpec.js
│  │  │  ├── backslashContinuation.js
│  │  │  ├── backtestEngine.js
│  │  │  ├── baseSelfCheckService.js
│  │  │  ├── bashListingSummary.js
│  │  │  ├── batches
│  │  │  │  └── index.js
│  │  │  ├── benchmarkSuite.js
│  │  │  ├── binaryAnalyzer.js
│  │  │  ├── bootstrapBudget.js
│  │  │  ├── boulderState.js
│  │  │  ├── bugSentinel.js
│  │  │  ├── bugfixRegressionGate.js
│  │  │  ├── builtinGlmKey.js
│  │  │  ├── byteFormat.js
│  │  │  ├── cacheMetricsTruth.js
│  │  │  ├── cacheService.js
│  │  │  ├── caching
│  │  │  │  └── index.js
│  │  │  ├── canonicalState.js
│  │  │  ├── capabilityAssessment.js
│  │  │  ├── capabilityRegistry.js
│  │  │  ├── capacityFlow.js
│  │  │  ├── chainWasm.js
│  │  │  ├── changeRegressionGate.js
│  │  │  ├── changeWatchService.js
│  │  │  ├── changeWatchVerdict.js
│  │  │  ├── channelApiCrypto.js
│  │  │  ├── channelApiService.js
│  │  │  ├── characterizationSnapshot.js
│  │  │  ├── chatErrorGuard.js
│  │  │  ├── chatLatencyAutoTuner.js
│  │  │  ├── chunk_diff.js
│  │  │  ├── ciStatusService.js
│  │  │  ├── circuitBreaker.js
│  │  │  ├── clarificationCards.js
│  │  │  ├── claudeCompat.js
│  │  │  ├── cleanupService.js
│  │  │  ├── cliAgentRunner.js
│  │  │  ├── cliAnythingGenerator.js
│  │  │  ├── cliAnythingService.js
│  │  │  ├── cliAuthService.js
│  │  │  ├── cliErrorDescriptor.js
│  │  │  ├── cliToolSelfHeal.js
│  │  │  ├── cloudSync.js
│  │  │  ├── codeChangeStats.js
│  │  │  ├── codeCheckService.js
│  │  │  ├── codeLaziness.js
│  │  │  ├── codebaseIntentClassifier.js
│  │  │  ├── coherenceState.js
│  │  │  ├── commandDispatchPort.js
│  │  │  ├── commandOverlapAudit.js
│  │  │  ├── commandRiskClassifier.js
│  │  │  ├── commandSubstitutionContext.js
│  │  │  ├── commentGuidance.js
│  │  │  ├── commitMessageService.js
│  │  │  ├── commitmentTrack.js
│  │  │  ├── commitmentTracker.js
│  │  │  ├── compactionUiPort.js
│  │  │  ├── completionContract.js
│  │  │  ├── completionPushPolicy.js
│  │  │  ├── comprehensiveDataService.js
│  │  │  ├── compression
│  │  │  │  └── index.js
│  │  │  ├── concurrencyLimiter.js
│  │  │  ├── concurrencySlots.js
│  │  │  ├── configGuard.js
│  │  │  ├── configMigration.js
│  │  │  ├── configRepairPolicy.js
│  │  │  ├── configRepairService.js
│  │  │  ├── configSyncKeys.js
│  │  │  ├── configSyncService.js
│  │  │  ├── constraintLattice.js
│  │  │  ├── containers
│  │  │  │  └── index.js
│  │  │  ├── contentBlockUtils.js
│  │  │  ├── contextCompressor.js
│  │  │  ├── contextDiagnostics.js
│  │  │  ├── contextProfile.js
│  │  │  ├── contextPruner.js
│  │  │  ├── contextRouter.js
│  │  │  ├── contextWarningThreshold.js
│  │  │  ├── contextWasm.js
│  │  │  ├── contextWindowGuard.js
│  │  │  ├── controlRequestGuard.js
│  │  │  ├── conversationStore.js
│  │  │  ├── correctionPhraseCard.js
│  │  │  ├── correctionPhraseService.js
│  │  │  ├── costByModel.js
│  │  │  ├── crashRecovery.js
│  │  │  ├── crdt_engine.js
│  │  │  ├── credentialGenerator.js
│  │  │  ├── credentialLease
│  │  │  │  ├── index.js
│  │  │  │  ├── leaseBroker.js
│  │  │  │  ├── leaseClient.js
│  │  │  │  ├── leaseProtocol.js
│  │  │  │  └── providers.js
│  │  │  ├── credentialWatcherService.js
│  │  │  ├── cronScheduler.js
│  │  │  ├── cronStepGuard.js
│  │  │  ├── crossAgentTasteLearner.js
│  │  │  ├── crossModelVerify.js
│  │  │  ├── crossPlatform
│  │  │  │  ├── clients
│  │  │  │  │  └── terminalClient.js
│  │  │  │  ├── crossLauncher.js
│  │  │  │  ├── crossPlatformHub.js
│  │  │  │  ├── notifier.js
│  │  │  │  ├── protocol.js
│  │  │  │  ├── ws
│  │  │  │  │  ├── e2e-test.js
│  │  │  │  │  └── syncServer.js
│  │  │  │  └── wsClientCore.js
│  │  │  ├── cursor2apiIntegrationService.js
│  │  │  ├── customProviderRegistrar.js
│  │  │  ├── customProviderRegistry.js
│  │  │  ├── daemonEntry.js
│  │  │  ├── daemonManager.js
│  │  │  ├── daemonSpawnLocation.js
│  │  │  ├── dataCuration.js
│  │  │  ├── dbHealthService.js
│  │  │  ├── dedupeCache.js
│  │  │  ├── degenerateShellEcho.js
│  │  │  ├── deliveryFormatter.js
│  │  │  ├── deliveryGate.js
│  │  │  ├── deliveryGateReporter.js
│  │  │  ├── deliveryLedger.js
│  │  │  ├── deliverySummaryFormat.js
│  │  │  ├── deliveryValidator.js
│  │  │  ├── dependencyInventory.js
│  │  │  ├── deterministicFacts.js
│  │  │  ├── devCourseMonitor.js
│  │  │  ├── devicePairing.js
│  │  │  ├── diagnosticEvents.js
│  │  │  ├── diagnosticGrounding.js
│  │  │  ├── directiveComposer.js
│  │  │  ├── directiveParser.js
│  │  │  ├── directiveRegistryAudit.js
│  │  │  ├── diskAnalyzeCatalog.js
│  │  │  ├── diskAnalyzeReport.js
│  │  │  ├── diskCleanupClarify.js
│  │  │  ├── docHelper.py
│  │  │  ├── docInspect.py
│  │  │  ├── docTypeset.py
│  │  │  ├── documentConvertService.js
│  │  │  ├── documentSnippetService.js
│  │  │  ├── doomLoopGuard.js
│  │  │  ├── dynamicFreeModelService.js
│  │  │  ├── dynamicPromptAssembler.js
│  │  │  ├── editDiffPreview.js
│  │  │  ├── editReplacer.js
│  │  │  ├── embeddingClient.js
│  │  │  ├── endpoints
│  │  │  │  └── index.js
│  │  │  ├── enhancedMockDataService.js
│  │  │  ├── enhancedModelSelector.js
│  │  │  ├── entrypoints
│  │  │  │  ├── index.js
│  │  │  │  ├── launcher.js
│  │  │  │  ├── probe.js
│  │  │  │  └── registry.js
│  │  │  ├── envPlatform.js
│  │  │  ├── envProbes.js
│  │  │  ├── envRepair.js
│  │  │  ├── errorClassifier.js
│  │  │  ├── errorEnumerationGuard.js
│  │  │  ├── errorSolutionAdvisor.js
│  │  │  ├── evals
│  │  │  │  └── index.js
│  │  │  ├── evolutionPolicy.js
│  │  │  ├── evolutionSafety.js
│  │  │  ├── execApproval.js
│  │  │  ├── executionComplexitySignals.js
│  │  │  ├── expandModelService.js
│  │  │  ├── extendedEmbeddingProviders.js
│  │  │  ├── extensionMarketplace.js
│  │  │  ├── externalAgentDirective.js
│  │  │  ├── fableVoiceProfile.js
│  │  │  ├── falsePositiveFixGuard.js
│  │  │  ├── featureFlags.js
│  │  │  ├── featureKeyBuilder.js
│  │  │  ├── fetchExecuteGuard.js
│  │  │  ├── fetchTimeout.js
│  │  │  ├── fewShotInjector.js
│  │  │  ├── fileHistoryService.js
│  │  │  ├── fileIntegrityService.js
│  │  │  ├── fileSalience.js
│  │  │  ├── file_sync_bus.js
│  │  │  ├── files
│  │  │  │  └── index.js
│  │  │  ├── fineTuning
│  │  │  │  └── index.js
│  │  │  ├── finlightNewsService.js
│  │  │  ├── flagRegistry.js
│  │  │  ├── flowPriorityDirective.js
│  │  │  ├── flowsEngine.js
│  │  │  ├── followThroughGuard.js
│  │  │  ├── followupSuggestionService.js
│  │  │  ├── freeModelChannels.js
│  │  │  ├── freeStockDataService.js
│  │  │  ├── freshInstallDoctor.js
│  │  │  ├── fsReadErrorGuard.js
│  │  │  ├── functionTagToolCall.js
│  │  │  ├── futureProofing.js
│  │  │  ├── gateway
│  │  │  │  ├── _aiGatewayHelpers.js
│  │  │  │  ├── _envParse.js
│  │  │  │  ├── _gatewayHardDeadline.js
│  │  │  │  ├── _modelIdParse.js
│  │  │  │  ├── _streamHealthSink.js
│  │  │  │  ├── abortRaceArm.js
│  │  │  │  ├── adapterVisionCapability.js
│  │  │  │  ├── adapters
│  │  │  │  │  ├── _abortHelpers.js
│  │  │  │  │  ├── _adapterUtils.js
│  │  │  │  │  ├── _anthropicFormat.js
│  │  │  │  │  ├── _anthropicSseStream.js
│  │  │  │  │  ├── _cacheUsage.js
│  │  │  │  │  ├── _commandAvailability.js
│  │  │  │  │  ├── _cwStreamParser.js
│  │  │  │  │  ├── _endpointResolver.js
│  │  │  │  │  ├── _errorClassifiers.js
│  │  │  │  │  ├── _fingerprint.js
│  │  │  │  │  ├── _ideTokenMixin.js
│  │  │  │  │  ├── _imageCompat.js
│  │  │  │  │  ├── _imageTranscode.js
│  │  │  │  │  ├── _messageBuilder.js
│  │  │  │  │  ├── _openaiSseStream.js
│  │  │  │  │  ├── _protocolPipeline.js
│  │  │  │  │  ├── _protocolRegistry.js
│  │  │  │  │  ├── _proxyTunnel.js
│  │  │  │  │  ├── _responseBuilder.js
│  │  │  │  │  ├── _responsesFormat.js
│  │  │  │  │  ├── _responsesSseStream.js
│  │  │  │  │  ├── _retryWithBackoff.js
│  │  │  │  │  ├── _sseParser.js
│  │  │  │  │  ├── _sseTextDecoder.js
│  │  │  │  │  ├── _streamProcessor.js
│  │  │  │  │  ├── _streamStaleDetector.js
│  │  │  │  │  ├── _toolSchemaConverter.js
│  │  │  │  │  ├── adaptiveParamStrip.js
│  │  │  │  │  ├── anthropicRelayPresets.js
│  │  │  │  │  ├── apiAdapter.js
│  │  │  │  │  ├── ccEnvAdoptPolicy.js
│  │  │  │  │  ├── claudeAdapter.js
│  │  │  │  │  ├── cliToolAdapter.js
│  │  │  │  │  ├── clipboardRelayAdapter.js
│  │  │  │  │  ├── codexAdapter.js
│  │  │  │  │  ├── codexCredentialProbe.js
│  │  │  │  │  ├── codexEnvAdoptPolicy.js
│  │  │  │  │  ├── codexEventStream.js
│  │  │  │  │  ├── commandCodeAdapter.js
│  │  │  │  │  ├── commandCodeInvocation.js
│  │  │  │  │  ├── cursor2apiAdapter.js
│  │  │  │  │  ├── cursorAdapter.js
│  │  │  │  │  ├── ideDetector.js
│  │  │  │  │  ├── ipAnonymizer.js
│  │  │  │  │  ├── kiroAdapter.js
│  │  │  │  │  ├── localLLMAdapter.js
│  │  │  │  │  ├── ollamaAdapter.js
│  │  │  │  │  ├── openaiRelayPresets.js
│  │  │  │  │  ├── openclawAdapter.js
│  │  │  │  │  ├── openclawInvocation.js
│  │  │  │  │  ├── opencodeAdapter.js
│  │  │  │  │  ├── opencodeBinResolver.js
│  │  │  │  │  ├── opencodeInvocation.js
│  │  │  │  │  ├── portableAdapterSpawn.js
│  │  │  │  │  ├── portableCliInstaller.js
│  │  │  │  │  ├── portableCliRegistry.js
│  │  │  │  │  ├── portableCliResolver.js
│  │  │  │  │  ├── relayApiAdapter.js
│  │  │  │  │  ├── streamErrorPartial.js
│  │  │  │  │  ├── streamStallPolicy.js
│  │  │  │  │  ├── traeAdapter.js
│  │  │  │  │  ├── traeOfficialArtifacts.js
│  │  │  │  │  ├── vscodeAdapter.js
│  │  │  │  │  ├── warpAdapter.js
│  │  │  │  │  └── webRelayAdapter.js
│  │  │  │  ├── agentModelProjection.js
│  │  │  │  ├── aiGateway.js
│  │  │  │  ├── aiGatewayCooldownMethods.js
│  │  │  │  ├── aiGatewayGenerateMethod.README.html
│  │  │  │  ├── aiGatewayGenerateMethod.README.md
│  │  │  │  ├── aiGatewayGenerateMethod.js
│  │  │  │  ├── aiGatewayGenerateMethod.test.js
│  │  │  │  ├── aiGatewayModelMethods.js
│  │  │  │  ├── aiGatewayRoutingMethods.js
│  │  │  │  ├── appLaunchInterceptor.js
│  │  │  │  ├── attachmentFailurePolicy.js
│  │  │  │  ├── autoModelRouting.js
│  │  │  │  ├── autoModelSelect.js
│  │  │  │  ├── breakCacheState.js
│  │  │  │  ├── buildChannelFailureAdvice.js
│  │  │  │  ├── builtinProviderConfig.js
│  │  │  │  ├── cacheEconomyStore.js
│  │  │  │  ├── capabilityModelKey.js
│  │  │  │  ├── capabilityRegistry.js
│  │  │  │  ├── cascadeModelScope.js
│  │  │  │  ├── channelHealthBroadcaster.js
│  │  │  │  ├── cliFailureEnvelope.js
│  │  │  │  ├── codexStallPolicy.js
│  │  │  │  ├── corsUtils.js
│  │  │  │  ├── credential-harvester.js
│  │  │  │  ├── credentialRefreshCoordinator.js
│  │  │  │  ├── customProviderVision.js
│  │  │  │  ├── customerQuotaEnforcer.js
│  │  │  │  ├── customerRegistry.js
│  │  │  │  ├── desktopIntentInterceptor.js
│  │  │  │  ├── errorContract.js
│  │  │  │  ├── failoverOrderStore.js
│  │  │  │  ├── failureExplainer.js
│  │  │  │  ├── failureReasonRanking.js
│  │  │  │  ├── gatewayAdapterLabels.js
│  │  │  │  ├── gatewayConstants.js
│  │  │  │  ├── gatewayErrorClassifier.js
│  │  │  │  ├── gatewayGuide.js
│  │  │  │  ├── gatewayIdleProgressPolicy.js
│  │  │  │  ├── glmVisionApiPin.js
│  │  │  │  ├── glmVisionImageDownscale.js
│  │  │  │  ├── glmVisionMaxTokens.js
│  │  │  │  ├── glmVisionModel.js
│  │  │  │  ├── glmVisionTextBudget.js
│  │  │  │  ├── imageOcrFallbackPolicy.js
│  │  │  │  ├── inlineImageOcrGuardPolicy.js
│  │  │  │  ├── keySelector.js
│  │  │  │  ├── keyStrategyDict.js
│  │  │  │  ├── lastVerifiedModelStore.js
│  │  │  │  ├── localOllamaProbe.js
│  │  │  │  ├── manualRelayAutoFallbackPolicy.js
│  │  │  │  ├── maxTokensPolicy.js
│  │  │  │  ├── modelCapability.js
│  │  │  │  ├── modelCatalogGraph.js
│  │  │  │  ├── modelCatalogPivots.js
│  │  │  │  ├── modelCuration.js
│  │  │  │  ├── modelDiscovery.js
│  │  │  │  ├── modelExistenceEvidence.js
│  │  │  │  ├── modelHealthLedger.js
│  │  │  │  ├── modelListTruth.js
│  │  │  │  ├── modelNotFoundCooldownScope.js
│  │  │  │  ├── modelNotFoundRecovery.js
│  │  │  │  ├── modelRouter.js
│  │  │  │  ├── modelSubstitutionNotice.js
│  │  │  │  ├── modelToolingCapability.js
│  │  │  │  ├── modernVisionHints.js
│  │  │  │  ├── oauthManager.js
│  │  │  │  ├── ocrConfidenceCaveat.js
│  │  │  │  ├── ocrCoverageNotice.js
│  │  │  │  ├── ocrLanguageNotice.js
│  │  │  │  ├── ocrOrientationNotice.js
│  │  │  │  ├── ocrRescueStatusNotice.js
│  │  │  │  ├── ocrResolutionNotice.js
│  │  │  │  ├── ocrTruncationNotice.js
│  │  │  │  ├── ocrUsageFootnote.js
│  │  │  │  ├── ocrUsageNotice.js
│  │  │  │  ├── paymentGatewayService.js
│  │  │  │  ├── plainTextImageDegrade.js
│  │  │  │  ├── pluginChain.js
│  │  │  │  ├── protocolConverter
│  │  │  │  │  └── index.js
│  │  │  │  ├── providerConnectivitySpec.js
│  │  │  │  ├── providerConnectivityTester.js
│  │  │  │  ├── providerPresets.js
│  │  │  │  ├── proxyServer.js
│  │  │  │  ├── qoderProxyModels.js
│  │  │  │  ├── recentModelsStore.js
│  │  │  │  ├── redisHealthStore.js
│  │  │  │  ├── redisRateLimiter.js
│  │  │  │  ├── refusalRecovery.js
│  │  │  │  ├── relayModelGuard.js
│  │  │  │  ├── relayPage.js
│  │  │  │  ├── relayVendorMismatchGuard.js
│  │  │  │  ├── requestDedup.js
│  │  │  │  ├── responseSessionStore.js
│  │  │  │  ├── routeFact.js
│  │  │  │  ├── routeLatencyPenalty.js
│  │  │  │  ├── routeLatencyStore.js
│  │  │  │  ├── runtimeDiagnosticsStore.js
│  │  │  │  ├── safeJsonParse.js
│  │  │  │  ├── scaleToZeroPolicy.js
│  │  │  │  ├── selfHealingWrapper.js
│  │  │  │  ├── serverErrorCooldownScope.js
│  │  │  │  ├── tlsSidecar
│  │  │  │  │  ├── index.js
│  │  │  │  │  ├── installer.js
│  │  │  │  │  └── sidecar.go
│  │  │  │  ├── toolCallingProbe.js
│  │  │  │  ├── toolCapabilityStore.js
│  │  │  │  ├── toolChallengeCadence.js
│  │  │  │  ├── traffic-integration.js
│  │  │  │  ├── traffic-logger.js
│  │  │  │  ├── traffic-stream.js
│  │  │  │  ├── ucbRouter.js
│  │  │  │  ├── upstreamModelProbe.js
│  │  │  │  ├── vertexRequestShaping.js
│  │  │  │  ├── visionCapability.js
│  │  │  │  ├── visionCapabilityProbe.js
│  │  │  │  ├── visionCapabilityStore.js
│  │  │  │  ├── visionCascadeAttemptNotice.js
│  │  │  │  ├── visionDenialCorrection.js
│  │  │  │  ├── visionDescribeReturn.js
│  │  │  │  ├── visionDirectTurnPolicy.js
│  │  │  │  ├── visionExhaustionDiagnostic.js
│  │  │  │  ├── visionFailureSummary.js
│  │  │  │  ├── visionFallbackCandidates.js
│  │  │  │  ├── visionGenerationExclusion.js
│  │  │  │  ├── visionModelDisplayName.js
│  │  │  │  ├── visionOcrFallback.js
│  │  │  │  ├── visionOcrSuccessClosure.js
│  │  │  │  ├── visionPoolFailStatus.js
│  │  │  │  ├── visionRouting.js
│  │  │  │  ├── webSearchInterceptor.js
│  │  │  │  ├── wildcardPoolGuard.js
│  │  │  │  └── zhipuFreeModels.js
│  │  │  ├── gatewayEnvFile.js
│  │  │  ├── gatewayIdleTimeoutPolicy.js
│  │  │  ├── gatewayResetPolicy.js
│  │  │  ├── gatewayResetService.js
│  │  │  ├── geolocationService.js
│  │  │  ├── gettingStartedService.js
│  │  │  ├── gitContextService.js
│  │  │  ├── gitExecutableDetector.js
│  │  │  ├── gitExecutableResolver.js
│  │  │  ├── gitOperationTracker.js
│  │  │  ├── gitSpawnHelper.js
│  │  │  ├── gitSpawnPlan.js
│  │  │  ├── gitTrackWhitelist.js
│  │  │  ├── gitignoreAdvisor.js
│  │  │  ├── gitignoreReviewStore.js
│  │  │  ├── gitignoreService.js
│  │  │  ├── globDoublestarAnchor.js
│  │  │  ├── goalCore.js
│  │  │  ├── goalEndurance.js
│  │  │  ├── goalKickoff.js
│  │  │  ├── goalModeService.js
│  │  │  ├── goalStopGate.js
│  │  │  ├── goalStore.js
│  │  │  ├── googleGenAI
│  │  │  │  └── index.js
│  │  │  ├── grepWindowsDriveKey.js
│  │  │  ├── groundTruth.js
│  │  │  ├── growthService.js
│  │  │  ├── guardApproval.js
│  │  │  ├── hardwareProfileService.js
│  │  │  ├── healAuditService.js
│  │  │  ├── healEscalationService.js
│  │  │  ├── heartbeatCooldown.js
│  │  │  ├── heartbeatService.js
│  │  │  ├── heuristic.js
│  │  │  ├── honestFailureReason.js
│  │  │  ├── htmlEntityCodePointGuard.js
│  │  │  ├── imageContextCard.js
│  │  │  ├── imageContextCardService.js
│  │  │  ├── imageGenFailureSummary.js
│  │  │  ├── imageGenPoolBridge.js
│  │  │  ├── imageGenProviders
│  │  │  │  └── index.js
│  │  │  ├── imageGenService.js
│  │  │  ├── imageGenUserPref.js
│  │  │  ├── imageMetadataProbe.js
│  │  │  ├── imageService.js
│  │  │  ├── imageToWebService.js
│  │  │  ├── inertia
│  │  │  │  ├── defaults.js
│  │  │  │  ├── inertialRunService.js
│  │  │  │  ├── momentum.js
│  │  │  │  └── planSchema.js
│  │  │  ├── inputPreprocessor.js
│  │  │  ├── inputSanitizer.js
│  │  │  ├── instructionEcosystemRegistry.js
│  │  │  ├── instructionExternalIncludes.js
│  │  │  ├── instructionFileService.js
│  │  │  ├── instructionIncludeBoundary.js
│  │  │  ├── instructionReviewStore.js
│  │  │  ├── instrumentService.js
│  │  │  ├── instrumentSyncService.js
│  │  │  ├── intentCoverage.js
│  │  │  ├── intentGate.js
│  │  │  ├── intentHeuristics.js
│  │  │  ├── interactiveMenuPort.js
│  │  │  ├── interruptionMarker.js
│  │  │  ├── jsDataSources.js
│  │  │  ├── keyHealthProbe.js
│  │  │  ├── keyUpdateFlow.js
│  │  │  ├── khyAnythingProxy.js
│  │  │  ├── khySelfUpdateService.js
│  │  │  ├── khyUpgradeRuntime.js
│  │  │  ├── khyosAgentChannel.js
│  │  │  ├── klineDataService.js
│  │  │  ├── knowledgeTeachingService.js
│  │  │  ├── latestUserText.js
│  │  │  ├── latestVersionResolver.js
│  │  │  ├── launchOutcome.js
│  │  │  ├── lazyLoader.js
│  │  │  ├── learningCurriculum.js
│  │  │  ├── learningCurriculumDynamic.js
│  │  │  ├── learningImprove.js
│  │  │  ├── learningOverlay.js
│  │  │  ├── learningProfile.js
│  │  │  ├── learningRetrieval.js
│  │  │  ├── listingParse.js
│  │  │  ├── liveModelSwitch.js
│  │  │  ├── llmGenerateSink.js
│  │  │  ├── llmService.js
│  │  │  ├── localBrainCalc.js
│  │  │  ├── localBrainEnvOptimize.js
│  │  │  ├── localBrainExternalApi.js
│  │  │  ├── localBrainFileLookup.js
│  │  │  ├── localBrainImageView.js
│  │  │  ├── localBrainProviderConfig.js
│  │  │  ├── localBrainService.js
│  │  │  ├── localBrainSessionContext.js
│  │  │  ├── localBrainTextOps.js
│  │  │  ├── localChatAdapters.js
│  │  │  ├── localExecutionPlanner.js
│  │  │  ├── localFormat.js
│  │  │  ├── localLLMService.js
│  │  │  ├── localMemoryRecall.js
│  │  │  ├── localNlp.js
│  │  │  ├── localReasoning.js
│  │  │  ├── localTemplates.js
│  │  │  ├── localToolLoop.js
│  │  │  ├── localWebSolver.js
│  │  │  ├── lrtaBackfill.js
│  │  │  ├── lspClient.js
│  │  │  ├── maintainerCockpit.js
│  │  │  ├── manageDbBootstrap.js
│  │  │  ├── marketDataService.js
│  │  │  ├── mathSolvePolicy.js
│  │  │  ├── mdEditorRegister.js
│  │  │  ├── mdSuggestedAppsPlan.js
│  │  │  ├── mediaTranscriptionService.js
│  │  │  ├── mediaUnderstanding.js
│  │  │  ├── memoryBridge.js
│  │  │  ├── memoryCompressor.js
│  │  │  ├── memoryContentDedup.js
│  │  │  ├── memoryDreamEnhancer.js
│  │  │  ├── memoryDreaming.js
│  │  │  ├── memoryKairos.js
│  │  │  ├── memoryLifecycle.js
│  │  │  ├── memoryOpsNotice.js
│  │  │  ├── memoryStaleness.js
│  │  │  ├── memoryTier.js
│  │  │  ├── memoryTrigger.js
│  │  │  ├── memoryWriteSafety.js
│  │  │  ├── meshCore.js
│  │  │  ├── meshStore.js
│  │  │  ├── messageTokenTally.js
│  │  │  ├── metaToolEngine.js
│  │  │  ├── metadataHook.js
│  │  │  ├── metadataPointers.js
│  │  │  ├── mlAgentService.js
│  │  │  ├── moaAggregation.js
│  │  │  ├── moaService.js
│  │  │  ├── modelAdaptationHttp.js
│  │  │  ├── modelCapabilityPort.js
│  │  │  ├── modelDiscoveryEngine.js
│  │  │  ├── modelEscalationPolicy.js
│  │  │  ├── modelFeatureRegistry.js
│  │  │  ├── modelIdentityTruth.js
│  │  │  ├── modelImportService.js
│  │  │  ├── modelMesh.js
│  │  │  ├── modelRouter
│  │  │  │  └── index.js
│  │  │  ├── modelSwitchManager.js
│  │  │  ├── modelTier.js
│  │  │  ├── modelTrainingService.js
│  │  │  ├── models
│  │  │  │  └── index.js
│  │  │  ├── modernKeyRedaction.js
│  │  │  ├── multiFreeService.js
│  │  │  ├── multiTerminalBackend.js
│  │  │  ├── multimodalInputService.js
│  │  │  ├── multimodalIntentRouter.js
│  │  │  ├── ndjsonStream.js
│  │  │  ├── networkDetector.js
│  │  │  ├── networkHealthMonitor.js
│  │  │  ├── newsContentFetcher.js
│  │  │  ├── notificationPort.js
│  │  │  ├── notificationService.js
│  │  │  ├── notifier.py
│  │  │  ├── ocrProviders
│  │  │  │  └── index.js
│  │  │  ├── ocrSnippetService.js
│  │  │  ├── offlineKnowledge.js
│  │  │  ├── ollamaModelManager.js
│  │  │  ├── operationTaskClassifier.js
│  │  │  ├── orchestrationFlow.js
│  │  │  ├── osProfileService.js
│  │  │  ├── outputIntegrityMonitor.js
│  │  │  ├── ownerControlService.js
│  │  │  ├── packageRegistryService.js
│  │  │  ├── parameterNormalizationEngine.js
│  │  │  ├── passthrough
│  │  │  │  └── index.js
│  │  │  ├── payloadProvisioner.js
│  │  │  ├── perRequestAdaptationPipeline.js
│  │  │  ├── performanceSampler.js
│  │  │  ├── permissionBroker.js
│  │  │  ├── permissionFallback.js
│  │  │  ├── permissionOptionOrder.js
│  │  │  ├── permissionPromptPort.js
│  │  │  ├── permissionStore.js
│  │  │  ├── personaService.js
│  │  │  ├── pipFailurePolicy.js
│  │  │  ├── pipResiduePolicy.js
│  │  │  ├── pipelineOrchestrator.js
│  │  │  ├── planModeDirective.js
│  │  │  ├── planModeService.js
│  │  │  ├── planModeSink.js
│  │  │  ├── platformCapabilities.js
│  │  │  ├── platformRewrite.js
│  │  │  ├── playwrightSearch.js
│  │  │  ├── pluginDoctorPort.js
│  │  │  ├── portableSyncRules.js
│  │  │  ├── portableSyncService.js
│  │  │  ├── postEditDiagnostics.js
│  │  │  ├── postEditDiagnosticsSummary.js
│  │  │  ├── prCommentsService.js
│  │  │  ├── prCreateService.js
│  │  │  ├── precommitCheck.js
│  │  │  ├── preferenceSignals.js
│  │  │  ├── preflightPermission.js
│  │  │  ├── priorityTaxonomy.js
│  │  │  ├── procedureCatalog.js
│  │  │  ├── progressiveProgress.js
│  │  │  ├── projectAnalysis
│  │  │  │  └── projectMapService.js
│  │  │  ├── projectBoundaryAnchor.js
│  │  │  ├── projectMemoryService.js
│  │  │  ├── projectMetadataService.js
│  │  │  ├── projectStore.js
│  │  │  ├── projectTemplateService.js
│  │  │  ├── promptAssemblyService.js
│  │  │  ├── promptAutoCapture.js
│  │  │  ├── promptCacheOptimizer.js
│  │  │  ├── promptCacheService.js
│  │  │  ├── promptComposer.js
│  │  │  ├── promptComposerService.js
│  │  │  ├── promptIntentRepair.js
│  │  │  ├── promptLibraryService.js
│  │  │  ├── promptReuseService.js
│  │  │  ├── promptReuseStore.js
│  │  │  ├── promptStore.js
│  │  │  ├── promptStructurer.js
│  │  │  ├── promptTemplateCatalog.js
│  │  │  ├── protocolArbitration.js
│  │  │  ├── proxyConfigService.js
│  │  │  ├── proxyNodeParse.js
│  │  │  ├── proxySubscriptionStore.js
│  │  │  ├── proxyUriHelpers.js
│  │  │  ├── proxyUriParsers.js
│  │  │  ├── pushConfigStore.js
│  │  │  ├── pushNotifyCore.js
│  │  │  ├── pythonDataSourceService.js
│  │  │  ├── pythonStrategyEngine.js
│  │  │  ├── queryEngine.js
│  │  │  ├── questionQuality.js
│  │  │  ├── quickTaskService.js
│  │  │  ├── ragRetrievalService.js
│  │  │  ├── rateLimiter.js
│  │  │  ├── realtime
│  │  │  │  └── index.js
│  │  │  ├── realtimeDataService.js
│  │  │  ├── receiptService.js
│  │  │  ├── recentTurnsSplit.js
│  │  │  ├── referenceDisambiguation.js
│  │  │  ├── referencesService.js
│  │  │  ├── repeatedPromptRounds.js
│  │  │  ├── replyDedup.js
│  │  │  ├── replyGuard.js
│  │  │  ├── repoDisciplineRisk.js
│  │  │  ├── reportKhyError.js
│  │  │  ├── repositories
│  │  │  │  └── index.js
│  │  │  ├── requirementArtifact.js
│  │  │  ├── requirementIntakeService.js
│  │  │  ├── rerank
│  │  │  │  └── index.js
│  │  │  ├── resourceGuard.js
│  │  │  ├── responses
│  │  │  │  └── index.js
│  │  │  ├── restoreAgentService.js
│  │  │  ├── restoreArchiveExtractCheck.js
│  │  │  ├── restoreCompletenessCheck.js
│  │  │  ├── restorePathPortabilityCheck.js
│  │  │  ├── restorePreflightCheck.js
│  │  │  ├── restoreProvenanceCheck.js
│  │  │  ├── resumeAdvisor.js
│  │  │  ├── retrySleepCleanup.js
│  │  │  ├── retryWithBackoff.js
│  │  │  ├── reversibility.js
│  │  │  ├── rewindResume.js
│  │  │  ├── riskGate.js
│  │  │  ├── roleService.js
│  │  │  ├── rollbackService.js
│  │  │  ├── roundAdvanceAssessor.js
│  │  │  ├── rtkEffectiveState.js
│  │  │  ├── rtkInstaller.js
│  │  │  ├── rtkMode.js
│  │  │  ├── runtimeProvisioner.js
│  │  │  ├── salvageSummaryFocus.js
│  │  │  ├── samplingPolicy.js
│  │  │  ├── sandbox
│  │  │  │  └── index.js
│  │  │  ├── scaffoldExtractor.js
│  │  │  ├── seamManager.js
│  │  │  ├── searchProviders
│  │  │  │  └── index.js
│  │  │  ├── searchTokenizer.js
│  │  │  ├── secretManagers
│  │  │  │  └── index.js
│  │  │  ├── securityGuardService.js
│  │  │  ├── selfAuditRegistry.js
│  │  │  ├── selfAuditVerifier.js
│  │  │  ├── selfCapabilityRegistry.js
│  │  │  ├── selfCapabilityVerifier.js
│  │  │  ├── selfEditAdvisory.js
│  │  │  ├── selfEditAdvisoryService.js
│  │  │  ├── selfEditWatcher.js
│  │  │  ├── selfEvidenceVerifier.js
│  │  │  ├── selfLocation.js
│  │  │  ├── selfOptimizer.js
│  │  │  ├── selfProfile.js
│  │  │  ├── selfRepairTransaction.js
│  │  │  ├── semanticProjection.js
│  │  │  ├── sensitiveHomeCaseFold.js
│  │  │  ├── sequentialQueue.js
│  │  │  ├── serviceLifecyclePolicy.js
│  │  │  ├── serviceRegistry.js
│  │  │  ├── serviceStatsSink.js
│  │  │  ├── sessionChecklistResetPolicy.js
│  │  │  ├── sessionChecklistResetService.js
│  │  │  ├── sessionFileRepair.js
│  │  │  ├── sessionForestPort.js
│  │  │  ├── sessionInsights.js
│  │  │  ├── sessionPersistence.js
│  │  │  ├── sessionRecapCjk.js
│  │  │  ├── sessionRecapService.js
│  │  │  ├── sessionSearchIndex.js
│  │  │  ├── sessionSourcePort.js
│  │  │  ├── sessionTitleService.js
│  │  │  ├── sessionTraceSummary.js
│  │  │  ├── sessionWatchdog.js
│  │  │  ├── session_registry.js
│  │  │  ├── shellSafetyValidator.js
│  │  │  ├── shellTimeoutClamp.js
│  │  │  ├── shellToToolMapper.js
│  │  │  ├── skillCuratorService.js
│  │  │  ├── skillInstallService.js
│  │  │  ├── skillLearningService.js
│  │  │  ├── skillPackageService.js
│  │  │  ├── skillRegistry.js
│  │  │  ├── skillSearch.js
│  │  │  ├── skillStateService.js
│  │  │  ├── skillVersionSync.js
│  │  │  ├── smallModelPromptTemplates.js
│  │  │  ├── smartTruncation.js
│  │  │  ├── sourceHealPolicy.js
│  │  │  ├── sourceHealService.js
│  │  │  ├── sourceSnapshotCrypto.js
│  │  │  ├── sqliteBackupService.js
│  │  │  ├── sseBackpressure.js
│  │  │  ├── sseKeepalive.js
│  │  │  ├── ssrfGuard.js
│  │  │  ├── stepAnchorStore.js
│  │  │  ├── stockAnalysisEngine.js
│  │  │  ├── strategyEngine.js
│  │  │  ├── strategyRecommender.js
│  │  │  ├── streamUsageOptions.js
│  │  │  ├── sttProviders
│  │  │  │  └── index.js
│  │  │  ├── subAgentModelSelect.js
│  │  │  ├── subAgentOrchestrator.js
│  │  │  ├── subAgentResultFooter.js
│  │  │  ├── subAgentTextStream.js
│  │  │  ├── subagentContextSummary.js
│  │  │  ├── subscriptionService.js
│  │  │  ├── subscriptionUserinfo.js
│  │  │  ├── syntheticToolLayer.js
│  │  │  ├── systemIntegration.js
│  │  │  ├── systemSettingService.js
│  │  │  ├── taskCleanupPolicy.js
│  │  │  ├── taskCleanupService.js
│  │  │  ├── taskClosure.js
│  │  │  ├── taskComplexity.js
│  │  │  ├── taskControlService.js
│  │  │  ├── taskDecomposer.js
│  │  │  ├── taskPanelState.js
│  │  │  ├── taskScale.js
│  │  │  ├── taskScheduler.js
│  │  │  ├── taskTemplates.js
│  │  │  ├── tasteService.js
│  │  │  ├── tasteWatchService.js
│  │  │  ├── tdxFormulaEngine.js
│  │  │  ├── teachingService.js
│  │  │  ├── telemetryService.js
│  │  │  ├── terminalLaunchCommand.js
│  │  │  ├── testWritingPolicy.js
│  │  │  ├── textHeuristics.js
│  │  │  ├── timeFormat.js
│  │  │  ├── tipHistoryStore.js
│  │  │  ├── tipScheduler.js
│  │  │  ├── todoStateStorePaths.js
│  │  │  ├── todoStorePath.js
│  │  │  ├── tokenBudget.js
│  │  │  ├── tokenBudgetNudge.js
│  │  │  ├── tokenPricing.js
│  │  │  ├── tokenUsageService.js
│  │  │  ├── tool
│  │  │  │  ├── httpEncoding.js
│  │  │  │  ├── loop
│  │  │  │  │  ├── approval.js
│  │  │  │  │  ├── diagnostics.js
│  │  │  │  │  ├── format.js
│  │  │  │  │  ├── interrupt.js
│  │  │  │  │  ├── iterations.js
│  │  │  │  │  ├── naturalActions.js
│  │  │  │  │  ├── recovery.js
│  │  │  │  │  ├── repeatStreak.js
│  │  │  │  │  ├── salvage.js
│  │  │  │  │  ├── steering.js
│  │  │  │  │  ├── toolCallTally.js
│  │  │  │  │  ├── toolNames.js
│  │  │  │  │  ├── toolOutput.js
│  │  │  │  │  ├── toolSets.js
│  │  │  │  │  └── usage.js
│  │  │  │  ├── searchFailureSignal.js
│  │  │  │  ├── toolAccessGateway.js
│  │  │  │  ├── toolCallColonKvAnchor.js
│  │  │  │  ├── toolCallCorrection.js
│  │  │  │  ├── toolCallEqualsKvGuard.js
│  │  │  │  ├── toolCallEqualsKvSplit.js
│  │  │  │  ├── toolCallNudges.js
│  │  │  │  ├── toolCallParser.js
│  │  │  │  ├── toolCalling.js
│  │  │  │  ├── toolCallingAppLaunch.js
│  │  │  │  ├── toolCallingBuiltins.js
│  │  │  │  ├── toolCallingPermissions.js
│  │  │  │  ├── toolClusterActivation.js
│  │  │  │  ├── toolDataSummary.js
│  │  │  │  ├── toolError.js
│  │  │  │  ├── toolErrorCodes.js
│  │  │  │  ├── toolExecutionEngine.js
│  │  │  │  ├── toolExecutionMetrics.js
│  │  │  │  ├── toolFailureRecovery.js
│  │  │  │  ├── toolGuards.js
│  │  │  │  ├── toolLoopDetector.js
│  │  │  │  ├── toolLoopJournal.js
│  │  │  │  ├── toolMetricsAggregator.js
│  │  │  │  ├── toolOutcomeSeverity.js
│  │  │  │  ├── toolParamNaming.js
│  │  │  │  ├── toolProgressAggregator.js
│  │  │  │  ├── toolProtocolAdapter.js
│  │  │  │  ├── toolRegistryDedup.js
│  │  │  │  ├── toolResultCompressor.js
│  │  │  │  ├── toolSandbox.js
│  │  │  │  ├── toolSpec.js
│  │  │  │  ├── toolTierCatalog.js
│  │  │  │  ├── toolUseLoop.js
│  │  │  │  ├── toolUseLoopCore.js
│  │  │  │  └── toolUseLoopHelpers.js
│  │  │  ├── toolAccessGateway.js
│  │  │  ├── toolCallColonKvAnchor.js
│  │  │  ├── toolCallCorrection.js
│  │  │  ├── toolCallEqualsKvGuard.js
│  │  │  ├── toolCallEqualsKvSplit.js
│  │  │  ├── toolCallNudges.js
│  │  │  ├── toolCallParser.js
│  │  │  ├── toolCalling.js
│  │  │  ├── toolCallingAppLaunch.js
│  │  │  ├── toolCallingBuiltins.js
│  │  │  ├── toolCallingPermissions.js
│  │  │  ├── toolClusterActivation.js
│  │  │  ├── toolDataSummary.js
│  │  │  ├── toolError.js
│  │  │  ├── toolErrorCodes.js
│  │  │  ├── toolExecutionEngine.js
│  │  │  ├── toolExecutionMetrics.js
│  │  │  ├── toolFailureRecovery.js
│  │  │  ├── toolGuards.js
│  │  │  ├── toolLoopDetector.js
│  │  │  ├── toolLoopJournal.js
│  │  │  ├── toolMetricsAggregator.js
│  │  │  ├── toolParamNaming.js
│  │  │  ├── toolProgressAggregator.js
│  │  │  ├── toolProtocolAdapter.js
│  │  │  ├── toolRegistryDedup.js
│  │  │  ├── toolResultCompressor.js
│  │  │  ├── toolSandbox.js
│  │  │  ├── toolSpec.js
│  │  │  ├── toolTierCatalog.js
│  │  │  ├── toolUseLoop.js
│  │  │  ├── toolUseLoopCore.js
│  │  │  ├── toolUseLoopHelpers.js
│  │  │  ├── traceAuditService.js
│  │  │  ├── tradingAgentsService.js
│  │  │  ├── trainingDataService.js
│  │  │  ├── trajectoryStatsStore.js
│  │  │  ├── transcriptRepair.js
│  │  │  ├── transparencyService.js
│  │  │  ├── ttsProviders
│  │  │  │  └── index.js
│  │  │  ├── tuiSelfHeal.js
│  │  │  ├── turnCheckpointService.js
│  │  │  ├── turnEventStandardizer.js
│  │  │  ├── twentyXMode.js
│  │  │  ├── ultraplanService.js
│  │  │  ├── unattendedAutoAnswer.js
│  │  │  ├── unknownExploration.js
│  │  │  ├── unknownProblemHandler.js
│  │  │  ├── unsupportedGuide.js
│  │  │  ├── updateChannelRouter.js
│  │  │  ├── updateCoordinator.js
│  │  │  ├── updateIndexProtocol.js
│  │  │  ├── updateProgressRenderer.js
│  │  │  ├── upstreamStudyCatalog.js
│  │  │  ├── upstreamStudyPlan.js
│  │  │  ├── upstreamStudyReport.js
│  │  │  ├── urlSafety.js
│  │  │  ├── usageFormatter.js
│  │  │  ├── usageHabitService.js
│  │  │  ├── usageTokenCountShape.js
│  │  │  ├── usageTracker.js
│  │  │  ├── userLogService.js
│  │  │  ├── userProfile.js
│  │  │  ├── vaultCore.js
│  │  │  ├── vaultStore.js
│  │  │  ├── vectorStore
│  │  │  │  └── index.js
│  │  │  ├── verificationAgent.js
│  │  │  ├── versionService.js
│  │  │  ├── videoGenPoolBridge.js
│  │  │  ├── videoGenProviders
│  │  │  │  └── index.js
│  │  │  ├── videoGenService.js
│  │  │  ├── visionRoutingTruth.js
│  │  │  ├── voiceInputService.js
│  │  │  ├── voiceService.js
│  │  │  ├── wasmAppService.js
│  │  │  ├── watchdogService.js
│  │  │  ├── weakModelChangeGuard.js
│  │  │  ├── weakModelGuidance.js
│  │  │  ├── webFetchDecode.js
│  │  │  ├── webSearchService.js
│  │  │  ├── webToolsService.js
│  │  │  ├── whatever.js
│  │  │  ├── winAppPaths.js
│  │  │  ├── windowsClipboardImg2FileService.js
│  │  │  ├── workspaceGitInit.js
│  │  │  ├── workspaceGitInitPolicy.js
│  │  │  ├── workspaceGitInitWizardPolicy.js
│  │  │  ├── workspaceTrust.js
│  │  │  ├── worktreeManager.js
│  │  │  ├── worktreeSessionCwd.js
│  │  │  ├── zenGatekeeper.js
│  │  │  ├── zhipuGlmModel.js
│  │  │  └── zhipuRequestShape.js
│  │  ├── skills
│  │  │  ├── built-in
│  │  │  │  ├── api-and-interface-design
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── batch
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── browser-testing-with-devtools
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── ci-cd-and-automation
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── claude-api
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── code-review-and-quality
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  ├── prompt.md
│  │  │  │  │  └── references
│  │  │  │  │     ├── performance-checklist.html
│  │  │  │  │     ├── performance-checklist.md
│  │  │  │  │     ├── security-checklist.html
│  │  │  │  │     └── security-checklist.md
│  │  │  │  ├── code-simplification
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── commit
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── context-engineering
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── create-mcp-server
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── create-skill
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── debug
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── debugging-and-error-recovery
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── deprecation-and-migration
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── documentation-and-adrs
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── doubt-driven-development
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  ├── prompt.md
│  │  │  │  │  └── references
│  │  │  │  │     ├── orchestration-patterns.html
│  │  │  │  │     └── orchestration-patterns.md
│  │  │  │  ├── dream
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── expert-team.html
│  │  │  │  ├── expert-team.md
│  │  │  │  ├── frontend-beautify
│  │  │  │  │  ├── SKILL.html
│  │  │  │  │  ├── SKILL.md
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  ├── prompt.md
│  │  │  │  │  └── references
│  │  │  │  │     ├── khyos-frontends.html
│  │  │  │  │     ├── khyos-frontends.md
│  │  │  │  │     ├── khyos-stack.html
│  │  │  │  │     └── khyos-stack.md
│  │  │  │  ├── frontend-ui-engineering
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  ├── prompt.md
│  │  │  │  │  └── references
│  │  │  │  │     ├── accessibility-checklist.html
│  │  │  │  │     └── accessibility-checklist.md
│  │  │  │  ├── git-workflow-and-versioning
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── hunter
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── idea-refine
│  │  │  │  │  ├── examples.html
│  │  │  │  │  ├── examples.md
│  │  │  │  │  ├── frameworks.html
│  │  │  │  │  ├── frameworks.md
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  ├── prompt.md
│  │  │  │  │  ├── refinement-criteria.html
│  │  │  │  │  ├── refinement-criteria.md
│  │  │  │  │  └── scripts
│  │  │  │  │     └── idea-refine.sh
│  │  │  │  ├── incremental-implementation
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── init-project
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── interview-me
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── keybindings
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── loop
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── pdf
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── performance-optimization
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  ├── prompt.md
│  │  │  │  │  └── references
│  │  │  │  │     ├── performance-checklist.html
│  │  │  │  │     └── performance-checklist.md
│  │  │  │  ├── planning-and-task-breakdown
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── remember
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── review-pr
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── security-and-hardening
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  ├── prompt.md
│  │  │  │  │  └── references
│  │  │  │  │     ├── security-checklist.html
│  │  │  │  │     └── security-checklist.md
│  │  │  │  ├── shipping-and-launch
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  ├── prompt.md
│  │  │  │  │  └── references
│  │  │  │  │     ├── accessibility-checklist.html
│  │  │  │  │     ├── accessibility-checklist.md
│  │  │  │  │     ├── performance-checklist.html
│  │  │  │  │     ├── performance-checklist.md
│  │  │  │  │     ├── security-checklist.html
│  │  │  │  │     └── security-checklist.md
│  │  │  │  ├── simplify
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── skill-creator.html
│  │  │  │  ├── skill-creator.md
│  │  │  │  ├── skillify
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── source-driven-development
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── spec-driven-development
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── stuck
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── task-dispatcher.html
│  │  │  │  ├── task-dispatcher.md
│  │  │  │  ├── test-driven-development
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  ├── prompt.md
│  │  │  │  │  └── references
│  │  │  │  │     ├── testing-patterns.html
│  │  │  │  │     └── testing-patterns.md
│  │  │  │  ├── update-config
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  ├── using-agent-skills
│  │  │  │  │  ├── manifest.json
│  │  │  │  │  ├── prompt.html
│  │  │  │  │  └── prompt.md
│  │  │  │  └── verify
│  │  │  │     ├── manifest.json
│  │  │  │     ├── prompt.html
│  │  │  │     └── prompt.md
│  │  │  ├── ccSkillBridge.js
│  │  │  ├── devops
│  │  │  │  └── git-workflow
│  │  │  │     ├── SKILL.html
│  │  │  │     └── SKILL.md
│  │  │  ├── evals
│  │  │  │  ├── README.html
│  │  │  │  ├── README.md
│  │  │  │  ├── skill-eval-baseline.json
│  │  │  │  ├── skill-eval-config.schema.json
│  │  │  │  ├── skill-eval-report.schema.json
│  │  │  │  ├── skill-scenario-report.schema.json
│  │  │  │  └── skill-scenario-suite.json
│  │  │  ├── index.js
│  │  │  ├── monitor-perf
│  │  │  │  └── system-monitor
│  │  │  │     ├── SKILL.html
│  │  │  │     └── SKILL.md
│  │  │  ├── ocSkillBridge.js
│  │  │  ├── quant
│  │  │  │  └── quant-analysis
│  │  │  │     ├── SKILL.html
│  │  │  │     └── SKILL.md
│  │  │  ├── security
│  │  │  │  └── cve-query
│  │  │  │     ├── SKILL.html
│  │  │  │     └── SKILL.md
│  │  │  ├── skillLoader.js
│  │  │  ├── skillSourceSpec.js
│  │  │  └── system-admin
│  │  │     └── linux-admin
│  │  │        ├── SKILL.html
│  │  │        └── SKILL.md
│  │  ├── tasks
│  │  │  ├── diskOutput.js
│  │  │  ├── index.js
│  │  │  ├── largeTaskBoard.js
│  │  │  ├── largeTaskOrchestrator.js
│  │  │  ├── largeTaskRuntimeStore.js
│  │  │  ├── largeTaskWorkerService.js
│  │  │  └── taskStore.js
│  │  ├── templates
│  │  │  ├── django-rest.json
│  │  │  ├── docstyles
│  │  │  │  ├── default.json
│  │  │  │  ├── gbt7714.json
│  │  │  │  └── ieee.json
│  │  │  ├── express-api.json
│  │  │  ├── flask-api.json
│  │  │  ├── go-api.json
│  │  │  ├── react-typescript.json
│  │  │  ├── spring-boot-mybatis.json
│  │  │  ├── vue-multipage.json
│  │  │  └── vue-typescript.json
│  │  ├── tools
│  │  │  ├── A2ATool
│  │  │  │  └── index.js
│  │  │  ├── AgentAssetsTool
│  │  │  │  └── index.js
│  │  │  ├── AgentTool
│  │  │  │  ├── claudeDelegation.js
│  │  │  │  └── index.js
│  │  │  ├── ApplyPatchTool
│  │  │  │  └── index.js
│  │  │  ├── ArtifactTool
│  │  │  │  └── index.js
│  │  │  ├── AskUserQuestionTool
│  │  │  │  └── index.js
│  │  │  ├── AssistantsTool
│  │  │  │  └── index.js
│  │  │  ├── BackgroundAgentOutputTool
│  │  │  │  └── index.js
│  │  │  ├── BashOutputTool
│  │  │  │  └── index.js
│  │  │  ├── BatchTool
│  │  │  │  └── index.js
│  │  │  ├── BriefTool
│  │  │  │  └── index.js
│  │  │  ├── CodeInterpreterTool
│  │  │  │  └── index.js
│  │  │  ├── CodebaseMapTool
│  │  │  │  └── index.js
│  │  │  ├── CommentGuidanceTool
│  │  │  │  └── index.js
│  │  │  ├── ComputerUseTool
│  │  │  │  └── index.js
│  │  │  ├── ConfigTool
│  │  │  │  └── index.js
│  │  │  ├── ConfigureExternalApp
│  │  │  │  └── index.js
│  │  │  ├── ConfigureModelProvider
│  │  │  │  └── index.js
│  │  │  ├── CreateToolTool
│  │  │  │  └── index.js
│  │  │  ├── CronDeleteTool
│  │  │  │  └── index.js
│  │  │  ├── CronListTool
│  │  │  │  └── index.js
│  │  │  ├── CtxInspectTool
│  │  │  │  └── index.js
│  │  │  ├── DesktopControlTool
│  │  │  │  └── index.js
│  │  │  ├── DeviceAppsTool
│  │  │  │  └── index.js
│  │  │  ├── DiscoverSkillsTool
│  │  │  │  └── index.js
│  │  │  ├── DiskAnalyzeTool
│  │  │  │  └── index.js
│  │  │  ├── DiskCleanupTool
│  │  │  │  └── index.js
│  │  │  ├── EmbeddingExtendedTool
│  │  │  │  └── index.js
│  │  │  ├── EnterPlanModeTool
│  │  │  │  └── index.js
│  │  │  ├── EnterWorktreeTool
│  │  │  │  └── index.js
│  │  │  ├── EvalsTool
│  │  │  │  └── index.js
│  │  │  ├── ExitPlanModeTool
│  │  │  │  └── index.js
│  │  │  ├── ExitWorktreeTool
│  │  │  │  └── index.js
│  │  │  ├── FileEditTool
│  │  │  │  └── index.js
│  │  │  ├── FileReadTool
│  │  │  │  └── index.js
│  │  │  ├── FileWriteTool
│  │  │  │  └── index.js
│  │  │  ├── FilesAPITool
│  │  │  │  └── index.js
│  │  │  ├── FineTuningTool
│  │  │  │  └── index.js
│  │  │  ├── FirecrawlTool
│  │  │  │  └── index.js
│  │  │  ├── GetLocationTool
│  │  │  │  └── index.js
│  │  │  ├── GlobTool
│  │  │  │  └── index.js
│  │  │  ├── GoalTool.js
│  │  │  ├── GoogleGenAITool
│  │  │  │  └── index.js
│  │  │  ├── GrepTool
│  │  │  │  └── index.js
│  │  │  ├── ImageGenExtendedTool
│  │  │  │  └── index.js
│  │  │  ├── ImportExternalAppModels
│  │  │  │  └── index.js
│  │  │  ├── KhyOsTool
│  │  │  │  └── index.js
│  │  │  ├── KhySelfTool
│  │  │  │  └── index.js
│  │  │  ├── KillShellTool
│  │  │  │  └── index.js
│  │  │  ├── LSPTool
│  │  │  │  └── index.js
│  │  │  ├── ListDirTool
│  │  │  │  └── index.js
│  │  │  ├── ListMcpResourcesTool
│  │  │  │  └── index.js
│  │  │  ├── LocalMemoryRecall.js
│  │  │  ├── MCPTool
│  │  │  │  └── index.js
│  │  │  ├── McpAuthTool
│  │  │  │  └── index.js
│  │  │  ├── MeshPeer.js
│  │  │  ├── ModelRouterTool
│  │  │  │  └── index.js
│  │  │  ├── MonitorTool
│  │  │  │  └── index.js
│  │  │  ├── MultiEdit.js
│  │  │  ├── MultiEditTool
│  │  │  │  └── index.js
│  │  │  ├── NewsSearchTool
│  │  │  │  └── index.js
│  │  │  ├── OCRExtendedTool
│  │  │  │  └── index.js
│  │  │  ├── PlanRetryTool
│  │  │  │  └── index.js
│  │  │  ├── PlanTool.js
│  │  │  ├── PluginHotReloadTool
│  │  │  │  └── index.js
│  │  │  ├── PowerShellTool
│  │  │  │  └── index.js
│  │  │  ├── ProjectBlueprintTool
│  │  │  │  └── index.js
│  │  │  ├── PushNotify.js
│  │  │  ├── REPLTool
│  │  │  │  └── index.js
│  │  │  ├── RPATool
│  │  │  │  └── index.js
│  │  │  ├── ReadMcpResourceTool
│  │  │  │  └── index.js
│  │  │  ├── RealtimeTool
│  │  │  │  └── index.js
│  │  │  ├── RecordProgress.js
│  │  │  ├── RemoteTriggerTool
│  │  │  │  └── index.js
│  │  │  ├── RerankTool
│  │  │  │  └── index.js
│  │  │  ├── ResponsesAPITool
│  │  │  │  └── index.js
│  │  │  ├── ReviewArtifactTool
│  │  │  │  └── index.js
│  │  │  ├── RtkGainTool
│  │  │  │  └── index.js
│  │  │  ├── STTExtendedTool
│  │  │  │  └── index.js
│  │  │  ├── SaveInstruction.js
│  │  │  ├── SaveMemory.js
│  │  │  ├── ScheduleCronTool
│  │  │  │  └── index.js
│  │  │  ├── SearchExtendedTool
│  │  │  │  └── index.js
│  │  │  ├── SendMessageTool
│  │  │  │  └── index.js
│  │  │  ├── SendUserFileTool
│  │  │  │  └── index.js
│  │  │  ├── SessionInsights.js
│  │  │  ├── SkillTool
│  │  │  │  └── index.js
│  │  │  ├── SleepTool
│  │  │  │  └── index.js
│  │  │  ├── SnipTool
│  │  │  │  └── index.js
│  │  │  ├── StructuredOutputTool
│  │  │  │  └── index.js
│  │  │  ├── SyntheticOutputTool
│  │  │  │  └── index.js
│  │  │  ├── TTSExtendedTool
│  │  │  │  └── index.js
│  │  │  ├── TaskCreateTool
│  │  │  │  └── index.js
│  │  │  ├── TaskGetTool
│  │  │  │  └── index.js
│  │  │  ├── TaskListTool
│  │  │  │  └── index.js
│  │  │  ├── TaskOutputTool
│  │  │  │  └── index.js
│  │  │  ├── TaskStopTool
│  │  │  │  └── index.js
│  │  │  ├── TaskUpdateTool
│  │  │  │  └── index.js
│  │  │  ├── TeamCreateTool
│  │  │  │  └── index.js
│  │  │  ├── TeamDeleteTool
│  │  │  │  └── index.js
│  │  │  ├── TerminalCaptureTool
│  │  │  │  └── index.js
│  │  │  ├── TodoWriteTool
│  │  │  │  └── index.js
│  │  │  ├── ToolRecommend
│  │  │  │  └── index.js
│  │  │  ├── UpstreamStudyTool
│  │  │  │  └── index.js
│  │  │  ├── VaultHttpFetch.js
│  │  │  ├── VectorStoreTool
│  │  │  │  └── index.js
│  │  │  ├── VerifyPlanExecutionTool
│  │  │  │  └── index.js
│  │  │  ├── VideoGenExtendedTool
│  │  │  │  └── index.js
│  │  │  ├── WeakModelGuidanceTool
│  │  │  │  └── index.js
│  │  │  ├── WebBrowserTool
│  │  │  │  └── index.js
│  │  │  ├── WebFetchTool
│  │  │  │  ├── index.js
│  │  │  │  └── webFetchDeadline.js
│  │  │  ├── WebSearchTool
│  │  │  │  └── index.js
│  │  │  ├── WeipuRewriteTool
│  │  │  │  └── index.js
│  │  │  ├── WorkflowTool
│  │  │  │  └── index.js
│  │  │  ├── _baseTool.js
│  │  │  ├── _dbTimeout.js
│  │  │  ├── _execCompat.js
│  │  │  ├── _fileLock.js
│  │  │  ├── _readTracker.js
│  │  │  ├── _taskStore.js
│  │  │  ├── _toolCategories.js
│  │  │  ├── _toolHealer.js
│  │  │  ├── _toolResultNormalizer.js
│  │  │  ├── _toolSyntaxHealer.js
│  │  │  ├── _toolTimeout.js
│  │  │  ├── _userDirs.js
│  │  │  ├── _walkBudget.js
│  │  │  ├── _writeToolNames.js
│  │  │  ├── adoptRole.js
│  │  │  ├── analyzeBinary.js
│  │  │  ├── appWindowLauncher.js
│  │  │  ├── backgroundShellRegistry.js
│  │  │  ├── backtest.js
│  │  │  ├── bash.js
│  │  │  ├── bashCommentLabel.js
│  │  │  ├── buildProject.js
│  │  │  ├── ccOutputTruncate.js
│  │  │  ├── ccValidationError.js
│  │  │  ├── cmd.js
│  │  │  ├── compileFile.js
│  │  │  ├── configureCapability.js
│  │  │  ├── configureErrorShape.js
│  │  │  ├── convertFile.js
│  │  │  ├── coverageReport.js
│  │  │  ├── createDocument.js
│  │  │  ├── dataFetch.js
│  │  │  ├── databaseQuery.js
│  │  │  ├── deploy.js
│  │  │  ├── docTitleStyle.js
│  │  │  ├── editFile.js
│  │  │  ├── executeCode.js
│  │  │  ├── exploreTool.js
│  │  │  ├── filePreReadHangGuard.js
│  │  │  ├── fileReadLimit.js
│  │  │  ├── forgeCodeSearch.js
│  │  │  ├── forgeCommits.js
│  │  │  ├── forgeRecon.js
│  │  │  ├── forgeSearch.js
│  │  │  ├── gitBlame.js
│  │  │  ├── gitClone.js
│  │  │  ├── gitCommit.js
│  │  │  ├── gitDiff.js
│  │  │  ├── gitLog.js
│  │  │  ├── gitPush.js
│  │  │  ├── gitStatus.js
│  │  │  ├── glob.js
│  │  │  ├── grep.js
│  │  │  ├── guardedReadFileSync.js
│  │  │  ├── httpRequest.js
│  │  │  ├── image2web.js
│  │  │  ├── imageDetect.js
│  │  │  ├── imageEdit.js
│  │  │  ├── imageGenerate.js
│  │  │  ├── imageOcr.js
│  │  │  ├── index.js
│  │  │  ├── inputValidators.js
│  │  │  ├── inspectDocument.js
│  │  │  ├── khyUpdate.js
│  │  │  ├── lintCode.js
│  │  │  ├── manageDeps.js
│  │  │  ├── news.js
│  │  │  ├── optimizeConfig.js
│  │  │  ├── pdfToWord.js
│  │  │  ├── platformUtils.js
│  │  │  ├── powershell.js
│  │  │  ├── projectTemplate.js
│  │  │  ├── pseudoFileReadGuard.js
│  │  │  ├── pythonInvocationHint.js
│  │  │  ├── quote.js
│  │  │  ├── readBinaryGuard.js
│  │  │  ├── readFile.js
│  │  │  ├── readFileFormatRouter.js
│  │  │  ├── recognizeImage.js
│  │  │  ├── registrySearch.js
│  │  │  ├── renderDocument.js
│  │  │  ├── replaceAtLocation.js
│  │  │  ├── repoAudit.js
│  │  │  ├── reverseEngineer.js
│  │  │  ├── runTests.js
│  │  │  ├── scaffoldFiles.js
│  │  │  ├── search.js
│  │  │  ├── securityScan.js
│  │  │  ├── semanticNumberCoerce.js
│  │  │  ├── sessionRecall.js
│  │  │  ├── shellClassifier.js
│  │  │  ├── shellCommand.js
│  │  │  ├── shellCommandEngine.js
│  │  │  ├── shellDiagnostics.js
│  │  │  ├── shellEmptyOutputNote.js
│  │  │  ├── shellErrorClassify.js
│  │  │  ├── shellExitSemantics.js
│  │  │  ├── shutdownTool.js
│  │  │  ├── specialFileReadGuard.js
│  │  │  ├── strategyList.js
│  │  │  ├── taskBlockedBySuffix.js
│  │  │  ├── taskMemorySection.js
│  │  │  ├── tasteTool.js
│  │  │  ├── teammateBus.js
│  │  │  ├── toolProfile.js
│  │  │  ├── toolRecommend.js
│  │  │  ├── toolSearch.js
│  │  │  ├── unpackTool.js
│  │  │  ├── verifyArtifact.js
│  │  │  ├── videoAnalyze.js
│  │  │  ├── videoGenerate.js
│  │  │  ├── webSearch.js
│  │  │  ├── winCommandTranslate.js
│  │  │  ├── winDeviceReadGuard.js
│  │  │  └── writeFile.js
│  │  └── vim
│  │     ├── motions.js
│  │     ├── operators.js
│  │     ├── settings.js
│  │     ├── textObjects.js
│  │     ├── transitions.js
│  │     ├── types.js
│  │     └── vimInput.js
│  ├── package.json
│  ├── pnpm-lock.yaml
│  ├── pnpm-workspace.yaml
│  └── substrate
│     ├── ansiSanitizer
│     │  ├── README.html
│     │  ├── README.md
│     │  ├── index.js
│     │  ├── index.test.js
│     │  └── khy.module.json
│     ├── apiResponse.js
│     ├── atomicWriteJson.js
│     ├── backendRuntime.js
│     ├── betaFallbackNotice.js
│     ├── breakCache.js
│     ├── clampInt.js
│     ├── classifyKhyError.js
│     ├── cleanText.js
│     ├── cloneCapabilityTasks.js
│     ├── collapseWhitespace.js
│     ├── collapseWhitespaceLoose.js
│     ├── collectLspDiagnostics.js
│     ├── constants
│     │  ├── chatHistoryDefaults.js
│     │  ├── cnMirror.js
│     │  ├── commandHelp.js
│     │  ├── commandSchema.js
│     │  ├── contextWindowDefaults.js
│     │  ├── cyberRiskInstruction.js
│     │  ├── gitCoAuthorTrailer.js
│     │  ├── gitWorkflowGuidance.js
│     │  ├── installationCandidates.js
│     │  ├── models.js
│     │  ├── nodePlatformLabel.js
│     │  ├── outputStyles.js
│     │  ├── positioning.js
│     │  ├── promptAnchors.js
│     │  ├── promptCacheOrder.js
│     │  ├── promptFreshness.js
│     │  ├── promptLocales.js
│     │  ├── promptPrefixShape.js
│     │  ├── promptSectionTaxonomy.js
│     │  ├── prompts.js
│     │  ├── retryBudget.js
│     │  ├── riskOrder.js
│     │  ├── serviceDefaults.js
│     │  ├── shellChainStyle.js
│     │  ├── shellTransparency.js
│     │  ├── smallModelDefaults.js
│     │  ├── systemClock.js
│     │  ├── systemPromptBoundary.js
│     │  ├── systemPromptSections.js
│     │  ├── toolIcons.js
│     │  └── wasmDefaults.js
│     ├── crossBranchSynthesis.js
│     ├── cryptoRandom.js
│     ├── dailyScheduler.js
│     ├── dataHome.js
│     ├── dedupeText.js
│     ├── deepClone.js
│     ├── diff
│     │  ├── envGates.js
│     │  └── structuredHunks.js
│     ├── docHelperEnabled.js
│     ├── ensureDirSync.js
│     ├── envFlagByName.js
│     ├── envFlagEnabled.js
│     ├── envInt.js
│     ├── envIntNonNeg.js
│     ├── envNum.js
│     ├── envOnByName.js
│     ├── ephemeralTmp.js
│     ├── escapeRegExp.js
│     ├── existsSyncSafe.js
│     ├── expandEnvPath.js
│     ├── expressAsyncPatch.js
│     ├── extractEndpoint.js
│     ├── fileEncoding.js
│     ├── finiteNumber.js
│     ├── firstGroup.js
│     ├── flagRegistry
│     │  ├── README.html
│     │  ├── README.md
│     │  ├── index.js
│     │  ├── index.test.js
│     │  └── khy.module.json
│     ├── format
│     │  ├── ccFormat.js
│     │  ├── ccModelName.js
│     │  ├── consoleError.js
│     │  ├── consoleNotice.js
│     │  ├── fullWidthInput.js
│     │  ├── statusMessageFormatter.js
│     │  └── tableStyle.js
│     ├── formatBytes.js
│     ├── gateOn.js
│     ├── gitSoftExec.js
│     ├── growthDataDir.js
│     ├── healAudit.js
│     ├── hostOfEndpoint.js
│     ├── httpError.js
│     ├── humanBytes.js
│     ├── isEnabledDefaultOn.js
│     ├── isOffValue.js
│     ├── isPathWithin.js
│     ├── isPlainObject.js
│     ├── javaEncoding.js
│     ├── khyError.js
│     ├── khyErrorCategory.js
│     ├── logger.js
│     ├── mapRuntimeErrorCategory.js
│     ├── markProcessFailure.js
│     ├── maskSecret.js
│     ├── maskToken.js
│     ├── mkdirpSync.js
│     ├── nativeHttp.js
│     ├── nearestExistingDir.js
│     ├── normLower.js
│     ├── normalizeAlnumKey.js
│     ├── normalizeAuthToken.js
│     ├── normalizeCompatibility.js
│     ├── normalizeToolName.js
│     ├── notifier.js
│     ├── onValueOr.js
│     ├── openclawHome.js
│     ├── oscSafeText.js
│     ├── parseBoolean.js
│     ├── parseJsonObjectMap.js
│     ├── parseListToSet.js
│     ├── parseRetryAfterCooldown.js
│     ├── parseTomlTables.js
│     ├── patchEnvContent.js
│     ├── pathCompat.js
│     ├── pathJoinSafe.js
│     ├── pgPaths.js
│     ├── pickLocale.js
│     ├── pickUserTextSafe.js
│     ├── platformCtx.js
│     ├── proxyBaseUrl.js
│     ├── proxyDispatcherAgent.js
│     ├── pythonAvailable.js
│     ├── pythonPath.js
│     ├── readFileSyncSafe.js
│     ├── readJsonFileSafe.js
│     ├── resolveEnv.js
│     ├── resolveGatewayEnvPaths.js
│     ├── resolveNumericFlag.js
│     ├── resolveToolPath.js
│     ├── resolveUserPath.js
│     ├── response.js
│     ├── responseOptimizers.js
│     ├── retry.js
│     ├── safeJsonParse.js
│     ├── safeStatSync.js
│     ├── sessionSlots.js
│     ├── sessionTopology.js
│     ├── simpleTokenEstimate.js
│     ├── sleep.js
│     ├── slugifyToken.js
│     ├── sourceTextCompressor.js
│     ├── spawnWithIdleTimeout.js
│     ├── storageRoots.js
│     ├── stripAnsi.js
│     ├── stripCodeSpans.js
│     ├── styleMatchers.js
│     ├── systemEncoding.js
│     ├── text
│     │  ├── README.html
│     │  ├── README.md
│     │  ├── displayWidthMemo.js
│     │  ├── displayWidthMemo.test.js
│     │  ├── imageIntent.js
│     │  ├── imageIntent.test.js
│     │  ├── inlineFileRefs.js
│     │  ├── inlineFileRefs.test.js
│     │  ├── keyFindings.js
│     │  ├── keyFindings.test.js
│     │  ├── khy.module.json
│     │  ├── permissionReply.js
│     │  ├── permissionReply.test.js
│     │  ├── resultGuard.js
│     │  ├── resultGuard.test.js
│     │  ├── width.js
│     │  └── width.test.js
│     ├── toLowerCaseSafe.js
│     ├── toNonNegInt.js
│     ├── toStr.js
│     ├── toolCallNoise.js
│     ├── toolNameVariants.js
│     ├── toolResultSanitizer.js
│     ├── trimIfString.js
│     ├── trimLowerCase.js
│     ├── trimLowerNullish.js
│     ├── trimLowerStripUnderscores.js
│     ├── truncateEllipsis.js
│     ├── tryOr.js
│     ├── tryOrAsync.js
│     ├── userFeedback.js
│     ├── userFriendlyError.js
│     ├── withTimeout.js
│     └── worktreeName.js
└── works
   ├── build
   │  ├── README.html
   │  ├── README.md
   │  ├── admin
   │  │  ├── _check-credentials.js
   │  │  ├── _create-admin.js
   │  │  ├── _del-creds.js
   │  │  ├── _fix-admin.js
   │  │  ├── _insert-user.js
   │  │  ├── _insert-user.py
   │  │  └── _reset-users.py
   │  ├── backend
   │  │  └── fix-deprecated-encoding.js
   │  ├── check_builtin_keys.py
   │  ├── check_keys.ps1
   │  ├── ci
   │  │  ├── annotate-patterns.js
   │  │  ├── check-agent-authz.js
   │  │  ├── check-agent-docs.js
   │  │  ├── check-agent-feedback.js
   │  │  ├── check-agent-rules.js
   │  │  ├── check-ai-gateway.js
   │  │  ├── check-api-contracts.js
   │  │  ├── check-auth-session.js
   │  │  ├── check-board-lane-map.js
   │  │  ├── check-build-artifacts.js
   │  │  ├── check-build-root.js
   │  │  ├── check-change-safety.js
   │  │  ├── check-code-standards.js
   │  │  ├── check-commit-message.js
   │  │  ├── check-commit-timing.js
   │  │  ├── check-copyright-readiness.js
   │  │  ├── check-core-safety.js
   │  │  ├── check-data-layout.js
   │  │  ├── check-data-lifecycle.js
   │  │  ├── check-debt-ledger.js
   │  │  ├── check-delegation-boundary.js
   │  │  ├── check-delivery-baseline.js
   │  │  ├── check-dependency-size.js
   │  │  ├── check-discoverability.js
   │  │  ├── check-duplication.js
   │  │  ├── check-env-gateway-pin.js
   │  │  ├── check-f2e-spec.js
   │  │  ├── check-f2e-wiring.js
   │  │  ├── check-feature-ownership.js
   │  │  ├── check-file-ratchet.js
   │  │  ├── check-flag-registry.js
   │  │  ├── check-frontend-design-tokens.js
   │  │  ├── check-frontend-size.js
   │  │  ├── check-frontend-tokens.js
   │  │  ├── check-golden-path.js
   │  │  ├── check-gov-rules.js
   │  │  ├── check-gov-status.js
   │  │  ├── check-incident-dr.js
   │  │  ├── check-leaf-contract.js
   │  │  ├── check-license-tiers.js
   │  │  ├── check-lifecycle-policy.js
   │  │  ├── check-memory-schema.js
   │  │  ├── check-model-hardcoding.js
   │  │  ├── check-model-list-truth.js
   │  │  ├── check-moonbit-layout.js
   │  │  ├── check-native-registry.js
   │  │  ├── check-no-emoji.js
   │  │  ├── check-node-syntax.js
   │  │  ├── check-notify-webhook.js
   │  │  ├── check-ops-health.js
   │  │  ├── check-pattern-coverage.js
   │  │  ├── check-permission-invariants.js
   │  │  ├── check-prompt-taxonomy.js
   │  │  ├── check-proposal-index.js
   │  │  ├── check-protocol-conformance.js
   │  │  ├── check-protocol-naming.js
   │  │  ├── check-provenance.js
   │  │  ├── check-python-syntax.py
   │  │  ├── check-release-triggers.js
   │  │  ├── check-repo-layout.js
   │  │  ├── check-rollout-stage.js
   │  │  ├── check-roots-isomorphic.js
   │  │  ├── check-rule-scaffold.js
   │  │  ├── check-rules-registry.js
   │  │  ├── check-runtime-placement.js
   │  │  ├── check-security-headers.js
   │  │  ├── check-skill-evals.js
   │  │  ├── check-skill-scenarios.js
   │  │  ├── check-staged-secrets.js
   │  │  ├── check-tool-contract.js
   │  │  ├── check-touch-cost.js
   │  │  ├── check-traffic-log.js
   │  │  ├── check-tui-cadence.js
   │  │  ├── check-tui-gates.js
   │  │  ├── check-unbypassable-gate.js
   │  │  ├── check-upload-safety.js
   │  │  ├── check-version-sync.js
   │  │  ├── check-weak-model-guard.js
   │  │  ├── check-wiring.js
   │  │  ├── check-workflow-node-parity.js
   │  │  ├── check-workflow-sanity.js
   │  │  ├── check-zcode-baseline.js
   │  │  ├── code-standards.baseline.json
   │  │  ├── codemod-f2e-bridge-mobile.js
   │  │  ├── conformance-runner.mjs
   │  │  ├── debt-ledger.json
   │  │  ├── dependency-size-baseline.json
   │  │  ├── discoverability-baseline.json
   │  │  ├── discoverability-demo.js
   │  │  ├── duplication-baseline.json
   │  │  ├── export-dimension-health.js
   │  │  ├── export-pyproject-dependencies.py
   │  │  ├── export-quality-dashboard.js
   │  │  ├── file-ratchet.config.json
   │  │  ├── frontend-size-baseline.json
   │  │  ├── generate-pattern-registry.js
   │  │  ├── json-schemas
   │  │  │  ├── arena-session.schema.json
   │  │  │  ├── http-error-envelope.schema.json
   │  │  │  ├── http-success-envelope.schema.json
   │  │  │  ├── integrity-manifest.schema.json
   │  │  │  ├── ipc-message.schema.json
   │  │  │  ├── receipt.schema.json
   │  │  │  ├── runtime-config.schema.json
   │  │  │  └── websocket-message.schema.json
   │  │  ├── lint-debt-tracker.js
   │  │  ├── pattern-coverage-baseline.json
   │  │  ├── print-maintainer-map.js
   │  │  ├── protocol-naming.json
   │  │  ├── repo-layout-baseline.json
   │  │  ├── ruleguard-baseline.json
   │  │  ├── run-python.js
   │  │  ├── security-scan.js
   │  │  ├── test-a2a-mcp-server-smoke.js
   │  │  ├── validate-json-schemas.js
   │  │  ├── validate-protocol-contracts.js
   │  │  ├── validate-reliability.js
   │  │  └── wiring-exemptions.json
   │  ├── copyright
   │  │  ├── LICENSE
   │  │  ├── repo-contract.html
   │  │  ├── repo-contract.md
   │  │  ├── upstream-manifest.json
   │  │  └── vendor
   │  │     └── software-copyright-materials
   │  │        ├── SKILL.html
   │  │        ├── SKILL.md
   │  │        ├── agents
   │  │        │  └── openai.yaml
   │  │        ├── references
   │  │        │  ├── application_fields.html
   │  │        │  ├── application_fields.md
   │  │        │  ├── business_understanding_rules.html
   │  │        │  ├── business_understanding_rules.md
   │  │        │  ├── code_selection_rules.html
   │  │        │  ├── code_selection_rules.md
   │  │        │  ├── copyright_material_rules.html
   │  │        │  ├── copyright_material_rules.md
   │  │        │  ├── manual_structure.html
   │  │        │  ├── manual_structure.md
   │  │        │  ├── officecli_backend.html
   │  │        │  ├── officecli_backend.md
   │  │        │  ├── playwright_cli_screenshots.html
   │  │        │  └── playwright_cli_screenshots.md
   │  │        ├── scripts
   │  │        │  ├── analyze_project.py
   │  │        │  ├── build_docx_from_md.py
   │  │        │  ├── capture_screenshots.py
   │  │        │  ├── check_environment.py
   │  │        │  ├── check_playwright_cli.py
   │  │        │  ├── common.py
   │  │        │  ├── confirm_stage.py
   │  │        │  ├── extract_code_material.py
   │  │        │  ├── generate_application_info.py
   │  │        │  ├── generate_business_context.py
   │  │        │  ├── generate_manual_draft.py
   │  │        │  ├── officecli_backend.py
   │  │        │  └── propose_code_selection.py
   │  │        └── tests
   │  │           ├── test_code_layout.py
   │  │           ├── test_officecli_builder.py
   │  │           ├── test_source_discovery.py
   │  │           └── test_workflow_integrity.py
   │  ├── docs
   │  │  ├── auto-fix-doc-index.js
   │  │  ├── build_docs_site.js
   │  │  ├── build_docs_site.test.js
   │  │  ├── check-fix-links.js
   │  │  ├── check_beginner_docs.js
   │  │  ├── check_beginner_docs.test.js
   │  │  ├── cleanup-orphan-html.js
   │  │  ├── fix-doc-index.js
   │  │  ├── gen-evolution-prompts.js
   │  │  ├── gen-rules-cards.js
   │  │  ├── lint_docs_widgets.js
   │  │  ├── lint_docs_widgets.test.js
   │  │  ├── md-to-pdf.js
   │  │  ├── mermaid-embed
   │  │  │  ├── build.mjs
   │  │  │  ├── ensure-mermaid.mjs
   │  │  │  ├── entry.mjs
   │  │  │  ├── package-lock.json
   │  │  │  └── package.json
   │  │  ├── rules-scaffold.js
   │  │  └── verify_docs_site.js
   │  ├── evidence
   │  │  ├── build-git-record.js
   │  │  ├── build-index.js
   │  │  ├── capture-runtime.js
   │  │  ├── collect-contribution.js
   │  │  └── render-images.js
   │  ├── findIgnored.js
   │  ├── frontend
   │  │  ├── README.html
   │  │  ├── README.md
   │  │  ├── cleanup-console.js
   │  │  ├── fix-hardcoded-colors.js
   │  │  └── fix-var-declarations.js
   │  ├── frontend-tokens.baseline.json
   │  ├── gen_keys.py
   │  ├── hooks
   │  │  └── agentFeedbackHint.js
   │  ├── install
   │  │  ├── enable-fs-compression.sh
   │  │  ├── enable-ntfs-compression.ps1
   │  │  └── link-shared-dev.js
   │  ├── install-hooks.sh
   │  ├── lib
   │  │  ├── agentRestorePlan.js
   │  │  ├── archiveExtractCompat.js
   │  │  ├── buildArtifactGuard.js
   │  │  ├── buildDepsCleanup.mjs
   │  │  ├── buildRootGuard.js
   │  │  ├── bundleLaunchContract.js
   │  │  ├── cryptoSuiteCompat.js
   │  │  ├── dependencyClosure.js
   │  │  ├── discoverabilityGuard.js
   │  │  ├── docsPaths.js
   │  │  ├── duplicationGuard.js
   │  │  ├── ext-run.js
   │  │  ├── fanInTiering.js
   │  │  ├── flagRegistryGuard.js
   │  │  ├── hydrationHealth.js
   │  │  ├── installIntegrity.js
   │  │  ├── leafContractGuard.js
   │  │  ├── maintainerTriage.js
   │  │  ├── mirrorSyncQueue.js
   │  │  ├── modelHardcodingGuard.js
   │  │  ├── modelListTruthGuard.js
   │  │  ├── modelTypeProviderPlan.js
   │  │  ├── pythonInterpreter.js
   │  │  ├── releaseHygieneGuard.js
   │  │  ├── restoreAutonomyGate.js
   │  │  ├── restoreCompletenessVerifier.js
   │  │  ├── restoreConflictDetector.js
   │  │  ├── restoreConflictResolver.js
   │  │  ├── restoreConvergenceVerifier.js
   │  │  ├── restoreEffectProbe.js
   │  │  ├── restoreFieldAttribution.js
   │  │  ├── restoreNavigator.js
   │  │  ├── restoreProvenance.js
   │  │  ├── restoreReadiness.js
   │  │  ├── restoreRecoursePlan.js
   │  │  ├── restoreSkipApplier.js
   │  │  ├── restoreStrategyLedger.js
   │  │  ├── restoreTraceJournal.js
   │  │  ├── ruleScaffold.js
   │  │  ├── runtimePlacementGuard.js
   │  │  ├── snapshotFormatCompat.js
   │  │  ├── storageBaseline.js
   │  │  ├── toolContractGuard.js
   │  │  ├── toolDescriptionGuard.js
   │  │  ├── touchCostProbe.js
   │  │  ├── tuiCadenceGuard.js
   │  │  └── workflowNodeParityGuard.js
   │  ├── maintenance
   │  │  ├── clean-temp.js
   │  │  ├── clean.js
   │  │  ├── gen-codeowners.js
   │  │  ├── organize.py
   │  │  ├── slim-down.bat
   │  │  ├── slim-down.sh
   │  │  └── strip-ai-attribution.js
   │  ├── memory
   │  │  ├── README.html
   │  │  ├── README.md
   │  │  ├── clear-memory.js
   │  │  └── restore-memory.js
   │  ├── moonbit
   │  │  └── run-wasm-indicators-tests-offline.sh
   │  ├── portable
   │  │  └── portable-package.bat
   │  ├── quality-gate
   │  │  ├── c8.config.json
   │  │  ├── coverage.js
   │  │  ├── index.js
   │  │  ├── lib
   │  │  │  ├── providerContractChild.js
   │  │  │  ├── providerContractFixtures.js
   │  │  │  └── qualityGateStages.js
   │  │  ├── merge-coverage.js
   │  │  ├── provider-contract.js
   │  │  └── workflow-regression.js
   │  ├── quarantine
   │  │  ├── README.html
   │  │  └── README.md
   │  ├── release
   │  │  ├── README-runtime-placement.html
   │  │  ├── README-runtime-placement.md
   │  │  ├── assemble-pip-runtime.js
   │  │  ├── audit_pip_artifacts.py
   │  │  ├── build-and-audit-pip-purity.sh
   │  │  ├── build-android.ps1
   │  │  ├── build-khy-os.sh
   │  │  ├── build-khy-wheel-with-ollama-runtime.ps1
   │  │  ├── build-payload-assets.js
   │  │  ├── build-pip-dist.js
   │  │  ├── build-platform-wheel.ps1
   │  │  ├── build-platform-wheel.sh
   │  │  ├── changelog-new.js
   │  │  ├── check-pip-dist-size.sh
   │  │  ├── check_manifest_sync.py
   │  │  ├── docs_bundle_regen.py
   │  │  ├── generate-pip-part-manifest.py
   │  │  ├── hygiene-allowlist.json
   │  │  ├── lib
   │  │  │  ├── releaseGateStages.js
   │  │  │  ├── resolveNpmRegistryToken.js
   │  │  │  ├── runtimeStaging.js
   │  │  │  └── verifyAndroidSignature.js
   │  │  ├── obfuscate.js
   │  │  ├── pin-khyos-toolchain.js
   │  │  ├── pin-runtime-binaries.js
   │  │  ├── pip_packaging_rules.py
   │  │  ├── publish
   │  │  │  ├── README.html
   │  │  │  ├── README.md
   │  │  │  ├── _common.sh
   │  │  │  ├── _git-forge.sh
   │  │  │  ├── publish-gitee.sh
   │  │  │  ├── publish-github.sh
   │  │  │  ├── publish-gitlab.sh
   │  │  │  ├── publish-npm.sh
   │  │  │  └── publish-pip.sh
   │  │  ├── publish-dual.sh
   │  │  ├── publish-from-pip-dual.ps1
   │  │  ├── release-gate.js
   │  │  ├── render_manifest.py
   │  │  ├── source-hygiene-scan.js
   │  │  ├── update-index.js
   │  │  ├── verify-android-signature.js
   │  │  └── verify-runtime-placement.js
   │  ├── restore
   │  │  ├── restore-apply.js
   │  │  ├── restore-authorize.js
   │  │  ├── restore-check-archive.js
   │  │  ├── restore-check-crypto.js
   │  │  ├── restore-check-format.js
   │  │  ├── restore-check.js
   │  │  ├── restore-conflicts.js
   │  │  ├── restore-converge.js
   │  │  ├── restore-effect-probe.js
   │  │  ├── restore-field-attribution.js
   │  │  ├── restore-ledger.js
   │  │  ├── restore-navigate.js
   │  │  ├── restore-plan.js
   │  │  ├── restore-provenance.js
   │  │  ├── restore-recourse.js
   │  │  ├── restore-resolve.js
   │  │  ├── restore-trace.js
   │  │  └── restore-verify-complete.js
   │  ├── ruleguard
   │  │  ├── backfill-fields.js
   │  │  ├── index.js
   │  │  ├── lib
   │  │  │  ├── apply.js
   │  │  │  ├── baseline.js
   │  │  │  ├── coverage.js
   │  │  │  ├── externalRules.js
   │  │  │  ├── glob.js
   │  │  │  ├── ledger.js
   │  │  │  ├── manifest.js
   │  │  │  ├── registry.js
   │  │  │  ├── run.js
   │  │  │  ├── suppression.js
   │  │  │  └── wiring.js
   │  │  └── register-external-rules.js
   │  ├── security
   │  │  ├── detectFileLeak.js
   │  │  └── guardDangerousCommand.js
   │  ├── sync
   │  │  ├── README.html
   │  │  ├── README.md
   │  │  ├── export-sync.bat
   │  │  ├── export-sync.sh
   │  │  ├── import-sync.bat
   │  │  ├── import-sync.sh
   │  │  ├── merge-contributions.bat
   │  │  ├── mirror-sync.js
   │  │  ├── push-mirrors.sh
   │  │  └── sync-status.js
   │  ├── test-replace.js
   │  └── tests
   │     ├── agentRestorePlan.test.js
   │     ├── archiveExtractCompat.test.js
   │     ├── artifactCheckers.test.js
   │     ├── artifactManifest.test.js
   │     ├── buildArtifactGuard.test.js
   │     ├── buildDepsCleanup.test.js
   │     ├── bundleLaunchContract.test.js
   │     ├── changelog-new.test.js
   │     ├── check-agent-feedback-ambiguity.test.js
   │     ├── check-agent-feedback.test.js
   │     ├── check-agent-rules.test.js
   │     ├── check-change-safety.test.js
   │     ├── check-commit-timing.test.js
   │     ├── check-delegation-boundary.test.js
   │     ├── check-delivery-baseline.test.js
   │     ├── check-duplication.test.js
   │     ├── check-golden-path.test.js
   │     ├── check-gov-rules.test.js
   │     ├── check-model-hardcoding.test.js
   │     ├── check-native-registry.test.js
   │     ├── check-no-emoji.test.js
   │     ├── check-pattern-coverage.test.js
   │     ├── check-release-triggers.test.js
   │     ├── check-repo-layout.test.js
   │     ├── check-rules-registry.test.js
   │     ├── check-tui-cadence.test.js
   │     ├── check-weak-model-guard.test.js
   │     ├── coverage-gate.test.js
   │     ├── cryptoSuiteCompat.test.js
   │     ├── d4D5RepointContract.test.js
   │     ├── duplicationGuard.test.js
   │     ├── ext-run.test.js
   │     ├── externalRules.test.js
   │     ├── fanInTiering.test.js
   │     ├── flag-registry.test.js
   │     ├── gen-evolution-prompts.test.js
   │     ├── genCodeowners.test.js
   │     ├── hydrationHealth.test.js
   │     ├── installIntegrity.test.js
   │     ├── leaf-contract.test.js
   │     ├── maintainerMapDocCoverage.test.js
   │     ├── maintainerTriage.test.js
   │     ├── mirrorSyncQueue.test.js
   │     ├── modelTypeProviderPlan.test.js
   │     ├── packPortableArtifact.test.js
   │     ├── packagePortable.test.js
   │     ├── pipSdistAllowlist.test.js
   │     ├── portableArtifactBuilder.test.js
   │     ├── portableHealthCheck.artifact.test.js
   │     ├── portableHostIsolation.test.js
   │     ├── print-maintainer-map.test.js
   │     ├── provider-contract.test.js
   │     ├── q1-criteria.test.js
   │     ├── quality-gate.test.js
   │     ├── release-gate.test.js
   │     ├── releaseHygiene.test.js
   │     ├── repoCodeStandards.test.js
   │     ├── repoNoHardcodedEndpoints.test.js
   │     ├── repoPatternRegistry.test.js
   │     ├── repoRequireResolution.test.js
   │     ├── repoRolloutStage.test.js
   │     ├── repoRulesRegistry.test.js
   │     ├── repoTaskEntryIntegrity.test.js
   │     ├── repoTuiGates.test.js
   │     ├── repoWiring.test.js
   │     ├── resolveNpmRegistryToken.test.js
   │     ├── restoreAutonomyGate.test.js
   │     ├── restoreCompletenessVerifier.test.js
   │     ├── restoreConflictDetector.test.js
   │     ├── restoreConflictResolver.test.js
   │     ├── restoreConvergenceVerifier.test.js
   │     ├── restoreEffectProbe.test.js
   │     ├── restoreFieldAttribution.test.js
   │     ├── restoreNavigator.test.js
   │     ├── restoreProvenance.test.js
   │     ├── restoreReadiness.test.js
   │     ├── restoreRecoursePlan.test.js
   │     ├── restoreSkipApplier.test.js
   │     ├── restoreStrategyLedger.test.js
   │     ├── restoreTraceJournal.test.js
   │     ├── ruleScaffold.test.js
   │     ├── ruleguard.test.js
   │     ├── runtimePlacementGuard.test.js
   │     ├── runtimeStaging.test.js
   │     ├── snapshotFormatCompat.test.js
   │     ├── storageBaseline.test.js
   │     ├── toolDescriptionGuard.test.js
   │     ├── touchCostProbe.test.js
   │     ├── updateIndex.test.js
   │     ├── verify-android-signature.test.js
   │     ├── workflow-regression-gate.test.js
   │     └── zcodeBaseline.test.js
   ├── quarantine
   │  └── patches
   │     └── node-pty@1.0.0.patch
   ├── record
   │  ├── CHANGELOG.md
   │  ├── ai
   │  │  ├── .metahash.json
   │  │  ├── CONTEXT.yaml
   │  │  ├── GOVERNANCE-LEDGER.html
   │  │  ├── GOVERNANCE-LEDGER.md
   │  │  ├── GUARDS.html
   │  │  ├── GUARDS.md
   │  │  ├── MAP.html
   │  │  ├── MAP.md
   │  │  ├── MINIAPP_WEBVIEW_SINGLETON.html
   │  │  ├── MINIAPP_WEBVIEW_SINGLETON.md
   │  │  ├── __scope_probe
   │  │  │  └── probe.json
   │  │  ├── hq
   │  │  │  ├── BUGS.json
   │  │  │  ├── CONTEXT.html
   │  │  │  ├── CONTEXT.md
   │  │  │  ├── MODELS.json
   │  │  │  ├── PROGRESS.json
   │  │  │  ├── ROADMAP.html
   │  │  │  ├── ROADMAP.md
   │  │  │  └── prompts
   │  │  │     ├── README.html
   │  │  │     ├── README.md
   │  │  │     ├── bugfix
   │  │  │     │  ├── 01-修复指定Bug.html
   │  │  │     │  ├── 01-修复指定Bug.md
   │  │  │     │  ├── 01-修复指定Bug.md
   │  │  │     │  ├── 02-回归验证.html
   │  │  │     │  └── 02-回归验证.md
   │  │  │     ├── docs
   │  │  │     │  ├── 01-文档完善.html
   │  │  │     │  └── 01-文档完善.md
   │  │  │     ├── feature
   │  │  │     │  ├── 01-新功能开发.html
   │  │  │     │  ├── 01-新功能开发.md
   │  │  │     │  ├── 02-手机端APK开发.html
   │  │  │     │  ├── 02-手机端APK开发.md
   │  │  │     │  ├── CRDT-实时协作编辑引擎.html
   │  │  │     │  ├── CRDT-实时协作编辑引擎.md
   │  │  │     │  ├── 四端跨设备同步.html
   │  │  │     │  ├── 四端跨设备同步.md
   │  │  │     │  ├── 密钥端点中心管理-KeyManager.html
   │  │  │     │  ├── 密钥端点中心管理-KeyManager.md
   │  │  │     │  ├── 手机端APK参考项目.html
   │  │  │     │  └── 手机端APK参考项目.md
   │  │  │     ├── governance
   │  │  │     │  ├── 01-板块规则与协议总纲.html
   │  │  │     │  └── 01-板块规则与协议总纲.md
   │  │  │     ├── meta
   │  │  │     │  ├── 01-能力沉淀.html
   │  │  │     │  ├── 01-能力沉淀.md
   │  │  │     │  ├── 02-新机器接入.html
   │  │  │     │  ├── 02-新机器接入.md
   │  │  │     │  ├── 03-同步就绪验证.html
   │  │  │     │  ├── 03-同步就绪验证.md
   │  │  │     │  ├── 04-协作开发端.html
   │  │  │     │  └── 04-协作开发端.md
   │  │  │     ├── performance
   │  │  │     │  ├── 01-性能优化.html
   │  │  │     │  └── 01-性能优化.md
   │  │  │     ├── quality
   │  │  │     │  ├── 01-测试补齐.html
   │  │  │     │  ├── 01-测试补齐.md
   │  │  │     │  ├── 02-代码审查.html
   │  │  │     │  └── 02-代码审查.md
   │  │  │     └── refactor
   │  │  │        ├── 01-模块重构.html
   │  │  │        └── 01-模块重构.md
   │  │  └── plans
   │  │     ├── miniapp-webview-singleton.html
   │  │     └── miniapp-webview-singleton.md
   │  ├── docs
   │  │  ├── .mailmap
   │  │  ├── 00_INDEX_仓库根.html
   │  │  ├── 00_INDEX_仓库根.md
   │  │  ├── 00_INDEX_文档索引.html
   │  │  ├── 00_INDEX_文档索引.md
   │  │  ├── 01_INIT_立项
   │  │  │  ├── 00_INDEX_立项-分类索引.html
   │  │  │  ├── 00_INDEX_立项-分类索引.md
   │  │  │  └── INIT-PRD
   │  │  │     ├── 00_INDEX_INIT-PRD-总目录.html
   │  │  │     ├── 00_INDEX_INIT-PRD-总目录.md
   │  │  │     ├── [INIT-PRD-001] Khy-OS-定位与已实现能力-2026-06-12.html
   │  │  │     ├── [INIT-PRD-001] Khy-OS-定位与已实现能力-2026-06-12.md
   │  │  │     ├── [INIT-PRD-002] 项目-定位.html
   │  │  │     ├── [INIT-PRD-002] 项目-定位.md
   │  │  │     ├── [INIT-PRD-003] KhyOS 的核心-定位口径单一真源.html
   │  │  │     ├── [INIT-PRD-003] KhyOS 的核心-定位口径单一真源.md
   │  │  │     ├── [INIT-PRD-004] 用户定位与增长路线.html
   │  │  │     ├── [INIT-PRD-004] 用户定位与增长路线.md
   │  │  │     ├── [INIT-PRD-005] 市场立足点与竞品格局.html
   │  │  │     ├── [INIT-PRD-005] 市场立足点与竞品格局.md
   │  │  │     ├── [INIT-PRD-006] 企业侧切入与验证方案.html
   │  │  │     └── [INIT-PRD-006] 企业侧切入与验证方案.md
   │  │  ├── 02_CONCEPTS_概念入门
   │  │  │  ├── 00_INDEX_概念入门-总览.html
   │  │  │  ├── 00_INDEX_概念入门-总览.md
   │  │  │  ├── CONCEPT
   │  │  │  │  ├── 00_INDEX_CONCEPT-总目录.html
   │  │  │  │  ├── 00_INDEX_CONCEPT-总目录.md
   │  │  │  │  ├── [CONCEPT-01] 什么是Agent-智能体.html
   │  │  │  │  ├── [CONCEPT-01] 什么是Agent-智能体.md
   │  │  │  │  ├── [CONCEPT-02] 什么是ToolCalling-工具调用.html
   │  │  │  │  ├── [CONCEPT-02] 什么是ToolCalling-工具调用.md
   │  │  │  │  ├── [CONCEPT-03] 什么是ToolLoop-工具循环.html
   │  │  │  │  ├── [CONCEPT-03] 什么是ToolLoop-工具循环.md
   │  │  │  │  ├── [CONCEPT-04] 什么是MCP-模型上下文协议.html
   │  │  │  │  ├── [CONCEPT-04] 什么是MCP-模型上下文协议.md
   │  │  │  │  ├── [CONCEPT-05] 什么是Skill-技能.html
   │  │  │  │  ├── [CONCEPT-05] 什么是Skill-技能.md
   │  │  │  │  ├── [CONCEPT-06] 什么是LLM-大语言模型.html
   │  │  │  │  ├── [CONCEPT-06] 什么是LLM-大语言模型.md
   │  │  │  │  ├── [CONCEPT-07] 什么是Prompt-提示词.html
   │  │  │  │  ├── [CONCEPT-07] 什么是Prompt-提示词.md
   │  │  │  │  ├── [CONCEPT-08] 什么是Context与Token-上下文与令牌.html
   │  │  │  │  ├── [CONCEPT-08] 什么是Context与Token-上下文与令牌.md
   │  │  │  │  ├── [CONCEPT-09] 什么是Embedding-向量.html
   │  │  │  │  ├── [CONCEPT-09] 什么是Embedding-向量.md
   │  │  │  │  ├── [CONCEPT-10] 什么是向量数据库.html
   │  │  │  │  ├── [CONCEPT-10] 什么是向量数据库.md
   │  │  │  │  ├── [CONCEPT-11] 什么是RAG-检索增强生成.html
   │  │  │  │  ├── [CONCEPT-11] 什么是RAG-检索增强生成.md
   │  │  │  │  ├── [CONCEPT-12] 什么是机器学习-MachineLearning.html
   │  │  │  │  ├── [CONCEPT-12] 什么是机器学习-MachineLearning.md
   │  │  │  │  ├── [CONCEPT-13] 什么是深度学习-DeepLearning.html
   │  │  │  │  ├── [CONCEPT-13] 什么是深度学习-DeepLearning.md
   │  │  │  │  ├── [CONCEPT-14] 什么是Transformer-变换器.html
   │  │  │  │  ├── [CONCEPT-14] 什么是Transformer-变换器.md
   │  │  │  │  ├── [CONCEPT-15] 什么是PyTorch-深度学习框架.html
   │  │  │  │  ├── [CONCEPT-15] 什么是PyTorch-深度学习框架.md
   │  │  │  │  ├── [CONCEPT-16] 什么是Harness-智能体运行骨架.html
   │  │  │  │  ├── [CONCEPT-16] 什么是Harness-智能体运行骨架.md
   │  │  │  │  ├── [CONCEPT-17] 什么是YOLO-实时目标检测.html
   │  │  │  │  ├── [CONCEPT-17] 什么是YOLO-实时目标检测.md
   │  │  │  │  ├── [CONCEPT-18] 什么是系统提示词-SystemPrompt.html
   │  │  │  │  ├── [CONCEPT-18] 什么是系统提示词-SystemPrompt.md
   │  │  │  │  ├── [CONCEPT-19] 什么是ReAct-智能体推理模式.html
   │  │  │  │  ├── [CONCEPT-19] 什么是ReAct-智能体推理模式.md
   │  │  │  │  ├── [CONCEPT-20] 什么是智能体编排-Orchestration.html
   │  │  │  │  ├── [CONCEPT-20] 什么是智能体编排-Orchestration.md
   │  │  │  │  ├── [CONCEPT-21] 什么是思维链-ChainOfThought.html
   │  │  │  │  ├── [CONCEPT-21] 什么是思维链-ChainOfThought.md
   │  │  │  │  ├── [CONCEPT-22] 什么是反思-Reflection.html
   │  │  │  │  ├── [CONCEPT-22] 什么是反思-Reflection.md
   │  │  │  │  ├── [CONCEPT-23] 什么是计划与执行-PlanAndExecute.html
   │  │  │  │  ├── [CONCEPT-23] 什么是计划与执行-PlanAndExecute.md
   │  │  │  │  ├── [CONCEPT-24] 什么是思维树-TreeOfThoughts.html
   │  │  │  │  ├── [CONCEPT-24] 什么是思维树-TreeOfThoughts.md
   │  │  │  │  ├── [CONCEPT-25] 什么是微调-FineTuning.html
   │  │  │  │  ├── [CONCEPT-25] 什么是微调-FineTuning.md
   │  │  │  │  ├── [CONCEPT-26] 什么是强化学习-RLHF.html
   │  │  │  │  ├── [CONCEPT-26] 什么是强化学习-RLHF.md
   │  │  │  │  ├── [CONCEPT-27] 什么是多模态-Multimodal.html
   │  │  │  │  ├── [CONCEPT-27] 什么是多模态-Multimodal.md
   │  │  │  │  ├── [CONCEPT-28] 什么是采样与温度-Sampling.html
   │  │  │  │  ├── [CONCEPT-28] 什么是采样与温度-Sampling.md
   │  │  │  │  ├── [CONCEPT-29] 什么是API与SDK.html
   │  │  │  │  ├── [CONCEPT-29] 什么是API与SDK.md
   │  │  │  │  ├── [CONCEPT-30] 函数调用与MCP辨析.html
   │  │  │  │  ├── [CONCEPT-30] 函数调用与MCP辨析.md
   │  │  │  │  ├── [CONCEPT-31] 什么是幻觉-Hallucination.html
   │  │  │  │  ├── [CONCEPT-31] 什么是幻觉-Hallucination.md
   │  │  │  │  ├── [CONCEPT-32] 什么是MVP-最小可行产品.html
   │  │  │  │  └── [CONCEPT-32] 什么是MVP-最小可行产品.md
   │  │  │  └── 其它概念
   │  │  │     ├── 00_INDEX_其它概念-总目录.html
   │  │  │     ├── 00_INDEX_其它概念-总目录.md
   │  │  │     ├── 00_完成度报告.html
   │  │  │     └── 00_完成度报告.md
   │  │  ├── 03_DESIGN_设计
   │  │  │  ├── 00_INDEX_设计-分类索引.html
   │  │  │  ├── 00_INDEX_设计-分类索引.md
   │  │  │  ├── DESIGN-ARCH
   │  │  │  │  ├── 00_INDEX_DESIGN-ARCH-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-ARCH-总目录.md
   │  │  │  │  ├── [DESIGN-ARCH-001] khy-移动智能体协议.html
   │  │  │  │  ├── [DESIGN-ARCH-001] khy-移动智能体协议.md
   │  │  │  │  ├── [DESIGN-ARCH-002] Khyos-CB-SSP-数学建模与实现映射.html
   │  │  │  │  ├── [DESIGN-ARCH-002] Khyos-CB-SSP-数学建模与实现映射.md
   │  │  │  │  ├── [DESIGN-ARCH-003] Khyos-数学重塑-受约束随机最短路径.html
   │  │  │  │  ├── [DESIGN-ARCH-003] Khyos-数学重塑-受约束随机最短路径.md
   │  │  │  │  ├── [DESIGN-ARCH-004] _cbssp_progress.html
   │  │  │  │  ├── [DESIGN-ARCH-004] _cbssp_progress.md
   │  │  │  │  ├── [DESIGN-ARCH-005] agentfs-智能体文件系统.html
   │  │  │  │  ├── [DESIGN-ARCH-005] agentfs-智能体文件系统.md
   │  │  │  │  ├── [DESIGN-ARCH-006] ai-gateway-适配器协议架构.html
   │  │  │  │  ├── [DESIGN-ARCH-006] ai-gateway-适配器协议架构.md
   │  │  │  │  ├── [DESIGN-ARCH-007] m1-微内核-ipc-moonbit.html
   │  │  │  │  ├── [DESIGN-ARCH-007] m1-微内核-ipc-moonbit.md
   │  │  │  │  ├── [DESIGN-ARCH-008] moonbit-系统边界.html
   │  │  │  │  ├── [DESIGN-ARCH-008] moonbit-系统边界.md
   │  │  │  │  ├── [DESIGN-ARCH-009] 可视化拖拽工作流编辑器-2026-06-09.html
   │  │  │  │  ├── [DESIGN-ARCH-009] 可视化拖拽工作流编辑器-2026-06-09.md
   │  │  │  │  ├── [DESIGN-ARCH-010] 核心架构.html
   │  │  │  │  ├── [DESIGN-ARCH-010] 核心架构.md
   │  │  │  │  ├── [DESIGN-ARCH-011] 应用接入标准.html
   │  │  │  │  ├── [DESIGN-ARCH-011] 应用接入标准.md
   │  │  │  │  ├── [DESIGN-ARCH-012] 工具延迟加载.html
   │  │  │  │  ├── [DESIGN-ARCH-012] 工具延迟加载.md
   │  │  │  │  ├── [DESIGN-ARCH-013] 弱模型兼容.html
   │  │  │  │  ├── [DESIGN-ARCH-013] 弱模型兼容.md
   │  │  │  │  ├── [DESIGN-ARCH-014] 模式图谱.html
   │  │  │  │  ├── [DESIGN-ARCH-014] 模式图谱.md
   │  │  │  │  ├── [DESIGN-ARCH-015] 编码规范.html
   │  │  │  │  ├── [DESIGN-ARCH-015] 编码规范.md
   │  │  │  │  ├── [DESIGN-ARCH-016] AI_Agent显示规范.html
   │  │  │  │  ├── [DESIGN-ARCH-016] AI_Agent显示规范.md
   │  │  │  │  ├── [DESIGN-ARCH-017] 元工具系统设计.html
   │  │  │  │  ├── [DESIGN-ARCH-017] 元工具系统设计.md
   │  │  │  │  ├── [DESIGN-ARCH-018] Agent提示词复用机制.html
   │  │  │  │  ├── [DESIGN-ARCH-018] Agent提示词复用机制.md
   │  │  │  │  ├── [DESIGN-ARCH-019] 用户输入预处理规范.html
   │  │  │  │  ├── [DESIGN-ARCH-019] 用户输入预处理规范.md
   │  │  │  │  ├── [DESIGN-ARCH-020] 架构债治理报告.html
   │  │  │  │  ├── [DESIGN-ARCH-020] 架构债治理报告.md
   │  │  │  │  ├── [DESIGN-ARCH-021] 巨型环反转设计.html
   │  │  │  │  ├── [DESIGN-ARCH-021] 巨型环反转设计.md
   │  │  │  │  ├── [DESIGN-ARCH-022] khyos多实例并发文件控制规范.html
   │  │  │  │  ├── [DESIGN-ARCH-022] khyos多实例并发文件控制规范.md
   │  │  │  │  ├── [DESIGN-ARCH-023] khyos文档排版与格式控制规范.html
   │  │  │  │  ├── [DESIGN-ARCH-023] khyos文档排版与格式控制规范.md
   │  │  │  │  ├── [DESIGN-ARCH-025] khyos元规划协议与动态约束注入规范.html
   │  │  │  │  ├── [DESIGN-ARCH-025] khyos元规划协议与动态约束注入规范.md
   │  │  │  │  ├── [DESIGN-ARCH-026] khyos系统级服务调用审批网关规范.html
   │  │  │  │  ├── [DESIGN-ARCH-026] khyos系统级服务调用审批网关规范.md
   │  │  │  │  ├── [DESIGN-ARCH-027] Agent依赖自愈机制规范.html
   │  │  │  │  ├── [DESIGN-ARCH-027] Agent依赖自愈机制规范.md
   │  │  │  │  ├── [DESIGN-ARCH-028] Agent通信防御-零静默失败与精准归因.html
   │  │  │  │  ├── [DESIGN-ARCH-028] Agent通信防御-零静默失败与精准归因.md
   │  │  │  │  ├── [DESIGN-ARCH-029] Agent有限窗口降级与强制兜底执行协议.html
   │  │  │  │  ├── [DESIGN-ARCH-029] Agent有限窗口降级与强制兜底执行协议.md
   │  │  │  │  ├── [DESIGN-ARCH-030] 源端构建-目标机自愈运行.html
   │  │  │  │  ├── [DESIGN-ARCH-030] 源端构建-目标机自愈运行.md
   │  │  │  │  ├── [DESIGN-ARCH-031] 网关日志租界隔离-按需可见与净味翻译.html
   │  │  │  │  ├── [DESIGN-ARCH-031] 网关日志租界隔离-按需可见与净味翻译.md
   │  │  │  │  ├── [DESIGN-ARCH-032] 内嵌MD工作台与跨平台右键集成.html
   │  │  │  │  ├── [DESIGN-ARCH-032] 内嵌MD工作台与跨平台右键集成.md
   │  │  │  │  ├── [DESIGN-ARCH-034] 动态自适应约束求解引擎.html
   │  │  │  │  ├── [DESIGN-ARCH-034] 动态自适应约束求解引擎.md
   │  │  │  │  ├── [DESIGN-ARCH-036] 万物结构化熔炉引擎.html
   │  │  │  │  ├── [DESIGN-ARCH-036] 万物结构化熔炉引擎.md
   │  │  │  │  ├── [DESIGN-ARCH-037] Khyos自举创世-需求内源发生器与闭环自愈引擎.html
   │  │  │  │  ├── [DESIGN-ARCH-037] Khyos自举创世-需求内源发生器与闭环自愈引擎.md
   │  │  │  │  ├── [DESIGN-ARCH-041] Khyos意图精准裁决-意图光谱解析与动态提权网关.html
   │  │  │  │  ├── [DESIGN-ARCH-041] Khyos意图精准裁决-意图光谱解析与动态提权网关.md
   │  │  │  │  ├── [DESIGN-ARCH-043] khy-agent-sdk-Claude对齐与D1-D6融合规范.html
   │  │  │  │  ├── [DESIGN-ARCH-043] khy-agent-sdk-Claude对齐与D1-D6融合规范.md
   │  │  │  │  ├── [DESIGN-ARCH-044] Agent自愈微循环-诊断修复重试.html
   │  │  │  │  ├── [DESIGN-ARCH-044] Agent自愈微循环-诊断修复重试.md
   │  │  │  │  ├── [DESIGN-ARCH-045] 非活跃通道生命周期治理-僵尸后台收回与日志越权阻断.html
   │  │  │  │  ├── [DESIGN-ARCH-045] 非活跃通道生命周期治理-僵尸后台收回与日志越权阻断.md
   │  │  │  │  ├── [DESIGN-ARCH-046] 聊天状态污染与回复截断治理-原子轮提交与空结果重试与截断信号保真.html
   │  │  │  │  ├── [DESIGN-ARCH-046] 聊天状态污染与回复截断治理-原子轮提交与空结果重试与截断信号保真.md
   │  │  │  │  ├── [DESIGN-ARCH-047] 轨迹溯源标准-溯源信封与防篡改链与注入隔离.html
   │  │  │  │  ├── [DESIGN-ARCH-047] 轨迹溯源标准-溯源信封与防篡改链与注入隔离.md
   │  │  │  │  ├── [DESIGN-ARCH-048] khyos轨迹回放与确定性复现.html
   │  │  │  │  ├── [DESIGN-ARCH-048] khyos轨迹回放与确定性复现.md
   │  │  │  │  ├── [DESIGN-ARCH-049] 轨迹即教材-AI引导回放.html
   │  │  │  │  ├── [DESIGN-ARCH-049] 轨迹即教材-AI引导回放.md
   │  │  │  │  ├── [DESIGN-ARCH-050] 项目整体意识与自驱收尾保障.html
   │  │  │  │  ├── [DESIGN-ARCH-050] 项目整体意识与自驱收尾保障.md
   │  │  │  │  ├── [DESIGN-ARCH-051] 单人维护者健康驾驶舱.html
   │  │  │  │  ├── [DESIGN-ARCH-051] 单人维护者健康驾驶舱.md
   │  │  │  │  ├── [DESIGN-ARCH-052] 任务驱动读取与搜索范围规划-精准而非全知.html
   │  │  │  │  ├── [DESIGN-ARCH-052] 任务驱动读取与搜索范围规划-精准而非全知.md
   │  │  │  │  ├── [DESIGN-ARCH-053] 命令与第三方应用输出折叠-几行预览与Ctrl+O展开.html
   │  │  │  │  ├── [DESIGN-ARCH-053] 命令与第三方应用输出折叠-几行预览与Ctrl+O展开.md
   │  │  │  │  ├── [DESIGN-ARCH-054] AI逆向工程-从产物还原与自验软件.html
   │  │  │  │  ├── [DESIGN-ARCH-054] AI逆向工程-从产物还原与自验软件.md
   │  │  │  │  ├── [DESIGN-ARCH-055] 对抗式训练-极端环境抗压自检与加固.html
   │  │  │  │  ├── [DESIGN-ARCH-055] 对抗式训练-极端环境抗压自检与加固.md
   │  │  │  │  ├── [DESIGN-ARCH-056] khyos桌面操控-眼耳嘴与模拟操作.html
   │  │  │  │  ├── [DESIGN-ARCH-056] khyos桌面操控-眼耳嘴与模拟操作.md
   │  │  │  │  ├── [DESIGN-ARCH-058] 细粒度权限策略与记忆主动化引擎.html
   │  │  │  │  ├── [DESIGN-ARCH-058] 细粒度权限策略与记忆主动化引擎.md
   │  │  │  │  ├── [DESIGN-ARCH-059] 能力即代码.html
   │  │  │  │  ├── [DESIGN-ARCH-059] 能力即代码.md
   │  │  │  │  ├── [DESIGN-ARCH-060] khy 功能接线与编排总图.html
   │  │  │  │  ├── [DESIGN-ARCH-060] khy 功能接线与编排总图.md
   │  │  │  │  ├── [DESIGN-ARCH-061] 更新包学习-取其精华弃其糟粕.html
   │  │  │  │  ├── [DESIGN-ARCH-061] 更新包学习-取其精华弃其糟粕.md
   │  │  │  │  ├── [DESIGN-ARCH-062] khyos 后台常驻与按需加载生命周期边界.html
   │  │  │  │  ├── [DESIGN-ARCH-062] khyos 后台常驻与按需加载生命周期边界.md
   │  │  │  │  ├── [DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS.html
   │  │  │  │  ├── [DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS.md
   │  │  │  │  ├── [DESIGN-ARCH-064] khyos 后端请求生命周期与逻辑关系图.html
   │  │  │  │  ├── [DESIGN-ARCH-064] khyos 后端请求生命周期与逻辑关系图.md
   │  │  │  │  ├── [DESIGN-ARCH-065] Hermes Agent v0.18.0 参考学习-判断验证自我进化.html
   │  │  │  │  ├── [DESIGN-ARCH-065] Hermes Agent v0.18.0 参考学习-判断验证自我进化.md
   │  │  │  │  ├── [DESIGN-ARCH-066] 前端代理出站桥-选节点实际路由与启用停用开关.html
   │  │  │  │  ├── [DESIGN-ARCH-066] 前端代理出站桥-选节点实际路由与启用停用开关.md
   │  │  │  │  ├── [DESIGN-ARCH-067] 动态模型差异化适配引擎.html
   │  │  │  │  ├── [DESIGN-ARCH-067] 动态模型差异化适配引擎.md
   │  │  │  │  ├── [DESIGN-ARCH-068] 仓库层级板块规范.html
   │  │  │  │  ├── [DESIGN-ARCH-068] 仓库层级板块规范.md
   │  │  │  │  ├── [DESIGN-ARCH-069] 拓展契约与核心边界规范.html
   │  │  │  │  ├── [DESIGN-ARCH-069] 拓展契约与核心边界规范.md
   │  │  │  │  ├── [DESIGN-ARCH-070] 治理总纲与可执行规则.html
   │  │  │  │  ├── [DESIGN-ARCH-070] 治理总纲与可执行规则.md
   │  │  │  │  ├── [DESIGN-ARCH-071] 通道选择决策矩阵.html
   │  │  │  │  ├── [DESIGN-ARCH-071] 通道选择决策矩阵.md
   │  │  │  │  ├── [DESIGN-ARCH-072] 模型上下文窗口探测规范.html
   │  │  │  │  ├── [DESIGN-ARCH-072] 模型上下文窗口探测规范.md
   │  │  │  │  ├── [DESIGN-ARCH-072] 项目规范化总纲.html
   │  │  │  │  ├── [DESIGN-ARCH-072] 项目规范化总纲.md
   │  │  │  │  ├── [DESIGN-ARCH-073] 规范快速参考卡.html
   │  │  │  │  ├── [DESIGN-ARCH-073] 规范快速参考卡.md
   │  │  │  │  ├── [DESIGN-ARCH-074] khyos 账号体系收口-用户名唯一键 alias 软冲突 密码必填 局域网登录.html
   │  │  │  │  ├── [DESIGN-ARCH-074] khyos 账号体系收口-用户名唯一键 alias 软冲突 密码必填 局域网登录.md
   │  │  │  │  ├── [DESIGN-ARCH-075] opencode高含金量功能教学与khy-os差距补齐路线.html
   │  │  │  │  ├── [DESIGN-ARCH-075] opencode高含金量功能教学与khy-os差距补齐路线.md
   │  │  │  │  ├── [DESIGN-ARCH-076] 任务最小闭环-裁决接线与交付台账.html
   │  │  │  │  ├── [DESIGN-ARCH-076] 任务最小闭环-裁决接线与交付台账.md
   │  │  │  │  ├── [DESIGN-ARCH-077] khyos 核心任务循环-稳定交付总纲.html
   │  │  │  │  ├── [DESIGN-ARCH-077] khyos 核心任务循环-稳定交付总纲.md
   │  │  │  │  ├── [DESIGN-ARCH-078] khyos桌面端与CLI-TUI互联共享方案.html
   │  │  │  │  ├── [DESIGN-ARCH-078] khyos桌面端与CLI-TUI互联共享方案.md
   │  │  │  │  ├── [DESIGN-ARCH-079] TUI界面设计规范.html
   │  │  │  │  ├── [DESIGN-ARCH-079] TUI界面设计规范.md
   │  │  │  │  ├── [DESIGN-ARCH-079] TUI组件实现提示词.html
   │  │  │  │  ├── [DESIGN-ARCH-079] TUI组件实现提示词.md
   │  │  │  │  ├── [DESIGN-ARCH-080] 网页端信息架构与四页重设计-2026-09-08.html
   │  │  │  │  ├── [DESIGN-ARCH-080] 网页端信息架构与四页重设计-2026-09-08.md
   │  │  │  │  ├── [DESIGN-ARCH-081] Claude Code TUI 1复刻实施计划.html
   │  │  │  │  ├── [DESIGN-ARCH-081] Claude Code TUI 1复刻实施计划.md
   │  │  │  │  ├── [DESIGN-ARCH-082] CC模式输入框与光标设计.html
   │  │  │  │  ├── [DESIGN-ARCH-082] CC模式输入框与光标设计.md
   │  │  │  │  ├── [DESIGN-ARCH-083] CC模式表格与折叠设计.html
   │  │  │  │  ├── [DESIGN-ARCH-083] CC模式表格与折叠设计.md
   │  │  │  │  ├── [DESIGN-ARCH-084] CC模式注意力与选择设计.html
   │  │  │  │  ├── [DESIGN-ARCH-084] CC模式注意力与选择设计.md
   │  │  │  │  ├── [DESIGN-ARCH-085] CC模式子视图子菜单卡片与滚动设计.html
   │  │  │  │  ├── [DESIGN-ARCH-085] CC模式子视图子菜单卡片与滚动设计.md
   │  │  │  │  ├── [DESIGN-ARCH-086] CC TUI 复刻总计划与子任务跟踪.html
   │  │  │  │  ├── [DESIGN-ARCH-086] CC TUI 复刻总计划与子任务跟踪.md
   │  │  │  │  ├── [DESIGN-ARCH-087] CC模式微交互与反馈设计.html
   │  │  │  │  ├── [DESIGN-ARCH-087] CC模式微交互与反馈设计.md
   │  │  │  │  ├── [DESIGN-ARCH-088] CC快捷键系统RedoFork与执行偏差处理.html
   │  │  │  │  ├── [DESIGN-ARCH-088] CC快捷键系统RedoFork与执行偏差处理.md
   │  │  │  │  ├── [DESIGN-ARCH-089] TUI设计模式调研报告.html
   │  │  │  │  ├── [DESIGN-ARCH-089] TUI设计模式调研报告.md
   │  │  │  │  ├── [DESIGN-ARCH-090] TUI用户评价调研与痛点分析.html
   │  │  │  │  ├── [DESIGN-ARCH-090] TUI用户评价调研与痛点分析.md
   │  │  │  │  ├── [DESIGN-ARCH-091] 密钥与端点中心管理（KeyManager）GUI设计规范.html
   │  │  │  │  ├── [DESIGN-ARCH-091] 密钥与端点中心管理（KeyManager）GUI设计规范.md
   │  │  │  │  ├── [DESIGN-ARCH-093] 密钥与智能体统一管理（工具矩阵与zcodeAdapter）设计规范.html
   │  │  │  │  ├── [DESIGN-ARCH-093] 密钥与智能体统一管理（工具矩阵与zcodeAdapter）设计规范.md
   │  │  │  │  ├── [DESIGN-ARCH-094] Provider卡片枢纽（CardHub）GUI设计规范.html
   │  │  │  │  ├── [DESIGN-ARCH-094] Provider卡片枢纽（CardHub）GUI设计规范.md
   │  │  │  │  ├── [DESIGN-ARCH-095] TUI交互完善调研与实施路线.html
   │  │  │  │  ├── [DESIGN-ARCH-095] TUI交互完善调研与实施路线.md
   │  │  │  │  ├── [DESIGN-ARCH-096] ycode 第二轮增量借鉴调研报告.html
   │  │  │  │  ├── [DESIGN-ARCH-096] ycode 第二轮增量借鉴调研报告.md
   │  │  │  │  ├── [DESIGN-ARCH-097] KhyOS 核心边界定稿-一词一解.html
   │  │  │  │  ├── [DESIGN-ARCH-097] KhyOS 核心边界定稿-一词一解.md
   │  │  │  │  ├── [DESIGN-ARCH-098] 系统提示词结构重设计-静态动态分层与缓存优化方案.html
   │  │  │  │  ├── [DESIGN-ARCH-098] 系统提示词结构重设计-静态动态分层与缓存优化方案.md
   │  │  │  │  ├── [DESIGN-ARCH-099] 提示词架构横向调研与khy-os对齐方案.html
   │  │  │  │  ├── [DESIGN-ARCH-099] 提示词架构横向调研与khy-os对齐方案.md
   │  │  │  │  ├── [DESIGN-ARCH-100] 模型列表真值校验与过滤规范.html
   │  │  │  │  ├── [DESIGN-ARCH-100] 模型列表真值校验与过滤规范.md
   │  │  │  │  ├── [DESIGN-ARCH-101] TUI 交互与展示规则细则.html
   │  │  │  │  ├── [DESIGN-ARCH-101] TUI 交互与展示规则细则.md
   │  │  │  │  ├── [DESIGN-ARCH-101] 代理模式统一Agent模型管理与协议桥接方案.html
   │  │  │  │  ├── [DESIGN-ARCH-101] 代理模式统一Agent模型管理与协议桥接方案.md
   │  │  │  │  ├── [DESIGN-ARCH-102] Khy TUI 统一规则手册.html
   │  │  │  │  ├── [DESIGN-ARCH-102] Khy TUI 统一规则手册.md
   │  │  │  │  ├── [DESIGN-ARCH-103] TUI 终端界面重设计方案.html
   │  │  │  │  ├── [DESIGN-ARCH-103] TUI 终端界面重设计方案.md
   │  │  │  │  ├── [DESIGN-ARCH-105] ycode 第三轮增量借鉴调研报告.html
   │  │  │  │  ├── [DESIGN-ARCH-105] ycode 第三轮增量借鉴调研报告.md
   │  │  │  │  ├── [DESIGN-ARCH-106] 项目规范化总纲.html
   │  │  │  │  ├── [DESIGN-ARCH-106] 项目规范化总纲.md
   │  │  │  │  ├── [DESIGN-ARCH-107] TUI组件实现提示词.html
   │  │  │  │  ├── [DESIGN-ARCH-107] TUI组件实现提示词.md
   │  │  │  │  ├── [DESIGN-ARCH-108] CC-TUI复刻执行提示词.html
   │  │  │  │  ├── [DESIGN-ARCH-108] CC-TUI复刻执行提示词.md
   │  │  │  │  ├── [DESIGN-ARCH-109] Y-code 借鉴实施方案.html
   │  │  │  │  ├── [DESIGN-ARCH-109] Y-code 借鉴实施方案.md
   │  │  │  │  ├── [DESIGN-ARCH-110] TUI-CLASSIC-SYNC 设计笔记.html
   │  │  │  │  ├── [DESIGN-ARCH-110] TUI-CLASSIC-SYNC 设计笔记.md
   │  │  │  │  ├── [DESIGN-ARCH-111] 规则遵守保障机制.html
   │  │  │  │  ├── [DESIGN-ARCH-111] 规则遵守保障机制.md
   │  │  │  │  ├── [DESIGN-ARCH-112] khyos-Harness架构对照.html
   │  │  │  │  ├── [DESIGN-ARCH-112] khyos-Harness架构对照.md
   │  │  │  │  ├── [DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式.html
   │  │  │  │  ├── [DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式.md
   │  │  │  │  ├── [DESIGN-ARCH-114] CLI 错误标准化规范.html
   │  │  │  │  ├── [DESIGN-ARCH-114] CLI 错误标准化规范.md
   │  │  │  │  ├── [DESIGN-ARCH-115] TUI 启动板块设计.html
   │  │  │  │  ├── [DESIGN-ARCH-115] TUI 启动板块设计.md
   │  │  │  │  ├── [DESIGN-ARCH-116] khyos-插件系统契约(@khy-plugin-sdk).html
   │  │  │  │  ├── [DESIGN-ARCH-116] khyos-插件系统契约(@khy-plugin-sdk).md
   │  │  │  │  ├── [DESIGN-ARCH-117] khy-多端入口矩阵.html
   │  │  │  │  ├── [DESIGN-ARCH-117] khy-多端入口矩阵.md
   │  │  │  │  ├── [DESIGN-ARCH-118] HQ 能力吸收与多机协作规范.html
   │  │  │  │  ├── [DESIGN-ARCH-118] HQ 能力吸收与多机协作规范.md
   │  │  │  │  ├── [DESIGN-ARCH-119] TUI原生文本选择与复制可用性修复.html
   │  │  │  │  ├── [DESIGN-ARCH-119] TUI原生文本选择与复制可用性修复.md
   │  │  │  │  ├── [DESIGN-ARCH-119] TUI文本选择与复制-验收标准.html
   │  │  │  │  ├── [DESIGN-ARCH-119] TUI文本选择与复制-验收标准.md
   │  │  │  │  ├── [DESIGN-ARCH-119] 应用内自绘选择-真渲染器验证-2026-09-17.js
   │  │  │  │  ├── [DESIGN-ARCH-119] 应用内自绘选择-端到端验证-2026-09-17.js
   │  │  │  │  ├── [DESIGN-ARCH-119] 鼠标拖选修复前后对照-2026-09-17.js
   │  │  │  │  ├── [DESIGN-ARCH-119] 鼠标拖选修复验收-2026-09-17.js
   │  │  │  │  ├── [DESIGN-ARCH-119] 鼠标拖选根因探针-2026-09-17.js
   │  │  │  │  ├── [DESIGN-ARCH-119] 鼠标拖选端到端接线验证-2026-09-17.js
   │  │  │  │  ├── [DESIGN-ARCH-120] khy-移动端合并方案.html
   │  │  │  │  ├── [DESIGN-ARCH-120] khy-移动端合并方案.md
   │  │  │  │  ├── [DESIGN-ARCH-121] khyos-CC-Harness借鉴清单.html
   │  │  │  │  ├── [DESIGN-ARCH-121] khyos-CC-Harness借鉴清单.md
   │  │  │  │  ├── [DESIGN-ARCH-122] TUI 设计族总纲.html
   │  │  │  │  ├── [DESIGN-ARCH-122] TUI 设计族总纲.md
   │  │  │  │  ├── [DESIGN-ARCH-123] K-01~K-12 施工盘点清单.html
   │  │  │  │  ├── [DESIGN-ARCH-123] K-01~K-12 施工盘点清单.md
   │  │  │  │  ├── [DESIGN-ARCH-124] CC 模式剪贴板复制能力补齐提案.html
   │  │  │  │  ├── [DESIGN-ARCH-124] CC 模式剪贴板复制能力补齐提案.md
   │  │  │  │  ├── [DESIGN-ARCH-125] 桌面端新对话卡片工作空间选择与快捷键统一登记.html
   │  │  │  │  ├── [DESIGN-ARCH-125] 桌面端新对话卡片工作空间选择与快捷键统一登记.md
   │  │  │  │  ├── [DESIGN-ARCH-126] 跨端 AI 编程任务看板泳道编排方案.html
   │  │  │  │  ├── [DESIGN-ARCH-126] 跨端 AI 编程任务看板泳道编排方案.md
   │  │  │  │  ├── [DESIGN-ARCH-127] khyos 可维护性诊断与减负方案.html
   │  │  │  │  ├── [DESIGN-ARCH-127] khyos 可维护性诊断与减负方案.md
   │  │  │  │  ├── [DESIGN-ARCH-128] khyos结构化输出方案-输出卫生层与语义渲染契约.html
   │  │  │  │  ├── [DESIGN-ARCH-128] khyos结构化输出方案-输出卫生层与语义渲染契约.md
   │  │  │  │  ├── [DESIGN-ARCH-129] TUI 滚动-选择-历史-固定底部共存设计.html
   │  │  │  │  ├── [DESIGN-ARCH-129] TUI 滚动-选择-历史-固定底部共存设计.md
   │  │  │  │  ├── [DESIGN-ARCH-130] 前台与后台任务编排方案.html
   │  │  │  │  ├── [DESIGN-ARCH-130] 前台与后台任务编排方案.md
   │  │  │  │  ├── [DESIGN-ARCH-131] 报错一键交修闭环方案.html
   │  │  │  │  ├── [DESIGN-ARCH-131] 报错一键交修闭环方案.md
   │  │  │  │  ├── [DESIGN-ARCH-132] TUI选区锚点漂移修复方案.html
   │  │  │  │  ├── [DESIGN-ARCH-132] TUI选区锚点漂移修复方案.md
   │  │  │  │  ├── [DESIGN-ARCH-133] 桌面端基本任务闭环-接入智能体工具循环.html
   │  │  │  │  ├── [DESIGN-ARCH-133] 桌面端基本任务闭环-接入智能体工具循环.md
   │  │  │  │  ├── [DESIGN-ARCH-134] TUI 启动屏视觉重设计.html
   │  │  │  │  ├── [DESIGN-ARCH-134] TUI 启动屏视觉重设计.md
   │  │  │  │  ├── [DESIGN-ARCH-135] TUI长任务会话中断与压缩不接续修复方案.html
   │  │  │  │  ├── [DESIGN-ARCH-135] TUI长任务会话中断与压缩不接续修复方案.md
   │  │  │  │  ├── [DESIGN-ARCH-136] 零尝试失败被误报为钉选抑制的修复方案.html
   │  │  │  │  ├── [DESIGN-ARCH-136] 零尝试失败被误报为钉选抑制的修复方案.md
   │  │  │  │  ├── [DESIGN-ARCH-137] khyos运行时信息获取规则与读取预算接线方案.html
   │  │  │  │  ├── [DESIGN-ARCH-137] khyos运行时信息获取规则与读取预算接线方案.md
   │  │  │  │  ├── [DESIGN-ARCH-138] 工具调用能力判定与文本拦截协议.html
   │  │  │  │  ├── [DESIGN-ARCH-138] 工具调用能力判定与文本拦截协议.md
   │  │  │  │  ├── [DESIGN-ARCH-139] 网关零尝试(NO_ATTEMPT)与钉选残留第6次复发修复方案.html
   │  │  │  │  ├── [DESIGN-ARCH-139] 网关零尝试(NO_ATTEMPT)与钉选残留第6次复发修复方案.md
   │  │  │  │  ├── [DESIGN-ARCH-140] khy启动卡顿定位与首帧前置方案.html
   │  │  │  │  ├── [DESIGN-ARCH-140] khy启动卡顿定位与首帧前置方案.md
   │  │  │  │  ├── [DESIGN-ARCH-140] 规则与规范依托全景盘点与补全提案.html
   │  │  │  │  ├── [DESIGN-ARCH-140] 规则与规范依托全景盘点与补全提案.md
   │  │  │  │  ├── [DESIGN-ARCH-141] 动态工作流-运行时自演化与节点热插拔方案.html
   │  │  │  │  ├── [DESIGN-ARCH-141] 动态工作流-运行时自演化与节点热插拔方案.md
   │  │  │  │  ├── [DESIGN-ARCH-142] 用户数据安全更新与可选更新机制.html
   │  │  │  │  ├── [DESIGN-ARCH-142] 用户数据安全更新与可选更新机制.md
   │  │  │  │  ├── [DESIGN-ARCH-143] DSH插件生态接入评估与分层适配方案.html
   │  │  │  │  ├── [DESIGN-ARCH-143] DSH插件生态接入评估与分层适配方案.md
   │  │  │  │  ├── [DESIGN-ARCH-144] khyquant剥离为可选拓展的结构划分与接口契约方案.html
   │  │  │  │  ├── [DESIGN-ARCH-144] khyquant剥离为可选拓展的结构划分与接口契约方案.md
   │  │  │  │  ├── [DESIGN-ARCH-145] 用户DIY空间分层与安全边界统一方案.html
   │  │  │  │  ├── [DESIGN-ARCH-145] 用户DIY空间分层与安全边界统一方案.md
   │  │  │  │  ├── [DESIGN-ARCH-146] TUI 卡片点击交互-选项命中与展开方案.html
   │  │  │  │  ├── [DESIGN-ARCH-146] TUI 卡片点击交互-选项命中与展开方案.md
   │  │  │  │  ├── [DESIGN-ARCH-147] 好设计十诫的工程映射与设计判据落地方案.html
   │  │  │  │  ├── [DESIGN-ARCH-147] 好设计十诫的工程映射与设计判据落地方案.md
   │  │  │  │  ├── [DESIGN-ARCH-148] README漏斗式重设计与真源指针化方案.html
   │  │  │  │  ├── [DESIGN-ARCH-148] README漏斗式重设计与真源指针化方案.md
   │  │  │  │  ├── [DESIGN-ARCH-149] TUI选区复制携带ANSI残留修复方案.html
   │  │  │  │  ├── [DESIGN-ARCH-149] TUI选区复制携带ANSI残留修复方案.md
   │  │  │  │  ├── [DESIGN-ARCH-150] 模型设置页排版减负与配置动线重设计.html
   │  │  │  │  ├── [DESIGN-ARCH-150] 模型设置页排版减负与配置动线重设计.md
   │  │  │  │  ├── [DESIGN-ARCH-151] TUI思维链折叠存储与显示减负方案.html
   │  │  │  │  ├── [DESIGN-ARCH-151] TUI思维链折叠存储与显示减负方案.md
   │  │  │  │  ├── [DESIGN-ARCH-152] 聊天气泡布局与系统提示词防泄露、思考过程与工具卡片渲染方案.html
   │  │  │  │  ├── [DESIGN-ARCH-152] 聊天气泡布局与系统提示词防泄露、思考过程与工具卡片渲染方案.md
   │  │  │  │  ├── [DESIGN-ARCH-153] khy 自知面对齐规范.html
   │  │  │  │  ├── [DESIGN-ARCH-153] khy 自知面对齐规范.md
   │  │  │  │  ├── [DESIGN-ARCH-154] 上下文窗口真值贯通-网关免费目录供血与前后端一致方案.html
   │  │  │  │  ├── [DESIGN-ARCH-154] 上下文窗口真值贯通-网关免费目录供血与前后端一致方案.md
   │  │  │  │  ├── [DESIGN-ARCH-155] 工具调用短显示规范-TUI与桌面统一.html
   │  │  │  │  ├── [DESIGN-ARCH-155] 工具调用短显示规范-TUI与桌面统一.md
   │  │  │  │  ├── [DESIGN-ARCH-156] TUI帧生成管线契约化-高度账本与字节出口单一所有者方案.html
   │  │  │  │  ├── [DESIGN-ARCH-156] TUI帧生成管线契约化-高度账本与字节出口单一所有者方案.md
   │  │  │  │  ├── [DESIGN-ARCH-157] 文件修改红绿diff三端统一规格.html
   │  │  │  │  ├── [DESIGN-ARCH-157] 文件修改红绿diff三端统一规格.md
   │  │  │  │  ├── [DESIGN-ARCH-158] TUI默认承载路径工具条目投影缺失修复方案.html
   │  │  │  │  ├── [DESIGN-ARCH-158] TUI默认承载路径工具条目投影缺失修复方案.md
   │  │  │  │  ├── [DESIGN-ARCH-159] CLI命令输出层次化与缩进统一方案.html
   │  │  │  │  ├── [DESIGN-ARCH-159] CLI命令输出层次化与缩进统一方案.md
   │  │  │  │  ├── [DESIGN-ARCH-160] 惯性执行机制设计方案.html
   │  │  │  │  ├── [DESIGN-ARCH-160] 惯性执行机制设计方案.md
   │  │  │  │  ├── [DESIGN-ARCH-161] 任务执行时延与质量优化方案.html
   │  │  │  │  ├── [DESIGN-ARCH-161] 任务执行时延与质量优化方案.md
   │  │  │  │  ├── [DESIGN-ARCH-162] Auto模式模型粒度健康路由方案.html
   │  │  │  │  ├── [DESIGN-ARCH-162] Auto模式模型粒度健康路由方案.md
   │  │  │  │  ├── [DESIGN-ARCH-163] 图文混合输入识别增强方案.html
   │  │  │  │  ├── [DESIGN-ARCH-163] 图文混合输入识别增强方案.md
   │  │  │  │  ├── [DESIGN-ARCH-164] 用户需求理解管线-意图裁决澄清问询与需求固化方案.html
   │  │  │  │  ├── [DESIGN-ARCH-164] 用户需求理解管线-意图裁决澄清问询与需求固化方案.md
   │  │  │  │  ├── [DESIGN-ARCH-165] TUI 工具卡片渲染规格与两端分工方案.html
   │  │  │  │  ├── [DESIGN-ARCH-165] TUI 工具卡片渲染规格与两端分工方案.md
   │  │  │  │  ├── [DESIGN-ARCH-166] 静默失效与真源漂移四例收敛方案.html
   │  │  │  │  ├── [DESIGN-ARCH-166] 静默失效与真源漂移四例收敛方案.md
   │  │  │  │  ├── [DESIGN-ARCH-167] 模型选择列表分组与信息分层方案.html
   │  │  │  │  ├── [DESIGN-ARCH-167] 模型选择列表分组与信息分层方案.md
   │  │  │  │  ├── [DESIGN-ARCH-168] 开机零自启与按需懒加载方案.html
   │  │  │  │  ├── [DESIGN-ARCH-168] 开机零自启与按需懒加载方案.md
   │  │  │  │  ├── [DESIGN-ARCH-169] khychat启动假阴性-就绪信号后置与守护僵尸化方案.html
   │  │  │  │  ├── [DESIGN-ARCH-169] khychat启动假阴性-就绪信号后置与守护僵尸化方案.md
   │  │  │  │  ├── [DESIGN-ARCH-170] 桌面端X报错功能接线与指路真实性方案.html
   │  │  │  │  ├── [DESIGN-ARCH-170] 桌面端X报错功能接线与指路真实性方案.md
   │  │  │  │  ├── [DESIGN-ARCH-171] 未接入后端判定与接线守卫真实性方案.html
   │  │  │  │  ├── [DESIGN-ARCH-171] 未接入后端判定与接线守卫真实性方案.md
   │  │  │  │  ├── [DESIGN-ARCH-176] TUI 与桌面端统一方案：底色分层 · 稳定渲染 · 共享语义.html
   │  │  │  │  └── [DESIGN-ARCH-176] TUI 与桌面端统一方案：底色分层 · 稳定渲染 · 共享语义.md
   │  │  │  ├── DESIGN-CPA
   │  │  │  │  ├── 00_INDEX_DESIGN-CPA-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-CPA-总目录.md
   │  │  │  │  ├── [DESIGN-CPA-001] CPA 反代集成方案.html
   │  │  │  │  ├── [DESIGN-CPA-001] CPA 反代集成方案.md
   │  │  │  │  ├── [DESIGN-CPA-002] CPA+NewAPI 分层架构实施方案.html
   │  │  │  │  ├── [DESIGN-CPA-002] CPA+NewAPI 分层架构实施方案.md
   │  │  │  │  ├── [DESIGN-CPA-003] CPA接入层+NewAPI治理层分层架构.html
   │  │  │  │  └── [DESIGN-CPA-003] CPA接入层+NewAPI治理层分层架构.md
   │  │  │  ├── DESIGN-FE
   │  │  │  │  ├── 00_INDEX_DESIGN-FE-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-FE-总目录.md
   │  │  │  │  ├── [DESIGN-FE-001] 前端页面规范.html
   │  │  │  │  ├── [DESIGN-FE-001] 前端页面规范.md
   │  │  │  │  ├── [DESIGN-FE-002] 前端组件库规范.html
   │  │  │  │  ├── [DESIGN-FE-002] 前端组件库规范.md
   │  │  │  │  ├── [DESIGN-FE-003] 前端快速参考卡.html
   │  │  │  │  └── [DESIGN-FE-003] 前端快速参考卡.md
   │  │  │  ├── DESIGN-FOLD
   │  │  │  │  ├── 00_INDEX_DESIGN-FOLD-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-FOLD-总目录.md
   │  │  │  │  ├── [DESIGN-FOLD-001] 子任务副屏折叠展开统一设计.html
   │  │  │  │  └── [DESIGN-FOLD-001] 子任务副屏折叠展开统一设计.md
   │  │  │  ├── DESIGN-MEM
   │  │  │  │  ├── 00_INDEX_DESIGN-MEM-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-MEM-总目录.md
   │  │  │  │  ├── [DESIGN-MEM-000] 记忆系统总结.html
   │  │  │  │  ├── [DESIGN-MEM-000] 记忆系统总结.md
   │  │  │  │  ├── [DESIGN-MEM-001] 记忆系统标准规范.html
   │  │  │  │  ├── [DESIGN-MEM-001] 记忆系统标准规范.md
   │  │  │  │  ├── [DESIGN-MEM-002] 记忆时机指南.html
   │  │  │  │  ├── [DESIGN-MEM-002] 记忆时机指南.md
   │  │  │  │  ├── [DESIGN-MEM-003] 记忆模板库.html
   │  │  │  │  ├── [DESIGN-MEM-003] 记忆模板库.md
   │  │  │  │  ├── [DESIGN-MEM-004] 记忆快速参考卡.html
   │  │  │  │  ├── [DESIGN-MEM-004] 记忆快速参考卡.md
   │  │  │  │  ├── [DESIGN-MEM-005] 记忆系统使用指南.html
   │  │  │  │  ├── [DESIGN-MEM-005] 记忆系统使用指南.md
   │  │  │  │  ├── [DESIGN-MEM-007] 记忆规则系统总纲.html
   │  │  │  │  └── [DESIGN-MEM-007] 记忆规则系统总纲.md
   │  │  │  ├── DESIGN-OTHER
   │  │  │  │  ├── 00_INDEX_DESIGN-OTHER-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-OTHER-总目录.md
   │  │  │  │  ├── [DESIGN-OTHER-001] Khyos-数学重塑-实施提示词链.html
   │  │  │  │  ├── [DESIGN-OTHER-001] Khyos-数学重塑-实施提示词链.md
   │  │  │  │  ├── [DESIGN-OTHER-002] _cbssp_分阶段防闪退提示词.html
   │  │  │  │  ├── [DESIGN-OTHER-002] _cbssp_分阶段防闪退提示词.md
   │  │  │  │  ├── [DESIGN-OTHER-003] khy-系统提示词结构图.html
   │  │  │  │  ├── [DESIGN-OTHER-003] khy-系统提示词结构图.md
   │  │  │  │  ├── [DESIGN-OTHER-004] 特性访问-提示词胶囊-2026-06-01.html
   │  │  │  │  ├── [DESIGN-OTHER-004] 特性访问-提示词胶囊-2026-06-01.md
   │  │  │  │  ├── [DESIGN-OTHER-005] desktop-rd-桌面端调研指针.html
   │  │  │  │  └── [DESIGN-OTHER-005] desktop-rd-桌面端调研指针.md
   │  │  │  ├── DESIGN-PERF
   │  │  │  │  ├── 00_INDEX_DESIGN-PERF-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-PERF-总目录.md
   │  │  │  │  ├── [DESIGN-PERF-001] khy-cli-交互流畅度修复方案-v1.html
   │  │  │  │  ├── [DESIGN-PERF-001] khy-cli-交互流畅度修复方案-v1.md
   │  │  │  │  ├── [DESIGN-PERF-001] 性能规范.html
   │  │  │  │  ├── [DESIGN-PERF-001] 性能规范.md
   │  │  │  │  ├── [DESIGN-PERF-002] khy-cli-交互流畅度修复方案-v1.html
   │  │  │  │  ├── [DESIGN-PERF-002] khy-cli-交互流畅度修复方案-v1.md
   │  │  │  │  ├── [DESIGN-PERF-003] TUI 启动阻塞治理方案.html
   │  │  │  │  ├── [DESIGN-PERF-003] TUI 启动阻塞治理方案.md
   │  │  │  │  ├── [DESIGN-PERF-004] TUI 动画节拍治理方案.html
   │  │  │  │  ├── [DESIGN-PERF-004] TUI 动画节拍治理方案.md
   │  │  │  │  ├── [DESIGN-PERF-005] khy-chat-启动慢与报错链治理方案.html
   │  │  │  │  └── [DESIGN-PERF-005] khy-chat-启动慢与报错链治理方案.md
   │  │  │  ├── DESIGN-RES
   │  │  │  │  ├── 00_INDEX_DESIGN-RES-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-RES-总目录.md
   │  │  │  │  ├── [DESIGN-RES-001] 桌面端智能体UI调研与差距分析-2026-09-09.html
   │  │  │  │  ├── [DESIGN-RES-001] 桌面端智能体UI调研与差距分析-2026-09-09.md
   │  │  │  │  ├── [DESIGN-RES-002] 桌面端智能体UI每日调研-2026-09-10.html
   │  │  │  │  ├── [DESIGN-RES-002] 桌面端智能体UI每日调研-2026-09-10.md
   │  │  │  │  ├── [DESIGN-RES-003] 跨Agent技能MCP统一管理-阶段一调研.html
   │  │  │  │  └── [DESIGN-RES-003] 跨Agent技能MCP统一管理-阶段一调研.md
   │  │  │  ├── [DESIGN-CICD-001] CI
   │  │  │  │  ├── CD 规范.html
   │  │  │  │  └── CD 规范.md
   │  │  │  ├── _archive_已删除孤儿引擎
   │  │  │  │  ├── 00_INDEX_已删除孤儿引擎归档.md
   │  │  │  │  ├── [DESIGN-ARCH-024] khyos元帅双模式任命与约束规范.md
   │  │  │  │  ├── [DESIGN-ARCH-033] 模型自适应与双轨热插拔架构.md
   │  │  │  │  ├── [DESIGN-ARCH-035] 上下文永续与认知压缩引擎.md
   │  │  │  │  ├── [DESIGN-ARCH-038] Khyos双轨淬火-确定性保底与模型辅助增强的Bug升维引擎.md
   │  │  │  │  ├── [DESIGN-ARCH-039] Khyos环境共生-环境感知与原生亲和架构.md
   │  │  │  │  ├── [DESIGN-ARCH-040] Khyos数据主权与极权路由-数据主权绝对论与单一权威注入网关.md
   │  │  │  │  └── [DESIGN-ARCH-042] Khyos自持基建-契约即文档与影响面评估与行为守卫.md
   │  │  │  └── 其它设计
   │  │  │     ├── 00_INDEX_其它设计-总目录.html
   │  │  │     ├── 00_INDEX_其它设计-总目录.md
   │  │  │     ├── EXECUTION_PROMPT.html
   │  │  │     ├── EXECUTION_PROMPT.md
   │  │  │     ├── [DESIGN-A11Y-001] 可访问性规范.html
   │  │  │     ├── [DESIGN-A11Y-001] 可访问性规范.md
   │  │  │     ├── [DESIGN-A2A-001] A2A 协议规范.html
   │  │  │     ├── [DESIGN-A2A-001] A2A 协议规范.md
   │  │  │     ├── [DESIGN-API-001] API 设计规范.html
   │  │  │     ├── [DESIGN-API-001] API 设计规范.md
   │  │  │     ├── [DESIGN-CACHE-001] 缓存规范.html
   │  │  │     ├── [DESIGN-CACHE-001] 缓存规范.md
   │  │  │     ├── [DESIGN-COMM-001] 通信协议规范.html
   │  │  │     ├── [DESIGN-COMM-001] 通信协议规范.md
   │  │  │     ├── [DESIGN-DB-001] 数据库规范.html
   │  │  │     ├── [DESIGN-DB-001] 数据库规范.md
   │  │  │     ├── [DESIGN-DEP-001] 依赖管理规范.html
   │  │  │     ├── [DESIGN-DEP-001] 依赖管理规范.md
   │  │  │     ├── [DESIGN-DEPLOY-001] 部署规范.html
   │  │  │     ├── [DESIGN-DEPLOY-001] 部署规范.md
   │  │  │     ├── [DESIGN-DOC-001] 文档结构规范.html
   │  │  │     ├── [DESIGN-DOC-001] 文档结构规范.md
   │  │  │     ├── [DESIGN-ENV-001] 环境配置规范.html
   │  │  │     ├── [DESIGN-ENV-001] 环境配置规范.md
   │  │  │     ├── [DESIGN-ERR-001] 错误处理规范.html
   │  │  │     ├── [DESIGN-ERR-001] 错误处理规范.md
   │  │  │     ├── [DESIGN-GIT-001] Git 工作流规范.html
   │  │  │     ├── [DESIGN-GIT-001] Git 工作流规范.md
   │  │  │     ├── [DESIGN-I18N-001] 国际化规范.html
   │  │  │     ├── [DESIGN-I18N-001] 国际化规范.md
   │  │  │     ├── [DESIGN-INDEX-001] 规范索引.html
   │  │  │     ├── [DESIGN-INDEX-001] 规范索引.md
   │  │  │     ├── [DESIGN-LEGISLATION] 跨Agent技能MCP统一管理-阶段二立法清单.html
   │  │  │     ├── [DESIGN-LEGISLATION] 跨Agent技能MCP统一管理-阶段二立法清单.md
   │  │  │     ├── [DESIGN-LOG-001] 日志规范.html
   │  │  │     ├── [DESIGN-LOG-001] 日志规范.md
   │  │  │     ├── [DESIGN-MONITOR-001] 监控告警规范.html
   │  │  │     ├── [DESIGN-MONITOR-001] 监控告警规范.md
   │  │  │     ├── [DESIGN-MS-001] 微服务通信规范.html
   │  │  │     ├── [DESIGN-MS-001] 微服务通信规范.md
   │  │  │     ├── [DESIGN-OUT-001] 输出结构规范.html
   │  │  │     ├── [DESIGN-OUT-001] 输出结构规范.md
   │  │  │     ├── [DESIGN-PHILOSOPHY] 设计哲学总纲.html
   │  │  │     ├── [DESIGN-PHILOSOPHY] 设计哲学总纲.md
   │  │  │     ├── [DESIGN-PRIV-001] 数据隐私规范.html
   │  │  │     ├── [DESIGN-PRIV-001] 数据隐私规范.md
   │  │  │     ├── [DESIGN-QUICK-REF] 设计模式速查卡.html
   │  │  │     ├── [DESIGN-QUICK-REF] 设计模式速查卡.md
   │  │  │     ├── [DESIGN-RESEARCH] 桌面端智能体UI每日调研-2026-09-10.html
   │  │  │     ├── [DESIGN-RESEARCH] 桌面端智能体UI每日调研-2026-09-10.md
   │  │  │     ├── [DESIGN-RESEARCH] 桌面端智能体UI调研与差距分析-2026-09-09.html
   │  │  │     ├── [DESIGN-RESEARCH] 桌面端智能体UI调研与差距分析-2026-09-09.md
   │  │  │     ├── [DESIGN-RESEARCH] 跨Agent技能MCP统一管理-阶段一调研.html
   │  │  │     ├── [DESIGN-RESEARCH] 跨Agent技能MCP统一管理-阶段一调研.md
   │  │  │     ├── [DESIGN-REVIEW-001] 代码审查规范.html
   │  │  │     ├── [DESIGN-REVIEW-001] 代码审查规范.md
   │  │  │     ├── [DESIGN-SIZE-001] khy-os 体积优化方案.html
   │  │  │     ├── [DESIGN-SIZE-001] khy-os 体积优化方案.md
   │  │  │     ├── [DESIGN-TEST-001] 测试规范.html
   │  │  │     ├── [DESIGN-TEST-001] 测试规范.md
   │  │  │     ├── ycode-inspiration-plan.html
   │  │  │     └── ycode-inspiration-plan.md
   │  │  ├── 04_IMPL_实现
   │  │  │  ├── 00_INDEX_实现-分类索引.html
   │  │  │  ├── 00_INDEX_实现-分类索引.md
   │  │  │  ├── IMPL-RPT
   │  │  │  │  ├── 00_INDEX_IMPL-RPT-总目录.html
   │  │  │  │  ├── 00_INDEX_IMPL-RPT-总目录.md
   │  │  │  │  ├── [IMPL-RPT-001] executeCode-进程级真隔离-2026-06-10.html
   │  │  │  │  ├── [IMPL-RPT-001] executeCode-进程级真隔离-2026-06-10.md
   │  │  │  │  ├── [IMPL-RPT-002] kiro-连接修复-2026-06-05.html
   │  │  │  │  ├── [IMPL-RPT-002] kiro-连接修复-2026-06-05.md
   │  │  │  │  ├── [IMPL-RPT-003] tui-inquirer闪退修复-2026-06-05.html
   │  │  │  │  ├── [IMPL-RPT-003] tui-inquirer闪退修复-2026-06-05.md
   │  │  │  │  ├── [IMPL-RPT-004] tui-叙事与选择覆盖层-2026-06-01.html
   │  │  │  │  ├── [IMPL-RPT-004] tui-叙事与选择覆盖层-2026-06-01.md
   │  │  │  │  ├── [IMPL-RPT-005] tui-权限授权掉cooked模式修复-2026-06-09.html
   │  │  │  │  ├── [IMPL-RPT-005] tui-权限授权掉cooked模式修复-2026-06-09.md
   │  │  │  │  ├── [IMPL-RPT-006] tui-流式与上下文显示-2026-06-01.html
   │  │  │  │  ├── [IMPL-RPT-006] tui-流式与上下文显示-2026-06-01.md
   │  │  │  │  ├── [IMPL-RPT-007] v0.1.84-修复说明.html
   │  │  │  │  ├── [IMPL-RPT-007] v0.1.84-修复说明.md
   │  │  │  │  ├── [IMPL-RPT-008] 修复-桥接状态刷屏.html
   │  │  │  │  ├── [IMPL-RPT-008] 修复-桥接状态刷屏.md
   │  │  │  │  ├── [IMPL-RPT-009] 特性访问与代理解耦-2026-06-01.html
   │  │  │  │  ├── [IMPL-RPT-009] 特性访问与代理解耦-2026-06-01.md
   │  │  │  │  ├── [IMPL-RPT-010] 网关适配器可用性严格化-本地安装与登录-2026-06-10.html
   │  │  │  │  ├── [IMPL-RPT-010] 网关适配器可用性严格化-本地安装与登录-2026-06-10.md
   │  │  │  │  ├── [IMPL-RPT-011] 航天级重构白皮书-2026-06-10.html
   │  │  │  │  ├── [IMPL-RPT-011] 航天级重构白皮书-2026-06-10.md
   │  │  │  │  ├── [IMPL-RPT-012] 航天级重构白皮书-第二轮-2026-06-10.html
   │  │  │  │  ├── [IMPL-RPT-012] 航天级重构白皮书-第二轮-2026-06-10.md
   │  │  │  │  ├── [IMPL-RPT-013] khy-claude-认证冲突修复.html
   │  │  │  │  ├── [IMPL-RPT-013] khy-claude-认证冲突修复.md
   │  │  │  │  ├── [IMPL-RPT-014] trae-适配器-官方扫描修复-2026-05-25.html
   │  │  │  │  ├── [IMPL-RPT-014] trae-适配器-官方扫描修复-2026-05-25.md
   │  │  │  │  ├── [IMPL-RPT-015] 修复记录时间线.html
   │  │  │  │  ├── [IMPL-RPT-015] 修复记录时间线.md
   │  │  │  │  ├── [IMPL-RPT-016] 剪贴板粘贴修复.html
   │  │  │  │  ├── [IMPL-RPT-016] 剪贴板粘贴修复.md
   │  │  │  │  ├── [IMPL-RPT-017] 守护进程端口发现修复.html
   │  │  │  │  ├── [IMPL-RPT-017] 守护进程端口发现修复.md
   │  │  │  │  ├── [IMPL-RPT-018] 管理前端自动可用修复-2026-05-31.html
   │  │  │  │  ├── [IMPL-RPT-018] 管理前端自动可用修复-2026-05-31.md
   │  │  │  │  ├── [IMPL-RPT-019] 终端提示符泄漏与交付空行修复-2026-05-31.html
   │  │  │  │  ├── [IMPL-RPT-019] 终端提示符泄漏与交付空行修复-2026-05-31.md
   │  │  │  │  ├── [IMPL-RPT-020] 网关传输韧性修复-2026-05-29.html
   │  │  │  │  ├── [IMPL-RPT-020] 网关传输韧性修复-2026-05-29.md
   │  │  │  │  ├── [IMPL-RPT-021] 网关超时与帧修复.html
   │  │  │  │  ├── [IMPL-RPT-021] 网关超时与帧修复.md
   │  │  │  │  ├── [IMPL-RPT-022] HOTFIX_MODEL_SELECTION.html
   │  │  │  │  ├── [IMPL-RPT-022] HOTFIX_MODEL_SELECTION.md
   │  │  │  │  ├── [IMPL-RPT-023] 文档排版-内容与样式分离-2026-06-12.html
   │  │  │  │  ├── [IMPL-RPT-023] 文档排版-内容与样式分离-2026-06-12.md
   │  │  │  │  ├── [IMPL-RPT-024] 元帅双模式任命与约束-2026-06-12.html
   │  │  │  │  ├── [IMPL-RPT-024] 元帅双模式任命与约束-2026-06-12.md
   │  │  │  │  ├── [IMPL-RPT-025] 元规划协议与动态约束注入-2026-06-12.html
   │  │  │  │  ├── [IMPL-RPT-025] 元规划协议与动态约束注入-2026-06-12.md
   │  │  │  │  ├── [IMPL-RPT-026] 生态架构重塑日志-2026-06-12.html
   │  │  │  │  ├── [IMPL-RPT-026] 生态架构重塑日志-2026-06-12.md
   │  │  │  │  ├── [IMPL-RPT-027] 前后端对接与交互重构日志-2026-06-12.html
   │  │  │  │  ├── [IMPL-RPT-027] 前后端对接与交互重构日志-2026-06-12.md
   │  │  │  │  ├── [IMPL-RPT-028] 按需加载与零噪音重构日志-2026-06-12.html
   │  │  │  │  ├── [IMPL-RPT-028] 按需加载与零噪音重构日志-2026-06-12.md
   │  │  │  │  ├── [IMPL-RPT-029] 夜间代码质量与健壮性完善日志-2026-06-11.html
   │  │  │  │  ├── [IMPL-RPT-029] 夜间代码质量与健壮性完善日志-2026-06-11.md
   │  │  │  │  ├── [IMPL-RPT-030] Agnes四模型一键置备-文生图图改图视频-2026-06-20.html
   │  │  │  │  ├── [IMPL-RPT-030] Agnes四模型一键置备-文生图图改图视频-2026-06-20.md
   │  │  │  │  ├── [IMPL-RPT-031] 多视角模型配置-单一图谱八视角-2026-06-20.html
   │  │  │  │  ├── [IMPL-RPT-031] 多视角模型配置-单一图谱八视角-2026-06-20.md
   │  │  │  │  ├── [IMPL-RPT-032] 有学习价值的Bug汇编-UX漂移与half-wired.html
   │  │  │  │  ├── [IMPL-RPT-032] 有学习价值的Bug汇编-UX漂移与half-wired.md
   │  │  │  │  ├── [IMPL-RPT-033] 后端公理化重构-网关与定价原子化-2026-07-30.html
   │  │  │  │  ├── [IMPL-RPT-033] 后端公理化重构-网关与定价原子化-2026-07-30.md
   │  │  │  │  ├── [IMPL-RPT-040] CC-zip1 命令对齐账本.html
   │  │  │  │  ├── [IMPL-RPT-040] CC-zip1 命令对齐账本.md
   │  │  │  │  ├── [IMPL-RPT-041] Qoder接入khy网关与开机自启实现记录-2026-07-13.html
   │  │  │  │  ├── [IMPL-RPT-041] Qoder接入khy网关与开机自启实现记录-2026-07-13.md
   │  │  │  │  ├── [IMPL-RPT-042] 交互过程与输出结构化-持久化与机器可读输出-2026-07-27.html
   │  │  │  │  ├── [IMPL-RPT-042] 交互过程与输出结构化-持久化与机器可读输出-2026-07-27.md
   │  │  │  │  ├── [IMPL-RPT-043] 输出截断根治与无感接续-max_tokens元数据缺失与锚点续写-2026-08-07.html
   │  │  │  │  ├── [IMPL-RPT-043] 输出截断根治与无感接续-max_tokens元数据缺失与锚点续写-2026-08-07.md
   │  │  │  │  ├── [IMPL-RPT-044] khyos 账号体系收口实施记录-ARCH-074-2026-09-02.html
   │  │  │  │  ├── [IMPL-RPT-044] khyos 账号体系收口实施记录-ARCH-074-2026-09-02.md
   │  │  │  │  ├── [IMPL-RPT-045] TUI按钮点击调研与鼠标历史回溯设计决策-2026-09-05.html
   │  │  │  │  ├── [IMPL-RPT-045] TUI按钮点击调研与鼠标历史回溯设计决策-2026-09-05.md
   │  │  │  │  ├── [IMPL-RPT-046] 渠道 API 文档板块-2026-09-08.html
   │  │  │  │  ├── [IMPL-RPT-046] 渠道 API 文档板块-2026-09-08.md
   │  │  │  │  ├── [IMPL-RPT-047] 六道治理债清理与密钥轮换-2026-09-08.html
   │  │  │  │  ├── [IMPL-RPT-047] 六道治理债清理与密钥轮换-2026-09-08.md
   │  │  │  │  ├── [IMPL-RPT-048] 网页端 Phase1 把坏暴露出来-落地记录-2026-09-08.html
   │  │  │  │  ├── [IMPL-RPT-048] 网页端 Phase1 把坏暴露出来-落地记录-2026-09-08.md
   │  │  │  │  ├── [IMPL-RPT-049] 规范族文档拆分为独立规范目录-2026-09-10.html
   │  │  │  │  ├── [IMPL-RPT-049] 规范族文档拆分为独立规范目录-2026-09-10.md
   │  │  │  │  ├── [IMPL-RPT-050] 规范简洁化与情景速查-2026-09-10.html
   │  │  │  │  ├── [IMPL-RPT-050] 规范简洁化与情景速查-2026-09-10.md
   │  │  │  │  ├── [IMPL-RPT-051] 工具注册表自愈层规范.html
   │  │  │  │  ├── [IMPL-RPT-051] 工具注册表自愈层规范.md
   │  │  │  │  ├── [IMPL-RPT-052] khy-启动性能修复报告-2026-09-14.html
   │  │  │  │  ├── [IMPL-RPT-052] khy-启动性能修复报告-2026-09-14.md
   │  │  │  │  ├── [IMPL-RPT-053] TUI-输出回显与滚轮修复-验收报告-2026-09-16.html
   │  │  │  │  ├── [IMPL-RPT-053] TUI-输出回显与滚轮修复-验收报告-2026-09-16.md
   │  │  │  │  ├── [IMPL-RPT-054] khy-os-代码规范修复报告-2026-09-04.html
   │  │  │  │  ├── [IMPL-RPT-054] khy-os-代码规范修复报告-2026-09-04.md
   │  │  │  │  ├── [IMPL-RPT-055] khy-os-规范修复最终验证报告-2026-09-04.html
   │  │  │  │  ├── [IMPL-RPT-055] khy-os-规范修复最终验证报告-2026-09-04.md
   │  │  │  │  ├── [IMPL-RPT-056] 文档精简与结构化整理落地记录.html
   │  │  │  │  ├── [IMPL-RPT-056] 文档精简与结构化整理落地记录.md
   │  │  │  │  ├── [IMPL-RPT-057] ARCH-119-提交完成与崩溃恢复报告-2026-09-18.html
   │  │  │  │  ├── [IMPL-RPT-057] ARCH-119-提交完成与崩溃恢复报告-2026-09-18.md
   │  │  │  │  ├── [IMPL-RPT-058] ARCH-119-逐hunk拆分提交-进度-2026-09-18.html
   │  │  │  │  ├── [IMPL-RPT-058] ARCH-119-逐hunk拆分提交-进度-2026-09-18.md
   │  │  │  │  ├── [IMPL-RPT-059] 上下状态显示一致-修复方案-2026-09-17.html
   │  │  │  │  ├── [IMPL-RPT-059] 上下状态显示一致-修复方案-2026-09-17.md
   │  │  │  │  ├── [IMPL-RPT-060] KhyOS规范落地自查报告-2026-09-21.html
   │  │  │  │  ├── [IMPL-RPT-060] KhyOS规范落地自查报告-2026-09-21.md
   │  │  │  │  ├── [IMPL-RPT-061] OpenCode-Zen-免鉴权通道-核实的方案-2026-09-23.html
   │  │  │  │  ├── [IMPL-RPT-061] OpenCode-Zen-免鉴权通道-核实的方案-2026-09-23.md
   │  │  │  │  ├── [IMPL-RPT-062] 长任务偏离与完成判据缺失-取证与方案提案-2026-09-23.html
   │  │  │  │  ├── [IMPL-RPT-062] 长任务偏离与完成判据缺失-取证与方案提案-2026-09-23.md
   │  │  │  │  ├── [IMPL-RPT-063] 会话轨迹问题盘点与修复方案-2026-09-28.html
   │  │  │  │  └── [IMPL-RPT-063] 会话轨迹问题盘点与修复方案-2026-09-28.md
   │  │  │  ├── [IMPL-RPT-045
   │  │  │  │  ├── ] 工具注册表自愈层规范.html
   │  │  │  │  └── ] 工具注册表自愈层规范.md
   │  │  │  └── 其它实现
   │  │  │     ├── 00_INDEX_其它实现-总目录.html
   │  │  │     ├── 00_INDEX_其它实现-总目录.md
   │  │  │     ├── [IMPL-DOC-001] 任务完成判断地图.html
   │  │  │     ├── [IMPL-DOC-001] 任务完成判断地图.md
   │  │  │     ├── [IMPL-DOC-002] README 内容规范落地记录.html
   │  │  │     ├── [IMPL-DOC-002] README 内容规范落地记录.md
   │  │  │     ├── [IMPL-MIG-001] 命令注册表迁移指南.html
   │  │  │     └── [IMPL-MIG-001] 命令注册表迁移指南.md
   │  │  ├── 05_TEST_测试
   │  │  │  ├── 00_INDEX_测试-分类索引.html
   │  │  │  ├── 00_INDEX_测试-分类索引.md
   │  │  │  └── TEST-RPT
   │  │  │     ├── 00_INDEX_TEST-RPT-总目录.html
   │  │  │     ├── 00_INDEX_TEST-RPT-总目录.md
   │  │  │     ├── [TEST-RPT-001] 验收不合规-2026-05-16.html
   │  │  │     ├── [TEST-RPT-001] 验收不合规-2026-05-16.md
   │  │  │     ├── [TEST-RPT-002] khy-os-测试指南.html
   │  │  │     ├── [TEST-RPT-002] khy-os-测试指南.md
   │  │  │     ├── [TEST-RPT-003] windows-ui-聊天回归报告模板.html
   │  │  │     ├── [TEST-RPT-003] windows-ui-聊天回归报告模板.md
   │  │  │     ├── [TEST-RPT-004] windows-ui-聊天回归报告示例-2026-05-20.html
   │  │  │     ├── [TEST-RPT-004] windows-ui-聊天回归报告示例-2026-05-20.md
   │  │  │     ├── [TEST-RPT-005] windows-ui-聊天回归清单.html
   │  │  │     ├── [TEST-RPT-005] windows-ui-聊天回归清单.md
   │  │  │     ├── [TEST-RPT-006] khy-os-交付验证-2026-05-09.html
   │  │  │     ├── [TEST-RPT-006] khy-os-交付验证-2026-05-09.md
   │  │  │     ├── [TEST-RPT-007] 文档排版-测试报告-2026-06-12.html
   │  │  │     ├── [TEST-RPT-007] 文档排版-测试报告-2026-06-12.md
   │  │  │     ├── [TEST-RPT-008] 元帅双模式任命-测试报告-2026-06-12.html
   │  │  │     ├── [TEST-RPT-008] 元帅双模式任命-测试报告-2026-06-12.md
   │  │  │     ├── [TEST-RPT-009] 元规划协议与动态约束注入-测试报告-2026-06-12.html
   │  │  │     ├── [TEST-RPT-009] 元规划协议与动态约束注入-测试报告-2026-06-12.md
   │  │  │     ├── [TEST-RPT-010] khy-os-测试覆盖率提升报告.html
   │  │  │     ├── [TEST-RPT-010] khy-os-测试覆盖率提升报告.md
   │  │  │     ├── [TEST-RPT-011] 全免费上线测试方案.html
   │  │  │     └── [TEST-RPT-011] 全免费上线测试方案.md
   │  │  ├── 06_DEPLOY_部署
   │  │  │  ├── 00_INDEX_部署-分类索引.html
   │  │  │  ├── 00_INDEX_部署-分类索引.md
   │  │  │  ├── DEPLOY
   │  │  │  │  ├── 00_INDEX_DEPLOY-总目录.html
   │  │  │  │  ├── 00_INDEX_DEPLOY-总目录.md
   │  │  │  │  ├── [DEPLOY-0100] LAN-FIREWALL.html
   │  │  │  │  ├── [DEPLOY-0100] LAN-FIREWALL.md
   │  │  │  │  ├── [DEPLOY-0101] PORTABLE.html
   │  │  │  │  ├── [DEPLOY-0101] PORTABLE.md
   │  │  │  │  ├── [DEPLOY-0102] CPA+NewAPI分层架构快速指南.html
   │  │  │  │  ├── [DEPLOY-0102] CPA+NewAPI分层架构快速指南.md
   │  │  │  │  ├── [DEPLOY-0103] CPA集成快速指南.html
   │  │  │  │  └── [DEPLOY-0103] CPA集成快速指南.md
   │  │  │  ├── DEPLOY-MAN
   │  │  │  │  ├── 00_INDEX_DEPLOY-MAN-总目录.html
   │  │  │  │  ├── 00_INDEX_DEPLOY-MAN-总目录.md
   │  │  │  │  ├── [DEPLOY-MAN-001] DEMO.html
   │  │  │  │  ├── [DEPLOY-MAN-001] DEMO.md
   │  │  │  │  ├── [DEPLOY-MAN-002] PRODUCT_HUNT.html
   │  │  │  │  ├── [DEPLOY-MAN-002] PRODUCT_HUNT.md
   │  │  │  │  ├── [DEPLOY-MAN-003] PUBLISHING.html
   │  │  │  │  ├── [DEPLOY-MAN-003] PUBLISHING.md
   │  │  │  │  ├── [DEPLOY-MAN-004] README.html
   │  │  │  │  ├── [DEPLOY-MAN-004] README.md
   │  │  │  │  ├── [DEPLOY-MAN-005] REDDIT.html
   │  │  │  │  ├── [DEPLOY-MAN-005] REDDIT.md
   │  │  │  │  ├── [DEPLOY-MAN-006] REPO_META.html
   │  │  │  │  ├── [DEPLOY-MAN-006] REPO_META.md
   │  │  │  │  ├── [DEPLOY-MAN-007] SHOW_HN.html
   │  │  │  │  ├── [DEPLOY-MAN-007] SHOW_HN.md
   │  │  │  │  ├── [DEPLOY-MAN-008] TWITTER.html
   │  │  │  │  ├── [DEPLOY-MAN-008] TWITTER.md
   │  │  │  │  ├── [DEPLOY-MAN-009] pip-打包对等-发布说明-2026-05-17.html
   │  │  │  │  ├── [DEPLOY-MAN-009] pip-打包对等-发布说明-2026-05-17.md
   │  │  │  │  ├── [DEPLOY-MAN-010] pip-打包对等-发现-2026-05-17.html
   │  │  │  │  ├── [DEPLOY-MAN-010] pip-打包对等-发现-2026-05-17.md
   │  │  │  │  ├── [DEPLOY-MAN-011] pip-docker-打包部署.html
   │  │  │  │  ├── [DEPLOY-MAN-011] pip-docker-打包部署.md
   │  │  │  │  ├── [DEPLOY-MAN-012] pip发布后-github发布手册.html
   │  │  │  │  ├── [DEPLOY-MAN-012] pip发布后-github发布手册.md
   │  │  │  │  ├── [DEPLOY-MAN-013] pypi-发布手册-0.1.17-0.1.18.html
   │  │  │  │  ├── [DEPLOY-MAN-013] pypi-发布手册-0.1.17-0.1.18.md
   │  │  │  │  ├── [DEPLOY-MAN-014] 发布说明-0.1.27.html
   │  │  │  │  ├── [DEPLOY-MAN-014] 发布说明-0.1.27.md
   │  │  │  │  ├── [DEPLOY-MAN-015] 源码还原与手工发布.html
   │  │  │  │  ├── [DEPLOY-MAN-015] 源码还原与手工发布.md
   │  │  │  │  ├── [DEPLOY-MAN-016] 部署指南-域名.html
   │  │  │  │  ├── [DEPLOY-MAN-016] 部署指南-域名.md
   │  │  │  │  ├── [DEPLOY-MAN-017] 部署指南-无域名.html
   │  │  │  │  ├── [DEPLOY-MAN-017] 部署指南-无域名.md
   │  │  │  │  ├── [DEPLOY-MAN-018] khyos-Android构建避坑指南.html
   │  │  │  │  ├── [DEPLOY-MAN-018] khyos-Android构建避坑指南.md
   │  │  │  │  ├── [DEPLOY-MAN-019] 模型可用性与适配器探测.html
   │  │  │  │  ├── [DEPLOY-MAN-019] 模型可用性与适配器探测.md
   │  │  │  │  ├── [DEPLOY-MAN-020] AI供应商与APIKey配置.html
   │  │  │  │  ├── [DEPLOY-MAN-020] AI供应商与APIKey配置.md
   │  │  │  │  ├── [DEPLOY-MAN-021] IDE桥接模式.html
   │  │  │  │  └── [DEPLOY-MAN-021] IDE桥接模式.md
   │  │  │  └── 其它部署
   │  │  │     ├── 00_INDEX_其它部署-总目录.html
   │  │  │     ├── 00_INDEX_其它部署-总目录.md
   │  │  │     ├── LAN-FIREWALL.html
   │  │  │     ├── LAN-FIREWALL.md
   │  │  │     ├── PORTABLE.html
   │  │  │     └── PORTABLE.md
   │  │  ├── 07_OPS_运维
   │  │  │  ├── 00_INDEX_运维-分类索引.html
   │  │  │  ├── 00_INDEX_运维-分类索引.md
   │  │  │  ├── OPS-MAN
   │  │  │  │  ├── 00_INDEX_OPS-MAN-总目录.html
   │  │  │  │  ├── 00_INDEX_OPS-MAN-总目录.md
   │  │  │  │  ├── [OPS-MAN-001] ai-快速通道.html
   │  │  │  │  ├── [OPS-MAN-001] ai-快速通道.md
   │  │  │  │  ├── [OPS-MAN-002] ai-管理-新api对齐.html
   │  │  │  │  ├── [OPS-MAN-002] ai-管理-新api对齐.md
   │  │  │  │  ├── [OPS-MAN-003] ai-管理-访问与登录.html
   │  │  │  │  ├── [OPS-MAN-003] ai-管理-访问与登录.md
   │  │  │  │  ├── [OPS-MAN-004] claude-code-代理配置.html
   │  │  │  │  ├── [OPS-MAN-004] claude-code-代理配置.md
   │  │  │  │  ├── [OPS-MAN-005] claude-code-规则到-khy-映射表.html
   │  │  │  │  ├── [OPS-MAN-005] claude-code-规则到-khy-映射表.md
   │  │  │  │  ├── [OPS-MAN-006] cli-万能接入-abu-案例.html
   │  │  │  │  ├── [OPS-MAN-006] cli-万能接入-abu-案例.md
   │  │  │  │  ├── [OPS-MAN-007] cli-万能接入-集成指南.html
   │  │  │  │  ├── [OPS-MAN-007] cli-万能接入-集成指南.md
   │  │  │  │  ├── [OPS-MAN-008] deepseek-tui-资源清理对齐.html
   │  │  │  │  ├── [OPS-MAN-008] deepseek-tui-资源清理对齐.md
   │  │  │  │  ├── [OPS-MAN-009] github-分支保护基线.html
   │  │  │  │  ├── [OPS-MAN-009] github-分支保护基线.md
   │  │  │  │  ├── [OPS-MAN-010] hermes风格-模型配置.html
   │  │  │  │  ├── [OPS-MAN-010] hermes风格-模型配置.md
   │  │  │  │  ├── [OPS-MAN-011] khy-os-学习指南.html
   │  │  │  │  ├── [OPS-MAN-011] khy-os-学习指南.md
   │  │  │  │  ├── [OPS-MAN-012] khy-os-应用接入指南.html
   │  │  │  │  ├── [OPS-MAN-012] khy-os-应用接入指南.md
   │  │  │  │  ├── [OPS-MAN-013] khy-os-开发者指南.html
   │  │  │  │  ├── [OPS-MAN-013] khy-os-开发者指南.md
   │  │  │  │  ├── [OPS-MAN-014] khy-os-用户指南-仅cli.html
   │  │  │  │  ├── [OPS-MAN-014] khy-os-用户指南-仅cli.md
   │  │  │  │  ├── [OPS-MAN-015] khy-os-用户指南.html
   │  │  │  │  ├── [OPS-MAN-015] khy-os-用户指南.md
   │  │  │  │  ├── [OPS-MAN-016] khy-ux-交付-深度学习指南.html
   │  │  │  │  ├── [OPS-MAN-016] khy-ux-交付-深度学习指南.md
   │  │  │  │  ├── [OPS-MAN-017] khy-智能体-五步实施.html
   │  │  │  │  ├── [OPS-MAN-017] khy-智能体-五步实施.md
   │  │  │  │  ├── [OPS-MAN-018] khy-编程智能体-风险预防-2026-05-30.html
   │  │  │  │  ├── [OPS-MAN-018] khy-编程智能体-风险预防-2026-05-30.md
   │  │  │  │  ├── [OPS-MAN-019] khy-远程ssh-实施清单.html
   │  │  │  │  ├── [OPS-MAN-019] khy-远程ssh-实施清单.md
   │  │  │  │  ├── [OPS-MAN-020] openagent-对齐日志.html
   │  │  │  │  ├── [OPS-MAN-020] openagent-对齐日志.md
   │  │  │  │  ├── [OPS-MAN-021] opencode-任务编排经验.html
   │  │  │  │  ├── [OPS-MAN-021] opencode-任务编排经验.md
   │  │  │  │  ├── [OPS-MAN-022] pip-安装布局参考.html
   │  │  │  │  ├── [OPS-MAN-022] pip-安装布局参考.md
   │  │  │  │  ├── [OPS-MAN-023] pip安装后-完整功能清单.html
   │  │  │  │  ├── [OPS-MAN-023] pip安装后-完整功能清单.md
   │  │  │  │  ├── [OPS-MAN-024] pip安装后-按需配置体验.html
   │  │  │  │  ├── [OPS-MAN-024] pip安装后-按需配置体验.md
   │  │  │  │  ├── [OPS-MAN-025] windows-vmware-清单.html
   │  │  │  │  ├── [OPS-MAN-025] windows-vmware-清单.md
   │  │  │  │  ├── [OPS-MAN-026] 会话恢复-按id.html
   │  │  │  │  ├── [OPS-MAN-026] 会话恢复-按id.md
   │  │  │  │  ├── [OPS-MAN-027] 快速开始.html
   │  │  │  │  ├── [OPS-MAN-027] 快速开始.md
   │  │  │  │  ├── [OPS-MAN-028] 环境要求.html
   │  │  │  │  ├── [OPS-MAN-028] 环境要求.md
   │  │  │  │  ├── [OPS-MAN-029] 磁盘守卫-防膨胀机制.html
   │  │  │  │  ├── [OPS-MAN-029] 磁盘守卫-防膨胀机制.md
   │  │  │  │  ├── [OPS-MAN-030] 移动端远程指南.html
   │  │  │  │  ├── [OPS-MAN-030] 移动端远程指南.md
   │  │  │  │  ├── [OPS-MAN-031] 终端-tui-有框输入区重构方案-2026-05-31.html
   │  │  │  │  ├── [OPS-MAN-031] 终端-tui-有框输入区重构方案-2026-05-31.md
   │  │  │  │  ├── [OPS-MAN-032] 网关-自定义provider配置-agnes.html
   │  │  │  │  ├── [OPS-MAN-032] 网关-自定义provider配置-agnes.md
   │  │  │  │  ├── [OPS-MAN-033] 自动保护与回滚.html
   │  │  │  │  ├── [OPS-MAN-033] 自动保护与回滚.md
   │  │  │  │  ├── [OPS-MAN-034] TODO.html
   │  │  │  │  ├── [OPS-MAN-034] TODO.md
   │  │  │  │  ├── [OPS-MAN-035] 特性访问-维护速查-2026-06-01.html
   │  │  │  │  ├── [OPS-MAN-035] 特性访问-维护速查-2026-06-01.md
   │  │  │  │  ├── [OPS-MAN-036] khyos跨平台构建-Windows支持方案.html
   │  │  │  │  ├── [OPS-MAN-036] khyos跨平台构建-Windows支持方案.md
   │  │  │  │  ├── [OPS-MAN-037] pip安装后-完整还原与全功能开启指南.html
   │  │  │  │  ├── [OPS-MAN-037] pip安装后-完整还原与全功能开启指南.md
   │  │  │  │  ├── [OPS-MAN-038] AI元数据-.ai-种子文档-用法指南-2026-06-15.html
   │  │  │  │  ├── [OPS-MAN-038] AI元数据-.ai-种子文档-用法指南-2026-06-15.md
   │  │  │  │  ├── [OPS-MAN-039] 文档排版-用法指南-2026-06-12.html
   │  │  │  │  ├── [OPS-MAN-039] 文档排版-用法指南-2026-06-12.md
   │  │  │  │  ├── [OPS-MAN-040] Git入门-main-HEAD-分支-工作树-结合本仓库.html
   │  │  │  │  ├── [OPS-MAN-040] Git入门-main-HEAD-分支-工作树-结合本仓库.md
   │  │  │  │  ├── [OPS-MAN-041] 通过KHY学习模式-从0到1面试大厂Agent岗-路线图-2026-06-15.html
   │  │  │  │  ├── [OPS-MAN-041] 通过KHY学习模式-从0到1面试大厂Agent岗-路线图-2026-06-15.md
   │  │  │  │  ├── [OPS-MAN-042] 发布手册-pip与npm-无AI照做.html
   │  │  │  │  ├── [OPS-MAN-042] 发布手册-pip与npm-无AI照做.md
   │  │  │  │  ├── [OPS-MAN-043] 从0到高手-新手成长路线与pip安装后清单.html
   │  │  │  │  ├── [OPS-MAN-043] 从0到高手-新手成长路线与pip安装后清单.md
   │  │  │  │  ├── [OPS-MAN-044] 从使用入门到开发精通-开发者成长路线.html
   │  │  │  │  ├── [OPS-MAN-044] 从使用入门到开发精通-开发者成长路线.md
   │  │  │  │  ├── [OPS-MAN-045] 账号池与多租户-深度指南.html
   │  │  │  │  ├── [OPS-MAN-045] 账号池与多租户-深度指南.md
   │  │  │  │  ├── [OPS-MAN-046] 旗舰特性目录-vault-notify-mesh-insights-forge-image2web.html
   │  │  │  │  ├── [OPS-MAN-046] 旗舰特性目录-vault-notify-mesh-insights-forge-image2web.md
   │  │  │  │  ├── [OPS-MAN-047] 代理服务器深度指南-khy-proxy.html
   │  │  │  │  ├── [OPS-MAN-047] 代理服务器深度指南-khy-proxy.md
   │  │  │  │  ├── [OPS-MAN-048] 本地模型微调-khy-train.html
   │  │  │  │  ├── [OPS-MAN-048] 本地模型微调-khy-train.md
   │  │  │  │  ├── [OPS-MAN-049] 算力与加速器自检-khy-compute.html
   │  │  │  │  ├── [OPS-MAN-049] 算力与加速器自检-khy-compute.md
   │  │  │  │  ├── [OPS-MAN-050] 成长档案迁移-khy-growth.html
   │  │  │  │  ├── [OPS-MAN-050] 成长档案迁移-khy-growth.md
   │  │  │  │  ├── [OPS-MAN-051] 知识库与教学自我认知-khy-knowledge.html
   │  │  │  │  ├── [OPS-MAN-051] 知识库与教学自我认知-khy-knowledge.md
   │  │  │  │  ├── [OPS-MAN-052] 安全守护-khy-security.html
   │  │  │  │  ├── [OPS-MAN-052] 安全守护-khy-security.md
   │  │  │  │  ├── [OPS-MAN-053] 监控与自检-khy-monitor.html
   │  │  │  │  ├── [OPS-MAN-053] 监控与自检-khy-monitor.md
   │  │  │  │  ├── [OPS-MAN-054] 变更裁决-khy-verdict.html
   │  │  │  │  ├── [OPS-MAN-054] 变更裁决-khy-verdict.md
   │  │  │  │  ├── [OPS-MAN-055] 可变性分级与变更治理-khy-evolve.html
   │  │  │  │  ├── [OPS-MAN-055] 可变性分级与变更治理-khy-evolve.md
   │  │  │  │  ├── [OPS-MAN-056] 按需依赖自愈-khy-deps.html
   │  │  │  │  ├── [OPS-MAN-056] 按需依赖自愈-khy-deps.md
   │  │  │  │  ├── [OPS-MAN-057] 工作流引擎-khy-workflow.html
   │  │  │  │  ├── [OPS-MAN-057] 工作流引擎-khy-workflow.md
   │  │  │  │  ├── [OPS-MAN-058] 环境开关与文档命名规范.html
   │  │  │  │  ├── [OPS-MAN-058] 环境开关与文档命名规范.md
   │  │  │  │  ├── [OPS-MAN-059] 文档-PDF与HTML生成与查看.html
   │  │  │  │  ├── [OPS-MAN-059] 文档-PDF与HTML生成与查看.md
   │  │  │  │  ├── [OPS-MAN-060] 高危操作为何被拒与如何放行.html
   │  │  │  │  ├── [OPS-MAN-060] 高危操作为何被拒与如何放行.md
   │  │  │  │  ├── [OPS-MAN-061] 发布门禁.html
   │  │  │  │  ├── [OPS-MAN-061] 发布门禁.md
   │  │  │  │  ├── [OPS-MAN-062] 键盘快捷键参考与跨平台对齐.html
   │  │  │  │  ├── [OPS-MAN-062] 键盘快捷键参考与跨平台对齐.md
   │  │  │  │  ├── [OPS-MAN-063] cc订阅迁移到新电脑-khy-claude-adopt-env.html
   │  │  │  │  ├── [OPS-MAN-063] cc订阅迁移到新电脑-khy-claude-adopt-env.md
   │  │  │  │  ├── [OPS-MAN-064] 打造最佳环境-如何扩展.html
   │  │  │  │  ├── [OPS-MAN-064] 打造最佳环境-如何扩展.md
   │  │  │  │  ├── [OPS-MAN-065] npm安装加速-npmrc模板.html
   │  │  │  │  ├── [OPS-MAN-065] npm安装加速-npmrc模板.md
   │  │  │  │  ├── [OPS-MAN-066] khyos进化提示词手册-1000条.html
   │  │  │  │  ├── [OPS-MAN-066] khyos进化提示词手册-1000条.md
   │  │  │  │  ├── [OPS-MAN-067] 症状分诊速查表.html
   │  │  │  │  ├── [OPS-MAN-067] 症状分诊速查表.md
   │  │  │  │  ├── [OPS-MAN-068] 离机还原自检清单.html
   │  │  │  │  ├── [OPS-MAN-068] 离机还原自检清单.md
   │  │  │  │  ├── [OPS-MAN-069] 已装副本完整性自检清单.html
   │  │  │  │  ├── [OPS-MAN-069] 已装副本完整性自检清单.md
   │  │  │  │  ├── [OPS-MAN-070] 首启依赖hydration自检清单.html
   │  │  │  │  ├── [OPS-MAN-070] 首启依赖hydration自检清单.md
   │  │  │  │  ├── [OPS-MAN-071] 卸载第三方应用怎么保证卸干净-原生自带卸载器.html
   │  │  │  │  ├── [OPS-MAN-071] 卸载第三方应用怎么保证卸干净-原生自带卸载器.md
   │  │  │  │  ├── [OPS-MAN-072] 目标连续多日运行不中断的底气自检.html
   │  │  │  │  ├── [OPS-MAN-072] 目标连续多日运行不中断的底气自检.md
   │  │  │  │  ├── [OPS-MAN-073] 离机渠道启动入口契约自检清单.html
   │  │  │  │  ├── [OPS-MAN-073] 离机渠道启动入口契约自检清单.md
   │  │  │  │  ├── [OPS-MAN-074] 首启崩溃真实原因加方法归因.html
   │  │  │  │  ├── [OPS-MAN-074] 首启崩溃真实原因加方法归因.md
   │  │  │  │  ├── [OPS-MAN-075] Agent 还原方案合成器.html
   │  │  │  │  ├── [OPS-MAN-075] Agent 还原方案合成器.md
   │  │  │  │  ├── [OPS-MAN-076] 三面镜子矛盾冲突检测.html
   │  │  │  │  ├── [OPS-MAN-076] 三面镜子矛盾冲突检测.md
   │  │  │  │  ├── [OPS-MAN-077] Windows md 文件建议的应用注册.html
   │  │  │  │  ├── [OPS-MAN-077] Windows md 文件建议的应用注册.md
   │  │  │  │  ├── [OPS-MAN-078] khy doctor 离机还原自检.html
   │  │  │  │  ├── [OPS-MAN-078] khy doctor 离机还原自检.md
   │  │  │  │  ├── [OPS-MAN-079] 三面镜子矛盾冲突消解.html
   │  │  │  │  ├── [OPS-MAN-079] 三面镜子矛盾冲突消解.md
   │  │  │  │  ├── [OPS-MAN-080] recap 的 CJK 化.html
   │  │  │  │  ├── [OPS-MAN-080] recap 的 CJK 化.md
   │  │  │  │  ├── [OPS-MAN-081] npm 渠道 Node 版本预检.html
   │  │  │  │  ├── [OPS-MAN-081] npm 渠道 Node 版本预检.md
   │  │  │  │  ├── [OPS-MAN-082] 三面镜子还原收敛与防循环.html
   │  │  │  │  ├── [OPS-MAN-082] 三面镜子还原收敛与防循环.md
   │  │  │  │  ├── [OPS-MAN-083] 依赖感知波次调度.html
   │  │  │  │  ├── [OPS-MAN-083] 依赖感知波次调度.md
   │  │  │  │  ├── [OPS-MAN-084] 还原自驱授权门.html
   │  │  │  │  ├── [OPS-MAN-084] 还原自驱授权门.md
   │  │  │  │  ├── [OPS-MAN-085] 还原补救追索.html
   │  │  │  │  ├── [OPS-MAN-085] 还原补救追索.md
   │  │  │  │  ├── [OPS-MAN-086] 还原轨迹日志.html
   │  │  │  │  ├── [OPS-MAN-086] 还原轨迹日志.md
   │  │  │  │  ├── [OPS-MAN-087] 波次执行故障感知.html
   │  │  │  │  ├── [OPS-MAN-087] 波次执行故障感知.md
   │  │  │  │  ├── [OPS-MAN-088] 还原策略台账.html
   │  │  │  │  ├── [OPS-MAN-088] 还原策略台账.md
   │  │  │  │  ├── [OPS-MAN-089] 还原学习应用器.html
   │  │  │  │  ├── [OPS-MAN-089] 还原学习应用器.md
   │  │  │  │  ├── [OPS-MAN-090] 还原导航器.html
   │  │  │  │  ├── [OPS-MAN-090] 还原导航器.md
   │  │  │  │  ├── [OPS-MAN-091] 波次前驱结果注入.html
   │  │  │  │  ├── [OPS-MAN-091] 波次前驱结果注入.md
   │  │  │  │  ├── [OPS-MAN-092] 跳过与失败在最终报告分列.html
   │  │  │  │  ├── [OPS-MAN-092] 跳过与失败在最终报告分列.md
   │  │  │  │  ├── [OPS-MAN-093] 确定性顺序链拆解.html
   │  │  │  │  ├── [OPS-MAN-093] 确定性顺序链拆解.md
   │  │  │  │  ├── [OPS-MAN-094] 角色工具作用域.html
   │  │  │  │  ├── [OPS-MAN-094] 角色工具作用域.md
   │  │  │  │  ├── [OPS-MAN-095] 还原解包完整性对账.html
   │  │  │  │  ├── [OPS-MAN-095] 还原解包完整性对账.md
   │  │  │  │  ├── [OPS-MAN-096] 多模型类型 Provider 配置对账.html
   │  │  │  │  ├── [OPS-MAN-096] 多模型类型 Provider 配置对账.md
   │  │  │  │  ├── [OPS-MAN-097] 角色工具作用域接线.html
   │  │  │  │  ├── [OPS-MAN-097] 角色工具作用域接线.md
   │  │  │  │  ├── [OPS-MAN-098] 并行写冲突检测.html
   │  │  │  │  ├── [OPS-MAN-098] 并行写冲突检测.md
   │  │  │  │  ├── [OPS-MAN-099] 空产出成功检测.html
   │  │  │  │  ├── [OPS-MAN-099] 空产出成功检测.md
   │  │  │  │  ├── [OPS-MAN-100] 便携 CLI 子系统.html
   │  │  │  │  ├── [OPS-MAN-100] 便携 CLI 子系统.md
   │  │  │  │  ├── [OPS-MAN-101] 角色归属诚实.html
   │  │  │  │  ├── [OPS-MAN-101] 角色归属诚实.md
   │  │  │  │  ├── [OPS-MAN-102] 卡住任务的强制终止逃生舱.html
   │  │  │  │  ├── [OPS-MAN-102] 卡住任务的强制终止逃生舱.md
   │  │  │  │  ├── [OPS-MAN-103] 写记忆·召回记忆明确告知用户.html
   │  │  │  │  ├── [OPS-MAN-103] 写记忆·召回记忆明确告知用户.md
   │  │  │  │  ├── [OPS-MAN-104] 纯文本模型图片 OCR 兜底与低置信诚实告诫.html
   │  │  │  │  ├── [OPS-MAN-104] 纯文本模型图片 OCR 兜底与低置信诚实告诫.md
   │  │  │  │  ├── [OPS-MAN-105] 还原快照格式兼容性对账.html
   │  │  │  │  ├── [OPS-MAN-105] 还原快照格式兼容性对账.md
   │  │  │  │  ├── [OPS-MAN-106] unpack 未知格式自救.html
   │  │  │  │  ├── [OPS-MAN-106] unpack 未知格式自救.md
   │  │  │  │  ├── [OPS-MAN-107] 还原来源可溯性对账.html
   │  │  │  │  ├── [OPS-MAN-107] 还原来源可溯性对账.md
   │  │  │  │  ├── [OPS-MAN-108] 还原归档形制可提取性对账.html
   │  │  │  │  ├── [OPS-MAN-108] 还原归档形制可提取性对账.md
   │  │  │  │  ├── [OPS-MAN-109] 纯文本模型图片 OCR 兜底覆盖率诚实告诫.html
   │  │  │  │  ├── [OPS-MAN-109] 纯文本模型图片 OCR 兜底覆盖率诚实告诫.md
   │  │  │  │  ├── [OPS-MAN-110] 还原解密套件可执行性对账.html
   │  │  │  │  ├── [OPS-MAN-110] 还原解密套件可执行性对账.md
   │  │  │  │  ├── [OPS-MAN-111] 纯文本模型图片 OCR 兜底截断诚实告诫.html
   │  │  │  │  ├── [OPS-MAN-111] 纯文本模型图片 OCR 兜底截断诚实告诫.md
   │  │  │  │  ├── [OPS-MAN-112] 纯文本模型图片 OCR 兜底语言包可用性诚实告诫.html
   │  │  │  │  ├── [OPS-MAN-112] 纯文本模型图片 OCR 兜底语言包可用性诚实告诫.md
   │  │  │  │  ├── [OPS-MAN-113] 还原字段效应探针（雅可比透镜）.html
   │  │  │  │  ├── [OPS-MAN-113] 还原字段效应探针（雅可比透镜）.md
   │  │  │  │  ├── [OPS-MAN-114] 还原字段归属探针（label preservation）.html
   │  │  │  │  ├── [OPS-MAN-114] 还原字段归属探针（label preservation）.md
   │  │  │  │  ├── [OPS-MAN-115] 纯文本模型图片 OCR 兜底方向自动校正.html
   │  │  │  │  ├── [OPS-MAN-115] 纯文本模型图片 OCR 兜底方向自动校正.md
   │  │  │  │  ├── [OPS-MAN-116] 纯文本模型图片 OCR 兜底低分辨率自动放大.html
   │  │  │  │  ├── [OPS-MAN-116] 纯文本模型图片 OCR 兜底低分辨率自动放大.md
   │  │  │  │  ├── [OPS-MAN-117] 还原完整性对账·运行时接线.html
   │  │  │  │  ├── [OPS-MAN-117] 还原完整性对账·运行时接线.md
   │  │  │  │  ├── [OPS-MAN-118] 视觉描述级联全失败 OCR 兜底底线解耦.html
   │  │  │  │  ├── [OPS-MAN-118] 视觉描述级联全失败 OCR 兜底底线解耦.md
   │  │  │  │  ├── [OPS-MAN-119] 还原解密前兼容性预检·运行时接线.html
   │  │  │  │  ├── [OPS-MAN-119] 还原解密前兼容性预检·运行时接线.md
   │  │  │  │  ├── [OPS-MAN-120] 剥图必留痕最小底线与OCR功能门解耦.html
   │  │  │  │  ├── [OPS-MAN-120] 剥图必留痕最小底线与OCR功能门解耦.md
   │  │  │  │  ├── [OPS-MAN-121] readFile二进制文件读前防护·接线.html
   │  │  │  │  ├── [OPS-MAN-121] readFile二进制文件读前防护·接线.md
   │  │  │  │  ├── [OPS-MAN-122] post-failure救援网剥图必留痕解耦.html
   │  │  │  │  ├── [OPS-MAN-122] post-failure救援网剥图必留痕解耦.md
   │  │  │  │  ├── [OPS-MAN-123] readFile按格式路由到提取器·接线.html
   │  │  │  │  ├── [OPS-MAN-123] readFile按格式路由到提取器·接线.md
   │  │  │  │  ├── [OPS-MAN-124] OCR成功路径向用户透明告知用了OCR.html
   │  │  │  │  ├── [OPS-MAN-124] OCR成功路径向用户透明告知用了OCR.md
   │  │  │  │  ├── [OPS-MAN-125] readFile特殊文件读前防护·接线.html
   │  │  │  │  ├── [OPS-MAN-125] readFile特殊文件读前防护·接线.md
   │  │  │  │  ├── [OPS-MAN-126] OCR成功路径确定性脚注兜底告知用了OCR.html
   │  │  │  │  ├── [OPS-MAN-126] OCR成功路径确定性脚注兜底告知用了OCR.md
   │  │  │  │  ├── [OPS-MAN-127] OCR救援网成功实时状态告知已降级到OCR.html
   │  │  │  │  ├── [OPS-MAN-127] OCR救援网成功实时状态告知已降级到OCR.md
   │  │  │  │  ├── [OPS-MAN-128] restore解密后归档形制解包前把关·接线.html
   │  │  │  │  ├── [OPS-MAN-128] restore解密后归档形制解包前把关·接线.md
   │  │  │  │  ├── [OPS-MAN-129] readFile伪文件系统有界超时读·接线.html
   │  │  │  │  ├── [OPS-MAN-129] readFile伪文件系统有界超时读·接线.md
   │  │  │  │  ├── [OPS-MAN-130] 还原来源可溯性·接线运行时横幅.html
   │  │  │  │  ├── [OPS-MAN-130] 还原来源可溯性·接线运行时横幅.md
   │  │  │  │  ├── [OPS-MAN-131] 重复代码检测门与公共测试脚手架.html
   │  │  │  │  ├── [OPS-MAN-131] 重复代码检测门与公共测试脚手架.md
   │  │  │  │  ├── [OPS-MAN-132] prep期OCR兜底非verbose实时状态告知已降级到OCR.html
   │  │  │  │  ├── [OPS-MAN-132] prep期OCR兜底非verbose实时状态告知已降级到OCR.md
   │  │  │  │  ├── [OPS-MAN-133] restore跨OS路径可移植性解包前把关·接线.html
   │  │  │  │  ├── [OPS-MAN-133] restore跨OS路径可移植性解包前把关·接线.md
   │  │  │  │  ├── [OPS-MAN-134] 视觉级联网络不可达终局诊断.html
   │  │  │  │  ├── [OPS-MAN-134] 视觉级联网络不可达终局诊断.md
   │  │  │  │  ├── [OPS-MAN-135] 工作流列表载入本页降级不泄漏全局横幅.html
   │  │  │  │  ├── [OPS-MAN-135] 工作流列表载入本页降级不泄漏全局横幅.md
   │  │  │  │  ├── [OPS-MAN-136] 首响应静默窗口守护·提交到首token及时回应·接线.html
   │  │  │  │  ├── [OPS-MAN-136] 首响应静默窗口守护·提交到首token及时回应·接线.md
   │  │  │  │  ├── [OPS-MAN-137] 网页代理内核二进制去哪下载·接确切官方URL到前端横幅.html
   │  │  │  │  ├── [OPS-MAN-137] 网页代理内核二进制去哪下载·接确切官方URL到前端横幅.md
   │  │  │  │  ├── [OPS-MAN-138] 空OCR剥图路径模型仍谎称没收到图的确定性纠正脚注.html
   │  │  │  │  ├── [OPS-MAN-138] 空OCR剥图路径模型仍谎称没收到图的确定性纠正脚注.md
   │  │  │  │  ├── [OPS-MAN-139] khy doctor 离机自检补代理内核下载指引CLI侧接线.html
   │  │  │  │  ├── [OPS-MAN-139] khy doctor 离机自检补代理内核下载指引CLI侧接线.md
   │  │  │  │  ├── [OPS-MAN-140] OCR成功读出但模型仍谎称没收到图的确定性纠正脚注.html
   │  │  │  │  ├── [OPS-MAN-140] OCR成功读出但模型仍谎称没收到图的确定性纠正脚注.md
   │  │  │  │  ├── [OPS-MAN-141] 代理内核安装显式CLI表面接线.html
   │  │  │  │  ├── [OPS-MAN-141] 代理内核安装显式CLI表面接线.md
   │  │  │  │  ├── [OPS-MAN-142] 失败墙推迟到OCR结果已知后减少心灵噪音.html
   │  │  │  │  ├── [OPS-MAN-142] 失败墙推迟到OCR结果已知后减少心灵噪音.md
   │  │  │  │  ├── [OPS-MAN-143] Windows保留设备名读前防护.html
   │  │  │  │  ├── [OPS-MAN-143] Windows保留设备名读前防护.md
   │  │  │  │  ├── [OPS-MAN-144] describe-fail到OCR成功的用户可见闭合减少心灵噪音.html
   │  │  │  │  ├── [OPS-MAN-144] describe-fail到OCR成功的用户可见闭合减少心灵噪音.md
   │  │  │  │  ├── [OPS-MAN-145] 级联逐候选请稍候提示减冗余减少心灵噪音.html
   │  │  │  │  ├── [OPS-MAN-145] 级联逐候选请稍候提示减冗余减少心灵噪音.md
   │  │  │  │  ├── [OPS-MAN-146] 主读工具FileReadTool防卡死守卫族parity接线.html
   │  │  │  │  ├── [OPS-MAN-146] 主读工具FileReadTool防卡死守卫族parity接线.md
   │  │  │  │  ├── [OPS-MAN-147] 次级读取工具统一读前防卡死前检.html
   │  │  │  │  ├── [OPS-MAN-147] 次级读取工具统一读前防卡死前检.md
   │  │  │  │  ├── [OPS-MAN-148] Site1-prep状态与OCR成功闭合跨层去重减少心灵噪音.html
   │  │  │  │  ├── [OPS-MAN-148] Site1-prep状态与OCR成功闭合跨层去重减少心灵噪音.md
   │  │  │  │  ├── [OPS-MAN-149] 编辑与探索读取工具接入统一读前防卡死前检.html
   │  │  │  │  ├── [OPS-MAN-149] 编辑与探索读取工具接入统一读前防卡死前检.md
   │  │  │  │  ├── [OPS-MAN-150] 级联中间提示显示归一去provider前缀减少心灵噪音.html
   │  │  │  │  ├── [OPS-MAN-150] 级联中间提示显示归一去provider前缀减少心灵噪音.md
   │  │  │  │  ├── [OPS-MAN-151] 缓存前缀击穿归因接线.html
   │  │  │  │  ├── [OPS-MAN-151] 缓存前缀击穿归因接线.md
   │  │  │  │  ├── [OPS-MAN-152] 交付门人类可读报告落盘接线.html
   │  │  │  │  ├── [OPS-MAN-152] 交付门人类可读报告落盘接线.md
   │  │  │  │  ├── [OPS-MAN-153] 会话快照损坏兜底修复接线.html
   │  │  │  │  ├── [OPS-MAN-153] 会话快照损坏兜底修复接线.md
   │  │  │  │  ├── [OPS-MAN-154] 任务模板执行手册注入接线.html
   │  │  │  │  ├── [OPS-MAN-154] 任务模板执行手册注入接线.md
   │  │  │  │  ├── [OPS-MAN-155] 指令注册表编译期收敛守卫接线.html
   │  │  │  │  ├── [OPS-MAN-155] 指令注册表编译期收敛守卫接线.md
   │  │  │  │  ├── [OPS-MAN-156] 取来即执行安全守卫接线.html
   │  │  │  │  ├── [OPS-MAN-156] 取来即执行安全守卫接线.md
   │  │  │  │  ├── [OPS-MAN-157] 用户显式 git-init 白名单覆盖接线.html
   │  │  │  │  ├── [OPS-MAN-157] 用户显式 git-init 白名单覆盖接线.md
   │  │  │  │  ├── [OPS-MAN-158] 本地模型并入统一目录接线.html
   │  │  │  │  ├── [OPS-MAN-158] 本地模型并入统一目录接线.md
   │  │  │  │  ├── [OPS-MAN-159] 失败墙视觉模型名显示归一去provider前缀减少心灵噪音.html
   │  │  │  │  ├── [OPS-MAN-159] 失败墙视觉模型名显示归一去provider前缀减少心灵噪音.md
   │  │  │  │  ├── [OPS-MAN-160] 行为特征化并入误报收口裁决接线.html
   │  │  │  │  ├── [OPS-MAN-160] 行为特征化并入误报收口裁决接线.md
   │  │  │  │  ├── [OPS-MAN-161] 失败墙真实失败原因标签去重减少心灵噪音.html
   │  │  │  │  ├── [OPS-MAN-161] 失败墙真实失败原因标签去重减少心灵噪音.md
   │  │  │  │  ├── [OPS-MAN-162] CLI-Web管理面平价守卫接线.html
   │  │  │  │  ├── [OPS-MAN-162] CLI-Web管理面平价守卫接线.md
   │  │  │  │  ├── [OPS-MAN-163] 动作契约核验器CI强制接线.html
   │  │  │  │  ├── [OPS-MAN-163] 动作契约核验器CI强制接线.md
   │  │  │  │  ├── [OPS-MAN-164] 视觉池失败状态人话化减少心灵噪音.html
   │  │  │  │  ├── [OPS-MAN-164] 视觉池失败状态人话化减少心灵噪音.md
   │  │  │  │  ├── [OPS-MAN-165] khy 个性化调优与使用建议.html
   │  │  │  │  ├── [OPS-MAN-165] khy 个性化调优与使用建议.md
   │  │  │  │  ├── [OPS-MAN-166] cc(Claude Code)个性化使用说明书·重逢版.html
   │  │  │  │  ├── [OPS-MAN-166] cc(Claude Code)个性化使用说明书·重逢版.md
   │  │  │  │  ├── [OPS-MAN-167] khy msg 多平台消息收发（钉钉·飞书·企业微信）.html
   │  │  │  │  ├── [OPS-MAN-167] khy msg 多平台消息收发（钉钉·飞书·企业微信）.md
   │  │  │  │  ├── [OPS-MAN-168] 弱模型护栏与维护子系统登记.html
   │  │  │  │  ├── [OPS-MAN-168] 弱模型护栏与维护子系统登记.md
   │  │  │  │  ├── [OPS-MAN-169] 项目规则总纲-命名·skill·权限·mcp.html
   │  │  │  │  ├── [OPS-MAN-169] 项目规则总纲-命名·skill·权限·mcp.md
   │  │  │  │  ├── [OPS-MAN-170] 外部技能安装-khy-skill-add.html
   │  │  │  │  ├── [OPS-MAN-170] 外部技能安装-khy-skill-add.md
   │  │  │  │  ├── [OPS-MAN-171] 技能包规范-manifest与prompt模板.html
   │  │  │  │  ├── [OPS-MAN-171] 技能包规范-manifest与prompt模板.md
   │  │  │  │  ├── [OPS-MAN-172] 自定义供应商接入指南.html
   │  │  │  │  ├── [OPS-MAN-172] 自定义供应商接入指南.md
   │  │  │  │  ├── [OPS-MAN-173] MCP工具接入快速上手.html
   │  │  │  │  ├── [OPS-MAN-173] MCP工具接入快速上手.md
   │  │  │  │  ├── [OPS-MAN-174] 任务入口总表.html
   │  │  │  │  ├── [OPS-MAN-174] 任务入口总表.md
   │  │  │  │  ├── [OPS-MAN-175] 首次运行自动登录与凭据.html
   │  │  │  │  ├── [OPS-MAN-175] 首次运行自动登录与凭据.md
   │  │  │  │  ├── [OPS-MAN-176] 数据备份与恢复.html
   │  │  │  │  ├── [OPS-MAN-176] 数据备份与恢复.md
   │  │  │  │  ├── [OPS-MAN-200] config-auto-repair.html
   │  │  │  │  ├── [OPS-MAN-200] config-auto-repair.md
   │  │  │  │  ├── [OPS-MAN-201] dependencies.html
   │  │  │  │  ├── [OPS-MAN-201] dependencies.md
   │  │  │  │  ├── [OPS-MAN-202] oncall.html
   │  │  │  │  ├── [OPS-MAN-202] oncall.md
   │  │  │  │  ├── [OPS-MAN-203] standards-enforcement.html
   │  │  │  │  ├── [OPS-MAN-203] standards-enforcement.md
   │  │  │  │  ├── [OPS-MAN-204] technical-debt-report.html
   │  │  │  │  ├── [OPS-MAN-204] technical-debt-report.md
   │  │  │  │  ├── [OPS-MAN-205] API厂商快速配置指南.html
   │  │  │  │  ├── [OPS-MAN-205] API厂商快速配置指南.md
   │  │  │  │  ├── [OPS-MAN-206] 工作树清洁方案.html
   │  │  │  │  ├── [OPS-MAN-206] 工作树清洁方案.md
   │  │  │  │  ├── [OPS-MAN-207] 还原子系统总纲.html
   │  │  │  │  ├── [OPS-MAN-207] 还原子系统总纲.md
   │  │  │  │  ├── [OPS-MAN-208] OCR 兜底族总纲.html
   │  │  │  │  ├── [OPS-MAN-208] OCR 兜底族总纲.md
   │  │  │  │  ├── [OPS-MAN-209] AI 供应商接入族总纲.html
   │  │  │  │  └── [OPS-MAN-209] AI 供应商接入族总纲.md
   │  │  │  ├── incident-runbooks
   │  │  │  │  ├── 00_INDEX_事件响应剧本-总目录.html
   │  │  │  │  └── 00_INDEX_事件响应剧本-总目录.md
   │  │  │  ├── runbooks
   │  │  │  │  ├── 00_INDEX_灾备演练剧本-总目录.html
   │  │  │  │  └── 00_INDEX_灾备演练剧本-总目录.md
   │  │  │  └── 其它运维
   │  │  │     ├── 00_INDEX_其它运维-总目录.html
   │  │  │     ├── 00_INDEX_其它运维-总目录.md
   │  │  │     ├── config-auto-repair.html
   │  │  │     ├── config-auto-repair.md
   │  │  │     ├── 快速配置说明.html
   │  │  │     └── 快速配置说明.md
   │  │  ├── 08_MGMT_项目管理
   │  │  │  ├── 00_INDEX_项目管理-分类索引.html
   │  │  │  ├── 00_INDEX_项目管理-分类索引.md
   │  │  │  ├── MGMT-OTHER
   │  │  │  │  ├── 00_INDEX_MGMT-OTHER-总目录.html
   │  │  │  │  ├── 00_INDEX_MGMT-OTHER-总目录.md
   │  │  │  │  ├── [MGMT-OTHER-001] RESTORE_WINDOWS.html
   │  │  │  │  ├── [MGMT-OTHER-001] RESTORE_WINDOWS.md
   │  │  │  │  ├── [MGMT-OTHER-002] 事后分析-终端崩溃-2026-05-09.html
   │  │  │  │  ├── [MGMT-OTHER-002] 事后分析-终端崩溃-2026-05-09.md
   │  │  │  │  ├── [MGMT-OTHER-003] 索引.html
   │  │  │  │  ├── [MGMT-OTHER-003] 索引.md
   │  │  │  │  ├── [MGMT-OTHER-004] 事后分析-Windows内核构建为何之前失败现在成功-2026-06-26.html
   │  │  │  │  ├── [MGMT-OTHER-004] 事后分析-Windows内核构建为何之前失败现在成功-2026-06-26.md
   │  │  │  │  ├── [MGMT-OTHER-005] 软件著作权登记申请要求-官方现行标准.html
   │  │  │  │  ├── [MGMT-OTHER-005] 软件著作权登记申请要求-官方现行标准.md
   │  │  │  │  ├── [MGMT-OTHER-006] khy-os软著申报定名与材料方案.html
   │  │  │  │  └── [MGMT-OTHER-006] khy-os软著申报定名与材料方案.md
   │  │  │  ├── MGMT-PLAN
   │  │  │  │  ├── 00_INDEX_MGMT-PLAN-总目录.html
   │  │  │  │  ├── 00_INDEX_MGMT-PLAN-总目录.md
   │  │  │  │  ├── [MGMT-PLAN-001] khy-os-体验改进计划-2026-05-26.html
   │  │  │  │  ├── [MGMT-PLAN-001] khy-os-体验改进计划-2026-05-26.md
   │  │  │  │  ├── [MGMT-PLAN-002] khy-librechat-差距修复路线图.html
   │  │  │  │  ├── [MGMT-PLAN-002] khy-librechat-差距修复路线图.md
   │  │  │  │  ├── [MGMT-PLAN-003] khy-大任务框架蓝图.html
   │  │  │  │  ├── [MGMT-PLAN-003] khy-大任务框架蓝图.md
   │  │  │  │  ├── [MGMT-PLAN-004] 三项目改进计划-2026-05-24.html
   │  │  │  │  ├── [MGMT-PLAN-004] 三项目改进计划-2026-05-24.md
   │  │  │  │  ├── [MGMT-PLAN-005] 自主生产计划-r2-2026-05-24.html
   │  │  │  │  ├── [MGMT-PLAN-005] 自主生产计划-r2-2026-05-24.md
   │  │  │  │  ├── [MGMT-PLAN-006] 智能体-操作系统-路线图.html
   │  │  │  │  ├── [MGMT-PLAN-006] 智能体-操作系统-路线图.md
   │  │  │  │  ├── [MGMT-PLAN-007] Khy-OS远景演进路线图-2026-06-12.html
   │  │  │  │  ├── [MGMT-PLAN-007] Khy-OS远景演进路线图-2026-06-12.md
   │  │  │  │  ├── [MGMT-PLAN-008] replSession与toolUseLoopCore拆分分批计划.html
   │  │  │  │  ├── [MGMT-PLAN-008] replSession与toolUseLoopCore拆分分批计划.md
   │  │  │  │  ├── [MGMT-PLAN-009] 文档精简与结构化整理方案.html
   │  │  │  │  ├── [MGMT-PLAN-009] 文档精简与结构化整理方案.md
   │  │  │  │  ├── [MGMT-PLAN-010] design-partner访谈工具包.html
   │  │  │  │  └── [MGMT-PLAN-010] design-partner访谈工具包.md
   │  │  │  ├── MGMT-RPT
   │  │  │  │  ├── 00_INDEX_MGMT-RPT-总目录.html
   │  │  │  │  ├── 00_INDEX_MGMT-RPT-总目录.md
   │  │  │  │  ├── [MGMT-RPT-001] deepseek-tui-对标.html
   │  │  │  │  ├── [MGMT-RPT-001] deepseek-tui-对标.md
   │  │  │  │  ├── [MGMT-RPT-002] khy-对比-desirecore-借鉴分析.html
   │  │  │  │  ├── [MGMT-RPT-002] khy-对比-desirecore-借鉴分析.md
   │  │  │  │  ├── [MGMT-RPT-003] khy-对比-hermes-成长架构.html
   │  │  │  │  ├── [MGMT-RPT-003] khy-对比-hermes-成长架构.md
   │  │  │  │  ├── [MGMT-RPT-004] khy-对比-openagent-交付差距.html
   │  │  │  │  ├── [MGMT-RPT-004] khy-对比-openagent-交付差距.md
   │  │  │  │  ├── [MGMT-RPT-005] khy-对比-qwen-code-差距分析.html
   │  │  │  │  ├── [MGMT-RPT-005] khy-对比-qwen-code-差距分析.md
   │  │  │  │  ├── [MGMT-RPT-006] AB-交付质量对齐-2026-06-03.html
   │  │  │  │  ├── [MGMT-RPT-006] AB-交付质量对齐-2026-06-03.md
   │  │  │  │  ├── [MGMT-RPT-007] cli-基准对比-2026-05-19.html
   │  │  │  │  ├── [MGMT-RPT-007] cli-基准对比-2026-05-19.md
   │  │  │  │  ├── [MGMT-RPT-008] hermes-khy-p0-执行任务-2026-05-17.html
   │  │  │  │  ├── [MGMT-RPT-008] hermes-khy-p0-执行任务-2026-05-17.md
   │  │  │  │  ├── [MGMT-RPT-009] hermes-成长架构-学习清单-2026-05-17.html
   │  │  │  │  ├── [MGMT-RPT-009] hermes-成长架构-学习清单-2026-05-17.md
   │  │  │  │  ├── [MGMT-RPT-010] windows-工具调用循环冻结-2026-05-28.html
   │  │  │  │  ├── [MGMT-RPT-010] windows-工具调用循环冻结-2026-05-28.md
   │  │  │  │  ├── [MGMT-RPT-011] 三项目深度学习-2026-05-21.html
   │  │  │  │  ├── [MGMT-RPT-011] 三项目深度学习-2026-05-21.md
   │  │  │  │  ├── [MGMT-RPT-012] ai-显示-对标与对齐.html
   │  │  │  │  ├── [MGMT-RPT-012] ai-显示-对标与对齐.md
   │  │  │  │  ├── [MGMT-RPT-013] cc-对标-第六轮-2026-05-26.html
   │  │  │  │  ├── [MGMT-RPT-013] cc-对标-第六轮-2026-05-26.md
   │  │  │  │  ├── [MGMT-RPT-014] khy-qwen-差距修复清单.html
   │  │  │  │  ├── [MGMT-RPT-014] khy-qwen-差距修复清单.md
   │  │  │  │  ├── [MGMT-RPT-015] khy-ux-交互对标.html
   │  │  │  │  ├── [MGMT-RPT-015] khy-ux-交互对标.md
   │  │  │  │  ├── [MGMT-RPT-016] 竞品情报图谱.html
   │  │  │  │  ├── [MGMT-RPT-016] 竞品情报图谱.md
   │  │  │  │  ├── [MGMT-RPT-017] 项目矛盾审计-2026-05-21-r2.html
   │  │  │  │  ├── [MGMT-RPT-017] 项目矛盾审计-2026-05-21-r2.md
   │  │  │  │  ├── [MGMT-RPT-018] 项目矛盾审计-2026-05-21.html
   │  │  │  │  ├── [MGMT-RPT-018] 项目矛盾审计-2026-05-21.md
   │  │  │  │  ├── [MGMT-RPT-019] 架构对比-cc-vs-khy.html
   │  │  │  │  ├── [MGMT-RPT-019] 架构对比-cc-vs-khy.md
   │  │  │  │  ├── [MGMT-RPT-020] 项目痛点诊断报告-2026-06-13.html
   │  │  │  │  ├── [MGMT-RPT-020] 项目痛点诊断报告-2026-06-13.md
   │  │  │  │  ├── [MGMT-RPT-021] 全量审查报告甄别-bundled路径与本仓源码对照-2026-07-14.html
   │  │  │  │  ├── [MGMT-RPT-021] 全量审查报告甄别-bundled路径与本仓源码对照-2026-07-14.md
   │  │  │  │  ├── [MGMT-RPT-022] 借鉴项目清单.html
   │  │  │  │  ├── [MGMT-RPT-022] 借鉴项目清单.md
   │  │  │  │  ├── [MGMT-RPT-023] GitHub调研-模型训练-2026-09-12.html
   │  │  │  │  ├── [MGMT-RPT-023] GitHub调研-模型训练-2026-09-12.md
   │  │  │  │  ├── [MGMT-RPT-024] 数据整备与多教师蒸馏设计方案-2026-09-13.html
   │  │  │  │  ├── [MGMT-RPT-024] 数据整备与多教师蒸馏设计方案-2026-09-13.md
   │  │  │  │  ├── [MGMT-RPT-025] 模型发现UI与一键链路收敛-2026-09-13.html
   │  │  │  │  ├── [MGMT-RPT-025] 模型发现UI与一键链路收敛-2026-09-13.md
   │  │  │  │  ├── [MGMT-RPT-026] GitHub调研-回测引擎-2026-09-13.html
   │  │  │  │  ├── [MGMT-RPT-026] GitHub调研-回测引擎-2026-09-13.md
   │  │  │  │  ├── [MGMT-RPT-027] GitHub调研-双机同步-2026-09-14.html
   │  │  │  │  ├── [MGMT-RPT-027] GitHub调研-双机同步-2026-09-14.md
   │  │  │  │  ├── [MGMT-RPT-028] GitHub调研-版本治理-2026-09-15.html
   │  │  │  │  ├── [MGMT-RPT-028] GitHub调研-版本治理-2026-09-15.md
   │  │  │  │  ├── [MGMT-RPT-029] khy-os-vs-ycode-能力矩阵与学习点.html
   │  │  │  │  ├── [MGMT-RPT-029] khy-os-vs-ycode-能力矩阵与学习点.md
   │  │  │  │  ├── [MGMT-RPT-030] DSH-一切皆插件对-khy-os-可行性分析.html
   │  │  │  │  ├── [MGMT-RPT-030] DSH-一切皆插件对-khy-os-可行性分析.md
   │  │  │  │  ├── [MGMT-RPT-031] GitHub调研-终端渲染TUI-2026-09-17.html
   │  │  │  │  ├── [MGMT-RPT-031] GitHub调研-终端渲染TUI-2026-09-17.md
   │  │  │  │  ├── [MGMT-RPT-032] 工作区脏状态盘点报告-2026-09-18.html
   │  │  │  │  └── [MGMT-RPT-032] 工作区脏状态盘点报告-2026-09-18.md
   │  │  │  └── MGMT-STD
   │  │  │     ├── 00_INDEX_MGMT-STD-总目录.html
   │  │  │     ├── 00_INDEX_MGMT-STD-总目录.md
   │  │  │     ├── [MGMT-STD-001] 项目文档结构与索引铁律规范.html
   │  │  │     ├── [MGMT-STD-001] 项目文档结构与索引铁律规范.md
   │  │  │     ├── [MGMT-STD-002] 工程交付综合系统提示词-文档结构与内嵌MD工作台.html
   │  │  │     ├── [MGMT-STD-002] 工程交付综合系统提示词-文档结构与内嵌MD工作台.md
   │  │  │     ├── [MGMT-STD-003] 任务三综合系统提示词-模型自适应与双轨热插拔架构.html
   │  │  │     ├── [MGMT-STD-003] 任务三综合系统提示词-模型自适应与双轨热插拔架构.md
   │  │  │     ├── [MGMT-STD-004] 曼孚-vibecoding-交付方法论-流程铁律.html
   │  │  │     ├── [MGMT-STD-004] 曼孚-vibecoding-交付方法论-流程铁律.md
   │  │  │     ├── [MGMT-STD-005] Khyos工作方法论-证据搜集与计划落地铁律.html
   │  │  │     ├── [MGMT-STD-005] Khyos工作方法论-证据搜集与计划落地铁律.md
   │  │  │     ├── [MGMT-STD-006] khy-vibecoding与speccoding能力对齐-可量化验收标准.html
   │  │  │     ├── [MGMT-STD-006] khy-vibecoding与speccoding能力对齐-可量化验收标准.md
   │  │  │     ├── [MGMT-STD-007] 文档规则总纲.html
   │  │  │     ├── [MGMT-STD-007] 文档规则总纲.md
   │  │  │     ├── [MGMT-STD-008] 规则编写与管理规范（元规则）.html
   │  │  │     └── [MGMT-STD-008] 规则编写与管理规范（元规则）.md
   │  │  ├── 09_STORY_修仙学AI
   │  │  │  ├── 00_INDEX_修仙学AI-总目录.html
   │  │  │  ├── 00_INDEX_修仙学AI-总目录.md
   │  │  │  ├── STORY-元婴
   │  │  │  │  ├── 00_INDEX_STORY-元婴-总目录.html
   │  │  │  │  ├── 00_INDEX_STORY-元婴-总目录.md
   │  │  │  │  ├── [STORY-章节-121] 第07章 元婴·观例悟法.html
   │  │  │  │  └── [STORY-章节-121] 第07章 元婴·观例悟法.md
   │  │  │  ├── STORY-化神
   │  │  │  │  ├── 00_INDEX_STORY-化神-总目录.html
   │  │  │  │  ├── 00_INDEX_STORY-化神-总目录.md
   │  │  │  │  ├── [STORY-章节-122] 第08章 化神·神识重楼.html
   │  │  │  │  └── [STORY-章节-122] 第08章 化神·神识重楼.md
   │  │  │  ├── STORY-合体
   │  │  │  │  ├── 00_INDEX_STORY-合体-总目录.html
   │  │  │  │  ├── 00_INDEX_STORY-合体-总目录.md
   │  │  │  │  ├── [STORY-章节-125] 第11章 合体·开卷问道.html
   │  │  │  │  └── [STORY-章节-125] 第11章 合体·开卷问道.md
   │  │  │  ├── STORY-大乘
   │  │  │  │  ├── 00_INDEX_STORY-大乘-总目录.html
   │  │  │  │  ├── 00_INDEX_STORY-大乘-总目录.md
   │  │  │  │  ├── [STORY-章节-126] 第12章 大乘·万法归一.html
   │  │  │  │  ├── [STORY-章节-126] 第12章 大乘·万法归一.md
   │  │  │  │  ├── [STORY-章节-127] 第13章 大乘·化身万千.html
   │  │  │  │  └── [STORY-章节-127] 第13章 大乘·化身万千.md
   │  │  │  ├── STORY-渡劫
   │  │  │  │  ├── 00_INDEX_STORY-渡劫-总目录.html
   │  │  │  │  ├── 00_INDEX_STORY-渡劫-总目录.md
   │  │  │  │  ├── [STORY-章节-128] 第14章 渡劫飞升·算道大成.html
   │  │  │  │  └── [STORY-章节-128] 第14章 渡劫飞升·算道大成.md
   │  │  │  ├── STORY-炼气
   │  │  │  │  ├── 00_INDEX_STORY-炼气-总目录.html
   │  │  │  │  ├── 00_INDEX_STORY-炼气-总目录.md
   │  │  │  │  ├── [STORY-章节-115] 第01章 炼气·凡尘初闻道.html
   │  │  │  │  ├── [STORY-章节-115] 第01章 炼气·凡尘初闻道.md
   │  │  │  │  ├── [STORY-章节-116] 第02章 炼气·万言炉与接龙诀.html
   │  │  │  │  └── [STORY-章节-116] 第02章 炼气·万言炉与接龙诀.md
   │  │  │  ├── STORY-炼虚
   │  │  │  │  ├── 00_INDEX_STORY-炼虚-总目录.html
   │  │  │  │  ├── 00_INDEX_STORY-炼虚-总目录.md
   │  │  │  │  ├── [STORY-章节-123] 第09章 炼虚·万象坐标.html
   │  │  │  │  ├── [STORY-章节-123] 第09章 炼虚·万象坐标.md
   │  │  │  │  ├── [STORY-章节-124] 第10章 炼虚·藏经阁.html
   │  │  │  │  └── [STORY-章节-124] 第10章 炼虚·藏经阁.md
   │  │  │  ├── STORY-番外
   │  │  │  │  ├── 00_INDEX_STORY-番外-总目录.html
   │  │  │  │  ├── 00_INDEX_STORY-番外-总目录.md
   │  │  │  │  ├── [STORY-番外-100] 番外01·观照之眼·注意力真谛.html
   │  │  │  │  ├── [STORY-番外-100] 番外01·观照之眼·注意力真谛.md
   │  │  │  │  ├── [STORY-番外-101] 番外02·炼器工坊·铸炉真诀.html
   │  │  │  │  ├── [STORY-番外-101] 番外02·炼器工坊·铸炉真诀.md
   │  │  │  │  ├── [STORY-番外-102] 番外03·护道法阵·御炉真章.html
   │  │  │  │  ├── [STORY-番外-102] 番外03·护道法阵·御炉真章.md
   │  │  │  │  ├── [STORY-番外-103] 番外04·法眼观物·一照真章.html
   │  │  │  │  ├── [STORY-番外-103] 番外04·法眼观物·一照真章.md
   │  │  │  │  ├── [STORY-番外-104] 番外05·立身法旨·开宗第一诀.html
   │  │  │  │  ├── [STORY-番外-104] 番外05·立身法旨·开宗第一诀.md
   │  │  │  │  ├── [STORY-番外-105] 番外06·思行合一·观己而动.html
   │  │  │  │  ├── [STORY-番外-105] 番外06·思行合一·观己而动.md
   │  │  │  │  ├── [STORY-番外-106] 番外07·万化调兵·分身有主.html
   │  │  │  │  ├── [STORY-番外-106] 番外07·万化调兵·分身有主.md
   │  │  │  │  ├── [STORY-番外-107] 番外08·步步推演·显影心算.html
   │  │  │  │  ├── [STORY-番外-107] 番外08·步步推演·显影心算.md
   │  │  │  │  ├── [STORY-番外-108] 番外09·回照自省·闻过则改.html
   │  │  │  │  ├── [STORY-番外-108] 番外09·回照自省·闻过则改.md
   │  │  │  │  ├── [STORY-番外-109] 番外10·先谋后动·分段克敌.html
   │  │  │  │  ├── [STORY-番外-109] 番外10·先谋后动·分段克敌.md
   │  │  │  │  ├── [STORY-番外-110] 番外11·万途并参·择优而行.html
   │  │  │  │  ├── [STORY-番外-110] 番外11·万途并参·择优而行.md
   │  │  │  │  ├── [STORY-番外-111] 番外12·点化真身·因材塑形.html
   │  │  │  │  ├── [STORY-番外-111] 番外12·点化真身·因材塑形.md
   │  │  │  │  ├── [STORY-番外-112] 番外13·赏罚淬心·万炼归真.html
   │  │  │  │  ├── [STORY-番外-112] 番外13·赏罚淬心·万炼归真.md
   │  │  │  │  ├── [STORY-番外-113] 番外14·六识同参·眼耳互通.html
   │  │  │  │  ├── [STORY-番外-113] 番外14·六识同参·眼耳互通.md
   │  │  │  │  ├── [STORY-番外-114] 番外15·火候心诀·随机造化.html
   │  │  │  │  └── [STORY-番外-114] 番外15·火候心诀·随机造化.md
   │  │  │  ├── STORY-筑基
   │  │  │  │  ├── 00_INDEX_STORY-筑基-总目录.html
   │  │  │  │  ├── 00_INDEX_STORY-筑基-总目录.md
   │  │  │  │  ├── [STORY-章节-117] 第03章 筑基·言灵咒.html
   │  │  │  │  ├── [STORY-章节-117] 第03章 筑基·言灵咒.md
   │  │  │  │  ├── [STORY-章节-118] 第04章 筑基·纳言之窗.html
   │  │  │  │  └── [STORY-章节-118] 第04章 筑基·纳言之窗.md
   │  │  │  └── STORY-金丹
   │  │  │     ├── 00_INDEX_STORY-金丹-总目录.html
   │  │  │     ├── 00_INDEX_STORY-金丹-总目录.md
   │  │  │     ├── [STORY-章节-119] 第05章 金丹·驭器术.html
   │  │  │     ├── [STORY-章节-119] 第05章 金丹·驭器术.md
   │  │  │     ├── [STORY-章节-120] 第06章 金丹·周天循环.html
   │  │  │     └── [STORY-章节-120] 第06章 金丹·周天循环.md
   │  │  ├── 09_STORY_修仙学AI.zip
   │  │  ├── 10_规范
   │  │  │  ├── 00_INDEX_规范-总目录.html
   │  │  │  ├── 00_INDEX_规范-总目录.md
   │  │  │  ├── DESIGN-API
   │  │  │  │  ├── 00_INDEX_DESIGN-API-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-API-总目录.md
   │  │  │  │  ├── [DESIGN-API-001] API 设计规范.html
   │  │  │  │  ├── [DESIGN-API-001] API 设计规范.md
   │  │  │  │  ├── [DESIGN-API-002] 外部错误信封与版本弃用政策.html
   │  │  │  │  ├── [DESIGN-API-002] 外部错误信封与版本弃用政策.md
   │  │  │  │  ├── [DESIGN-API-003] API 幂等性规范.html
   │  │  │  │  └── [DESIGN-API-003] API 幂等性规范.md
   │  │  │  ├── DESIGN-DOC
   │  │  │  │  ├── 00_INDEX_DESIGN-DOC-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-DOC-总目录.md
   │  │  │  │  ├── [DESIGN-DOC-001] 文档结构规范.html
   │  │  │  │  ├── [DESIGN-DOC-001] 文档结构规范.md
   │  │  │  │  ├── [DESIGN-DOC-002] AI 指令文件标准.html
   │  │  │  │  ├── [DESIGN-DOC-002] AI 指令文件标准.md
   │  │  │  │  ├── [DESIGN-DOC-003] README 内容规范.html
   │  │  │  │  └── [DESIGN-DOC-003] README 内容规范.md
   │  │  │  ├── DESIGN-FE
   │  │  │  │  ├── 00_INDEX_DESIGN-FE-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-FE-总目录.md
   │  │  │  │  ├── [DESIGN-FE-001] 前端页面规范.html
   │  │  │  │  ├── [DESIGN-FE-001] 前端页面规范.md
   │  │  │  │  ├── [DESIGN-FE-002] 前端组件库规范.html
   │  │  │  │  ├── [DESIGN-FE-002] 前端组件库规范.md
   │  │  │  │  ├── [DESIGN-FE-003] 前端快速参考卡.html
   │  │  │  │  ├── [DESIGN-FE-003] 前端快速参考卡.md
   │  │  │  │  ├── [DESIGN-FE-004] 前端 CSS 与样式架构规范.html
   │  │  │  │  ├── [DESIGN-FE-004] 前端 CSS 与样式架构规范.md
   │  │  │  │  ├── [DESIGN-FE-005] 组件开发规范.html
   │  │  │  │  ├── [DESIGN-FE-005] 组件开发规范.md
   │  │  │  │  ├── [DESIGN-FE-006] 组件API设计-基础组件.html
   │  │  │  │  ├── [DESIGN-FE-006] 组件API设计-基础组件.md
   │  │  │  │  ├── [DESIGN-FE-007] 组件API设计-反馈组件.html
   │  │  │  │  ├── [DESIGN-FE-007] 组件API设计-反馈组件.md
   │  │  │  │  ├── [DESIGN-FE-008] 组件API设计-数据组件.html
   │  │  │  │  ├── [DESIGN-FE-008] 组件API设计-数据组件.md
   │  │  │  │  ├── [DESIGN-FE-009] 组件测试规范.html
   │  │  │  │  ├── [DESIGN-FE-009] 组件测试规范.md
   │  │  │  │  ├── [DESIGN-FE-010] 组件文档与发布规范.html
   │  │  │  │  ├── [DESIGN-FE-010] 组件文档与发布规范.md
   │  │  │  │  ├── [DESIGN-FE-011] 组件质量保证规范.html
   │  │  │  │  └── [DESIGN-FE-011] 组件质量保证规范.md
   │  │  │  ├── DESIGN-GIT
   │  │  │  │  ├── 00_INDEX_DESIGN-GIT-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-GIT-总目录.md
   │  │  │  │  ├── [DESIGN-GIT-001] Git 工作流规范.html
   │  │  │  │  ├── [DESIGN-GIT-001] Git 工作流规范.md
   │  │  │  │  ├── [DESIGN-GIT-002] Commit Message 规范.html
   │  │  │  │  ├── [DESIGN-GIT-002] Commit Message 规范.md
   │  │  │  │  ├── [DESIGN-GIT-003] Git 自动化治理规范.html
   │  │  │  │  ├── [DESIGN-GIT-003] Git 自动化治理规范.md
   │  │  │  │  ├── [DESIGN-GIT-004] 提交时机规范.html
   │  │  │  │  └── [DESIGN-GIT-004] 提交时机规范.md
   │  │  │  ├── DESIGN-LAY
   │  │  │  │  ├── 00_INDEX_DESIGN-LAY-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-LAY-总目录.md
   │  │  │  │  ├── [DESIGN-LAY-001] 后端分层架构规范.html
   │  │  │  │  ├── [DESIGN-LAY-001] 后端分层架构规范.md
   │  │  │  │  ├── [DESIGN-LAY-002] 目录层级与文件归类规范.html
   │  │  │  │  ├── [DESIGN-LAY-002] 目录层级与文件归类规范.md
   │  │  │  │  ├── [DESIGN-LAY-003] 仓库整理与巡检规范.html
   │  │  │  │  ├── [DESIGN-LAY-003] 仓库整理与巡检规范.md
   │  │  │  │  ├── [DESIGN-LAY-004] build-root-demo.js
   │  │  │  │  ├── [DESIGN-LAY-004] 构建产物单一根规范.html
   │  │  │  │  ├── [DESIGN-LAY-004] 构建产物单一根规范.md
   │  │  │  │  ├── [DESIGN-LAY-005] 仓库层级板块规范.html
   │  │  │  │  ├── [DESIGN-LAY-005] 仓库层级板块规范.md
   │  │  │  │  ├── [DESIGN-LAY-006] family-probe.js
   │  │  │  │  ├── [DESIGN-LAY-006] layout-probe.js
   │  │  │  │  ├── [DESIGN-LAY-006] move-cost.js
   │  │  │  │  ├── [DESIGN-LAY-006] 仓库层级可发现性规范.html
   │  │  │  │  ├── [DESIGN-LAY-006] 仓库层级可发现性规范.md
   │  │  │  │  ├── [DESIGN-LAY-007] 三态目录立体分层方案.html
   │  │  │  │  ├── [DESIGN-LAY-007] 三态目录立体分层方案.md
   │  │  │  │  ├── [DESIGN-LAY-008] 目录层级重设计执行路线图.html
   │  │  │  │  ├── [DESIGN-LAY-008] 目录层级重设计执行路线图.md
   │  │  │  │  ├── [DESIGN-LAY-008] 附录A 方案P全量文件去向表.html
   │  │  │  │  └── [DESIGN-LAY-008] 附录A 方案P全量文件去向表.md
   │  │  │  ├── DESIGN-MEM
   │  │  │  │  ├── 00_INDEX_DESIGN-MEM-总目录.html
   │  │  │  │  ├── 00_INDEX_DESIGN-MEM-总目录.md
   │  │  │  │  ├── [DESIGN-MEM-000] 记忆系统总结.html
   │  │  │  │  ├── [DESIGN-MEM-000] 记忆系统总结.md
   │  │  │  │  ├── [DESIGN-MEM-001] 记忆系统标准规范.html
   │  │  │  │  ├── [DESIGN-MEM-001] 记忆系统标准规范.md
   │  │  │  │  ├── [DESIGN-MEM-002] 记忆时机指南.html
   │  │  │  │  ├── [DESIGN-MEM-002] 记忆时机指南.md
   │  │  │  │  ├── [DESIGN-MEM-003] 记忆模板库.html
   │  │  │  │  ├── [DESIGN-MEM-003] 记忆模板库.md
   │  │  │  │  ├── [DESIGN-MEM-004] 记忆快速参考卡.html
   │  │  │  │  ├── [DESIGN-MEM-004] 记忆快速参考卡.md
   │  │  │  │  ├── [DESIGN-MEM-005] 记忆系统使用指南.html
   │  │  │  │  ├── [DESIGN-MEM-005] 记忆系统使用指南.md
   │  │  │  │  ├── [DESIGN-MEM-006] 记忆与维护元数据生命周期规范.html
   │  │  │  │  ├── [DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md
   │  │  │  │  ├── [DESIGN-MEM-008] 记忆操作可见性规范.html
   │  │  │  │  └── [DESIGN-MEM-008] 记忆操作可见性规范.md
   │  │  │  ├── registry
   │  │  │  │  ├── 00_INDEX_registry-总目录.html
   │  │  │  │  ├── 00_INDEX_registry-总目录.md
   │  │  │  │  ├── ARCHITECTURE-POLICY.json
   │  │  │  │  ├── BUILD-OUTPUTS.json
   │  │  │  │  ├── COPYRIGHT-MATERIALS.json
   │  │  │  │  ├── COPYRIGHT.json
   │  │  │  │  ├── DATA-LOCATIONS.json
   │  │  │  │  ├── DOMAIN-DEPS.json
   │  │  │  │  ├── FEATURE-OWNERSHIP.json
   │  │  │  │  ├── MEMORY-RECORD-SCHEMA.json
   │  │  │  │  ├── PROPOSAL-ARTIFACT-INDEX.json
   │  │  │  │  ├── RULES-REGISTRY.json
   │  │  │  │  └── SOURCING-PROVENANCE.json
   │  │  │  ├── 其它规范
   │  │  │  │  ├── 00_INDEX_其它规范-总目录.html
   │  │  │  │  ├── 00_INDEX_其它规范-总目录.md
   │  │  │  │  ├── FILE-FORMAT-PROTOCOL.html
   │  │  │  │  ├── FILE-FORMAT-PROTOCOL.md
   │  │  │  │  ├── PROCESS-102-下一步最该做什么决策标准.html
   │  │  │  │  ├── PROCESS-102-下一步最该做什么决策标准.md
   │  │  │  │  ├── RELIABILITY-PROTOCOL.html
   │  │  │  │  ├── RELIABILITY-PROTOCOL.md
   │  │  │  │  ├── [DESIGN-A11Y-001] 可访问性规范.html
   │  │  │  │  ├── [DESIGN-A11Y-001] 可访问性规范.md
   │  │  │  │  ├── [DESIGN-A2A-001] A2A 协议规范.html
   │  │  │  │  ├── [DESIGN-A2A-001] A2A 协议规范.md
   │  │  │  │  ├── [DESIGN-A2A-002] A2A 标准协议适配规范.html
   │  │  │  │  ├── [DESIGN-A2A-002] A2A 标准协议适配规范.md
   │  │  │  │  ├── [DESIGN-ACP-001] ACP消息元数据与终态契约.html
   │  │  │  │  ├── [DESIGN-ACP-001] ACP消息元数据与终态契约.md
   │  │  │  │  ├── [DESIGN-AGENT-001] 子智能体交接契约.html
   │  │  │  │  ├── [DESIGN-AGENT-001] 子智能体交接契约.md
   │  │  │  │  ├── [DESIGN-AGENT-002] 智能体工具授权矩阵.html
   │  │  │  │  ├── [DESIGN-AGENT-002] 智能体工具授权矩阵.md
   │  │  │  │  ├── [DESIGN-AUD-001] 审计日志规范.html
   │  │  │  │  ├── [DESIGN-AUD-001] 审计日志规范.md
   │  │  │  │  ├── [DESIGN-AUTH-002] Session 管理规范.html
   │  │  │  │  ├── [DESIGN-AUTH-002] Session 管理规范.md
   │  │  │  │  ├── [DESIGN-BACKUP-001] 备份恢复规范.html
   │  │  │  │  ├── [DESIGN-BACKUP-001] 备份恢复规范.md
   │  │  │  │  ├── [DESIGN-CACHE-001] 缓存规范.html
   │  │  │  │  ├── [DESIGN-CACHE-001] 缓存规范.md
   │  │  │  │  ├── [DESIGN-CAP-001] 容量规划规范.html
   │  │  │  │  ├── [DESIGN-CAP-001] 容量规划规范.md
   │  │  │  │  ├── [DESIGN-CHANGELOG-001] Changelog 格式规范.html
   │  │  │  │  ├── [DESIGN-CHANGELOG-001] Changelog 格式规范.md
   │  │  │  │  ├── [DESIGN-CICD-001] CI-CD 规范.html
   │  │  │  │  ├── [DESIGN-CICD-001] CI-CD 规范.md
   │  │  │  │  ├── [DESIGN-COM-001] 代码注释规范.html
   │  │  │  │  ├── [DESIGN-COM-001] 代码注释规范.md
   │  │  │  │  ├── [DESIGN-COMM-001] 通信协议规范.html
   │  │  │  │  ├── [DESIGN-COMM-001] 通信协议规范.md
   │  │  │  │  ├── [DESIGN-COMM-002] WebSocket 与 SSE 规范.html
   │  │  │  │  ├── [DESIGN-COMM-002] WebSocket 与 SSE 规范.md
   │  │  │  │  ├── [DESIGN-COMP-001] 代码复杂度规范.html
   │  │  │  │  ├── [DESIGN-COMP-001] 代码复杂度规范.md
   │  │  │  │  ├── [DESIGN-CORS-001] CORS 跨域资源共享规范.html
   │  │  │  │  ├── [DESIGN-CORS-001] CORS 跨域资源共享规范.md
   │  │  │  │  ├── [DESIGN-DB-001] 数据库规范.html
   │  │  │  │  ├── [DESIGN-DB-001] 数据库规范.md
   │  │  │  │  ├── [DESIGN-DELIV-001] 可交付性判断标准.html
   │  │  │  │  ├── [DESIGN-DELIV-001] 可交付性判断标准.md
   │  │  │  │  ├── [DESIGN-DELIV-002] 产品任务面与交付律.html
   │  │  │  │  ├── [DESIGN-DELIV-002] 产品任务面与交付律.md
   │  │  │  │  ├── [DESIGN-DEP-001] 依赖管理规范.html
   │  │  │  │  ├── [DESIGN-DEP-001] 依赖管理规范.md
   │  │  │  │  ├── [DESIGN-DEPLOY-001] 部署规范.html
   │  │  │  │  ├── [DESIGN-DEPLOY-001] 部署规范.md
   │  │  │  │  ├── [DESIGN-DLQ-001] Dead Letter Queue 规范.html
   │  │  │  │  ├── [DESIGN-DLQ-001] Dead Letter Queue 规范.md
   │  │  │  │  ├── [DESIGN-DR-001] 灾备规范.html
   │  │  │  │  ├── [DESIGN-DR-001] 灾备规范.md
   │  │  │  │  ├── [DESIGN-ENV-001] 环境配置规范.html
   │  │  │  │  ├── [DESIGN-ENV-001] 环境配置规范.md
   │  │  │  │  ├── [DESIGN-ERR-001] 错误处理规范.html
   │  │  │  │  ├── [DESIGN-ERR-001] 错误处理规范.md
   │  │  │  │  ├── [DESIGN-FF-001] Feature Flag 功能开关规范.html
   │  │  │  │  ├── [DESIGN-FF-001] Feature Flag 功能开关规范.md
   │  │  │  │  ├── [DESIGN-GOV-001] 治理总纲与可执行规则.html
   │  │  │  │  ├── [DESIGN-GOV-001] 治理总纲与可执行规则.md
   │  │  │  │  ├── [DESIGN-GW-002] AI 模型降级与熔断规范.html
   │  │  │  │  ├── [DESIGN-GW-002] AI 模型降级与熔断规范.md
   │  │  │  │  ├── [DESIGN-I18N-001] 国际化规范.html
   │  │  │  │  ├── [DESIGN-I18N-001] 国际化规范.md
   │  │  │  │  ├── [DESIGN-IP-001] 软件著作权就绪规范.html
   │  │  │  │  ├── [DESIGN-IP-001] 软件著作权就绪规范.md
   │  │  │  │  ├── [DESIGN-IP-002] 软著材料生成器与在仓契约.html
   │  │  │  │  ├── [DESIGN-IP-002] 软著材料生成器与在仓契约.md
   │  │  │  │  ├── [DESIGN-IR-001] 事件响应规范.html
   │  │  │  │  ├── [DESIGN-IR-001] 事件响应规范.md
   │  │  │  │  ├── [DESIGN-LOG-001] 日志规范.html
   │  │  │  │  ├── [DESIGN-LOG-001] 日志规范.md
   │  │  │  │  ├── [DESIGN-MCP-001] MCP 协议实现规范.html
   │  │  │  │  ├── [DESIGN-MCP-001] MCP 协议实现规范.md
   │  │  │  │  ├── [DESIGN-MIG-001] 数据迁移规范.html
   │  │  │  │  ├── [DESIGN-MIG-001] 数据迁移规范.md
   │  │  │  │  ├── [DESIGN-MONITOR-001] 监控告警规范.html
   │  │  │  │  ├── [DESIGN-MONITOR-001] 监控告警规范.md
   │  │  │  │  ├── [DESIGN-MS-001] 微服务通信规范.html
   │  │  │  │  ├── [DESIGN-MS-001] 微服务通信规范.md
   │  │  │  │  ├── [DESIGN-NAM-001] 统一命名规范.html
   │  │  │  │  ├── [DESIGN-NAM-001] 统一命名规范.md
   │  │  │  │  ├── [DESIGN-NAM-002] A2A 与 ACP 命名及术语规范.html
   │  │  │  │  ├── [DESIGN-NAM-002] A2A 与 ACP 命名及术语规范.md
   │  │  │  │  ├── [DESIGN-NOTIFY-001] 通知与邮件规范.html
   │  │  │  │  ├── [DESIGN-NOTIFY-001] 通知与邮件规范.md
   │  │  │  │  ├── [DESIGN-OBS-001] 可观测性三支柱规范.html
   │  │  │  │  ├── [DESIGN-OBS-001] 可观测性三支柱规范.md
   │  │  │  │  ├── [DESIGN-OPS-002] Graceful Shutdown 规范.html
   │  │  │  │  ├── [DESIGN-OPS-002] Graceful Shutdown 规范.md
   │  │  │  │  ├── [DESIGN-OPS-003] Health Check 规范.html
   │  │  │  │  ├── [DESIGN-OPS-003] Health Check 规范.md
   │  │  │  │  ├── [DESIGN-OUT-001] 输出结构规范.html
   │  │  │  │  ├── [DESIGN-OUT-001] 输出结构规范.md
   │  │  │  │  ├── [DESIGN-PERF-001] 性能规范.html
   │  │  │  │  ├── [DESIGN-PERF-001] 性能规范.md
   │  │  │  │  ├── [DESIGN-PRIN-001] 好设计十诫工程判据.html
   │  │  │  │  ├── [DESIGN-PRIN-001] 好设计十诫工程判据.md
   │  │  │  │  ├── [DESIGN-PRIV-001] 数据隐私规范.html
   │  │  │  │  ├── [DESIGN-PRIV-001] 数据隐私规范.md
   │  │  │  │  ├── [DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.html
   │  │  │  │  ├── [DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md
   │  │  │  │  ├── [DESIGN-PROCESS-002] 新机制落地四阶段流程.html
   │  │  │  │  ├── [DESIGN-PROCESS-002] 新机制落地四阶段流程.md
   │  │  │  │  ├── [DESIGN-PROCESS-003] 规范-实现变更判定规范.html
   │  │  │  │  ├── [DESIGN-PROCESS-003] 规范-实现变更判定规范.md
   │  │  │  │  ├── [DESIGN-PROMPT-001] Prompt Engineering 规范.html
   │  │  │  │  ├── [DESIGN-PROMPT-001] Prompt Engineering 规范.md
   │  │  │  │  ├── [DESIGN-PROMPT-002] 系统提示词分层规范-静态与动态分区.html
   │  │  │  │  ├── [DESIGN-PROMPT-002] 系统提示词分层规范-静态与动态分区.md
   │  │  │  │  ├── [DESIGN-QUAL-001] 门禁基线与债务台账规范.html
   │  │  │  │  ├── [DESIGN-QUAL-001] 门禁基线与债务台账规范.md
   │  │  │  │  ├── [DESIGN-QUAL-002] 官方一致性套件接入规范.html
   │  │  │  │  ├── [DESIGN-QUAL-002] 官方一致性套件接入规范.md
   │  │  │  │  ├── [DESIGN-REVIEW-001] 代码审查规范.html
   │  │  │  │  ├── [DESIGN-REVIEW-001] 代码审查规范.md
   │  │  │  │  ├── [DESIGN-RL-001] Rate Limiting 限流规范.html
   │  │  │  │  ├── [DESIGN-RL-001] Rate Limiting 限流规范.md
   │  │  │  │  ├── [DESIGN-SEC-001] 安全规范.html
   │  │  │  │  ├── [DESIGN-SEC-001] 安全规范.md
   │  │  │  │  ├── [DESIGN-SEMVER-001] 语义化版本规范.html
   │  │  │  │  ├── [DESIGN-SEMVER-001] 语义化版本规范.md
   │  │  │  │  ├── [DESIGN-SEMVER-002] 版本管理与发布触发规范.html
   │  │  │  │  ├── [DESIGN-SEMVER-002] 版本管理与发布触发规范.md
   │  │  │  │  ├── [DESIGN-SKILL-001] Skill 编写规范.html
   │  │  │  │  ├── [DESIGN-SKILL-001] Skill 编写规范.md
   │  │  │  │  ├── [DESIGN-SOURCING-001] 借鉴与实现统一规则.html
   │  │  │  │  ├── [DESIGN-SOURCING-001] 借鉴与实现统一规则.md
   │  │  │  │  ├── [DESIGN-STD-001] 文档国标映射规范.html
   │  │  │  │  ├── [DESIGN-STD-001] 文档国标映射规范.md
   │  │  │  │  ├── [DESIGN-TEST-001] 测试规范.html
   │  │  │  │  ├── [DESIGN-TEST-001] 测试规范.md
   │  │  │  │  ├── [DESIGN-TOOL-001] 工具与扩展升级废弃规范.html
   │  │  │  │  ├── [DESIGN-TOOL-001] 工具与扩展升级废弃规范.md
   │  │  │  │  ├── [DESIGN-TOOL-002] 拓展契约与核心边界规范.html
   │  │  │  │  ├── [DESIGN-TOOL-002] 拓展契约与核心边界规范.md
   │  │  │  │  ├── [DESIGN-UI-002] 界面设计方案.html
   │  │  │  │  ├── [DESIGN-UI-002] 界面设计方案.md
   │  │  │  │  ├── [DESIGN-UI-TEST-001] UI设计验证测试规范.html
   │  │  │  │  ├── [DESIGN-UI-TEST-001] UI设计验证测试规范.md
   │  │  │  │  ├── [DESIGN-UPLOAD-001] 文件上传规范.html
   │  │  │  │  └── [DESIGN-UPLOAD-001] 文件上传规范.md
   │  │  │  └── 规则卡
   │  │  │     ├── 00_INDEX_规则卡总目录.html
   │  │  │     ├── 00_INDEX_规则卡总目录.md
   │  │  │     ├── [AGENT-001] 子智能体交接契约.html
   │  │  │     ├── [AGENT-001] 子智能体交接契约.md
   │  │  │     ├── [API-001] 内外 API 边界.html
   │  │  │     ├── [API-001] 内外 API 边界.md
   │  │  │     ├── [API-002] API 版本化与弃用政策.html
   │  │  │     ├── [API-002] API 版本化与弃用政策.md
   │  │  │     ├── [API-003] 统一错误信封与四终态.html
   │  │  │     ├── [API-003] 统一错误信封与四终态.md
   │  │  │     ├── [API-004] 最小披露跨 transport 传播.html
   │  │  │     ├── [API-004] 最小披露跨 transport 传播.md
   │  │  │     ├── [AUD-001] 审计日志规范.html
   │  │  │     ├── [AUD-001] 审计日志规范.md
   │  │  │     ├── [AUTH-002] Session 管理规范.html
   │  │  │     ├── [AUTH-002] Session 管理规范.md
   │  │  │     ├── [BACKUP-001] 备份恢复规范.html
   │  │  │     ├── [BACKUP-001] 备份恢复规范.md
   │  │  │     ├── [COM-001] 代码注释规范.html
   │  │  │     ├── [COM-001] 代码注释规范.md
   │  │  │     ├── [COMMS-001] ACP 三态信封.html
   │  │  │     ├── [COMMS-001] ACP 三态信封.md
   │  │  │     ├── [COMMS-002] ACP 方法登记制.html
   │  │  │     ├── [COMMS-002] ACP 方法登记制.md
   │  │  │     ├── [COMMS-003] 全链路追踪标识.html
   │  │  │     ├── [COMMS-003] 全链路追踪标识.md
   │  │  │     ├── [COMMS-004] 可观察终态与错误码.html
   │  │  │     ├── [COMMS-004] 可观察终态与错误码.md
   │  │  │     ├── [COMP-001] 代码复杂度规范.html
   │  │  │     ├── [COMP-001] 代码复杂度规范.md
   │  │  │     ├── [CORS-001] CORS 跨域资源共享规范.html
   │  │  │     ├── [CORS-001] CORS 跨域资源共享规范.md
   │  │  │     ├── [DLQ-001] 死信队列规范.html
   │  │  │     ├── [DLQ-001] 死信队列规范.md
   │  │  │     ├── [DOCS-001] 文档命名与索引登记.html
   │  │  │     ├── [DOCS-001] 文档命名与索引登记.md
   │  │  │     ├── [DOCS-002] 索引命名格式动态决策.html
   │  │  │     ├── [DOCS-002] 索引命名格式动态决策.md
   │  │  │     ├── [DOCS-003] AI 指令文件标准.html
   │  │  │     ├── [DOCS-003] AI 指令文件标准.md
   │  │  │     ├── [DOCS-004] README 内容规范.html
   │  │  │     ├── [DOCS-004] README 内容规范.md
   │  │  │     ├── [DR-001] 灾备规范.html
   │  │  │     ├── [DR-001] 灾备规范.md
   │  │  │     ├── [FE-004] 前端 CSS 与样式架构规范.html
   │  │  │     ├── [FE-004] 前端 CSS 与样式架构规范.md
   │  │  │     ├── [FF-001] Feature Flag 功能开关规范.html
   │  │  │     ├── [FF-001] Feature Flag 功能开关规范.md
   │  │  │     ├── [GW-002] AI 模型降级与熔断规范.html
   │  │  │     ├── [GW-002] AI 模型降级与熔断规范.md
   │  │  │     ├── [IR-001] 事件响应规范.html
   │  │  │     ├── [IR-001] 事件响应规范.md
   │  │  │     ├── [LAYOUT-001] 目录层级与文件归类.html
   │  │  │     ├── [LAYOUT-001] 目录层级与文件归类.md
   │  │  │     ├── [LAYOUT-002] 上帝文件门.html
   │  │  │     ├── [LAYOUT-002] 上帝文件门.md
   │  │  │     ├── [LAYOUT-003] 任务入口命名规约.html
   │  │  │     ├── [LAYOUT-003] 任务入口命名规约.md
   │  │  │     ├── [LAYOUT-004] 仓库整理与巡检.html
   │  │  │     ├── [LAYOUT-004] 仓库整理与巡检.md
   │  │  │     ├── [LAYOUT-005] 构建产物单一根.html
   │  │  │     ├── [LAYOUT-005] 构建产物单一根.md
   │  │  │     ├── [LAYOUT-006] 仓库层级可发现性.html
   │  │  │     ├── [LAYOUT-006] 仓库层级可发现性.md
   │  │  │     ├── [LAYOUT-007] 三态目录立体分层.html
   │  │  │     ├── [LAYOUT-007] 三态目录立体分层.md
   │  │  │     ├── [MEMORY-001] session 与 persistent 区分.html
   │  │  │     ├── [MEMORY-001] session 与 persistent 区分.md
   │  │  │     ├── [MEMORY-002] persistent 记录要素.html
   │  │  │     ├── [MEMORY-002] persistent 记录要素.md
   │  │  │     ├── [MEMORY-003] 指定读写入口.html
   │  │  │     ├── [MEMORY-003] 指定读写入口.md
   │  │  │     ├── [MEMORY-004] session 生命周期清除.html
   │  │  │     ├── [MEMORY-004] session 生命周期清除.md
   │  │  │     ├── [MGMT-STD-008] 规则编写与管理规范（元规则）.html
   │  │  │     ├── [MGMT-STD-008] 规则编写与管理规范（元规则）.md
   │  │  │     ├── [MIG-001] 数据迁移规范.html
   │  │  │     ├── [MIG-001] 数据迁移规范.md
   │  │  │     ├── [MOD-004] 治理总纲板块入口.html
   │  │  │     ├── [MOD-004] 治理总纲板块入口.md
   │  │  │     ├── [NAM-001] 统一命名规范.html
   │  │  │     ├── [NAM-001] 统一命名规范.md
   │  │  │     ├── [NAM-002] A2A 与 ACP 命名及术语规范.html
   │  │  │     ├── [NAM-002] A2A 与 ACP 命名及术语规范.md
   │  │  │     ├── [NOTIFY-001] 通知与邮件规范.html
   │  │  │     ├── [NOTIFY-001] 通知与邮件规范.md
   │  │  │     ├── [OPS-002] Graceful Shutdown 规范.html
   │  │  │     ├── [OPS-002] Graceful Shutdown 规范.md
   │  │  │     ├── [OPS-003] Health Check 规范.html
   │  │  │     ├── [OPS-003] Health Check 规范.md
   │  │  │     ├── [PROCESS-001] 分支纪律.html
   │  │  │     ├── [PROCESS-001] 分支纪律.md
   │  │  │     ├── [PROCESS-002] 多轨道版本同步.html
   │  │  │     ├── [PROCESS-002] 多轨道版本同步.md
   │  │  │     ├── [PROCESS-003] 验收门禁.html
   │  │  │     ├── [PROCESS-003] 验收门禁.md
   │  │  │     ├── [PROCESS-004] 委派边界.html
   │  │  │     ├── [PROCESS-004] 委派边界.md
   │  │  │     ├── [PROCESS-005] 版本管理与发布触发.html
   │  │  │     ├── [PROCESS-005] 版本管理与发布触发.md
   │  │  │     ├── [PROCESS-006] 新机制落地四阶段.html
   │  │  │     ├── [PROCESS-006] 新机制落地四阶段.md
   │  │  │     ├── [PROCESS-007] 引导式搜索与压缩保留清单.html
   │  │  │     ├── [PROCESS-007] 引导式搜索与压缩保留清单.md
   │  │  │     ├── [PROCESS-008] 新机制落地阶段可校验.html
   │  │  │     ├── [PROCESS-008] 新机制落地阶段可校验.md
   │  │  │     ├── [PROCESS-009] 提交时机判据（到点就提交）.html
   │  │  │     ├── [PROCESS-009] 提交时机判据（到点就提交）.md
   │  │  │     ├── [PROCESS-010] 软件著作权就绪.html
   │  │  │     ├── [PROCESS-010] 软件著作权就绪.md
   │  │  │     ├── [PROCESS-011] 规范-实现变更判定.html
   │  │  │     ├── [PROCESS-011] 规范-实现变更判定.md
   │  │  │     ├── [PROCESS-013] 构建与交付依赖须原生官方源.html
   │  │  │     ├── [PROCESS-013] 构建与交付依赖须原生官方源.md
   │  │  │     ├── [PROCESS-014] 可交付性基线.html
   │  │  │     ├── [PROCESS-014] 可交付性基线.md
   │  │  │     ├── [PROCESS-101] 贡献者规则提案权.html
   │  │  │     ├── [PROCESS-101] 贡献者规则提案权.md
   │  │  │     ├── [PROCESS-102] 下一步最该做什么决策标准.html
   │  │  │     ├── [PROCESS-102] 下一步最该做什么决策标准.md
   │  │  │     ├── [PROMPT-001] Prompt Engineering 规范.html
   │  │  │     ├── [PROMPT-001] Prompt Engineering 规范.md
   │  │  │     ├── [RUNTIME-001] 零硬编码.html
   │  │  │     ├── [RUNTIME-001] 零硬编码.md
   │  │  │     ├── [RUNTIME-002] 状态透明.html
   │  │  │     ├── [RUNTIME-002] 状态透明.md
   │  │  │     ├── [RUNTIME-003] 活动式超时.html
   │  │  │     ├── [RUNTIME-003] 活动式超时.md
   │  │  │     ├── [RUNTIME-004] 终端无滚动区.html
   │  │  │     ├── [RUNTIME-004] 终端无滚动区.md
   │  │  │     ├── [RUNTIME-005] CLI 错误标准化.html
   │  │  │     ├── [RUNTIME-005] CLI 错误标准化.md
   │  │  │     ├── [RUNTIME-006] 网关首选通道不得硬钉.html
   │  │  │     ├── [RUNTIME-006] 网关首选通道不得硬钉.md
   │  │  │     ├── [RUNTIME-007] 修复先复现（看病）.html
   │  │  │     ├── [RUNTIME-007] 修复先复现（看病）.md
   │  │  │     ├── [RUNTIME-008] 新增先提问（求学）.html
   │  │  │     ├── [RUNTIME-008] 新增先提问（求学）.md
   │  │  │     ├── [RUNTIME-009] 删除先报部位（搓澡）.html
   │  │  │     ├── [RUNTIME-009] 删除先报部位（搓澡）.md
   │  │  │     ├── [RUNTIME-010] 工具授权须明确授予（默认拒绝）.html
   │  │  │     ├── [RUNTIME-010] 工具授权须明确授予（默认拒绝）.md
   │  │  │     ├── [RUNTIME-011] TUI 动画节拍三方一致.html
   │  │  │     ├── [RUNTIME-011] TUI 动画节拍三方一致.md
   │  │  │     ├── [SEC-001] 安全规范（安全头 输入验证 注入防护 日志脱敏）.html
   │  │  │     ├── [SEC-001] 安全规范（安全头 输入验证 注入防护 日志脱敏）.md
   │  │  │     ├── [SECURITY-001] 密钥防泄露.html
   │  │  │     ├── [SECURITY-001] 密钥防泄露.md
   │  │  │     ├── [SECURITY-002] critical gate 不可绕过.html
   │  │  │     ├── [SECURITY-002] critical gate 不可绕过.md
   │  │  │     ├── [SECURITY-003] 弱模型改动护栏.html
   │  │  │     ├── [SECURITY-003] 弱模型改动护栏.md
   │  │  │     ├── [SECURITY-004] 权限档 fail-closed.html
   │  │  │     ├── [SECURITY-004] 权限档 fail-closed.md
   │  │  │     ├── [SKILL-001] Skill 编写规范.html
   │  │  │     ├── [SKILL-001] Skill 编写规范.md
   │  │  │     ├── [SOURCING-001] 上游源码不复制.html
   │  │  │     ├── [SOURCING-001] 上游源码不复制.md
   │  │  │     ├── [SOURCING-002] 许可证分级硬门槛.html
   │  │  │     ├── [SOURCING-002] 许可证分级硬门槛.md
   │  │  │     ├── [SOURCING-003] 六字段提案先行.html
   │  │  │     ├── [SOURCING-003] 六字段提案先行.md
   │  │  │     ├── [SOURCING-004] 能力域归属登记.html
   │  │  │     ├── [SOURCING-004] 能力域归属登记.md
   │  │  │     ├── [SOURCING-005] 实现唯一性与四步检索.html
   │  │  │     ├── [SOURCING-005] 实现唯一性与四步检索.md
   │  │  │     ├── [SOURCING-006] 决策只追加不改写.html
   │  │  │     ├── [SOURCING-006] 决策只追加不改写.md
   │  │  │     ├── [TOOLING-001] 扩展一目录一 manifest.html
   │  │  │     ├── [TOOLING-001] 扩展一目录一 manifest.md
   │  │  │     ├── [TOOLING-002] 工具注册契约.html
   │  │  │     ├── [TOOLING-002] 工具注册契约.md
   │  │  │     ├── [TOOLING-003] 最小权限与升级废弃.html
   │  │  │     ├── [TOOLING-003] 最小权限与升级废弃.md
   │  │  │     ├── [TOOLING-004] 检查入口脚本必须存在.html
   │  │  │     ├── [TOOLING-004] 检查入口脚本必须存在.md
   │  │  │     ├── [TOOLING-005] 本地与 CI 双注册.html
   │  │  │     ├── [TOOLING-005] 本地与 CI 双注册.md
   │  │  │     ├── [TOOLING-006] 规则登记表.html
   │  │  │     ├── [TOOLING-006] 规则登记表.md
   │  │  │     ├── [TOOLING-007] 规则登记表与真源双向可达.html
   │  │  │     ├── [TOOLING-007] 规则登记表与真源双向可达.md
   │  │  │     ├── [TOOLING-008] 规则卡由登记表生成.html
   │  │  │     ├── [TOOLING-008] 规则卡由登记表生成.md
   │  │  │     ├── [TOOLING-009] 规则接线完整性.html
   │  │  │     ├── [TOOLING-009] 规则接线完整性.md
   │  │  │     ├── [TOOLING-010] 维护成本可观测.html
   │  │  │     ├── [TOOLING-010] 维护成本可观测.md
   │  │  │     ├── [TOOLING-011] 工作流节点类型接线一致.html
   │  │  │     ├── [TOOLING-011] 工作流节点类型接线一致.md
   │  │  │     ├── [UPLOAD-001] 文件上传规范.html
   │  │  │     └── [UPLOAD-001] 文件上传规范.md
   │  │  ├── 11_报告
   │  │  │  ├── 00_INDEX_报告-分类索引.html
   │  │  │  ├── 00_INDEX_报告-分类索引.md
   │  │  │  ├── RESEARCH
   │  │  │  │  ├── 00_INDEX_RESEARCH-总目录.html
   │  │  │  │  ├── 00_INDEX_RESEARCH-总目录.md
   │  │  │  │  ├── [RESEARCH-001] TUI微交互调研_剪贴板反馈_Toast_滚动指示器_特性门控.html
   │  │  │  │  ├── [RESEARCH-001] TUI微交互调研_剪贴板反馈_Toast_滚动指示器_特性门控.md
   │  │  │  │  ├── [RESEARCH-002] 概念入门完成度报告.html
   │  │  │  │  ├── [RESEARCH-002] 概念入门完成度报告.md
   │  │  │  │  ├── [RESEARCH-003] khy-os-协议与工程规范深度调研报告-2026-09-15.html
   │  │  │  │  ├── [RESEARCH-003] khy-os-协议与工程规范深度调研报告-2026-09-15.md
   │  │  │  │  ├── [RESEARCH-004] khy-os-协议与工程规范分步改进计划-2026-09-15.html
   │  │  │  │  ├── [RESEARCH-004] khy-os-协议与工程规范分步改进计划-2026-09-15.md
   │  │  │  │  ├── [RESEARCH-005] khy-os-能力缺口闭环执行计划-2026-09-15.html
   │  │  │  │  ├── [RESEARCH-005] khy-os-能力缺口闭环执行计划-2026-09-15.md
   │  │  │  │  ├── [RESEARCH-006] khy-os-规则合规检查报告-2026-09-15.html
   │  │  │  │  ├── [RESEARCH-006] khy-os-规则合规检查报告-2026-09-15.md
   │  │  │  │  ├── [RESEARCH-007] khy-os-规范合规审计报告-2026-09-15.html
   │  │  │  │  ├── [RESEARCH-007] khy-os-规范合规审计报告-2026-09-15.md
   │  │  │  │  ├── [RESEARCH-008] khy-os-不足诊断与自对抗式设计方案.html
   │  │  │  │  ├── [RESEARCH-008] khy-os-不足诊断与自对抗式设计方案.md
   │  │  │  │  ├── [RESEARCH-009] khy-os-深度不足诊断与对抗式修复-第二轮.html
   │  │  │  │  ├── [RESEARCH-009] khy-os-深度不足诊断与对抗式修复-第二轮.md
   │  │  │  │  ├── [RESEARCH-010] khy-os-冗余诊断与对抗式精简方案-第三轮.html
   │  │  │  │  ├── [RESEARCH-010] khy-os-冗余诊断与对抗式精简方案-第三轮.md
   │  │  │  │  ├── [RESEARCH-011] khy-os-用户体感诊断与修复-第四轮.html
   │  │  │  │  ├── [RESEARCH-011] khy-os-用户体感诊断与修复-第四轮.md
   │  │  │  │  ├── [RESEARCH-012] khy-os-用户体感诊断-第五轮.html
   │  │  │  │  ├── [RESEARCH-012] khy-os-用户体感诊断-第五轮.md
   │  │  │  │  ├── [RESEARCH-013] khy-os-三轮对抗式诊断与修复总结.html
   │  │  │  │  ├── [RESEARCH-013] khy-os-三轮对抗式诊断与修复总结.md
   │  │  │  │  ├── [RESEARCH-014] khy-os-四轮对抗式诊断与修复-最终总结.html
   │  │  │  │  ├── [RESEARCH-014] khy-os-四轮对抗式诊断与修复-最终总结.md
   │  │  │  │  ├── [RESEARCH-015] HQ合并入khyos-可行性调研-2026-09-17.html
   │  │  │  │  ├── [RESEARCH-015] HQ合并入khyos-可行性调研-2026-09-17.md
   │  │  │  │  ├── [RESEARCH-016] HQ丢弃-多机协作保留-方案-2026-09-17.html
   │  │  │  │  ├── [RESEARCH-016] HQ丢弃-多机协作保留-方案-2026-09-17.md
   │  │  │  │  ├── [RESEARCH-017] 防止越改越差-方案-2026-09-17.html
   │  │  │  │  ├── [RESEARCH-017] 防止越改越差-方案-2026-09-17.md
   │  │  │  │  ├── [RESEARCH-018] 5-3-1架构符合性调研与迁移设计-2026-09-28.html
   │  │  │  │  ├── [RESEARCH-018] 5-3-1架构符合性调研与迁移设计-2026-09-28.md
   │  │  │  │  ├── [RESEARCH-019] Claude Code源码架构深度解析与khy-os逐章对照学习指南-2026-09-29.html
   │  │  │  │  ├── [RESEARCH-019] Claude Code源码架构深度解析与khy-os逐章对照学习指南-2026-09-29.md
   │  │  │  │  ├── [RESEARCH-020] 差距一Token预算正向语义Nudge实施计划-2026-09-29.html
   │  │  │  │  ├── [RESEARCH-020] 差距一Token预算正向语义Nudge实施计划-2026-09-29.md
   │  │  │  │  ├── [RESEARCH-021] 5-3-1符合性复测与方案R收官-2026-09-30.html
   │  │  │  │  ├── [RESEARCH-021] 5-3-1符合性复测与方案R收官-2026-09-30.md
   │  │  │  │  ├── [RESEARCH-022] 5-3-1树形图设计-现状树与目标树-2026-10-02.html
   │  │  │  │  ├── [RESEARCH-022] 5-3-1树形图设计-现状树与目标树-2026-10-02.md
   │  │  │  │  ├── [RESEARCH-024] Q0积压分类与分组提交建议-2026-10-02.html
   │  │  │  │  ├── [RESEARCH-024] Q0积压分类与分组提交建议-2026-10-02.md
   │  │  │  │  ├── [RESEARCH-025] 交接执行收尾-2026-10-02.html
   │  │  │  │  └── [RESEARCH-025] 交接执行收尾-2026-10-02.md
   │  │  │  ├── metrics
   │  │  │  │  ├── 00_INDEX_metrics-总目录.html
   │  │  │  │  ├── 00_INDEX_metrics-总目录.md
   │  │  │  │  ├── 技能场景评估-2026-05-19T05-53-26.json
   │  │  │  │  ├── 技能场景评估-2026-05-19T06-19-43.json
   │  │  │  │  ├── 技能场景评估-最新.json
   │  │  │  │  ├── 技能评估-2026-05-19T05-53-26.json
   │  │  │  │  ├── 技能评估-2026-05-19T06-19-42.json
   │  │  │  │  ├── 技能评估-2026-05-19T06-30-01.json
   │  │  │  │  ├── 技能评估-最新.json
   │  │  │  │  ├── 维度健康.json
   │  │  │  │  └── 质量看板.json
   │  │  │  ├── 其它报告
   │  │  │  │  ├── 00_INDEX_其它报告-总目录.html
   │  │  │  │  ├── 00_INDEX_其它报告-总目录.md
   │  │  │  │  ├── 2026-09-16_khy-os体积构成分析与瘦身方案.html
   │  │  │  │  ├── 2026-09-16_khy-os体积构成分析与瘦身方案.md
   │  │  │  │  ├── 2026-09-16_三项门禁缺口整改方案.html
   │  │  │  │  ├── 2026-09-16_三项门禁缺口整改方案.md
   │  │  │  │  ├── NIGHTSHIFT-2026-09-13-夜班组值简报.html
   │  │  │  │  ├── NIGHTSHIFT-2026-09-13-夜班组值简报.md
   │  │  │  │  ├── NIGHTSHIFT-2026-09-15-夜班组值简报.html
   │  │  │  │  ├── NIGHTSHIFT-2026-09-15-夜班组值简报.md
   │  │  │  │  ├── REPO-SIZE-MANAGEMENT-PLAN.html
   │  │  │  │  ├── REPO-SIZE-MANAGEMENT-PLAN.md
   │  │  │  │  ├── TUI-AI不回复问题根因总结.html
   │  │  │  │  └── TUI-AI不回复问题根因总结.md
   │  │  │  ├── 历史
   │  │  │  │  ├── 2026-08-依赖削减调研报告.html
   │  │  │  │  ├── 2026-08-依赖削减调研报告.md
   │  │  │  │  ├── 2026-08-根目录归档-修复记录.html
   │  │  │  │  ├── 2026-08-根目录归档-修复记录.md
   │  │  │  │  ├── 2026-08-部署报告.html
   │  │  │  │  ├── 2026-08-部署报告.md
   │  │  │  │  ├── 2026-08-项目规模报告.html
   │  │  │  │  ├── 2026-08-项目规模报告.md
   │  │  │  │  ├── 2026-09-根目录补丁存档-归档记录.html
   │  │  │  │  ├── 2026-09-根目录补丁存档-归档记录.md
   │  │  │  │  ├── fix_diff.txt
   │  │  │  │  ├── stash_patch.txt
   │  │  │  │  ├── 技能场景评估-2026-05-19T05-53-26.json
   │  │  │  │  ├── 技能场景评估-2026-05-19T06-19-43.json
   │  │  │  │  ├── 技能评估-2026-05-19T05-53-26.json
   │  │  │  │  ├── 技能评估-2026-05-19T06-19-42.json
   │  │  │  │  └── 技能评估-2026-05-19T06-30-01.json
   │  │  │  └── 对齐
   │  │  │     ├── 待办与进度
   │  │  │     │  ├── 2026-07-11_claude_code_vs_khyos对齐任务单.html
   │  │  │     │  └── 2026-07-11_claude_code_vs_khyos对齐任务单.md
   │  │  │     └── 报告
   │  │  │        ├── 2026-09-13_claude_code_vs_khyos对齐报告.html
   │  │  │        ├── 2026-09-13_claude_code_vs_khyos对齐报告.md
   │  │  │        ├── 2026-09-14_TUI启动速度错误稳定性检查.html
   │  │  │        ├── 2026-09-14_TUI启动速度错误稳定性检查.md
   │  │  │        ├── 2026-09-14_claude_code_vs_khyos对齐报告.html
   │  │  │        ├── 2026-09-14_claude_code_vs_khyos对齐报告.md
   │  │  │        ├── 2026-09-14_前端启动速度错误稳定性检查.html
   │  │  │        ├── 2026-09-14_前端启动速度错误稳定性检查.md
   │  │  │        ├── 2026-09-14_根因诊断与修复方案.html
   │  │  │        ├── 2026-09-14_根因诊断与修复方案.md
   │  │  │        ├── 2026-09-15_claude_code_vs_khyos对齐报告.html
   │  │  │        └── 2026-09-15_claude_code_vs_khyos对齐报告.md
   │  │  ├── 12_模板
   │  │  │  ├── 00_INDEX_模板-分类索引.html
   │  │  │  ├── 00_INDEX_模板-分类索引.md
   │  │  │  └── national-exam-site
   │  │  │     └── 全国人事考试服务平台_files
   │  │  │        └── fstyle_ty.css
   │  │  ├── 13_传承
   │  │  │  ├── 00_INDEX_传承-分类索引.html
   │  │  │  ├── 00_INDEX_传承-分类索引.md
   │  │  │  └── 其它传承
   │  │  │     ├── 00_INDEX_其它传承-总目录.html
   │  │  │     ├── 00_INDEX_其它传承-总目录.md
   │  │  │     ├── KHY-OS-传承书.html
   │  │  │     └── KHY-OS-传承书.md
   │  │  ├── 14_维护者
   │  │  │  ├── 00_INDEX_维护者-分类索引.html
   │  │  │  ├── 00_INDEX_维护者-分类索引.md
   │  │  │  ├── registry
   │  │  │  │  ├── 00_INDEX_registry-总目录.html
   │  │  │  │  ├── 00_INDEX_registry-总目录.md
   │  │  │  │  └── 维护映射表.json
   │  │  │  ├── taste.html
   │  │  │  └── taste.md
   │  │  ├── 15_维护记录
   │  │  │  ├── 00_INDEX_维护记录-分类索引.html
   │  │  │  ├── 00_INDEX_维护记录-分类索引.md
   │  │  │  └── 其它维护记录
   │  │  │     ├── 00_INDEX_其它维护记录-总目录.html
   │  │  │     ├── 00_INDEX_其它维护记录-总目录.md
   │  │  │     ├── NIGHTSHIFT.html
   │  │  │     ├── NIGHTSHIFT.md
   │  │  │     └── 鼠标通道分离：滚轮与拖选的解耦点.png
   │  │  ├── 16_设计模式
   │  │  │  ├── 00_INDEX_设计模式-分类索引.html
   │  │  │  ├── 00_INDEX_设计模式-分类索引.md
   │  │  │  └── registry
   │  │  │     ├── 00_INDEX_registry-总目录.html
   │  │  │     ├── 00_INDEX_registry-总目录.md
   │  │  │     └── 模式注册表.json
   │  │  ├── 17_AI协作预设包
   │  │  │  ├── 00_INDEX_总入口.html
   │  │  │  ├── 00_INDEX_总入口.md
   │  │  │  ├── skills
   │  │  │  │  ├── 00_INDEX_技能包-总目录.html
   │  │  │  │  ├── 00_INDEX_技能包-总目录.md
   │  │  │  │  ├── README.html
   │  │  │  │  ├── README.md
   │  │  │  │  ├── khy-gateway-fix
   │  │  │  │  │  ├── manifest.json
   │  │  │  │  │  ├── prompt.html
   │  │  │  │  │  └── prompt.md
   │  │  │  │  ├── khy-honest-closure
   │  │  │  │  │  ├── manifest.json
   │  │  │  │  │  ├── prompt.html
   │  │  │  │  │  └── prompt.md
   │  │  │  │  ├── khy-onboarding
   │  │  │  │  │  ├── manifest.json
   │  │  │  │  │  ├── prompt.html
   │  │  │  │  │  └── prompt.md
   │  │  │  │  ├── khy-pick-task
   │  │  │  │  │  ├── manifest.json
   │  │  │  │  │  ├── prompt.html
   │  │  │  │  │  └── prompt.md
   │  │  │  │  ├── khy-release-safety
   │  │  │  │  │  ├── manifest.json
   │  │  │  │  │  ├── prompt.html
   │  │  │  │  │  └── prompt.md
   │  │  │  │  ├── khy-safe-change
   │  │  │  │  │  ├── manifest.json
   │  │  │  │  │  ├── prompt.html
   │  │  │  │  │  └── prompt.md
   │  │  │  │  ├── khy-troubleshoot
   │  │  │  │  │  ├── manifest.json
   │  │  │  │  │  ├── prompt.html
   │  │  │  │  │  └── prompt.md
   │  │  │  │  └── khy-weak-model-guardrails
   │  │  │  │     ├── manifest.json
   │  │  │  │     ├── prompt.html
   │  │  │  │     └── prompt.md
   │  │  │  ├── 给AI看
   │  │  │  │  ├── 任务派发卡.html
   │  │  │  │  ├── 任务派发卡.md
   │  │  │  │  ├── 功能提示词-03-外部Agent资产管理.html
   │  │  │  │  ├── 功能提示词-03-外部Agent资产管理.md
   │  │  │  │  ├── 协作铁律.html
   │  │  │  │  ├── 协作铁律.md
   │  │  │  │  ├── 总说明-一次读懂全局.html
   │  │  │  │  ├── 总说明-一次读懂全局.md
   │  │  │  │  ├── 错误自查手册.html
   │  │  │  │  ├── 错误自查手册.md
   │  │  │  │  ├── 项目情况说明-开场白.html
   │  │  │  │  └── 项目情况说明-开场白.md
   │  │  │  └── 给人看
   │  │  │     ├── 使用说明-怎么用这套包.html
   │  │  │     ├── 使用说明-怎么用这套包.md
   │  │  │     ├── 发展路径-决策与选活.html
   │  │  │     ├── 发展路径-决策与选活.md
   │  │  │     ├── 命脉自保清单-给人.html
   │  │  │     ├── 命脉自保清单-给人.md
   │  │  │     ├── 总说明-一页速览.html
   │  │  │     ├── 总说明-一页速览.md
   │  │  │     ├── 排错速查-给人.html
   │  │  │     ├── 排错速查-给人.md
   │  │  │     ├── 长任务提示词库-给人.html
   │  │  │     └── 长任务提示词库-给人.md
   │  │  ├── 18_归档
   │  │  │  ├── 00_INDEX_归档-总目录.html
   │  │  │  ├── 00_INDEX_归档-总目录.md
   │  │  │  └── 03_DESIGN_设计
   │  │  │     ├── 00_INDEX_已删除孤儿引擎归档.html
   │  │  │     ├── 00_INDEX_已删除孤儿引擎归档.md
   │  │  │     ├── [DESIGN-ARCH-024] khyos元帅双模式任命与约束规范.html
   │  │  │     ├── [DESIGN-ARCH-024] khyos元帅双模式任命与约束规范.md
   │  │  │     ├── [DESIGN-ARCH-033] 模型自适应与双轨热插拔架构.html
   │  │  │     ├── [DESIGN-ARCH-033] 模型自适应与双轨热插拔架构.md
   │  │  │     ├── [DESIGN-ARCH-035] 上下文永续与认知压缩引擎.html
   │  │  │     ├── [DESIGN-ARCH-035] 上下文永续与认知压缩引擎.md
   │  │  │     ├── [DESIGN-ARCH-038] Khyos双轨淬火-确定性保底与模型辅助增强的Bug升维引擎.html
   │  │  │     ├── [DESIGN-ARCH-038] Khyos双轨淬火-确定性保底与模型辅助增强的Bug升维引擎.md
   │  │  │     ├── [DESIGN-ARCH-039] Khyos环境共生-环境感知与原生亲和架构.html
   │  │  │     ├── [DESIGN-ARCH-039] Khyos环境共生-环境感知与原生亲和架构.md
   │  │  │     ├── [DESIGN-ARCH-040] Khyos数据主权与极权路由-数据主权绝对论与单一权威注入网关.html
   │  │  │     ├── [DESIGN-ARCH-040] Khyos数据主权与极权路由-数据主权绝对论与单一权威注入网关.md
   │  │  │     ├── [DESIGN-ARCH-042] Khyos自持基建-契约即文档与影响面评估与行为守卫.html
   │  │  │     └── [DESIGN-ARCH-042] Khyos自持基建-契约即文档与影响面评估与行为守卫.md
   │  │  ├── 19_资产
   │  │  │  ├── 00_INDEX_资产-总目录.md
   │  │  │  ├── mermaid.min.js
   │  │  │  └── site
   │  │  │     ├── 00_INDEX_site-总目录.md
   │  │  │     ├── dead-links.json
   │  │  │     ├── docs-site.css
   │  │  │     ├── docs-site.js
   │  │  │     ├── hljs-github-dark.min.css
   │  │  │     ├── mermaid.min.js
   │  │  │     └── nav-data.js
   │  │  ├── GLM快速配置指南.html
   │  │  ├── GLM快速配置指南.md
   │  │  ├── design
   │  │  │  ├── 00_INDEX_设计笔记-分类索引.html
   │  │  │  ├── 00_INDEX_设计笔记-分类索引.md
   │  │  │  ├── TUI-CLASSIC-SYNC.html
   │  │  │  └── TUI-CLASSIC-SYNC.md
   │  │  ├── index.html
   │  │  ├── opencode-provider-keys.html
   │  │  ├── opencode-provider-keys.md
   │  │  └── tui-interaction-optimize
   │  │     ├── 00_INDEX_tui-interaction-优化日志-总目录.html
   │  │     ├── 00_INDEX_tui-interaction-优化日志-总目录.md
   │  │     ├── LOG.html
   │  │     └── LOG.md
   │  ├── env.example
   │  ├── evidence
   │  │  ├── 01_人类贡献
   │  │  │  ├── ai-usage.html
   │  │  │  ├── ai-usage.md
   │  │  │  ├── 人类指令语料.html
   │  │  │  ├── 人类指令语料.md
   │  │  │  ├── 决策记录.html
   │  │  │  ├── 决策记录.md
   │  │  │  ├── 发布记录.html
   │  │  │  ├── 发布记录.md
   │  │  │  ├── 开发过程说明.html
   │  │  │  ├── 开发过程说明.md
   │  │  │  ├── 迭代与验收.html
   │  │  │  └── 迭代与验收.md
   │  │  ├── 02_独创性
   │  │  │  ├── 原创代码规模.html
   │  │  │  ├── 原创代码规模.md
   │  │  │  ├── 设计决策.html
   │  │  │  └── 设计决策.md
   │  │  ├── 03_图片
   │  │  │  ├── HTML源码
   │  │  │  │  ├── 图表
   │  │  │  │  │  ├── 01_提交活跃度_全分支按月.html
   │  │  │  │  │  ├── 02_三模态反馈存证构成.html
   │  │  │  │  │  ├── 03_存证按日分布.html
   │  │  │  │  │  ├── 04_人类意愿痕迹.html
   │  │  │  │  │  ├── 05_原创代码规模.html
   │  │  │  │  │  └── 06_治理与设计留痕规模.html
   │  │  │  │  ├── 架构图
   │  │  │  │  │  ├── 01_分层架构与依赖方向.html
   │  │  │  │  │  └── 02_模块依赖图_实测.html
   │  │  │  │  └── 终端截图
   │  │  │  │     ├── 01_version.html
   │  │  │  │     ├── 02_commands.html
   │  │  │  │     ├── 03_hq_status.html
   │  │  │  │     ├── 04_storage_status.html
   │  │  │  │     ├── 05_gateway_status.html
   │  │  │  │     └── 06_trajectory_list.html
   │  │  │  ├── 图片清单.json
   │  │  │  ├── 图片证据说明.html
   │  │  │  ├── 图片证据说明.md
   │  │  │  ├── 图表
   │  │  │  │  ├── 01_提交活跃度_全分支按月.png
   │  │  │  │  ├── 02_三模态反馈存证构成.png
   │  │  │  │  ├── 03_存证按日分布.png
   │  │  │  │  ├── 04_人类意愿痕迹.png
   │  │  │  │  ├── 05_原创代码规模.png
   │  │  │  │  └── 06_治理与设计留痕规模.png
   │  │  │  ├── 架构图
   │  │  │  │  ├── 01_分层架构与依赖方向.png
   │  │  │  │  └── 02_模块依赖图_实测.png
   │  │  │  ├── 界面截图
   │  │  │  │  ├── 01_ai管理台.png
   │  │  │  │  └── 02_桌面端.png
   │  │  │  ├── 终端截图
   │  │  │  │  ├── 01_version.png
   │  │  │  │  ├── 02_commands.png
   │  │  │  │  ├── 03_hq_status.png
   │  │  │  │  ├── 04_storage_status.png
   │  │  │  │  ├── 05_gateway_status.png
   │  │  │  │  └── 06_trajectory_list.png
   │  │  │  └── 运行截图清单.json
   │  │  ├── 04_机器可读
   │  │  │  └── contribution-metrics.json
   │  │  ├── 05_索引与对账
   │  │  │  ├── 对账表.html
   │  │  │  ├── 对账表.md
   │  │  │  ├── 提交记录与证据链.html
   │  │  │  ├── 提交记录与证据链.md
   │  │  │  └── 证据总清单.json
   │  │  ├── 06_申报材料
   │  │  │  ├── README.html
   │  │  │  ├── README.md
   │  │  │  ├── 递交核对表.html
   │  │  │  └── 递交核对表.md
   │  │  ├── README.html
   │  │  └── README.md
   │  ├── root-gitignore.txt
   │  └── software-misc
   │     └── akshare_scripts
   │        ├── akshare_data.py
   │        └── requirements.txt
   ├── ship
   │  ├── Dockerfile
   │  ├── Dockerfile.dockerignore
   │  ├── deploy
   │  │  └── free-test
   │  │     ├── .github
   │  │     │  └── workflows
   │  │     │     └── deploy-pages.yml
   │  │     ├── apps
   │  │     │  └── ai-frontend
   │  │     │     └── .env.production
   │  │     ├── deploy-free-test.ps1
   │  │     └── supabase
   │  │        ├── config.toml
   │  │        ├── functions
   │  │        │  ├── khyos-ai
   │  │        │  │  └── index.ts
   │  │        │  └── khyos-api
   │  │        │     └── index.ts
   │  │        └── schema.sql
   │  ├── docker-compose.yml
   │  └── fly.staging.toml
   └── verify
      ├── DEBT.html
      └── DEBT.md
```

## §B 退役清单（109 项；每行 = 现路径 → 处置）

```text
.clinerules  →  [退役-D4] .clinerules（圈留则不动）
.cursor/rules/khy-maintainability.mdc  →  [退役-D4] .cursor/（圈留则不动）
.opencode/README.html  →  [退役-D4] .opencode/（圈留则不动）
.opencode/README.md  →  [退役-D4] .opencode/（圈留则不动）
.opencode/config.json  →  [退役-D4] .opencode/（圈留则不动）
.zcode/plans/plan-sess_ee2d7822-39ad-4bb9-92f9-57196682e483.md  →  [退役-D4] .zcode/（圈留则不动）
CLAUDE.md  →  [退役-D4] 并入 AGENTS.md（圈留则留根）
package-lock.json  →  [退役-W生态] npm 双栈退役（先改 dependabot/frontend-ci 等 4 消费方）
services/backend/src/services/accountPool/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/accountPool/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/adversarial/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/adversarial/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/advisor/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/advisor/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/agentAssets/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/agentAssets/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/agentsight/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/agentsight/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/artifact/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/artifact/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/assistant/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/assistant/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/auditFixLoop/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/auditFixLoop/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/auditTrajectory/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/auditTrajectory/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/autofixPr/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/autofixPr/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/autonomy/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/autonomy/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/backup/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/backup/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/browser/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/browser/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/capabilityMatrix/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/capabilityMatrix/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/ccSwitch/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/ccSwitch/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/changelog/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/changelog/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/channels/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/channels/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/chatStateIsolation/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/chatStateIsolation/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/claimMain/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/claimMain/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/cognitiveSnapshot/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/cognitiveSnapshot/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/commandCatalog/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/commandCatalog/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/compact/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/compact/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/config/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/config/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/context/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/context/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/contextScope/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/contextScope/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/conversation/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/conversation/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/dataSovereignty/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/dataSovereignty/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/dependency/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/dependency/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/deploy/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/deploy/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/desktopControl/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/desktopControl/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/deviceApps/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/deviceApps/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/diskAnalyze/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/diskAnalyze/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/diskCleanup/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/diskCleanup/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/docsFreshness/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/docsFreshness/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/dualTrack/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/dualTrack/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/dualTrackForge/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/dualTrackForge/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/envSymbiosis/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/envSymbiosis/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/evoEngine/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/evoEngine/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/extensions/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/extensions/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/extensions/quantApp.js  →  [退役-P2收尾] 壳 services/backend/src/services/extensions/quantApp.js（消费者重指后删，逐壳一提交）
services/backend/src/services/externalApps/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/externalApps/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/failsafe/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/failsafe/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/forge/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/forge/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/formatInspect/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/formatInspect/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/gatewayLogLease/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/gatewayLogLease/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/hooks/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/hooks/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/ide/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/ide/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/intentArbiter/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/intentArbiter/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/keybindings/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/keybindings/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/management/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/management/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/marshal/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/marshal/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/mcp/firecrawl/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/mcp/firecrawl/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/mcp/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/mcp/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/memoryEngine/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/memoryEngine/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/messaging/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/messaging/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/metaConstraint/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/metaConstraint/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/metaplan/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/metaplan/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/onboarding/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/onboarding/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/orchestrator/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/orchestrator/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/orphanSweep/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/orphanSweep/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/output/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/output/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/permissionPolicy/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/permissionPolicy/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/plugins/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/plugins/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/proactiveCollaboration/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/proactiveCollaboration/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/projectBlueprint/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/projectBlueprint/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/projectCoherence/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/projectCoherence/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/projectHygiene/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/projectHygiene/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/proxy/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/proxy/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/publish/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/publish/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/query/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/query/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/remote/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/remote/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/remotedev/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/remotedev/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/repoMap/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/repoMap/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/resilience/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/resilience/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/restore/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/restore/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/reverseEngineer/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/reverseEngineer/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/search/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/search/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/security/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/security/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/selfHeal/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/selfHeal/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/selfRepair/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/selfRepair/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/selfSustainingInfra/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/selfSustainingInfra/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/session/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/session/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/skills/extensions/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/skills/extensions/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/skills/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/skills/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/stateMachine/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/stateMachine/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/structuredFurnace/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/structuredFurnace/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/subscribePr/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/subscribePr/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/syscallGateway/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/syscallGateway/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/tokenless/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/tokenless/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/toolCatalog/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/toolCatalog/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/toolUseLoop/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/toolUseLoop/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/trajectoryGuide/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/trajectoryGuide/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/trajectoryProvenance/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/trajectoryProvenance/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/typeset/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/typeset/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/uninstall/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/uninstall/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/upstreamStudy/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/upstreamStudy/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/wasm-sandbox/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/wasm-sandbox/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/webFrontendEval/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/webFrontendEval/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/weipuxiezuo/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/weipuxiezuo/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/workflow/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/workflow/index.js（消费者重指后删，逐壳一提交）
services/backend/src/services/workspace/index.js  →  [退役-P2收尾] 壳 services/backend/src/services/workspace/index.js（消费者重指后删，逐壳一提交）
```

## §C UNMAPPED-待议（3 项；P3 逐族清单点名时消化，禁止静默入 misc）

```text
works/build/githooks/commit-msg  →  UNMAPPED-待议: works/build/githooks/commit-msg
works/build/githooks/post-commit  →  UNMAPPED-待议: works/build/githooks/post-commit
works/build/githooks/pre-commit  →  UNMAPPED-待议: works/build/githooks/pre-commit
```


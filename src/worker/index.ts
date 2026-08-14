/**
 * Worker bundle entry — shared lane tooling for the in-process host and the
 * headless worker bundle. (startup/runner are mounted by subpath so their
 * `name`/`apply` exports don't clash here.)
 * @module taskswarm/worker
 */
export { registerLaneTools, buildWorkerMission, type LaneRuntime } from './lane-tools.ts'
export { createReviewerSpawner, lastAssistantText, type ReviewerDeps, type ReviewRequest, type ReviewResult } from './reviewer.ts'

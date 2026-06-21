/**
 * The shared run-status classifier for the FLAT adapters (claude-code, droid) now lives with the
 * rest of the per-CLI codec machinery in {@link ../agent-cli/codec} as `classifyFlatRun`. This
 * module re-exports it under its historical name so existing imports keep working; the codecs call
 * it directly.
 */
export { classifyFlatRun as classifyHarnessRun } from '../agent-cli/codec';

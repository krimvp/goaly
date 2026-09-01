import path from 'node:path';
import type { Logger } from '../log/logger';
import { buildLogger, type FileLogOptions } from '../log/build';
import type { PhasedStreamSink } from '../agent-cli/stream';
import { StreamTranscriptSink, STREAM_FILE } from '../runlog/stream-transcript';
import { makeStreamRenderer, streamLogFields } from './stream-render';
import type { ComposeOptions } from './compose-options';

/**
 * The OBSERVABILITY wiring: the run's diagnostic logger and the one phase-tagged stream sink that
 * fans events out to the live view, the debug log, the durable transcript, and any embedder hook.
 * Extracted from `compose.ts` so the composition root stays about wiring seams together, not about
 * which consumer surfaces a stream event reaches.
 */

/**
 * Assemble the one phase-tagged stream sink (issue #23) that fans every event out to the
 * driver-side consumer surfaces — the `--stream` live stderr view, the diagnostics logger (at
 * `debug`, respecting `--log-level`), the durable transcript (issue #28), and any embedder
 * subscription. Returns `undefined` when no consumer is active so a default run builds NO taps and
 * pays zero streaming overhead. Each branch is guarded: a throwing consumer can never crash a run
 * or starve the others (fail-closed).
 */
export function buildStreamSink(
  options: ComposeOptions,
  logger: Logger,
  stateDir: string,
  now: () => number,
): PhasedStreamSink | undefined {
  const renderer = options.stream === true ? makeStreamRenderer(streamRendererOpts(options)) : undefined;
  const routeToLog = (options.logLevel ?? 'info') === 'debug';
  const transcript = buildTranscriptSink(options, stateDir, now);
  const embedder = options.onStreamEvent;
  if (renderer === undefined && !routeToLog && transcript === undefined && embedder === undefined) {
    return undefined;
  }

  return (phase, event) => {
    if (renderer !== undefined) renderer(phase, event);
    if (routeToLog) logger.debug('stream', streamLogFields(phase, event));
    if (transcript !== undefined) transcript(phase, event); // already fail-closed inside the sink
    if (embedder !== undefined) {
      try {
        embedder(phase, event);
      } catch {
        /* an embedder subscription must never crash the run */
      }
    }
  };
}

/**
 * Build the durable stream-transcript subscriber (issue #28) when enabled. `streamFile` sets an
 * explicit path; `streamTranscript: true` uses the default `<stateDir>/<runId>/stream.jsonl`.
 * Returns the bound, already-fail-closed {@link PhasedStreamSink}, or `undefined` when no transcript
 * was requested.
 */
function buildTranscriptSink(
  options: ComposeOptions,
  stateDir: string,
  now: () => number,
): PhasedStreamSink | undefined {
  const file =
    options.streamFile ??
    (options.streamTranscript === true ? path.join(stateDir, options.runId, STREAM_FILE) : undefined);
  if (file === undefined) return undefined;
  return new StreamTranscriptSink({ path: file, now }).record;
}

function streamRendererOpts(options: ComposeOptions): { write?: (line: string) => void } {
  return options.streamWrite !== undefined ? { write: options.streamWrite } : {};
}

/**
 * Build the run's diagnostic logger: a console sink (stderr, human-formatted) plus, unless
 * disabled, a size-rotated JSON file co-located with the run log at `<stateDir>/<runId>/goaly.log`.
 * `runId` is bound onto every record. This is the only place real filesystem logging is wired.
 */
export function buildRunLogger(options: ComposeOptions, stateDir: string): Logger {
  const file: FileLogOptions | undefined =
    options.noLogFile === true
      ? undefined
      : {
          path: options.logFile ?? path.join(stateDir, options.runId, 'goaly.log'),
          ...(options.logFs !== undefined ? { fs: options.logFs } : {}),
        };
  return buildLogger({
    level: options.logLevel ?? 'info',
    console: options.noLogConsole !== true,
    ...(file !== undefined ? { file } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    fields: { runId: options.runId },
  });
}

"use client";

interface Props {
  analysis: string | null;
  analyzing: boolean;
  /** Disabled until the detail payload has arrived. */
  ready: boolean;
  onRun: () => void;
}

/**
 * The coach-analysis block. Presentational: the modal keeps the streaming
 * state and the request, because the stream writes into it token by token.
 */
export function AnalysisPanel({ analysis, analyzing, ready, onRun }: Props) {
  if (analysis === null) {
    return (
      <div>
        <button
          type="button"
          onClick={onRun}
          disabled={!ready}
          className="w-full py-2.5 bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors cursor-pointer"
        >
          Coach Analysis
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="border border-orange-500/30 bg-orange-500/5 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-orange-400 uppercase tracking-wider">
            Coach Analysis
          </h3>
          {!analyzing && (
            <button
              type="button"
              onClick={onRun}
              className="text-gray-500 hover:text-white text-xs transition-colors cursor-pointer"
            >
              Re-run
            </button>
          )}
        </div>
        <div className="text-gray-200 text-sm whitespace-pre-wrap leading-relaxed">
          {analysis || (
            <span className="text-gray-500 animate-pulse">Analyzing your session...</span>
          )}
        </div>
      </div>
    </div>
  );
}

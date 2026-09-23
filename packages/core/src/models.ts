/**
 * Every Claude model this app talks to, named by the job it does.
 *
 * The IDs are pinned on purpose. The Messages API has no "latest" alias and
 * this module deliberately does not invent one: a model swap changes the advice
 * a real athlete acts on, invalidates the prompt-cache prefix the coach routes
 * are built around, and can 400 on a parameter the next generation drops
 * (`budget_tokens` and `temperature` are accepted on Sonnet 4.6 and rejected on
 * Sonnet 5). Moving a role forward is a reviewed edit, never an automatic one.
 *
 * Each role reads an env override first so a model can be rolled forward — or
 * rolled back — without a deploy, since App Runner owns its environment
 * independently of deploy.yml.
 */

/** The coaching chat. Interactive and streamed, so it is latency-sensitive. */
export const COACH_MODEL = process.env.COACH_MODEL ?? "claude-sonnet-5";

/**
 * One-shot activity analysis. Streamed, but nobody is waiting mid-sentence.
 *
 * Opus rather than Sonnet because every saved analysis is replayed into later
 * coach prompts, so a misread stays in context. Side by side on four real
 * activities, Sonnet 5 put an HR average in the wrong zone twice and gave
 * pre-race advice for a race already run; Opus 5.5 got both right and caught a
 * watch that measured 290 m over the course. About 2.5x the cost per analysis.
 */
export const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL ?? "claude-opus-5-5";

/**
 * Re-runs an analysis server-side when ANALYSIS_MODEL's safety classifiers
 * decline it. Same constraints as PLAN_PARSE_FALLBACK_MODEL below: it must be on
 * that model's allowed_fallback_models, and it stays out of PINNED_MODELS.
 */
export const ANALYSIS_FALLBACK_MODEL =
  process.env.ANALYSIS_FALLBACK_MODEL ?? "claude-opus-5";

/**
 * Condenses a finished conversation into a few sentences of memory. Cheap and
 * best-effort by design — see summarizeConversation.
 */
export const SUMMARY_MODEL = process.env.SUMMARY_MODEL ?? "claude-haiku-4-5";

/**
 * Transcribes an uploaded plan document into structured sessions. Runs once per
 * upload against a whole PDF, so it gets the strongest model available.
 */
export const PLAN_PARSE_MODEL =
  process.env.PLAN_PARSE_MODEL ?? "claude-opus-5-5";

/**
 * Re-runs a plan parse server-side when PLAN_PARSE_MODEL's safety classifiers
 * decline the document. It has to be on that model's `allowed_fallback_models`
 * (see GET /v1/models with the server-side-fallback beta), and it is the
 * previous parser, already proven on real plans. Deliberately not in
 * PINNED_MODELS: it is meant to trail the parser, so `pnpm models:check` would
 * flag it as behind forever.
 */
export const PLAN_PARSE_FALLBACK_MODEL =
  process.env.PLAN_PARSE_FALLBACK_MODEL ?? "claude-opus-5";

/** Every pinned role, for `pnpm models:check` to report against. */
export const PINNED_MODELS = {
  COACH_MODEL,
  ANALYSIS_MODEL,
  SUMMARY_MODEL,
  PLAN_PARSE_MODEL,
} as const;

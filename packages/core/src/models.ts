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

/** One-shot activity analysis. Streamed, but nobody is waiting mid-sentence. */
export const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL ?? "claude-sonnet-5";

/**
 * Condenses a finished conversation into a few sentences of memory. Cheap and
 * best-effort by design — see summarizeConversation.
 */
export const SUMMARY_MODEL = process.env.SUMMARY_MODEL ?? "claude-haiku-4-5";

/**
 * Transcribes an uploaded plan document into structured sessions. Runs once per
 * upload against a whole PDF, so it gets the strongest model available.
 */
export const PLAN_PARSE_MODEL = process.env.PLAN_PARSE_MODEL ?? "claude-opus-5";

/** Every pinned role, for `pnpm models:check` to report against. */
export const PINNED_MODELS = {
  COACH_MODEL,
  ANALYSIS_MODEL,
  SUMMARY_MODEL,
  PLAN_PARSE_MODEL,
} as const;

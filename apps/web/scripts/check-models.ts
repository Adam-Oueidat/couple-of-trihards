/**
 * Reports whether any pinned model in @trihards/core is behind what the API now
 * offers.
 *
 * This script never edits a pin. Adoption is a reviewed decision — see the note
 * in packages/core/src/models.ts — so the most it does is tell you a newer model
 * exists and exit non-zero. Run it by hand, or on a schedule so it opens an
 * issue.
 *
 *   pnpm models:check
 */
import Anthropic from "@anthropic-ai/sdk";
import { PINNED_MODELS } from "@trihards/core";

interface Listed {
  id: string;
  name: string;
  created: number;
}

/**
 * The Models API lists dated snapshots, not aliases: `claude-haiku-4-5` is not
 * in the listing at all, `claude-haiku-4-5-20251001` is. So an alias pin has to
 * match its snapshot.
 *
 * Plain prefix matching would be wrong — `claude-fable-5` is a prefix of
 * `claude-fable-5-1`, which is a different model, not a snapshot of it. Only an
 * `-YYYYMMDD` suffix means "same model, dated".
 */
function resolve(pinned: string, available: Listed[]): Listed | undefined {
  return available.find(
    (m) => m.id === pinned || /^-\d{8}$/.test(m.id.slice(pinned.length)),
  );
}

/**
 * "Newer" across families is not "better": a Haiku released after an Opus is no
 * upgrade for the plan parser. Compare within a family and leave the rest to a
 * human. The family is the tier segment of the id (claude-**sonnet**-5), which
 * is also the part that occasionally gains a whole new name — hence the separate
 * list at the end.
 */
function familyOf(modelId: string): string {
  return modelId.split("-")[1] ?? modelId;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set — cannot reach the Models API.");
    process.exit(2);
  }

  const client = new Anthropic();

  const available: Listed[] = [];
  for await (const model of client.models.list()) {
    available.push({
      id: model.id,
      name: model.display_name,
      created: Date.parse(model.created_at),
    });
  }

  let behind = false;
  const resolved: Listed[] = [];

  for (const [role, pinned] of Object.entries(PINNED_MODELS)) {
    const current = resolve(pinned, available);
    if (!current) {
      // Either the id is a typo or the model is not available to this org.
      // Both are worth failing on: the pin is not usable as written.
      console.log(`${role}: ${pinned} — NOT FOUND in the Models API`);
      behind = true;
      continue;
    }
    resolved.push(current);

    const newer = available
      .filter(
        (m) => familyOf(m.id) === familyOf(pinned) && m.created > current.created,
      )
      .sort((a, b) => b.created - a.created);

    if (newer.length === 0) {
      console.log(`${role}: ${pinned} — up to date`);
      continue;
    }

    behind = true;
    console.log(`${role}: ${pinned} — newer in the same family:`);
    for (const m of newer) console.log(`    ${m.id} (${m.name})`);
  }

  // Anything released after the newest thing we pin, in a family we do not use
  // at all. Informational only: a brand-new tier cannot show up in the checks
  // above, because there is no pin in its family to compare against.
  const newestPinned = Math.max(0, ...resolved.map((m) => m.created));
  const pinnedFamilies = new Set(resolved.map((m) => familyOf(m.id)));
  const otherNew = available
    .filter((m) => m.created > newestPinned && !pinnedFamilies.has(familyOf(m.id)))
    .sort((a, b) => b.created - a.created);

  if (otherNew.length > 0) {
    console.log("\nNewer models in families we do not pin (review, not a failure):");
    for (const m of otherNew) console.log(`    ${m.id} (${m.name})`);
  }

  if (behind) {
    console.log("\nOne or more pins are behind. Bumping them is a reviewed edit.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

# BRT-05 — Format Engine

Status: **implemented** · ADR: [0024](../adr/ADR-0024-deterministic-format-engines-and-immutable-event-plans.md) · Code: `packages/competition/src/format/*`, `packages/persistence/src/competition-structure-store.ts`

## 1. Port

```ts
interface CompetitionFormatEngine {
  id: string;                       // "single-elimination"
  version: number;                  // 1 — any change in generated structure ⇒ new version
  configurationSchema: BrObjectSchema;
  contestType: ContestType;         // the discipline must allow it
  minParticipants; maxParticipants;
  generate(input: FormatEngineInput): PlanDocument;   // pure
}
FormatEngineInput = { eventId, participants[{participantId, kind}], seedOrder[], config, allowedContestTypes }
PlanDocument      = { engineId, engineVersion, rounds[{ key, sequence, roundType, label, byes[], contests[{ key, sequence, contestType, slots[{ slot, source, participantId?, contestKey? }] }] }] }
```

- **Engines are pure.** They make no database, clock or randomness calls. Identical input always gives an identical logical plan, and therefore an identical `planHash`.
- **Persistence is separate:** `StructureStore.generatePlan` persists the plan document, rounds, contests and contestants.
- **Shared input guards** (`assertEngineInput`) reject:
  - a field size outside the engine's range;
  - a contest type the discipline doesn't allow (e.g. HEAT-only running vs. a MATCH format);
  - duplicate participants;
  - a seed order that is not an exact permutation of the field;
  - configuration for engines that take none.
- **Registry:** `formatEngine(id, version)` resolves exact versions only (`single-elimination/1`, `round-robin/1`). A FormatVersion pins one. Unknown versions fail closed at FormatVersion creation and at plan generation.

## 2. SINGLE_ELIMINATION v1 (`single-elimination/1`)

- Supports 2–256 participants. The bracket expands to the next power of two.
- **Standard seed placement:** `order(1) = [1]`, `order(2k) = ⋃ s ∈ order(k) : [s, 2k+1−s]`, giving e.g. `[1,8,4,5,2,7,3,6]`. Seeds 1 and 2 can only meet in the final.
- **Byes:**
  - A top seed whose first-round opposite position is empty is placed **directly into its round-2 slot** as a `PARTICIPANT`.
  - A bye is a structural consequence of seeding. It is not a contest and not a result, so no winner is fabricated.
  - Round 1 therefore holds only real contests: `n − size/2 ≥ 1` of them.
- **Dependencies:** later slots are `WINNER_OF_CONTEST(contestKey)`, always referencing an earlier contest (acyclic by construction). Nothing is resolved at generation.
- **Stable bracket positions:** keys are `r{round}-c{position}`. Bye positions are skipped, so keys need not be contiguous (e.g. 6 entrants → `r1-c2`, `r1-c4`).
- **Totals:** exactly **n − 1 contests** and **one final**.
- **Rounds:** round type `KNOCKOUT`, with the last round `FINAL`. Labels (Final, Semifinal, Quarterfinal, Round of N) are presentation only.
- **Configuration:** none (`{}`).

## 3. ROUND_ROBIN v1 (`round-robin/1`)

- Supports 2–64 participants, individual or team. It uses the **circle method**:
  - participants are placed in seed order;
  - an odd count adds a BYE placeholder;
  - seed 1 stays fixed and the others rotate one position per round.
- **Totals:** `n − 1` rounds (even n) or `n` rounds (odd n), and **n(n−1)/2 contests**.
- **Guarantees:** no duplicate pairing, no self-pairing, and every participant at most once per round.
- **BYEs** are recorded on the round (`byes[]`), never as a contest or result. With odd n, each participant sits out exactly once (balanced).
- Round type `GROUP`, labels "Round k". **No standings are computed**: a schedule is not a ranking.
- **Configuration:** none (`{}`).

## 4. Canonical hashing (evidence of how a structure was generated)

These BR-JSON root schemas are registered in `@br/schemas`. Hashes use the `ledger-fact` domain tag. The existing golden vectors are unchanged: 58 reproduce and the reference checker agrees 36/36.

| Document | Content | Stored in |
|---|---|---|
| `br:competition-field@1` | Event id + participant set (keyed by participant id; order-independent) | `event_field.field_hash` |
| `br:competition-seeding@1` | Event, field hash, method, `br-draw/1` + seed (draw), ordered seed list | `event_seeding.seeding_hash` |
| `br:competition-plan-input@1` | Event, DisciplineVersion id + spec hash, FormatVersion id + spec hash, engine id/version, field hash, seeding hash, config hash, seed order | `event_plan.input_hash` |
| `br:competition-plan@1` | The logical plan (rounds, contests, slot sources) | `event_plan.plan_hash` + `plan_document` |

This is **not** a blockchain proof. It makes a plan's inputs and output reproducible and tamper-evident against the stored facts.

## 5. Immutability and versioning

- One EventPlan per event (PK). It is append-only, even for the owner.
  - A repeat with the same canonical input returns the stored plan.
  - A different input is refused.
- `plan_document` is the historical truth. **Projection rebuilds never regenerate plans with current engine code.** Structure is read from the persisted rounds, contests and contestants.
- Changing generated semantics requires a **new engine version**. Old versions stay registered for events that pin them.

## 6. Deterministic draw `br-draw/1`

- The input set is sorted.
- A Fisher–Yates shuffle draws its randomness from `HMAC-SHA256(drawSeed, "br-draw/1:" + counter)`, with rejection sampling (no modulo bias).
- The seed is 32 bytes from a CSPRNG and is persisted.
- **Reproducible and tamper-evident, not provably fair.** The platform chose the seed. Commit–reveal or an external beacon is future work.

## 7. Tests

`packages/competition/src/competition.test.ts` covers:

**Single elimination**
- 2, 3, 4, 5 and 8 entrants: n−1 contests, one final, acyclic dependencies, every participant exactly once, nothing resolved.
- Seed separation and bye placement.
- Stable keys.
- Property test over **2..64** entrants: validity, determinism, seed 1 on top.

**Round robin**
- 2–5 entrants: pair uniqueness, no self-pairing, balanced byes.
- Property test over **2..40** entrants.

**Shared**
- Input guards for both engines.
- The registry resolves exact versions only.
- Draw permutation and reproducibility (property tested).

Integration tests (`competition.int.test.ts`) cover persisted plans, concurrency and immutability.

## 8. Not implemented

Double elimination, qualification + final, stepladder, heats/sessions formats, multi-stage (Stage), standings and advancement.

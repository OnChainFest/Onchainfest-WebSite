# ONCF-05A — Sports & Competition Engine Design

| | |
|---|---|
| Status | **Design proposal — final revision after review (eight-sport scope, six proof cases), awaiting approval.** No code, migration, table, API, catalog or lifecycle change was made in this phase. |
| Phase | ONCF-05A (research + domain design). Implementation starts at ONCF-05B, after approval. |
| Canonical sports (fixed) | Tennis · Padel · Running (incl. marathon) · Swimming · Cycling · Bowling · Basketball · Golf |
| Builds on | BRT-01 result domain §4–§6, §9; BRT-05 competition / format / catalog docs; ADR-0008, -0024, -0025, -0026, -0047, -0048, -0049; ONCF-03A catalog manifest; ONCF-04 registration; BRT-01 bowling and padel walkthroughs |
| Code inspected (read-only) | `packages/competition/src/{catalog,catalog-manifest,category,draw,lifecycle}.ts`, `packages/competition/src/format/*`, `packages/rankings/src/classification-policy.ts`, `packages/domain/src/{results,rankings}.ts`, `packages/persistence/src/cli/seed-competition.ts`, `db/migrations/0008_competition_engine.sql` |
| Notation | **[ADR]** = needs an architecture decision before implementation. **COMMON PRACTICE** = organizer convention, not a governing-body rule. **[S]** = verified only via a secondary source. **UNVERIFIED** = could not be checked; not relied on. |

---

## 1. Executive Summary

The eight canonical sports — **tennis, padel, running / marathon, swimming, cycling, bowling, basketball, golf** — fall into three paradigms. A bracket engine alone cannot serve them:

- **Head-to-head** (tennis, padel, basketball; also bowling and golf match play).
  - Entrants meet in matches.
  - Winners advance, or earn table points.
- **Race / timed** (running, swimming, cycling).
  - Many entrants start together or at intervals.
  - **Elapsed time or finish order** ranks them.
  - A "heat" is often a *logistic* partition (running waves, swimming timed finals), not a competitive one.
- **Score / performance** (bowling, golf).
  - Each entrant produces a **score per unit of play** (a game, a round).
  - Scores **accumulate**.
  - A **cut** or **qualifying** reduces the field.

### OnChainFest already has the right skeleton

The design extends it rather than replacing it:

- **Catalog as data.** DisciplineVersion and FormatVersion.
- **Pure, versioned format engines** with immutable hashed plans (ADR-0024).
- **Contest types.** `MATCH | HEAT | SERIES | SESSION | ATTEMPT_SET | ROUTINE` cover all eight sports.
- **Results.** `WIN_LOSS_DRAW | RANKED` outcome models, and classifications as derived Results (ADR-0047).
- **Participation.** Declared lineups (ADR-0026), and Teams with `EVENT_PAIR` / `EVENT_SQUAD` kinds.

### Approved core architecture (unchanged in this revision)

- **Four stage engines:**
  - `KNOCKOUT`
  - `ROUND_ROBIN`
  - `FIELD`: everyone ranked together, optionally split into **logistic** partitions.
  - `HEATS`: **competitive** partitions with qualification.
- **Cumulative / multi-round classification.**
- **An advancement engine.**
- **Ruleset** (scoring) as a separate versioned axis.
- **ClassificationPolicy** as a separate axis.
- **SchedulingProfile and Resource model.**
- **Capability-driven compatibility** (§18.4).

> **Architectural rule (binding).** No engine branches on sport identity. A sport is represented only through versioned data (DisciplineVersion, Ruleset, FormatVersion, ClassificationPolicy, SchedulingProfile, Resource types), declared **capabilities** and **parameters**. A sport code never appears in engine control flow.

> **Modality ≠ Format (binding).**
>
> - **MODALITY** is *what is played and by whom*: discipline + category, which fixes the entrant structure.
> - **FORMAT** is *how the competition is organized*: the stage graph.
>
> An Event pins one modality and one format **independently**. A modality may select **any compatible format** (§16). No modality is bound permanently to one format.

### Missing pieces (gaps, §33)

1. Stages and transitions.
2. Field-style contests at scale. `contestant.slot` is CHECK-capped at 64.
3. Entry attributes: entry time, average, handicap index, bib.
4. A timing model.
5. Classification rules beyond comparator keys.
6. The Ruleset axis.
7. A Resource model.
8. Roster snapshot at field lock.

### Design matrix and proof cases

The design matrix is **8 sports × 3 modalities × 3 formats** (§14–§16). Every one of the 72 combinations is classified as compatible or not, with its full capability profile.

ONCF-05B represents **all eight sports in the domain model**. It does not build a tennis/padel engine to be adapted later. Six **proof cases** (§34) are executed first:

| # | Proof case | Proves |
|---|---|---|
| A | Tennis singles — single elimination | `KNOCKOUT` |
| B | Padel doubles — groups → knockout | `ROUND_ROBIN` + standings |
| C | Running road race — wave start | `FIELD` + logistic partitions + scale |
| D | Swimming individual — heats → final | `HEATS` + entry-time seeding + qualification |
| E | Golf stroke play — multi-round + cut | Cumulative classification + cut |
| F | Basketball 3x3 — pools → knockout | Team roster/lineup + timed-or-target scoring + resource constraints |

**Revision note (after review).**

- Basketball modality 3 is now **wheelchair basketball** (IWBF, verified basics). The **3x3 Shoot-Out** is a future skills-contest extension, because its format is verified only through secondary sources.
- Golf modality order is individual stroke play, four-ball, scramble. Scramble is labelled **COMMON PRACTICE**.
- The capability matrix covers all 72 combinations.
- The validation set grows from five to six proof cases.
- Appendix A holds the consistency audit.

---

## 2. Scope

**In scope (this document):**

- research on governing-body rules for the eight sports;
- modality and format selection;
- the domain model of the competition engine;
- a mapping of the existing catalog;
- gaps, risks and a sequence.

**Out of scope (no change made):**

- code, migrations, tables, API, catalog provisioning;
- draw, heat, scheduling and scoring algorithms;
- UI, sponsor logic, rewards, $BRT, payments, notifications;
- any change to ONCF-04.

**Canonical sports:** exactly the eight listed. Football, volleyball, pickleball and the others appear only in §35 as future extensions.

**Platform context:** an amateur and community multi-sport festival platform. The pilot organizer context is Costa Rica (BRT-00: CRCC bowling; legacy padel). Selections favour formats that amateur organizers actually run. Where this differs from elite governing-body practice, that is stated.

---

## 3. Terminology

Each term has **one meaning**. The left column is the canonical name.

| Term | Definition | Where it lives | Examples |
|---|---|---|---|
| **Sport** | A family of disciplines governed together, usually by one international federation | `sports.sport` (exists) | `tennis`, `swimming`, `golf` |
| **Discipline** | A distinct way of playing the sport, with its own entrant structure, result schema and comparator | `sports.discipline` (exists) | `tennis.singles`, `swimming.pool`, `basketball.3x3`, `golf.stroke` |
| **DisciplineVersion** | The immutable sporting rule set an Event is played under | `sports.discipline_version` (exists) | `padel.doubles@1` |
| **Participation modality** | *Who forms an entrant and how many compete*: entrant kind, roster, lineup, ordered legs. A property of the DisciplineVersion | `DisciplineVersion.participation` (extended §29) | singles; pair; relay of 4; scramble team of 4 |
| **Category** | Eligibility labels on one Event: gender (incl. MIXED), age band, skill or handicap class, division | `EventCategory` (exists) | MEN, WOMEN, MIXED, Masters 40–44, "Handicap", "Category B" |
| **Modality / event type** | What the sport's community calls "an event". It is **Discipline + Category (+ distance/stroke when the discipline is parameterised)**. Not a stored entity | — | "Padel mixed doubles" = `padel.doubles` + MIXED; "100 m freestyle" = `swimming.pool` + `{stroke: FREE, distance: 100}` |
| **Ruleset (scoring model)** | How *one contest* is won or measured: sets/games, timed periods, target score, elapsed time, pinfall, strokes, Stableford points; plus handicap application | **New versioned axis** (§22) | best of 3 tie-break sets with star point; 10 min or first to 21; 10 frames ≤ 300 |
| **Competition format** | The *structure* of an Event as a **stage graph**: stages, their engines and the transitions between them | `FormatTemplate/FormatVersion` (exists; extended §18) | groups → knockout; heats → final; 4 rounds with a 36-hole cut |
| **Competition structure** | The **materialized** plan of one Event: stages, rounds, contests, slots. Output of the format engine | `event_plan` + `round/contest/contestant` (exists) | the 32-line draw of one event |
| **Stage** | A homogeneous phase run by one stage engine | **New** (BRT-05 §8 deferred it until the first multi-stage format) | group stage, main draw, heats, final, round 3 after the cut |
| **Contest** | The atomic producer of a Result (BRT-01 §5.4) | `competition.contest` (exists) | a match, a heat, a wave, one bowler's 6-game block, one golfer's round |
| **Classification** | The **in-event** order of entrants, derived from contest results. A ResultVersion (ADR-0047) | Results ledger (exists) | group table, race result, leaderboard |
| **Standings** | A classification built from match outcomes and table points | Classification with a standings policy (§24) | padel group table, 3x3 pool standings |
| **Ranking (system)** | A **cross-competition** ordering of athletes (ADR-0048). **Not** the order within one event | `ranking.*` (exists) | a platform best-mark ranking |
| **Seeding** | The ordered entrant list (plus seed values) that a draw or heat engine consumes | `event_seeding` (exists; extended §25) | ITF seeds 1–8; swimming entry times |
| **Advancement** | Turning results into the occupants of later slots or fields | **New engine** (§26) | winner → next slot; top 8 times → final; top 65 and ties → round 3 |
| **Entry attribute** | A per-participant value declared at entry and used by seeding, handicap or start lists | **New** (§17) | entry time 1:02.45; bowling average 182; handicap index 14.3; bib 1043 |
| **Resource** | A schedulable place or capacity | **New** (§28) | padel court 3; lanes 7–8; pool lanes 1–8; tee 1 at 07:30; wave B |
| **Roster / Lineup** | Roster = athletes a TEAM entrant may field, frozen at field lock. Lineup = athletes (and their **order**) declared for one contest | Lineup exists (ADR-0026); roster snapshot new (§29) | 3x3: roster 4, lineup 4; relay: 4 legs in order; Baker: 5 bowlers in frame order |

**Naming rules.**

- **"Modality"** means participation modality or event type, never format.
- **"Ranking"** is reserved for cross-competition systems (ADR-0048). The order inside one event is a **classification**. The ticket's "ranking model" is therefore modelled as the **classification model** (§23). This avoids a direct conflict with the existing `@br/rankings` vocabulary.

---

## 4. Competition Families

**Method.** Every modality × format pair from §6–§13 was classified. A family is kept as a **primitive** only if it cannot be composed from other primitives.

| # | Family evaluated | Verdict | How it is represented |
|---|---|---|---|
| 1 | KNOCKOUT | **Primitive** (stage engine `KNOCKOUT`) | Bracket; winner/loser transitions; byes; third place; stepladder as a degenerate seeded knockout |
| 2 | ROUND_ROBIN | **Primitive** (stage engine `ROUND_ROBIN`) | 1..n groups; circle method; repeat factor (e.g. FIP 2-pair group plays twice) |
| 3 | POOL_AND_KNOCKOUT | Composite | `ROUND_ROBIN` → rank transition → `KNOCKOUT` |
| 4 | LEAGUE / STANDINGS | Composite | `ROUND_ROBIN` (1 group, repeat 1–2) + standings policy. Multi-week leagues are a scheduling concern |
| 5 | RACE / TIMED | **Primitive** (stage engine `FIELD`) | One ranked field; contests are logistic partitions (waves, start intervals); metric classification by time or finish order |
| 6 | HEATS_AND_FINALS | **Primitive** (stage engine `HEATS`) + composite | `HEATS` (competitive partitions seeded by entry value) → qualify-by-place-and-time → `FIELD`/`HEATS` final |
| 7 | QUALIFYING_AND_FINAL | Composite | Any ranked stage → rank/cut transition → `KNOCKOUT` (stepladder, match play) or `FIELD` (final) |
| 8 | SCORE / LEADERBOARD | = `FIELD` | Same primitive as race; the metric is score (pins up, strokes down, points up) |
| 9 | MULTI_ROUND | **Primitive mechanism**: cumulative classification across rounds of one stage | `FIELD` stage with *k* rounds + `aggregate` (SUM of strokes, pins or times) |
| 10 | STAGED / CUMULATIVE | Composite | MULTI_ROUND + **adjustments** (cycling bonuses, same-time) + **parallel classifications** from the same contests (GC, points, team) + cut transitions between rounds (golf) |

**Result:**

- **4 stage engines:** `KNOCKOUT`, `ROUND_ROBIN`, `FIELD`, `HEATS`.
- **1 aggregation mechanism:** cumulative classification across rounds.
- **5 transition kinds:**
  - `WINNER_OF` / `LOSER_OF`;
  - `RANK_FROM_GROUP` (incl. best-ranked across groups);
  - `QUALIFY_BY_PLACE_AND_TIME` (Q/q);
  - `CUT` (top N and ties, or within X of the lead);
  - `STEPLADDER`.

**Key insight: logistic vs competitive partitions.**

- **Logistic partitions** are only scheduling devices. All entrants are ranked **together**:
  - swimming timed-final heats;
  - running waves;
  - golf tee groups;
  - bowling squads and lane pairs;
  - cycling time-trial start slots.
- **Competitive partitions** rank entrants **within** the partition for qualification:
  - track heats with Q by place;
  - padel groups;
  - swimming semi-finals.

The `FIELD` engine has logistic partitions; the `HEATS` engine has competitive ones. Mixing the two is the most likely modelling error, so the engine keeps them as separate primitives.

---

## 5. Sport Inventory

| Sport | Governing body (cited) | Paradigm | Contest type (existing vocabulary) | Entrant kinds | Primary result unit |
|---|---|---|---|---|---|
| Tennis | ITF | Head-to-head | MATCH | Athlete, pair | sets / games / points |
| Padel | FIP | Head-to-head | MATCH | Pair | sets / games / points |
| Running | World Athletics | Race | HEAT (wave, heat, race) | Athlete, relay team | elapsed time / finish order |
| Swimming | World Aquatics | Race | HEAT | Athlete, relay team | elapsed time (1/100 s) |
| Cycling | UCI | Race | HEAT (mass start); SESSION (time trial) | Athlete (team classification derived) | finish order + time; time |
| Bowling | IBF (formerly World Bowling); USBC for handicap | Score (+ match play) | SERIES (block of games); MATCH (match play / stepladder) | Athlete, pair, trio, team | pins per game (frames) |
| Basketball | FIBA (5v5, 3x3); IWBF (wheelchair) | Head-to-head | MATCH | Team | points |
| Golf | R&A / USGA (Rules of Golf, WHS); PGA Tour for cut practice | Score (+ match play) | SERIES (one round per entrant); MATCH (match play) | Athlete, pair, team | strokes per hole; Stableford points; holes up |

All eight fit the existing six contest types. **No new contest type is needed.**

---

## 6. Tennis

**Sources:**

- **[R]** ITF Rules of Tennis 2026: https://www.itftennis.com/media/7221/2026-rules-of-tennis-english.pdf
- **[J]** ITF World Tennis Tour Juniors Regulations 2026: https://www.itftennis.com/media/15524/2026-itf-world-tennis-tour-juniors-regulations.pdf

The junior regulations are the most explicit public ITF text on draws, round robin and rest. They are used as **reference templates**, not as rules binding amateur events.

### 6.1 Rules relevant to the engine

**One ruleset.** The Rules of Tennis cover singles and doubles in one text. The doubles rules sit inside it: court width, Rule 14 order of service, Rule 15 order of receiving. Mixed doubles has no separate ruleset; it appears only as variants. For example, Appendix VI No-Ad says the player of the same gender as the server receives the deciding point [R].

**Scoring [R].**

- Rule 6: an advantage set or a tie-break set (6 games with a 2-game margin; tie-break at 6–6).
- Rule 7: best of 3 or best of 5 sets.
- Tie-break game: first to 7 points with a 2-point margin.
- **Appendix VI (alternative procedures and scoring):**
  - No-Ad;
  - Short Sets: first to 4 games, tie-break at 4–4;
  - match tie-break to 7 or 10, replacing the deciding set;
  - final-set tie-break to 10 at 6–6;
  - the No-Let rule.
- The format, including the final set, **must be announced in advance**.

**Draws [J §45, §48].**

- Main draw sizes: 8, 16, 24, 32, 48, 64, 96, 128. These are **not all powers of two**: 24 and 48 sit inside 32 and 64 brackets with byes.
- Seeds:

| Draw size | Seeds |
|---|---|
| 8 | 2 |
| 16 | 4 |
| 24 / 32 | 8 |
| 48 / 64 / 96 / 128 | 16 |

- Seed 1 goes on line 1; seed 2 on the last line.
- Seeds 3–4 are drawn as a pair onto fixed lines; seeds 5–8 (and 9–12, 13–16) in groups of four. For a 32 draw, seeds 3–4 go to lines 9/24 and seeds 5–8 to lines 8/16/17/25.
- Seeds of the same nation are separated by half, then by quarter.
- **Byes go to the highest seeds first.** Remaining byes are drawn and spread across sections.
- Doubles teams are seeded by ranking, with ties broken by combined ranking [J].

**Round robin → knockout [J (J30/J60 events)].**

- Seeds 1–8 go on line 1 of groups A–H.
- Group winners enter the knockout on fixed or drawn lines: A on line 1, B on line 8, C/D drawn into lines 3/6, E–H into the rest.

**Round-robin tie-break [J §57].**

1. Most wins.
2. Two tied: head-to-head.
3. Three or more tied: % sets won, then % games won.

Conditions:
- Only players who completed all their group matches count; retired matches count as completed.
- All matches of a player who gave one or more walkovers are excluded.
- A match tie-break counts as 1 set and 1 game.

**Match formats [J §35].**

- Main-draw singles: best of 3 tie-break sets.
- Round robin and qualifying: 2 sets + a 10-point match tie-break.
- Doubles: 2 sets + a match tie-break with No-Ad.

**Rest [J, "Between Matches"].**

- At most 1 singles and 1 doubles main-draw match per day, with ≥ 12 h after the player's last match of the previous day.
- A second match on the same day needs minimum rest **based on how long the previous match lasted**:

| Previous match length | Minimum rest |
|---|---|
| < 1 h | 30 min |
| 1–1.5 h | 1 h |
| 1.5–2 h | 1.5 h |
| > 2 h | 2 h |

- Earlier start if all players agree.

### 6.2 Discipline vs modality decision (singles / doubles / mixed)

**Decision:**

- **Singles and doubles are separate Disciplines** (`tennis.singles`, `tennis.doubles`), as the catalog already has them. They share a ruleset family and a ScoringFormat, but differ in entrant structure (1 athlete vs a pair). That structure is part of the DisciplineVersion's `participation`.
- **Mixed doubles is not a discipline.** It is `tennis.doubles` + category `MIXED`.

**Why not one "tennis" discipline with a modality field:**

1. Entrant structure, lineup validation and authority scopes (`tennis.singles` vs `tennis.doubles`) differ.
2. Ranking universes differ (ADR-0048 universes pin a DisciplineVersion).
3. It is already in production.

**Why mixed is a category:**

1. The ITF has no separate mixed ruleset; mixed affects only a **scoring variant** (who receives the deciding point).
2. The composition "one man + one woman" is **eligibility**, and the platform never infers sex (`category.ts`).

The scoring variant is a ScoringFormat parameter (`decidingPointReceiver: SAME_GENDER_AS_SERVER`), enabled when the category is MIXED.

### 6.3 Selection

| Modalities | Formats |
|---|---|
| 1. **Singles** | 1. **Single elimination** (seeded draw, byes, optional third place) |
| 2. **Doubles** (men's / women's / open) | 2. **Round robin** (single group; small fields) |
| 3. **Mixed doubles** | 3. **Round robin → knockout** (ITF J30/J60 template) |

- **Modalities:** these are the events every ITF-sanctioned and club tournament offers; singles and doubles are separate ranking lists.
- **Formats:** single elimination is the ITF main-draw structure [J]. Round robin and RR → KO are ITF-codified [J] and guarantee each entrant several matches (product judgement: preferred by amateur organizers).
- **Not selected:**
  - Double elimination: no ITF basis found.
  - Consolation/feed-in: common at club level but not codified in the sources read. It is a future option (§35).

### 6.4 Draws, courts and engine requirements

- **Draw:** knockout with an **explicit draw size** (not only the next power of two), seed count by table, banded seed placement, byes to top seeds, best-effort separation.
- **Court allocation:** one tennis court per match. Singles and doubles use the same court resource (doubles uses the alleys).
- **Progression:** winner → next slot; in RR → KO, group rank → knockout line.
- **Standings:** wins → H2H (two-way only) → % sets → % games, with completed-matches and walkover exclusion rules.
- **Scheduling/rest:** rest is a **function of the previous match duration**, plus a daily cap per event type. It must be checked **across events** (singles + doubles).

---

## 7. Padel

**Sources:**

- **[FR]** FIP Rules of Padel (Dec 2025): https://www.padelfip.com/wp-content/uploads/2025/12/FIP_Rules-of-Padel.pdf (ES: …/FIP_Reglas-del-Padel.pdf)
- **[CT]** Cupra FIP Tour Rulebook: https://www.padelfip.com/wp-content/uploads/2025/03/Cupra-FIP-Tour-Rulebook_EN-2.pdf
- **[PR]** FIP Promises Tour Rulebook (2026): https://www.padelfip.com/wp-content/uploads/2026/04/EN-FIP-Promises-Tour-Rulebook-09_07_2026.pdf
- **[WC]** FIP World Cup Pairs: https://www.padelfip.com/wp-content/uploads/2025/10/FIP-World-Cup-Pairs-EN-1.pdf
- Premier Padel rulebook: **UNVERIFIED** (not opened).

### 7.1 Rules relevant to the engine

**Scoring [FR Rule 1]. Three official deuce systems:**

1. **Advantage.**
2. **Star Point:** deuce 1 → advantage 1 → deuce 2 → advantage 2 → deuce 3 → one deciding "Star Point".
3. **Golden Point:** a single deciding point.

Sets, match and alternatives:
- Sets of 6 with a 2-game margin; tie-break to 7 at 6–6.
- Best of 3. The organizer may announce an advantage third set.
- Alternatives: a 4-game mini-set (tie-break at 4–4), a 7-point match tie-break, or a **10-point super tie-break replacing the third set**.
- In mixed matches, the deciding point is received by the player of the same sex as the server [FR].
- The **Cupra FIP Tour mandates tie-break sets and Star Point** [CT §11.1.9].

**The pair is the entrant.**

- Acceptance and seeding use the pair's **combined FIP ranking**, "both players added together" [CT §2.1, §2.2.1, §4.2.4; WC §2]. Ties go to the pair with the higher-ranked player, then to a draw.
- Whether points or positions are added is not stated verbatim. It is read as points, but that reading is **unverified**.

**Partner rules [CT].**

- A player may not register with more than one partner.
- A withdrawn pair is replaced **by another pair**.
- A wild-card pair may change a partner only until the qualifying draw.
- No mid-event partner substitution clause was found, so **the pair is atomic**.

**Draws [CT §4.2].**

- Main draws of 16, 28 or 32 with qualifying draws of 16, 32 or 64; 4 qualifiers.
- 8 seeds in a 32 draw.
- Placement: seed 1 on line 1, seed 2 on the last line, seeds 3–4 drawn onto the middle lines.
- Wild cards can be seeded; qualifiers and lucky losers cannot.

**Groups [PR].**

- Format by number of pairs:
  - 4–8 pairs: round robin is **mandatory**.
  - 9–16 pairs: round robin or knockout, the promoter's choice.
  - 17+ pairs: knockout is mandatory.
- Group layouts are tabulated with **uneven sizes**: e.g. 13 pairs = 1×4 + 3×3; 11 pairs = 3×3 + 1×2, where the **2-pair group plays twice**.
- Seeds 1 and 2 go to different groups; with unequal sizes, the higher seeds go to the smaller groups.
- Semi-final crossovers are fixed: with 4 groups, 1st of G1 v 1st of G4 and G2 v G3; with 2 groups, 1A v 2B.
- The FIP does not recognise consolation draws.

**Group tie-break [PR].**

- Three-way tie: set difference among the tied pairs → game difference among them → draw. Once separated, a remaining two-way tie goes to head-to-head.
- Team events (ties made of pair rubbers): match difference → set difference → game difference → draw.
- A no-show counts 6/0 6/0.

**Americano / Mexicano:** in no FIP document read. **COMMON PRACTICE** (social rotating-partner formats).

### 7.2 Selection

| Modalities | Formats |
|---|---|
| 1. **Men's doubles** | 1. **Single elimination** (optional qualifying draw) |
| 2. **Women's doubles** | 2. **Groups → knockout** (FIP Promises template) |
| 3. **Mixed doubles** | 3. **Round robin** (single group; 4–8 pairs) |

- **Modalities:** all three are `padel.doubles` + a category, which is **fully compatible with the existing catalog** (`padel.doubles@1`, TEAM, 2 per entry). These are the three events of every FIP and club tournament.
- **Formats:** these are the three structures the FIP itself codifies, chosen by field size.
- **Not selected:**
  - Americano: COMMON PRACTICE; it needs a rotating-partner engine (§35).
  - Consolation: not recognised by the FIP.

### 7.3 Padel vs tennis

| Aspect | Shared (generic) | Padel-specific | Tennis-specific |
|---|---|---|---|
| Scoring | `SETS_OF_GAMES` family: sets, tie-break, match tie-break | Star Point deuce option; super tie-break as the common third set | Short sets; best of 5; No-Let |
| Entrant | TEAM `EVENT_PAIR` (doubles) | Always a pair; partner atomic; combined pair ranking | Singles exists |
| Draw | Knockout primitive, seed table, byes to seeds | Qualifying + main draw; seed lines differ (3–4 in the middle) | 24/48 draws; nation separation |
| Groups | `ROUND_ROBIN` primitive | Uneven groups incl. a 2-pair double round robin; field-size-driven format | Groups of 3–4 with fixed group-winner lines |
| Standings | Standings policy engine | Set/game **difference** among tied; three-way-first rule | Win → H2H → **% sets** → % games; walkover exclusion |
| Resource | court | padel court | tennis court |

**Conclusion.** Padel and tennis share every engine. Their differences are **parameters**: deuce mode, seed-line table, group table, standings criteria. There is no sport branch.

### 7.4 Engine requirements

- Pair entrant (existing `EVENT_PAIR`), with a pair seed value **declared** from external rankings.
- Configurable deuce mode.
- Group layouts driven by a **group-size table** (data), including a repeat factor for 2-entrant groups.
- Fixed crossover maps.
- Standings with tied-subset difference criteria.

---

## 8. Marathon / Running

**Source:**

- **[WA]** World Athletics Competition & Technical Rules (C1.1 & C2.1), in force 1 Jul 2026: https://worldathletics.org/download/download?filename=0ed43077-8e08-492b-a4b3-267f27c18d0b.pdf&urlslug=C1.1%20%26%20C2.1%20-%20Competition%20Rules%20%26%20Technical%20Rules (index: https://worldathletics.org/about-iaaf/documents/book-of-rules)

Rule numbers below are as cross-referenced in the extracted text.

### 8.1 Rules relevant to the engine

**Official time is gun time [WA, TR 19 transponder section].** "The time elapsed between an athlete crossing the start line and the finish line can be made known to them, but will not be considered an official time." So **net (chip) time is informational**.

**Timing methods [WA].**

- Three methods: hand, fully automatic, transponder.
- Transponders are allowed only for races not held completely in the stadium (road, cross-country, trail and mountain).
- Back-up judges are recommended because chips may not separate close finishes.

**Rounding [WA].**

| Context | Rounding |
|---|---|
| Track, fully automatic, ≤ 10,000 m | up to the next 0.01 s |
| Track, fully automatic, > 10,000 m | up to the next 0.1 s |
| Track, hand timing | up to the next 0.1 s |
| Outside the stadium | up to the next whole second (2:09:44.322 → 2:09:45) |
| Transponder | whole second |

**Ties [WA, TR 21].**

- Track: the photo-finish judge looks at 0.001 s; if still equal, the tied athletes advance if lanes allow, otherwise lots are drawn.
- Road: the judges' finish order stands.

**Result codes [WA C1.1]:** DNS, DNF, DQ (with the rule number).

**Age groups [WA C1.1].**

- U18 (16–17) and U20 (18–19) on 31 December.
- **Masters: from the 35th birthday.**
- Five-year masters bands follow WMA: **UNVERIFIED**.

**Start waves / corrals:** **COMMON PRACTICE**. The rules say only that athletes assemble "in the manner determined by the organisers".

**Track rounds [WA, TR 20].**

- Qualification by place (**Q**) and by time (**q**) follows the competition's tables.
- **Zigzag** heat distribution.
- Heat running order drawn by lot.
- Lane draws by rank band in later rounds (e.g. the top 4 drawn into lanes 3–6 on the straight).
- **Minimum time between rounds:** 45 min (≤ 200 m), 90 min (> 200 m to 1000 m), next day (> 1000 m).

**Relays [WA, TR 24].**

- Any 4 of the entered athletes, one leg each; up to 2 substitutes after the team has started.
- **Order declared** by first call.
- Mixed relays run M-W-M-W.
- Road Relay: marathon distance in 6 stages [WA, TR 55].

**Road distances [WA, TR 55]:** mile, 5 km, 10 km, 15 km, 10 mi, 20 km, half marathon, 25 km, 30 km, marathon, 50 km, 100 km.

**Team scoring (cross-country):**

- Team scoring is set by **competition regulations, not the Technical Rules**.
- Example: 4 scorers of up to 6 starters; lowest sum of places wins; ties go to the team whose last scorer finished closer to first. Source: https://worldathletics.org/news/press-releases/preliminary-entries-course-scoring-details-ia

### 8.2 Selection

| Modalities | Formats |
|---|---|
| 1. **Road race** (individual; 5K → marathon) | 1. **Mass-start timed race** (single start) |
| 2. **Track race** (individual; sprint → 10,000 m) | 2. **Wave-start timed race** (multi-wave mass start) |
| 3. **Relay** (road relay or track 4×) | 3. **Heats → final** (Q/q qualification) |

**Modalities:**

- **Road race** covers the ticket's "marathon" and, in our product judgement (not a sourced statistic), is the highest-participation amateur running modality in the pilot market.
- **Track** introduces heats, lanes and Q/q.
- **Relay** introduces an **ordered team lineup** and mixed composition.

**Ambiguity resolved, trail vs track.** Trail and mountain racing is, in our product judgement, popular locally (unsourced). In the engine it is the **same paradigm as road** (mass start, transponders, gun time); only the course resource differs. It is therefore a future *discipline* on the road model (`running.trail`). Track was chosen as modality 2 because it is the only running modality that needs heats and lanes.

**Formats:**

- Mass and wave starts are the two ways road races actually run.
- Heats → final is the track norm.
- Team scoring (sum of places) is a **parallel classification** on any of the three formats (§23), not a format of its own.

### 8.3 Engine requirements

- **Never a draw or bracket.** The chain is:
  participant → race (Event = distance + category) → **start wave** (logistic partition) → timing → elapsed time → classification.
- **Start reference per entrant:** gun time of their wave (official) and chip-start time (net, informational). Elapsed time = finish − reference.
- **Category sub-classifications** (gender, age bands) from **one race**. Age is a declared category label; the platform never derives it from DOB.
- **Status codes** DNS/DNF/DQ with a rule reference.
- **Rounding policy per discipline** (whole second up on the road).
- **Ties** stand on the road; on the track, a 0.001 s chain, then lots.
- **Scale:** one road race may have thousands of entrants. Results arrive by **timing-system import** (ADR-0017 ingestion boundary), not by hand entry.

---

## 9. Swimming

**Sources:**

- **[WAq]** World Aquatics Competition Regulations Part Two, Swimming (in force Feb 2026; copy hosted by the Slovenian federation): https://www.plavalna-zveza.si/wp-content/uploads/2026/01/2026-02-18_World-Aquatics_CR-Final-Swimming.pdf
- **[OW]** World Aquatics Competition Regulations Part Three, Open Water (June 2025): https://www.swiss-aquatics.ch/wp-content/uploads/2026/01/World-Aquatics_Competition-Regulations_June-2025_Open-Water-updated-01.07.2025.pdf

The 2026 edition renumbers the old "SW" rules as articles.

### 9.1 Rules relevant to the engine

**Heat seeding by entry time [WAq Art. 3.2].**

- Entrants are listed fastest first; identical times are ordered by random draw; no time = last.
- 1 heat = direct final.
- 2 heats: fastest in heat 2, next in heat 1, alternating. With 3 heats, the last three are circle-seeded.
- With 4 or more heats, the earlier heats are filled in blocks.
- 400/800/1500 m: only the last two heats are circle-seeded.
- At least 3 swimmers per heat.

**Lanes [WAq Art. 3.2.5].**

| Pool | Lane order |
|---|---|
| 8 lanes | **4, 5, 3, 6, 2, 7, 1, 8** |
| 10 lanes (0–9) | fastest in 4, next in 5 |
| 6 lanes | fastest in 3, next in 4 |
| Odd number of lanes | fastest in the centre lane |

Below World Aquatics or Olympic level, **lanes may be drawn** [WAq Art. 3.6].

**Semi-finals and final [WAq Art. 3.3–3.4].**

- Semis are seeded alternately; the final takes the fastest 8.
- A tie for the last place: **swim-off** for events ≤ 200 m.
- A withdrawal is replaced by the next fastest.
- Format by distance [WAq Art. 3.7]: 50/100 m → heats, semis, final; ≥ 200 m → heats, final; 800/1500 m may be a **timed final**.

**Timing and ties [WAq Art. 11].**

- Automatic timing to **1/100 s**.
- Equal times = **equal placing**; there is no thousandths tie-break.
- Manual fallback: average of 2 watches, thousandths **truncated**.
- DQ = no time, no place. For a disqualified relay, the legal splits before the offending swimmer are still recorded.

**Relays [WAq Art. 10.4, Art. 9].**

- 4 swimmers; mixed relays are 2 men + 2 women.
- Order declared before the deadline; substitution only for a medical emergency.
- Composition may change between heats and final.
- Medley relay order: back, breast, fly, free.
- An early takeover disqualifies the team.

**Open water [OW].**

- Events: 5/10 km and a 4×1500 m mixed relay; an optional knockout sprint.
- Mass start, from a platform with positions drawn, or in the water.
- **Transponders on both wrists**; finishing without one = DQ. The Chief Referee decides places using video.
- Time limit relative to the winner.

### 9.2 Selection

| Modalities | Formats |
|---|---|
| 1. **Individual pool events** (stroke × distance × category) | 1. **Timed finals** (heats seeded by entry time, overall classification) |
| 2. **Relays** (freestyle, medley, mixed) | 2. **Heats → final** (top 8 by time) |
| 3. **Open water** (1–10 km) | 3. **Mass-start open-water race** |

- **Modalities:** individual events are the core of masters and age-group meets. Relays bring team scoring and ordered legs. Open water suits the pilot market's sea and lake venues (product judgement) and reuses the running mass-start and transponder model.
- **Formats:** timed finals are permitted by WAq Art. 3.7 and common at amateur meets (COMMON PRACTICE). Heats → final is the World Aquatics championship structure [WAq Art. 3.3–3.4]. Heats → semis → final applies only to large fields and is a parameter of format 2 (an extra `HEATS` stage), not a separate selection.

### 9.3 Engine requirements

- Seeding by an **entry attribute** (entry time).
- Heat composition by a **circle-seeding rule** (data: how many final heats are circle-seeded).
- Lane assignment by a **pool-size lane-order table** (data).
- **Timed finals:** heats are *logistic*; one classification across heats.
- **Heats → final:** heats are *competitive in time only*. Qualification is by time across heats (not by place), so the transition is `QUALIFY_BY_PLACE_AND_TIME` with `places = 0` and `times = 8`.
- **Ties** = equal places; a swim-off is **a new contest** created by an organizer decision (audited), never automatically.
- **Relay lineup** = 4 ordered legs (with a stroke per leg for medley); may change between stages.
- **Precision:** 1/100 s, manual times truncated.

---

## 10. Cycling

**Sources:**

- **[UCI-2]** UCI Regulations Part 2, Road Races (2026; bilingual edition published by the Japan Cycling Federation, English text verbatim): https://jcf.or.jp/wp2012/wp-content/plugins/download-monitor/download.php?id=3792
- **[GF]** UCI Gran Fondo World Series: https://ucigranfondoworldseries.com/en/?p=30
- MTB XCO: UCI Part 4 primary text **not verified**. Facts below are **[S]**, via USA Cycling 2026 XCO regulations and press.

### 10.1 Rules relevant to the engine

**Mass-start road race [UCI-2].**

- Classified by order of crossing the line (2.3.037).
- **"All riders in a given bunch shall be credited with the same time"** (2.3.040).
- Times rounded down to the whole second (2.3.041).
- Riders more than 8% (adjustable) behind the winner are not placed (2.3.039).
- Optional team classification = sum of the 3 best times, ties broken by sum of placings (2.3.044).

**Individual time trial [UCI-2].**

- Start order set by the organiser on objective criteria (2.4.006).
- **Identical intervals** (2.4.007). The regulation does not fix 1 minute; 1 minute is the Gran Fondo series standard [GF] = COMMON PRACTICE.
- Times to 0.1 s; 0.01 s at top level (2.4.015–016).

**Criterium [UCI-2, 2.7.002].** A closed circuit, classified at the finish of the last lap **or** by laps covered + intermediate sprint points.

**Stage race [UCI-2, 2.6].**

- **GC = sum of stage times** (2.6.014), with time bonuses: stage finish 10/6/4 s; intermediate 3/2/1 s (2.6.019).
- **3-km rule:** an incident in the last 3 km means the rider is credited with their group's time (2.6.027).
- GC tie-break: hundredths from time trials → sum of stage placings → place in the last stage (2.6.015).
- Team classification = sum of the 3 best per stage (2.6.016).
- Points and mountain classifications are optional (2.6.013).

**Gran Fondo [GF].**

- Age categories in 5-year bands from 35 (19–34 first); age on 31 Dec.
- **Gun or net time allowed.**
- Top 25% per age group qualify for the World Championships.
- Event types: road race, time trial, or a 3-day stage race.

**MTB XCO [S].** Start grid by ranking. The **80% rule** pulls lapped riders, who are classified with "−n laps" in the order they were pulled.

### 10.2 Selection

| Modalities | Formats |
|---|---|
| 1. **Road race / Gran Fondo** (mass start, age categories) | 1. **Mass-start race** (finish order + same-time groups) |
| 2. **Individual time trial** | 2. **Interval-start time trial** (ranked by time) |
| 3. **MTB cross-country** (XCO / marathon) | 3. **Multi-stage cumulative (GC)** |

- **Modalities:** Gran Fondo is the UCI's mass-participation road format [GF] and, in our product judgement, the highest-participation amateur cycling modality. The time trial is the cleanest pure-time modality. MTB is, in our product judgement (unsourced), strong in the pilot market, and adds laps and lapped riders. Criterium was considered as #3; it is an alternative for urban festivals but adds sprint points that a v1 does not need.
- **Formats:** these are the three classification mechanics the UCI defines.

### 10.3 Time-based vs mass-start ranking, and stage races

These are **different comparators on the same `FIELD` primitive**:

- **Time trial:** `elapsedTime ASC`; the start offset is per entrant (interval).
- **Mass start:** `finishOrder ASC` for **place**, while `time` is a *derived display* with **same-time-in-bunch** adjustment. Lapped or pulled riders are ranked by `lapsCompleted DESC` and then pull order.

**A stage race is not a new primitive.** It is a **MULTI_ROUND** `FIELD` stage (each stage = one round) plus:

- **(a) Adjustments** per rider per stage: bonuses, 3-km credits, same-time. These are recorded in the **contest result content**, never computed by the engine from video.
- **(b) Parallel classifications** from the same contest results: GC, points, mountains, team.
- **(c) Elimination carry-over:** DNF in a stage = out of the GC.

The same mechanism covers golf multi-round play (§13) and bowling all-events (§11). This confirms MULTI_ROUND as a shared primitive, not a cycling special case.

---

## 11. Bowling

**Sources:**

- **[IBF23]** IBF World Championships 2023 Rules & Regulations: https://ABF-Online.org/zipped/IBFWC2023_R&R.pdf
- **[ABF]** Asian Bowling Federation (IBF Asia zone) championship rules: https://www.abf-online.org/zipped/22ndAIBC_Rules.pdf, https://www.abf-online.org/zipped/43rdMIO_Rules.pdf
- **[USBC]** USBC *Handicap Facts*: https://images.bowl.com/bowl/media/legacy/internap/bowl/rules/pdfs/Handicap%20Facts.pdf
- PBA stepladder **[S]**: https://en.wikipedia.org/wiki/PBA_Tour
- **Internal:** BRT-01 La Negrita bowling walkthrough (`docs/examples/BRT-01-BOWLING-WALKTHROUGH.md`).

The general IBF playing rules (frames, the 300 maximum) were **not verified** against an IBF document. They are standard tenpin scoring.

### 11.1 Rules relevant to the engine

**Two competing championship models exist, so formats vary by organizer.**

1. **IBF 2023: match-play round robin.**
   - 7-game round robin in subgroups of 8, scoring **3 points per win, 1 per draw**.
   - A second round robin.
   - Semi-finals 1v4 and 2v3, then the final, **best of 3 games**.
   - Doubles, trios and team bowl in **Baker format** (team members bowl frames in rotation in one game).
   - Lineup changes are allowed between games.
   - **Ties that affect advancement:** a 9th–10th-frame roll-off.
   - Medal ties: co-medallists [IBF23].
2. **Classic pinfall: ABF and amateur practice.**
   - Singles, doubles and team of 4 bowl **6 games each**.
   - **All-events = 18-game total pinfall.**
   - **Masters:** top 16 bowl a scratch round robin with **10 bonus pins per match won, 5 per tie**.
   - Ties for the last Masters spot: 1-game roll-off, then 9th/10th-frame sudden death.
   - Masters standings ties: scratch pinfall → head-to-head → wins → smallest high–low spread → highest game.
   - Event medal ties: co-champions [ABF].

**Lanes [IBF23 Rule 5.3; ABF].**

- Each game is bowled on a **pair of lanes**, alternating lanes each frame.
- A predetermined lane assignment and **lane-move schedule**: odd lanes move left, even lanes move right, after each game.
- The number of bowlers per pair stays constant.

**Stepladder:** #5 v #4, the winner plays #3 … up to #1. **PBA practice / COMMON PRACTICE** in amateur finals; not an IBF rule [S].

**Handicap [USBC].**

- Handicap = percentage × (basis − average). The league chooses the basis and percentage.
- "90% of 220" is **COMMON PRACTICE** [S].

**Legacy pilot (BRT-01 walkthrough).**

- La Negrita runs qualifying 3-game series → "Llaves".
- Standings: average desc → total pins desc → highest series desc.
- Scratch, handicap and senior divisions.
- One series counting for several events (**cross-event derivation**).

### 11.2 Selection

| Modalities | Formats |
|---|---|
| 1. **Singles** | 1. **Aggregate pinfall** (N games, scratch or handicap) |
| 2. **Doubles** | 2. **Qualifying → stepladder / knockout finals** |
| 3. **Team** (trios or 4–5; Baker or individual-games) | 3. **Round-robin match play** (win points, or pins + bonus) |

- **Modalities:** the three events every IBF, ABF and amateur championship holds. All-events is a **derived classification** across them, not a modality.
- **Formats:**
  - Aggregate pinfall is the amateur and ABF norm, and the pilot's format.
  - Qualifying → stepladder is the standard amateur final (COMMON PRACTICE).
  - Round-robin match play is the IBF championship model and the ABF Masters.

### 11.3 Engine requirements

Bowling is **not** "match winner advances". The chain is:

```
entrant (athlete / pair / team) → SERIES contest = block of N games on a lane pair
  → per game: frames (Performance components) → game score (0..300)
  → series total (+ handicap per game) → classification by SUM(pins) [scratch or handicap]
  → qualification (top K, roll-off for ties at the cut) → finals (stepladder = chain of MATCH contests,
    or a match-play round robin with bonus pins added to pinfall)
```

- **Handicap:** applied by the **ruleset** from an **entry attribute** (entering average plus its source). Two Events can classify the **same contests** (scratch and handicap): cross-event derivation, BRT-01 §5.4.
- **Baker:** a **team lineup with frame order**. The team, not the individual, owns the game score.
- **Match play inside a pinfall competition:** IBF Masters add bonus pins per win to pinfall. This is a classification key `SUM(pins) + bonus × wins`, expressed as a **derived metric**, not new code.
- **Ties:** a roll-off is an **extra contest**, created by an audited organizer decision. Medal ties are shared.

---

## 12. Basketball

**Sources:**

- **[OBR]** FIBA Official Basketball Rules 2026 v1.0: https://assets.fiba.basketball/image/upload/documents-corporate-fiba-official-rules-2026-v1-0.pdf
- **[3x3-26]** FIBA Official 3x3 Basketball Rules 2026, Korean Basketball Association edition (translated): https://www.koreabasketball.or.kr/static/2026_FIBA_3x3.pdf
- **[3x3-EN]** Older English reproduction by Basketball Ireland: https://ireland.basketball/uploads/ed/BI3x3Rules.pdf
- The fiba3x3.com rules pages returned HTTP 403 and are **not directly verified**.
- **[COMP]** FIBA 3x3 competition structure: https://about.fiba.basketball/en/our-sport/3x3-basketball/competition-structure
- **[U23]** FIBA 3x3 U23 World Cup 2026 format: https://www.fiba.basketball/en/news/all-you-need-to-know-before-fiba-3x3-u23-world-cup-2026
- **[SO]** FIBA Shoot-Out/Dunk contests: https://www.fiba.basketball/en/news/dunk-and-shoot-out-contests-start-today

### 12.1 Rules relevant to the engine

**5v5 [OBR].**

- 5 players on court; **no more than 12 team members entitled to play**.
- 4 × 10 min, with 5-minute overtimes until decided. **There are no draws.**
- **Forfeit** (Art. 20): the team can't field 5 players 15 minutes after the start → 20–0 and **0 classification points**. A second forfeit = disqualification from the tournament.
- **Default** (Art. 21): fewer than 2 players on court → the score stands if the winner is ahead, else 2–0. The defaulting team gets **1 point**.

**5v5 classification (Appendix D).**

- Win = 2 points, loss (incl. by default) = 1, forfeit = 0.
- Ties: games among the tied teams → points difference among them → points scored among them → overall points difference → overall points scored → draw.
- **The procedure restarts** whenever a team is separated (D.1.4).
- Cross-group comparison (e.g. best third-placed team): wins, then point difference, then points scored (D.4).

**3x3 [3x3-26; 3x3-EN].**

- 4 players (3 on court + 1 substitute); one basket; a **half court may be used**.
- 1-point and 2-point shots.
- **10 minutes or the first team to 21** (in regulation); overtime = first to 2 points.
- Forfeit: no 3 players at the start → "w-0".
- Standings: wins (or win ratio across pools) → head-to-head (within a pool) → **average points scored, each game counted to at most 21**, forfeit wins excluded → seeding.
- **Seeding:** the sum of the 3 best players' individual ranking points.
- Events run as **pools → knockout**. For example, the U23 World Cup 2026 has 20 teams in 4 pools of 5, with the top 2 to the quarter-finals plus a third-place game [U23].
- Grassroots events are a FIBA-recognised level [COMP].
- The 12-second shot clock is **[S]**.

**3x3 is a separate discipline.** It has its own rulebook, entrant size, scoring family (timed-or-target), standings rule and seeding rule. It is a separate discipline (`basketball.3x3`), not "5v5 with fewer players". This is consistent with the IOC treating 3x3 as its own discipline.

**Third modality: wheelchair basketball (IWBF).**

- **Source [IWBF-R]:** IWBF Quick Rule Guide, https://iwbf.org/our-sport/rules
  - Two teams of **five on court**.
  - Teams of **up to 12 players**.
  - **Four 10-minute periods**, with extra periods if tied.
  - Standard court, basket height, foul line and three-point line.
- **Source [IWBF-C]:** https://iwbf.org/our-sport/classification
  - Players are classified **1.0–4.5**.
  - The five on court may total **at most 14.0 points**. Exceeding the limit is a technical foul.
  - International play requires an eligible impairment and minimum impairment criteria.
- **Not verified:** the full IWBF Official Wheelchair Basketball Rules PDF was not opened. Detailed rule differences (e.g. travelling, timing) are **UNVERIFIED** and not relied on.

**Why it is the third modality:**

- It is a governing-body-codified basketball modality (IWBF, Paralympic).
- It fits an inclusive multi-sport festival.
- It exercises a capability no other modality needs: a **lineup constraint over declared entry attributes** (sum of classification points ≤ 14.0).
- **Honesty rule.** Classification points are **declared entry attributes**. The platform never verifies impairment or classification. The on-court cap is a rule applied by game officials. The platform **records** it and does **not** validate it in v1, because on-court five-player units are never stored (§29).

**Moved to future (§35): FIBA 3x3 Shoot-Out skills contest.**

- FIBA runs it at 3x3 events [SO].
- Its detailed format (10-shot qualifying, 18-shot final, points then time) is supported **only by a search snippet [S]**.
- Per review, it is **not canonical** until a primary FIBA format source is verified.

### 12.2 Selection

| Modalities | Formats |
|---|---|
| 1. **5v5** | 1. **Pool play → knockout** |
| 2. **3x3** | 2. **Round robin / league table** |
| 3. **Wheelchair basketball** (IWBF) | 3. **Single elimination** |

**Formats.**

- **Pools → knockout** is the FIBA 3x3 event structure [U23] and a usual 5v5 tournament structure.
- **Round robin** is the base case of FIBA Appendix D.
- **Single elimination** is the simplest knockout. It is common for short community events (COMMON PRACTICE), and every modality can select it.

All three formats are compatible with all three modalities (§16).

### 12.3 Team, roster, lineup, match and result

| Concept | 5v5 | 3x3 | Wheelchair |
|---|---|---|---|
| **Team** (entrant) | `EVENT_SQUAD` or `PERSISTENT` | `EVENT_SQUAD` (4) | `EVENT_SQUAD` or `PERSISTENT` |
| **Roster** (frozen at lock) | ≤ 12 entitled to play [OBR] | 4 | ≤ 12 [IWBF-R] |
| **Lineup** (declared per match) | the ≤ 12 dressed players | the 4 | the ≤ 12 dressed players |
| **On court** (rule data, never stored) | 5 (minimum 2 to continue) | 3 | 5, Σ classification ≤ 14.0 [IWBF-C] |
| **Substitution** | rolling | rolling | rolling |
| **Entry attributes** | — | ranking points per member (declared; for seeding) | classification points per member (declared) |
| **Match** | MATCH, `TIMED_PERIODS` (4×10, OT 5) | MATCH, `TIMED_OR_TARGET` | MATCH, `TIMED_PERIODS` (4×10, extra periods) |
| **Result** | WIN/LOSS, points; forfeit vs default distinguished | WIN/LOSS, points (counted to at most 21 for standings) | WIN/LOSS, points |

**Scheduling.**

- 5v5 and wheelchair basketball need a **full court**.
- 3x3 needs a **half court** (one basket). One full court can host two 3x3 courts as overlapping resources (§28).
- A 3x3 game is about 10 minutes of play, so slots are dense (≈ 20-minute slots = COMMON PRACTICE).

---

## 13. Golf

**Sources:**

- **[RoG3]** R&A/USGA Rules of Golf, Rule 3: https://www.randa.org/rog/the-rules-of-golf/rule-3
- **[RoG21]** Rule 21: https://www.randa.org/rog/the-rules-of-golf/rule-21
- **[CP5]** Committee Procedures §5: https://www.randa.org/rog/committee-procedures/5
- **[CP6]** Committee Procedures §6: https://www.randa.org/rog/committee-procedures/6
- **[WHS-C]** World Handicap System Appendix C: https://www.randa.org/roh/appendices/appendix-c
- WHS allowance table **[S]**: https://www.nationalclubgolfer.com/whs/world-handicap-system-handicap-allowances/
- PGA Tour cut **[S]**: https://thegolfnewsnet.com/ryan_ballengee/2026/04/10/what-is-pga-tour-cut-rule-2025-how-cut-line-determined-102941/
- USGA pages returned HTTP 403.

### 13.1 Rules relevant to the engine

**Forms of play [RoG3].**

- **Match play:** won when a side leads by more holes than remain; a tie is extended hole by hole.
- **Stroke play:** fewest total strokes over all rounds wins.
- Either form can be individual or with partners, gross or net.

**Scorecard [RoG3].**

- The **marker certifies hole scores**; the player checks them.
- Returning a hole score lower than actual = **DQ**.
- **The Committee adds up totals and applies handicap** (3.3b(4)). The platform therefore stores **hole scores**, and totals are **computed**.

**Other forms [RoG21].**

- **Stableford:** 0/1/2/3/4/5/6 points for double bogey or worse / bogey / par / birdie / eagle / albatross / condor, measured against a fixed target. **Highest total wins.**
- Maximum Score: per-hole cap.
- Par/Bogey: holes won or lost against a target.
- Rule 22: foursomes (alternate shot). Rule 23: four-ball (better ball).

**Scramble:** **not in the Rules of Golf → COMMON PRACTICE.** WHS does give scramble allowances [S].

**Cut and ties [CP5].**

- The terms of competition must state the cut, when it applies, how ties at the cut are handled, and how many continue.
- **Ties in stroke play:** a play-off, **or matching scorecards**:
  1. last 9 → last 6 → last 3 → 18th hole;
  2. then the first nine's last 6 / last 3 / last hole.
- Net count-back deducts 1/18 of the handicap per hole.

**PGA Tour cut [S]:** after 36 holes, **top 65 and ties**. Signature events use top 50 and ties plus anyone within 10 shots of the lead.

**Match play from qualifying.**

- The match-play draw can be **seeded**, avoiding byes through the draw size [CP5 5G(1)].
- Stroke-play qualifying ties are broken by random draw, count-back or play-off [CP6 6G(4)].

**Tee times [CP5 5G(2); CP6 6G(1)].**

- The Committee sets the starting times and groups of 2–4.
- Two-tee starts (holes 1 and 10) are allowed. In later rounds, groups can be arranged by score.
- **Shotgun start** (all groups start at once on different holes): **COMMON PRACTICE**.

**Handicap allowances [WHS-C; S].**

| Format | Allowance |
|---|---|
| Individual stroke play | 95% |
| Individual match play | 100% |
| Four-ball stroke play | 85% |
| Four-ball match play | 90% |
| Foursomes | 50% of the combined handicap |
| Scramble | 25/20/15/10% (4-person) [S] |

Net = gross − playing handicap.

### 13.2 Selection

| Modalities | Formats |
|---|---|
| 1. **Individual stroke play** (gross and net flights) | 1. **Multi-round stroke-play leaderboard** (optional cut; count-back) |
| 2. **Four-ball** (better ball, pairs) | 2. **Stableford** (points leaderboard; net) |
| 3. **Scramble** (teams of 2–4) **— COMMON PRACTICE** | 3. **Match-play bracket** (seeded from stroke-play qualifying) |

**Modalities.**

- **Individual stroke play** is the canonical Rules of Golf competition (Rule 3.3).
- **Four-ball** is the codified partner form (Rule 23).
- **Scramble** is **not** a Rules of Golf form of play. It is labelled **COMMON PRACTICE** wherever it appears. It is retained, per review, because it is highly relevant to OnChainFest's amateur and corporate events. This is a product judgement, not a sourced statistic.
  - Its handicap allowances come from WHS tables verified only via a secondary source [S].
- **Match play** is a *format*, not a modality, because it applies to individuals and to four-ball pairs.

**Formats.**

- The **multi-round leaderboard** is the golf test case (proof case E).
- **Stableford** is a Rules of Golf form (Rule 21.1) suited to net amateur fields.
- The **match-play bracket** shows a qualifying → knockout composition across paradigms (CP5 5G, CP6 6G(4)).

### 13.3 Engine requirements

Golf must **not** be modelled as a bracket (except format 3). The chain is:

```
entrant (athlete | pair | scramble team) → round r: SERIES contest per entrant (or per team)
  → hole scores (Performance per hole, ordinal 1..18) → scorecard certified (marker attestation)
  → round total (computed) → cumulative total over rounds → leaderboard (classification)
  → CUT after round k (top N and ties | within X of lead) → field of round k+1 → final classification
  → ties: play-off contest (organizer decision) or count-back chain (data)
```

- **Many entrants compete simultaneously** with no head-to-head. The **tee group is a logistic partition**: a group of 3 is not a "match".
- **Ruleset-specific scoring:** stroke (sum, low), Stableford (points per hole vs par + strokes received, high), match play (holes won). All are computed from **the same hole scores** with **par and stroke index per hole** (course data on the resource; §28).
- **Handicap:** an entry attribute (handicap index) → course handicap (course data) → playing handicap (allowance from the format/ruleset). The platform **does not compute WHS indexes**; it records the declared index and its source.
- **The cut is a transition** with **ties included**. The next round's field therefore has an **unknown size until the cut resolves**, which is a key engine requirement (§26).

---

## 14. Three Modalities per Sport

**MODALITY = what is played and by whom.** A modality is a Discipline plus a Category (plus distance/stroke parameters where the discipline is parameterised). It fixes the **entrant structure**.

| Sport | Modality 1 | Modality 2 | Modality 3 | Discipline mapping (proposed codes; operator approval needed) |
|---|---|---|---|---|
| Tennis | Singles | Doubles | Mixed doubles | `tennis.singles` · `tennis.doubles` · `tennis.doubles` + MIXED |
| Padel | Men's doubles | Women's doubles | Mixed doubles | `padel.doubles` + MEN · + WOMEN · + MIXED |
| Running / Marathon | Road race | Track race | Relay | `running.road` · `running.track` · `running.relay` |
| Swimming | Individual pool event | Relay | Open water | `swimming.pool` · `swimming.relay` · `swimming.open_water` |
| Cycling | Road race / Gran Fondo | Individual time trial | MTB cross-country | `cycling.road` · `cycling.itt` · `cycling.mtb_xc` |
| Bowling | Singles | Doubles | Team | `bowling.tenpin.singles` · `.doubles` · `.team` |
| Basketball | 5v5 | 3x3 | Wheelchair basketball | `basketball.5x5` · `basketball.3x3` · `basketball.wheelchair` |
| Golf | Individual stroke play | Four-ball | Scramble *(COMMON PRACTICE)* | `golf.individual` · `golf.fourball` · `golf.scramble` |

**Discipline rule.**

- **Separate Discipline** when the entrant structure, result schema or comparator differs.
- **Category** when only eligibility differs: MEN/WOMEN/MIXED, age band, skill class.
- **Parameter** when only distance or stroke differs (5K vs marathon, 100 m free vs 200 m back).

This keeps the catalog from exploding into one discipline per distance (open question §37).

---

## 15. Three Formats per Sport

**FORMAT = how the competition is organized**: a stage graph of stage engines and transitions. The same format template is reused across sports and modalities wherever capabilities allow (§18.4).

| Sport | Format 1 | Format 2 | Format 3 |
|---|---|---|---|
| Tennis | Single elimination | Round robin | Round robin → knockout |
| Padel | Single elimination (opt. qualifying) | Groups → knockout | Round robin |
| Running / Marathon | Mass-start timed race | Wave-start timed race | Heats → final |
| Swimming | Timed finals | Heats → final | Open-water mass start |
| Cycling | Mass-start race | Interval-start time trial | Multi-stage cumulative (GC) |
| Bowling | Aggregate pinfall | Qualifying → stepladder | Round-robin match play |
| Basketball | Pool play → knockout | Round robin / league | Single elimination |
| Golf | Multi-round stroke-play leaderboard (+ cut) | Stableford | Match-play bracket (from qualifying) |

**Format templates are sport-neutral.**

- "Single elimination" for tennis and for basketball is the same `KNOCKOUT` template, with different draw-policy data.
- "Groups → knockout" (padel) and "Pool play → knockout" (basketball) are the same `ROUND_ROBIN → KNOCKOUT` graph.
- "Mass-start timed race" (running) and "mass-start race" (cycling) are the same `FIELD` graph with a different Ruleset.

---

## 16. Compatibility Matrix

### 16.1 Summary matrix

| Sport | Modality 1 | Modality 2 | Modality 3 | Format 1 | Format 2 | Format 3 |
|---|---|---|---|---|---|---|
| Tennis | Singles | Doubles | Mixed doubles | Single elimination | Round robin | RR → knockout |
| Padel | Men's doubles | Women's doubles | Mixed doubles | Single elimination | Groups → knockout | Round robin |
| Running / Marathon | Road race | Track race | Relay | Mass start | Wave start | Heats → final |
| Swimming | Individual pool | Relay | Open water | Timed finals | Heats → final | Open-water mass start |
| Cycling | Road / Gran Fondo | Individual TT | MTB XC | Mass start | Interval TT | Multi-stage GC |
| Bowling | Singles | Doubles | Team | Aggregate pinfall | Qualifying → stepladder | RR match play |
| Basketball | 5v5 | 3x3 | Wheelchair | Pool → knockout | Round robin | Single elimination |
| Golf | Individual stroke | Four-ball | Scramble *(CP)* | Multi-round leaderboard | Stableford | Match-play bracket |

### 16.2 Compatibility rule

A modality × format combination is **compatible** when two conditions hold:

1. The format's stage engines and transitions **require** only capabilities that the modality's DisciplineVersion **provides** (§18.4).
2. Its Ruleset family is allowed by the DisciplineVersion.

A ✘ cell means the capabilities do not match, or that no governing or common-practice basis was found. It is **never** a sport-name check. A modality selects any ✓ format; nothing binds a modality to one format.

### 16.3 Capability matrix (all 72 combinations)

**Legend**

| Column | Values |
|---|---|
| **Entrant** | `IND` = INDIVIDUAL Athlete · `PAIR` = TEAM / `EVENT_PAIR` · `TEAM` = TEAM / `EVENT_SQUAD` or `PERSISTENT` |
| **Roster** | athletes frozen at field lock (TEAM/PAIR only) |
| **Lineup** | `—` implicit single athlete · `both` both members, unordered · `ord(n)` n ordered legs or positions · `≤12 dressed` declared match squad (on-court count is rule data) · `all` |
| **Scoring** (Ruleset family) | `SOG` SETS_OF_GAMES · `TP` TIMED_PERIODS · `TOT` TIMED_OR_TARGET · `ET` ELAPSED_TIME · `FOT` FINISH_ORDER_WITH_TIME · `LAT` LAPS_AND_TIME · `FP` FRAMES_PINFALL · `STK` STROKES · `STB` STABLEFORD · `MPH` MATCH_PLAY_HOLES |
| **Classif.** | `STD` standings (match points + criteria) · `BRK` bracket placing · `MET` metric order in one contest/stage · `MET-Σ` metric aggregated over rounds |
| **Engines** | stage engines in order: `KO`, `RR`, `FIELD`, `HEATS` |
| **Advance** | `W/L` winner/loser of · `RFG` rank from group (fixed crossover) · `QPT` qualify by place and time · `CUT` · `STEP` stepladder · `QUAL` qualifying rank → seeded KO · `DNF-out` multi-round elimination of non-finishers · `—` none |
| **Seeding inputs** | `EXT` declared external ranking · `EXT-pair` combined pair ranking (declared) · `EXT-3` sum of best-3 members (declared) · `RAND` deterministic draw · `ENTRY-T` entry time · `PRED-T` declared predicted time · `AVG` declared average · `HCP` declared handicap index · `QUAL` previous-stage result · `OBJ` organizer objective order · `CAT` category |
| **Entry attrs** | per-participant declared values (P-3), e.g. `bib`, `ageBand`, `teamAffil`, `entryTime`, `rankPts`, `avg`, `hcpIdx`, `classPts`, `gender` (composition only) |
| **Partition** | `LOG` logistic (ranked together) · `COMP` competitive (ranked within; qualification) · `—` none |

`CP` = COMMON PRACTICE.

#### Tennis

| Modality | Format | OK | Entrant | Roster | Lineup | Scoring | Classif. | Engines | Advance | Resources | Seeding inputs | Entry attrs | Partition |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Singles | Single elimination | ✓ | IND | — | — | SOG | BRK | KO | W/L | tennis court | EXT, RAND | rankPts | — |
| Singles | Round robin | ✓ | IND | — | — | SOG | STD (`itf_rr`) | RR | — | tennis court | EXT, RAND | rankPts | — |
| Singles | RR → knockout | ✓ | IND | — | — | SOG (per stage) | STD → BRK | RR, KO | RFG, W/L | tennis court | EXT, RAND | rankPts | COMP (groups) |
| Doubles | Single elimination | ✓ | PAIR | 2 | both | SOG (No-Ad option) | BRK | KO | W/L | tennis court | EXT-pair, RAND | rankPts (pair) | — |
| Doubles | Round robin | ✓ | PAIR | 2 | both | SOG | STD (`itf_rr`) | RR | — | tennis court | EXT-pair, RAND | rankPts (pair) | — |
| Doubles | RR → knockout | ✓ | PAIR | 2 | both | SOG | STD → BRK | RR, KO | RFG, W/L | tennis court | EXT-pair | rankPts (pair) | COMP |
| Mixed doubles | Single elimination | ✓ | PAIR | 2 (1 M + 1 W, declared) | both | SOG + mixed deciding-point receiver | BRK | KO | W/L | tennis court | EXT-pair, RAND | rankPts, gender | — |
| Mixed doubles | Round robin | ✓ | PAIR | 2 (declared) | both | SOG + mixed rule | STD | RR | — | tennis court | EXT-pair, RAND | rankPts, gender | — |
| Mixed doubles | RR → knockout | ✓ | PAIR | 2 (declared) | both | SOG + mixed rule | STD → BRK | RR, KO | RFG, W/L | tennis court | EXT-pair | rankPts, gender | COMP |

#### Padel

| Modality | Format | OK | Entrant | Roster | Lineup | Scoring | Classif. | Engines | Advance | Resources | Seeding inputs | Entry attrs | Partition |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Men's doubles | Single elimination | ✓ | PAIR | 2 | both | SOG + deuce mode | BRK | KO (+ opt. qualifying KO) | W/L (qualifiers → main lines) | padel court | EXT-pair, RAND | rankPts (pair) | — |
| Men's doubles | Groups → knockout | ✓ | PAIR | 2 | both | SOG + deuce mode | STD (`fip_groups`) → BRK | RR, KO | RFG, W/L | padel court | EXT-pair | rankPts (pair) | COMP |
| Men's doubles | Round robin | ✓ | PAIR | 2 | both | SOG + deuce mode | STD (`fip_groups`) | RR | — | padel court | EXT-pair, RAND | rankPts (pair) | — |
| Women's doubles | Single elimination | ✓ | PAIR | 2 | both | SOG + deuce mode | BRK | KO | W/L | padel court | EXT-pair, RAND | rankPts (pair) | — |
| Women's doubles | Groups → knockout | ✓ | PAIR | 2 | both | SOG + deuce mode | STD → BRK | RR, KO | RFG, W/L | padel court | EXT-pair | rankPts (pair) | COMP |
| Women's doubles | Round robin | ✓ | PAIR | 2 | both | SOG + deuce mode | STD | RR | — | padel court | EXT-pair, RAND | rankPts (pair) | — |
| Mixed doubles | Single elimination | ✓ | PAIR | 2 (declared) | both | SOG + deuce mode + mixed receiver | BRK | KO | W/L | padel court | EXT-pair, RAND | rankPts, gender | — |
| Mixed doubles | Groups → knockout | ✓ | PAIR | 2 (declared) | both | SOG + mixed receiver | STD → BRK | RR, KO | RFG, W/L | padel court | EXT-pair | rankPts, gender | COMP |
| Mixed doubles | Round robin | ✓ | PAIR | 2 (declared) | both | SOG + mixed receiver | STD | RR | — | padel court | EXT-pair, RAND | rankPts, gender | — |

#### Running / Marathon

| Modality | Format | OK | Entrant | Roster | Lineup | Scoring | Classif. | Engines | Advance | Resources | Seeding inputs | Entry attrs | Partition |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Road race | Mass start | ✓ | IND | — | — | ET (gun official; net info; road rounding) | MET + category subsets (+ opt. team-derived) | FIELD | — | road course | CAT (none needed) | bib, ageBand, teamAffil (opt.) | — (one start) |
| Road race | Wave start | ✓ | IND | — | — | ET (own wave gun) | MET across waves + subsets | FIELD | — | road course + wave start windows (capacity) | PRED-T or CAT (wave assignment) | bib, ageBand, predTime | LOG (waves; CP) |
| Road race | Heats → final | ✘ | — | — | — | — | — | — | — | — | — | — | Road racing has no heats |
| Track race | Mass start | ✓ | IND | — | — | ET (0.01 s FAT) | MET | FIELD | — | track | OBJ/RAND (start positions) | bib, seasonBest (opt.) | — (single-section race) |
| Track race | Wave start | ✘ | — | — | — | — | — | — | — | — | — | — | No basis for track waves; sections are heats |
| Track race | Heats → final | ✓ | IND | — | — | ET (0.01 s) | MET (place in heat; time across heats) | HEATS → FIELD | QPT (Q/q; lanes by rank band) | track × lanes | ENTRY-T (best performance), zigzag | bib, entryTime | COMP |
| Relay | Mass start | ✓ | TEAM | 4–6 [WA TR 24] | ord(4) legs (mixed pattern) | ET (team) | MET | FIELD | — | road course (relay zones) | CAT | bib, teamName | — |
| Relay | Wave start | ✓ *(CP)* | TEAM | 4–6 | ord(4) | ET (own wave gun) | MET across waves | FIELD | — | road course + waves | PRED-T, CAT | bib, predTime | LOG |
| Relay | Heats → final | ✓ | TEAM | 4–6 | ord(4); may change between rounds | ET (0.01 s) | MET | HEATS → FIELD | QPT | track × lanes | ENTRY-T (team) | entryTime | COMP |

#### Swimming

| Modality | Format | OK | Entrant | Roster | Lineup | Scoring | Classif. | Engines | Advance | Resources | Seeding inputs | Entry attrs | Partition |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Individual pool | Timed finals | ✓ | IND | — | — | ET (0.01 s; manual truncated; ties equal) | MET across heats | FIELD | — | pool (lanes) × session | ENTRY-T (circle seeding; lane table) | entryTime, ageBand | LOG |
| Individual pool | Heats → final | ✓ | IND | — | — | ET | MET (time across heats) | HEATS → FIELD (+ opt. semis HEATS) | QPT (q = 8 by time; swim-off by decision) | pool × lanes | ENTRY-T; final re-laned by heat time | entryTime | COMP (by time) |
| Individual pool | Open-water mass start | ✘ | — | — | — | — | — | — | — | — | — | — | Pool modality; open water is modality 3 |
| Relay | Timed finals | ✓ | TEAM | 4–n [WAq 10.4] | ord(4) (+ stroke per leg, medley; 2M+2W mixed, declared) | ET (team) | MET across heats | FIELD | — | pool × lanes | ENTRY-T (team) | entryTime (team) | LOG |
| Relay | Heats → final | ✓ | TEAM | 4–n | ord(4); may change between heats and final | ET | MET | HEATS → FIELD | QPT (by time) | pool × lanes | ENTRY-T (team) | entryTime (team) | COMP |
| Relay | Open-water mass start | ✘ | — | — | — | — | — | — | — | — | — | — | Open-water relays: future (§35) |
| Open water | Timed finals | ✘ | — | — | — | — | — | — | — | — | — | — | Not a pool structure |
| Open water | Heats → final | ✘ | — | — | — | — | — | — | — | — | — | — | Knockout sprint: future (§35) |
| Open water | Open-water mass start | ✓ | IND | — | — | ET (transponder; referee decides places) | MET (+ age subsets) | FIELD | — | open-water course | RAND (start positions drawn) | bib/cap, ageBand | — or LOG (age-group waves) |

#### Cycling

| Modality | Format | OK | Entrant | Roster | Lineup | Scoring | Classif. | Engines | Advance | Resources | Seeding inputs | Entry attrs | Partition |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Road / Gran Fondo | Mass start | ✓ | IND | — | — | FOT (same-time bunches; 1 s down; gun or net) | MET (place) + age subsets (+ opt. team best-3) | FIELD | — | road course | CAT | bib, ageBand, teamAffil | LOG (category starts; CP) |
| Road / Gran Fondo | Interval TT | ✘ | — | — | — | — | — | — | — | — | — | — | That is modality 2 |
| Road / Gran Fondo | Multi-stage GC | ✓ | IND | — | — | FOT per stage + adjustments (bonuses, 3-km) | MET-Σ (GC) + parallel classifications | FIELD × k rounds | DNF-out | road course per stage | CAT | bib, ageBand, teamAffil | LOG |
| Individual TT | Mass start | ✘ | — | — | — | — | — | — | — | — | — | — | Contradiction (TT = interval start) |
| Individual TT | Interval TT | ✓ | IND | — | — | ET (0.1 s) | MET | FIELD | — | TT course × start slots | OBJ (organizer criteria [UCI 2.4.006]) | bib, ageBand | LOG (start slots) |
| Individual TT | Multi-stage GC | ✓ | IND | — | — | ET per stage | MET-Σ | FIELD × k | DNF-out | course per stage | OBJ | bib, ageBand | LOG |
| MTB XC | Mass start | ✓ | IND | — | — | LAT (laps DESC, time ASC; pulled −n laps [S]) | MET | FIELD | — | MTB circuit | EXT (grid by ranking [S]), CAT | bib, ageBand, rankPts | LOG (category grids) |
| MTB XC | Interval TT | ✘ | — | — | — | — | — | — | — | — | — | — | No basis found |
| MTB XC | Multi-stage GC | ✓ *(CP)* | IND | — | — | LAT / ET per stage | MET-Σ | FIELD × k | DNF-out | MTB course per stage | CAT | bib, ageBand | LOG |

#### Bowling

| Modality | Format | OK | Entrant | Roster | Lineup | Scoring | Classif. | Engines | Advance | Resources | Seeding inputs | Entry attrs | Partition |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Singles | Aggregate pinfall | ✓ | IND | — | — | FP (+ handicap) | MET-Σ (pins; scratch or handicap) | FIELD (N games) | — (or CUT to finals) | lane pairs × squad | RAND / AVG (lane assignment) | avg (+source), hcp | LOG (squads, lane pairs) |
| Singles | Qualifying → stepladder | ✓ *(stepladder CP)* | IND | — | — | FP | MET-Σ → BRK | FIELD → KO (stepladder) | CUT (top K; roll-off by decision), STEP | lane pairs | QUAL | avg, hcp | LOG (qualifying) |
| Singles | RR match play | ✓ | IND | — | — | FP (game = match) | STD (3/1/0 or pins + bonus) | RR (→ KO semis) | RFG, W/L | lane pair per game | QUAL / RAND | avg | COMP (subgroups) |
| Doubles | Aggregate pinfall | ✓ | PAIR | 2 | both (ord(2) if Baker) | FP | MET-Σ | FIELD | — / CUT | lane pairs × squad | RAND / AVG | avg (each), hcp | LOG |
| Doubles | Qualifying → stepladder | ✓ *(CP)* | PAIR | 2 | both | FP | MET-Σ → BRK | FIELD → KO | CUT, STEP | lane pairs | QUAL | avg, hcp | LOG |
| Doubles | RR match play | ✓ | PAIR | 2 | ord(2) Baker [IBF23] | FP (Baker) | STD | RR (→ KO) | RFG, W/L | lane pair | QUAL / RAND | avg | COMP |
| Team | Aggregate pinfall | ✓ | TEAM | n + reserves | ord(n) | FP | MET-Σ | FIELD | — / CUT | lane pairs × squad | RAND / AVG | avg (each), hcp | LOG |
| Team | Qualifying → stepladder | ✓ *(CP)* | TEAM | n + reserves | ord(n); changes between games | FP | MET-Σ → BRK | FIELD → KO | CUT, STEP | lane pairs | QUAL | avg | LOG |
| Team | RR match play | ✓ | TEAM | n + reserves | ord(n) Baker frame order | FP (Baker) | STD | RR (→ KO) | RFG, W/L | lane pair | QUAL / RAND | avg | COMP |

#### Basketball

| Modality | Format | OK | Entrant | Roster | Lineup | Scoring | Classif. | Engines | Advance | Resources | Seeding inputs | Entry attrs | Partition |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5v5 | Pool → knockout | ✓ | TEAM | ≤ 12 match-eligible | ≤12 dressed (5 on court) | TP (4×10, OT 5; forfeit / default) | STD (`fiba_5x5`) → BRK | RR, KO | RFG (+ best-ranked across groups), W/L | full court | EXT, RAND | — | COMP |
| 5v5 | Round robin | ✓ | TEAM | ≤ 12 | ≤12 dressed | TP | STD (`fiba_5x5`) | RR | — | full court | RAND | — | — |
| 5v5 | Single elimination | ✓ *(CP)* | TEAM | ≤ 12 | ≤12 dressed | TP | BRK | KO | W/L | full court | EXT, RAND | — | — |
| 3x3 | Pool → knockout | ✓ | TEAM | 4 | 4 (3 on court) | TOT (10 min or 21; OT +2) | STD (`fiba_3x3`) → BRK | RR, KO | RFG, W/L | **half court** | EXT-3 (declared) | rankPts (each member) | COMP |
| 3x3 | Round robin | ✓ | TEAM | 4 | 4 | TOT | STD (`fiba_3x3`) | RR | — | half court | EXT-3, RAND | rankPts | — |
| 3x3 | Single elimination | ✓ *(CP)* | TEAM | 4 | 4 | TOT | BRK | KO | W/L | half court | EXT-3, RAND | rankPts | — |
| Wheelchair | Pool → knockout | ✓ | TEAM | ≤ 12 [IWBF-R] | ≤12 dressed (5 on court, Σ class ≤ 14.0; recorded, not validated) | TP (4×10, extra periods) | STD (FIBA-style template; IWBF classification rules UNVERIFIED) → BRK | RR, KO | RFG, W/L | full court | RAND, EXT | classPts (each; declared) | COMP |
| Wheelchair | Round robin | ✓ | TEAM | ≤ 12 | ≤12 dressed | TP | STD | RR | — | full court | RAND | classPts | — |
| Wheelchair | Single elimination | ✓ *(CP)* | TEAM | ≤ 12 | ≤12 dressed | TP | BRK | KO | W/L | full court | RAND, EXT | classPts | — |

#### Golf

| Modality | Format | OK | Entrant | Roster | Lineup | Scoring | Classif. | Engines | Advance | Resources | Seeding inputs | Entry attrs | Partition |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Individual stroke | Multi-round leaderboard | ✓ | IND | — | — | STK (hole scores; gross / net 95%) | MET-Σ (strokes ASC; count-back) | FIELD × k rounds | CUT (top N **and ties** / within X) | golf course × tee times (starting tee, group 2–4) | HCP / RAND (tee draw); later rounds by score | hcpIdx (+source) | LOG (tee groups) |
| Individual stroke | Stableford | ✓ | IND | — | — | STB (net; 95%) | MET-Σ (points DESC) | FIELD (× k) | opt. CUT | course × tee times | HCP / RAND | hcpIdx | LOG |
| Individual stroke | Match-play bracket | ✓ | IND | — | — | STK (qualifying) → MPH (100%) | MET-Σ → BRK | FIELD → KO | QUAL, W/L | course × tee times | QUAL (stroke-play qualifying) | hcpIdx | LOG (qualifying) |
| Four-ball | Multi-round leaderboard | ✓ | PAIR | 2 | both | STK better ball (85% [S]) | MET-Σ | FIELD × k | CUT | course × tee times | HCP (pair) / RAND | hcpIdx (each) | LOG |
| Four-ball | Stableford | ✓ *(better-ball Stableford: CP)* | PAIR | 2 | both | STB better ball | MET-Σ | FIELD | opt. CUT | course × tee times | HCP / RAND | hcpIdx | LOG |
| Four-ball | Match-play bracket | ✓ | PAIR | 2 | both | MPH (Rule 23; 90% [S]) | BRK | FIELD (opt. qualifying) → KO | QUAL, W/L | course × tee times | QUAL / EXT | hcpIdx | LOG |
| Scramble *(CP)* | Multi-round leaderboard | ✓ *(CP)* | TEAM | 2–4 | all | STK team ball (scramble allowance [S]) | MET-Σ | FIELD (× k; usually 1) | opt. CUT | course × tee times / shotgun (CP) | HCP (team) / RAND | hcpIdx (each) | LOG |
| Scramble *(CP)* | Stableford | ✘ (v1) | — | — | — | — | — | — | — | — | — | — | No source found; not supported in v1 |
| Scramble *(CP)* | Match-play bracket | ✘ (v1) | — | — | — | — | — | — | — | — | — | — | No source found; not supported in v1 |

**Totals:** 72 combinations. **61 compatible** (✓) and **11 not supported** (✘): running 2, swimming 4, cycling 3, golf 2.

**Logistic vs competitive partitions, as the matrix uses them:**

| Partition | Kind |
|---|---|
| Running waves | LOG |
| Swimming timed-final heats | LOG |
| Swimming championship heats | COMP |
| Track heats | COMP |
| Padel and tennis groups | COMP |
| Basketball pools | COMP |
| Bowling squads and lane pairs | LOG |
| Bowling match-play subgroups | COMP |
| Golf tee groups | LOG |
| Cycling start slots and category starts | LOG |

---

## 17. Entrant Model

### 17.1 Layers (all except the roster snapshot and entry attributes exist today)

```
Person  (identity; PII isolated — never seen by the engine)
  └─controls→ Athlete  (sporting identity; Passport)
Athlete ─TeamMembership (temporal)→ Team  (competition-side identity; kind PERSISTENT | EVENT_PAIR | EVENT_SQUAD)
Registration  (request; entrant = athlete XOR team)                                   ← exists (ONCF-04 individual flow)
  └─field lock→ Participant  = ENTRANT  (event-scoped; INDIVIDUAL | TEAM)            ← exists
        ├─ entry attributes  {entryTime, average, handicapIndex, rankingPoints, bib, startGroup…}   ← NEW (§25)
        ├─ roster snapshot   (TEAM only; ACTIVE members at lock)                       ← NEW (§29)
        └─ per contest: Contestant (slot / lane / start position) + declared Lineup (ordered)   ← exists (order is NEW)
```

### 17.2 Entrant by modality (no new registration domain)

| Modality | Entrant | Participant kind | Team kind | Roster | Lineup per contest |
|---|---|---|---|---|---|
| Tennis singles; bowling singles; golf individual; running road/track; swimming individual; swimming open water; cycling all | Athlete | INDIVIDUAL | — | — | the athlete (implicit) |
| Tennis doubles/mixed; padel doubles; golf four-ball; bowling doubles | **Pair** | TEAM | `EVENT_PAIR` | exactly 2 | both (bowling doubles: both, in bowling order) |
| Running relay; swimming relay | **Relay team** | TEAM | `EVENT_SQUAD` | 4 + up to 2 reserves (WA) | **4 ordered legs** (+ stroke per leg in medley) |
| Bowling team (trios / 4–5) | **Team** | TEAM | `EVENT_SQUAD` / `PERSISTENT` | ≥ size, + reserves | N bowlers; **frame order** in Baker |
| Golf scramble *(COMMON PRACTICE)* | **Team** | TEAM | `EVENT_SQUAD` | 2–4 | all members |
| Basketball 5v5 / 3x3 / wheelchair | **Team** | TEAM | `EVENT_SQUAD` / `PERSISTENT` | 5v5 and wheelchair ≤ 12; 3x3 = 4 | dressed players (wheelchair: declared classification points per member) |

- **Pair vs team.** A pair's identity **is** its two members, so changing a partner means a **new entrant**. FIP rules support this: replacement is by another pair [CT]. A squad keeps its identity across roster changes.
- **The engine never asks "is this a pair?".** It reads `roster`, `lineup` and `substitution` parameters (§29).
- **Team classifications derived from individuals** are **parallel classifications** over INDIVIDUAL participants, grouped by a declared team label. They are **not** TEAM entrants. Examples:
  - cross-country: sum of 4 places;
  - cycling: sum of the 3 best times;
  - bowling all-events.

  This avoids registering each runner twice. A team-affiliation **entry attribute** is new.

---

## 18. Competition Model

### 18.1 What an Event pins (five independent axes)

```
Event
 ├─ DisciplineVersion   WHAT is played, BY WHOM: entrant structure, roster/lineup, result schema, metrics,
 │                      allowed contest types, allowed ruleset families, required resource types        (exists; extended)
 ├─ Ruleset (Scoring)   HOW one contest is decided or measured: family + parameters (+ handicap allowance)  (NEW axis; §22)
 ├─ FormatVersion       HOW the event is structured: stage graph (stages, engines, transitions, draw/heat policy) (exists; extended)
 ├─ Classification/Standings policy (per stage and event)  HOW entrants are ordered                     (exists as ClassificationPolicy; extended §23–24)
 └─ SchedulingProfile   WHEN/WHERE: durations, intervals, rest rules, resource requirements               (NEW, operational; §27)
```

### 18.2 Stage graph (extends FormatVersion)

```
FormatVersion.configuration = {
  stages: [{
    key, engine: KNOCKOUT | ROUND_ROBIN | FIELD | HEATS, engineVersion,
    rounds: integer (FIELD multi-round; e.g. golf 4, bowling 1 block of 6 games, stage race n),
    partition?: { purpose: LOGISTIC | COMPETITIVE, method: …, size }   // FIELD: logistic; HEATS: competitive
    drawPolicy? (KO/RR) | heatPolicy? (HEATS/FIELD)
    rulesetRef?  (per-stage override, e.g. RR 2 sets + MTB; KO best of 3)
    classificationPolicyRef
  }],
  transitions: [{ from, to, kind: WINNER_OF | LOSER_OF | RANK_FROM_GROUP | BEST_RANKED_ACROSS_GROUPS
                                 | QUALIFY_BY_PLACE_AND_TIME | CUT | STEPLADDER, params }]
}
```

- **Existing `single-elimination/1` and `round-robin/1` remain valid** one-stage graphs. They are never rewritten (ADR-0024).
- **One immutable plan per event still holds.** Later-stage contests exist in the plan with **dependent** entry. In `FIELD` stages after a cut the entry is **dynamic**: `ENTRY_FROM_TRANSITION(t)` with an unknown count. Resolution is advancement (§26), never a re-plan.

### 18.3 Primitive inventory (what is actually needed)

Of the modules suggested by the ticket, only these are needed as **separate abstractions**:

| Needed module | Kind | Notes |
|---|---|---|
| **Stage engines** (`KNOCKOUT`, `ROUND_ROBIN`, `FIELD`, `HEATS`) | Pure, versioned (ADR-0024) | Replaces the "DrawEngine/HeatEngine" split; draw and heat policies are their parameters |
| **SeedingEngine** | Pure | Produces the ordered list plus seed values |
| **RulesetEngine** (scoring) | Pure validator/normalizer per family | Validates a score sheet → normalized contest result |
| **ClassificationEngine** | Pure (exists, `classification-engine/1`) | Standings and metric classification are **one engine** with two policy families |
| **AdvancementEngine** | Pure | Results + classifications → slot or field resolutions |
| **SchedulingEngine** | Pure proposal | Operational; the organizer accepts |
| **Timing** | **Not an engine**: a ruleset family (`ELAPSED_TIME`) + ingestion adapter | Timing systems are evidence sources (ADR-0017) |

**Not needed as separate modules:**

- **StandingsEngine:** a classification policy.
- **HeatEngine:** a stage engine.
- **RosterEngine / LineupEngine:** validation inside the existing competition store.
- **ResultEngine:** the Result ledger exists.
- **ResourceEngine:** data plus scheduler input.
- **CompetitionDefinition / SportDefinition / DisciplineDefinition:** the existing catalog.

### 18.4 Capability-driven compatibility (no sport branching)

**Today.** `compatibleFormatVersionIds` already applies a capability rule: a format's contest type must be allowed by the discipline (ONCF-03A). The design generalizes that rule; it does not add a new mechanism.

**What each side declares.** A DisciplineVersion **provides** capabilities, and a FormatVersion (stage graph) and a Ruleset **require** them:

```
provides (DisciplineVersion @2, data):
  contestTypes        MATCH | HEAT | SERIES | SESSION | …
  outcomeModel        WIN_LOSS_DRAW | RANKED
  entrantStructure    INDIVIDUAL | PAIR | SQUAD (+ roster/lineup ranges, ordered legs)
  rulesetFamilies     e.g. [SETS_OF_GAMES] | [ELAPSED_TIME] | [STROKES, STABLEFORD, MATCH_PLAY_HOLES]
  partitionKinds      LOGISTIC | COMPETITIVE
  resourceTypes       e.g. [PADEL_COURT] | [POOL] | [GOLF_COURSE]
  entryAttributes     declared keys + types (entryTime: DURATION, avg: INTEGER, hcpIdx: DECIMAL, classPts: DECIMAL …)
requires (stage engine / transition / ruleset, data):
  KNOCKOUT            contestTypes ∋ MATCH, outcomeModel = WIN_LOSS_DRAW
  ROUND_ROBIN         contestTypes ∋ MATCH
  FIELD               outcomeModel = RANKED, contestTypes ∩ {HEAT, SERIES, SESSION} ≠ ∅
  HEATS               FIELD requirements + partitionKinds ∋ COMPETITIVE
  QPT / CUT           a METRIC classification policy
  seeding BY_ENTRY_ATTRIBUTE(k)   entryAttributes ∋ k
```

**The rule.**

- A combination is valid **iff** every requirement is satisfied.
- The rule is evaluated by one generic function, used by the catalog read (`compatibleFormatVersionIds`), by `createEvent` and by plan generation.
- A disagreement is a **capability mismatch** error naming the missing capability, never the sport.

**Mixed paradigms (golf, bowling).** Golf match play and bowling match play are MATCH contests inside sports that are otherwise FIELD. The discipline simply provides both `MATCH` and `SERIES`; the format chooses. No `if sport` exists anywhere: the 72-row matrix in §16.3 is the **output** of this rule applied to catalog data, not a hand-maintained table in code.

---

## 19. Draw Model

**Applies to the `KNOCKOUT` and `ROUND_ROBIN` stage engines.** Pure: (entrants, seeding, draw policy, draw seed) → slot assignments, hashed into the plan.

```
DrawPolicy {
  // KNOCKOUT
  drawSize: NEXT_POWER_OF_TWO | integer (8, 16, 24, 28, 32, 48 … — ITF/FIP list non-power-of-two sizes)
  seedTable: [{ maxEntrants, seeds }]                      // data: ITF 8→2, 16→4, 32→8, 64→16; FIP similar
  seedPlacement: FIXED_LINES | BANDED_DRAW                 // BANDED: 3–4 drawn as a pair, 5–8 as four, onto fixed lines
  seedLines?: { [drawSize]: { band: lines[] } }            // data (ITF vs FIP lines differ)
  byes: TO_TOP_SEEDS_THEN_DRAWN
  unseeded: RANDOM | SEED_ORDER
  thirdPlace: boolean; stepladder?: { seats: 3..5 }        // stepladder = degenerate seeded chain (bowling)
  separation?: [{ attribute: CLUB | ORGANIZATION | REGION | TEAM_AFFILIATION, by: HALF_THEN_QUARTER, strength: SOFT }]
  // ROUND_ROBIN
  groupLayout: TABLE | EVEN                                // TABLE = FIP group-size table by field size (data)
  groupFill: SERPENTINE | SEED_PER_GROUP_THEN_DRAWN
  repeatWhenGroupSize: { 2: 2 }                            // FIP: a 2-pair group plays twice
  higherSeedsToSmallerGroups: boolean                      // FIP
}
```

- **Randomness:** only the existing `br-draw/1` primitive. All random choices draw from **one persisted seed** with labelled counters, so one seed reproduces the whole draw.
- **Byes** stay structural, never contests or results (ADR-0024).
- **Data, not code:** the ITF and FIP seed tables, line tables and the FIP group table are **published draw-policy templates**, each citing its source.
- The draw never reads results, knows nothing about sets, time or strokes, and never branches on sport.

---

## 20. Heat Model

**Applies to the `HEATS` stage (competitive) and to `FIELD` stages with logistic partitions** (waves, timed-final heats, tee groups, bowling squads, TT start slots).

```
HeatPolicy {
  purpose: COMPETITIVE | LOGISTIC
  seedBy: ENTRY_ATTRIBUTE(key, order) | RANDOM | PREVIOUS_STAGE_RESULT | CATEGORY
  composition: CIRCLE_SEEDED_LAST_K(k) | ZIGZAG | BLOCKS | SINGLE        // swimming: circle-seed last 3 (2 for ≥400 m); track: zigzag
  capacity: { lanes | groupSize | waveCapacity }                         // pool lanes; golf 2–4; wave size
  minPerHeat: integer                                                    // swimming: 3
  positionAssignment: LANE_ORDER_TABLE(table) | RANK_BAND_DRAW(bands) | DRAWN | START_INTERVAL(seconds) | NONE
  runOrder: SLOWEST_FIRST | DRAWN | BY_CATEGORY
}
```

- **Lane order tables are data:** World Aquatics 8-lane `4,5,3,6,2,7,1,8`; WA track rank bands.
- **The lane, start position, start time or tee is a Contestant attribute.** It is part of the plan when fixed at plan time, or of the resolution when assigned after a previous stage (e.g. final lanes by semi times).
- **Contest per heat.** A heat, wave, TT start block or bowling squad is one HEAT/SESSION/SERIES contest.
  - The 64-slot cap on `contestant.slot` must be lifted or redesigned for road races (§33, prerequisite P-1).
  - For golf and bowling, the contest is **per entrant per round/block** (SERIES, as in the BRT-01 walkthrough). The tee group or squad is a **scheduling group**, not a contest.

---

## 21. Timing Model

Timing is **a ruleset family plus evidence ingestion**, not an engine.

```
TimingRules (in Ruleset ELAPSED_TIME / FINISH_ORDER_WITH_TIME / LAPS_AND_TIME) {
  officialReference: GUN | WAVE_GUN | INDIVIDUAL_START (TT) | CHIP_START      // WA: gun official, net informational; UCI GF: either
  informationalReference?: CHIP_START
  precision: 1 s | 0.1 s | 0.01 s | 0.001 s
  rounding: UP | DOWN | TRUNCATE                                             // WA road: up to 1 s; UCI road: down to 1 s; WAq manual: truncate
  sameTimeGroups: boolean                                                    // UCI mass start
  tieRule: EQUAL_PLACE | FINER_PRECISION_THEN_LOTS | SWIM_OFF_BY_DECISION | JUDGES_ORDER
  notPlacedBeyond?: { percentOfWinner }                                      // UCI 8%
  laps?: { pulledRule: PERCENT_OF_LEADER_LAP(80), classifyPulled: LAPS_DOWN_THEN_PULL_ORDER }
}
```

**Recorded per entrant per contest** (result content, not engine state):

- start instant (gun / wave / individual);
- chip start;
- finish instant;
- raw elapsed time;
- official elapsed time (after rounding);
- adjustments with reasons (bonus, same-time, 3-km rule);
- splits as Performances (ordinal);
- laps;
- status (DNS/DNF/DQ + rule ref).

**Source:**

- Timing systems are **ingested** through the ADR-0017 external ingestion boundary. Their export is **primary evidence** (BRT-01 evidence expectations).
- Hand entry is a fallback.
- The engine never computes a finish from raw chip reads beyond the declared rounding and reference rules.

---

## 22. Scoring Model

A new versioned catalog axis **Ruleset** (ScoringFormat) **[ADR]**. It is pinned by the Event, optionally overridden per stage, and its allowed families are declared by the DisciplineVersion.

**Why it is not part of the DisciplineVersion:**

- the same discipline legitimately runs best of 3, short sets, star or golden point, gross or net;
- one version per combination would explode the catalog.

**Why it is not part of the FormatVersion:**

- the group stage and the knockout of one event often use different rulesets (ITF J §35).

| Family | Parameters (data) | Sports |
|---|---|---|
| `SETS_OF_GAMES` | setsToWin; gamesPerSet (6, short 4); tiebreakAt / To; finalSet FULL \| MATCH_TIEBREAK(7/10); deuce ADVANTAGE \| NO_AD \| GOLDEN_POINT \| STAR_POINT; decidingPointReceiver (MIXED) | Tennis, padel |
| `TIMED_PERIODS` | periods, minutes, overtime (5 min, repeat), drawAllowed=false, forfeitScore (20–0), defaultRule | Basketball 5v5, wheelchair basketball |
| `TIMED_OR_TARGET` | minutes 10, target 21, overtimeTarget +2, forfeit "w-0", standingsPointCap 21 | Basketball 3x3 |
| `ATTEMPT_POINTS_TIME` *(future; not in the canonical matrix)* | attempts, timeLimit, rank points DESC then time ASC | Future: basketball Shoot-Out skills contest [S] |
| `ELAPSED_TIME` | TimingRules (§21) | Running, swimming, cycling TT, open water |
| `FINISH_ORDER_WITH_TIME` | TimingRules + sameTimeGroups | Cycling mass start |
| `LAPS_AND_TIME` | TimingRules + laps | MTB XC, criterium (v2) |
| `FRAMES_PINFALL` | games per block, frames 10, max 300; handicap { basis, percent, cap? }; baker: boolean | Bowling |
| `STROKES` | holes 9 or 18; par and stroke index (from course resource); gross \| net; allowance %; maxScore? | Golf stroke play, scramble |
| `STABLEFORD` | points table (0..6) vs net par; allowance % | Golf |
| `MATCH_PLAY_HOLES` | holes; extraHoles: SUDDEN_DEATH; allowance % | Golf match play |

**Normalized contest result.**

- Every family maps onto the **existing ResultEntry** (`outcome`, `rank`, `primaryMark`, `tieBreakKeys`, `components`) and Performances (sets, frames, holes, splits).
- MATCH families emit `WIN/LOSS/…` plus metrics (setsWon, gamesWon, pointsFor/Against).
- FIELD families emit `RANKED` + `primaryMark` (time, pins, strokes, points).
- **No change to the Result model is needed**, except for the outcome-code additions in §30.

**Handicap.**

- **Inputs:** an entry attribute (bowling average, golf index), course data (golf) and an allowance (format).
- **Output:** a **net mark alongside the gross mark**. Both are recorded, so scratch and handicap classifications derive from the same contest (cross-event derivation).

---

## 23. Ranking Model

> **Naming.** This is the ticket's "ranking model". In OnChainFest vocabulary it is the **classification model** for in-event order. "Ranking" stays reserved for cross-competition systems (ADR-0048, §32).

**Result ≠ classification.**

- A contest **result** records what happened (a time, pins, holes).
- A **classification** orders entrants, over one contest or many, under a policy. It is a derived ResultVersion with pinned inputs (ADR-0047).

**Two policy families, one engine:**

| Family | Primary | Used by |
|---|---|---|
| **METRIC** | ordered keys over (aggregated) metrics | running, swimming, cycling, bowling pinfall, golf stroke/Stableford |
| **STANDINGS** | match points from outcomes, then criteria | tennis/padel RR, basketball, bowling match play (§24) |

**METRIC policy (extends `classification-engine/1`).**

```
MetricClassificationPolicy {
  scope: CONTEST | STAGE | EVENT | CATEGORY_SUBSET(category labels)            // age-group results from one race
  aggregate: { over: ROUNDS | CONTESTS, fn: SUM | MIN | MAX | BEST_N(n) }       // golf SUM strokes; bowling SUM pins; GC SUM time
  keys: [ { metric, order, source: PRIMARY_MARK | PERFORMANCE | ADJUSTED_MARK } ]
  derived?: [ { key: "pinsPlusBonus", expr: SUM(pins) + BONUS_PER_WIN(10) * wins } ]   // closed vocabulary, no scripting
  tieBreak: [ COUNT_BACK(segments: [9,6,3,1], holesFrom: LAST) | PLACE_SUM | LAST_STAGE_PLACE
            | FINER_PRECISION | HIGHEST_SINGLE(game) | SMALLEST_SPREAD | ORGANIZER_LOT | SHARED ]
  statusOrder: [ RANKED, NOT_PLACED, PULLED(lapsDown), DNF, DQ, DNS ]          // non-finishers placed after finishers, by rule
  teamDerived?: { groupBy: TEAM_AFFILIATION, scorers: N, fn: SUM_OF_PLACES | SUM_OF_TIMES, incompleteTeam: EXCLUDE }
}
```

**Examples (as data):**

| Case | Policy |
|---|---|
| Road race | keys `elapsedTime ASC`; tie `SHARED`; category subsets by gender and age band; optional team `SUM_OF_PLACES` of 4 |
| Golf stroke play | aggregate `SUM` over rounds; `strokes ASC`; tie `COUNT_BACK(9,6,3,1)` or a play-off contest by decision |
| Bowling scratch | aggregate `SUM` over games; `pins DESC`; legacy pilot: `average DESC → total DESC → highSeries DESC` |
| Cycling GC | aggregate `SUM(adjustedTime)`; ties `FINER_PRECISION(TT) → PLACE_SUM → LAST_STAGE_PLACE` |

**Gaps vs `classification-engine/1`.** These need `classification-engine/2` **[ADR]**:

- policy keys must equal the DisciplineVersion comparator keys (ADR-0049) → **relax** per competition;
- no category subsets;
- no `BEST_N`;
- no derived bonus metrics;
- no count-back, place-sum or status ordering;
- no team-derived classification.

---

## 24. Standings Model

The STANDINGS family of the classification engine.

```
StandingsPolicy {
  matchPoints: [{ when: { outcome, decidedBy? }, points }]   // FIBA 2/1/0 (forfeit 0, default-loss 1); IBF bowling 3/1/0
  criteria (ordered): POINTS | WINS | WIN_RATIO | MATCHES_PLAYED
                    | DIFFERENCE(for, against) | RATIO_PERCENT(for, against) | SUM(metric, capPerContest?)  // 3x3 cap 21
                    | AVERAGE(metric, excludeForfeits)
                    | HEAD_TO_HEAD(sub-criteria, among: TIED, minTied: 2 | maxTied: 2)    // ITF: two-way only
                    | TIED_SUBSET(sub-criteria, minTied: 3)                               // FIP three-way: set diff → game diff among tied
                    | SEED | ORGANIZER_LOT
  restartOnSeparation: boolean                                // FIBA D.1.4
  exclusions: { walkoverGiverAllMatches: boolean, onlyCompletedAll: boolean, retiredCountsCompleted: boolean }   // ITF J §57
  crossGroupComparison?: criteria[]                           // FIBA D.4 "best third"
  minimumInputStatus: PROVISIONAL | OFFICIAL | FINAL          // ADR-0008: operational tables on PROVISIONAL
}
```

**Templates as data, each citing its source:**

| Template | Criteria |
|---|---|
| `itf_rr` [J §57] | wins → H2H(2) → %sets → %games, with exclusions |
| `fip_groups` [PR] | wins → TIED_SUBSET(3: set diff, game diff) → H2H(2) → lot |
| `fiba_5x5` [OBR App. D] | points → H2H mini-table (diff, scored) → overall diff → scored → lot; restart |
| `fiba_3x3` [3x3-26 App. D] | wins/ratio → H2H → AVERAGE(points, cap 21, exclude forfeits) → seed |
| `ibf_bowling_rr` [IBF23] | points 3/1/0; advancement ties → roll-off by decision |

**Arithmetic:** exact. Ratios and percentages compare by integer cross-multiplication; no floats (BR-JSON).

**Guarantees kept (ADR-0047):**

- the engine proposes and an authority submits;
- staleness is computed;
- **no standings column** is written anywhere.

---

## 25. Seeding Model

**Exists:** `event_seeding`, one fact per event (MANUAL permutation or DETERMINISTIC_DRAW), hashed and audited, immutable once a plan exists.

**Proposed** (extends it; **[ADR]**, migration later):

```
Seeding {
  method: MANUAL | RANDOM | RANKED_THEN_DRAWN | BY_ENTRY_ATTRIBUTE | BY_PREVIOUS_STAGE
  seedValue source:
     DECLARED_EXTERNAL(label, asOf)        // ITF/FIP/3x3 ranking points, pair sum declared by organizer
   | ENTRY_ATTRIBUTE(key)                  // swimming entry time; bowling average; golf handicap index (flights/tee times)
   | PLATFORM_RANKING_SNAPSHOT(ref)        // ADR-0048 BEST_MARK — fits race/score sports (e.g. 5K best time)
   | QUALIFICATION(stageRef)               // stroke-play qualifying → match play; bowling qualifying → stepladder
  seededCount; ties: RANDOM_BY_DRAW_SEED | HIGHER_INDIVIDUAL (FIP pair) | ENTRY_ORDER
  protectedPositions?: […]; overrides?: [{ participantId, from, to, reason }]   // audited, hashed, publicly flagged
}
```

| Sport | Seeding input |
|---|---|
| Tennis / padel | declared external ranking; pair = combined [CT] |
| 3x3 | sum of the 3 best players' points [3x3-26] |
| Swimming | entry time; no time = last; equal times drawn [WAq] |
| Track | best performance (competition rules) |
| Cycling TT | objective criteria chosen by the organiser [UCI-2] |
| MTB | ranking grid [S] |
| Bowling | qualifying result, or average for squads |
| Golf | qualifying for match play; handicap or score for tee times |

**Not invented here:** a points-table ranking system (deferred in ADR-0048). Head-to-head sports use **declared external** seed values. These are recorded and hashed but **never verified**, the same honesty rule as `EligibilityBasis.DECLARED`.

**Entry attributes are a prerequisite** (§33 P-3). Participants carry none today.

---

## 26. Advancement Model

A **pure engine**: plan + stage graph + results/classifications at the policy status → **resolutions**. Each resolution is an **append-only fact** (new table **[ADR]**) referencing the exact ResultVersion or classification version it used.

| Transition | Trigger | Resolves |
|---|---|---|
| `WINNER_OF` / `LOSER_OF` | contest result | one slot (KO next round, third place, stepladder climb) |
| `RANK_FROM_GROUP(stage, group, rank)` | group classification complete | one KO slot (fixed crossover map) |
| `BEST_RANKED_ACROSS_GROUPS(rank, n)` | all groups complete | n slots, via `crossGroupComparison` |
| `QUALIFY_BY_PLACE_AND_TIME(Q, q)` | all heats of the round complete | Q per heat by place + q fastest of the rest; **lanes by rank band** in the target heats |
| `CUT(rule)` | round k classification | the **field** of round k+1. Count unknown until resolved: top N **and ties**, or within X of the lead |
| `STEPLADDER` | qualifying classification, then each match | seat k ← qualifying rank; the winner climbs |

**Rules:**

- **ADR-0008:**
  - operational advancement consumes **PROVISIONAL** results at the event's declared level;
  - cross-competition qualification (e.g. Gran Fondo top 25% → World Championships) is a **verification-gated Achievement** (ADR-0050), out of scope here.
- **Frozen at start:** a resolution is current until the dependent contest **starts**. A later change to an upstream result is a LATE ruling (ADR-0008 §3), never a silent re-resolution.
- **Ties at a qualification boundary.** A swim-off, roll-off or play-off is an **organizer decision** that creates an **extra contest**, audited. Otherwise `tieRule` decides: shared advancement with both tied entrants going through (WA, if lanes allow; the golf cut includes ties) or a draw.
- **Withdrawal after qualification:** the next eligible entrant replaces them where the rule says so (swimming [WAq]). This is a new resolution fact.

**Completion:**

- A contest is **decided** when it has a result at the policy status. Contest `COMPLETED` (operational) is never enough (BRT-05 §8).
- A group, heat round or leaderboard round is complete when all its contests are decided or `CANCELLED/VOID`.
- A stage is complete when all its rounds are complete **and** all its outgoing transitions have resolved.
- The event is **ready to complete** when all its stages are. `COMPLETED` stays an organizer command.

---

## 27. Scheduling Model

A **pure proposal engine** plus organizer acceptance. `contest_schedule` stays an OP table with audited changes. The scheduler is **competition-scoped**, not event-scoped: one athlete in singles and doubles, or in the 100 m and the relay, must be seen by one run.

### 27.1 Scheduling units by sport

| Sport | Primary resource | Scheduling unit | Source |
|---|---|---|---|
| Tennis | **Court** | match slot (court × time) | J (rest), common |
| Padel | **Court** | match slot | CT/PR |
| Running | **Course + start wave** (road); **track + heat + lane** | wave start time (with capacity); heat slot | WA (heats, round gaps); waves COMMON PRACTICE |
| Swimming | **Pool (lanes) + session + heat** | heat slot (all lanes) within a session | WAq |
| Cycling | **Course + start slot / category start** | TT start interval per rider; category start time | UCI-2, GF |
| Bowling | **Lane pair + squad** | squad block (lane pairs × game count) + per-game lane-move schedule | IBF23, ABF |
| Basketball | **Court** (full for 5v5 and wheelchair; half for 3x3) | game slot | OBR, 3x3, IWBF-R |
| Golf | **Tee time on a course** (starting tee 1/10; group 2–4; shotgun optional) | tee-time slot (interval) per group | CP5, CP6 |

**Research confirmed the ticket's suggested resources, with refinements:**

- bowling's unit is the **lane pair**, not a single lane;
- 3x3 uses a **half court**;
- golf has a **starting tee** dimension (two-tee starts).

### 27.2 Constraints

| Constraint | Hard/soft | Value source |
|---|---|---|
| Resource availability windows; type compatibility | HARD | Resource (§28); DisciplineVersion `requiredResourceTypes` |
| One contest per resource at a time (+ changeover); wave/lane/group capacity | HARD | SchedulingProfile, Resource |
| Dependency order (after feeder contests' expected end) | HARD | Plan / stage graph |
| Athlete not in two contests at once, across events | HARD | athlete index from rosters and lineups |
| **Rest rule** = table f(previous contest duration or round distance) | HARD or SOFT (profile) | ITF J table; WA 45/90 min/next day; organizer otherwise |
| Max contests per entrant per day | SOFT | ITF J (1 singles + 1 doubles) |
| Session grouping (swimming sessions; golf rounds per day; stage per day) | SOFT | Profile |
| Start interval (TT, tee times) | Input | Profile (1 min TT = COMMON PRACTICE; tee interval COMMON PRACTICE) |
| Expected duration per ruleset (Bo3 ≈ 75–90 min; 3x3 ≈ 20 min slot; heat by distance) | Input (estimate) | Profile, COMMON PRACTICE |

**No universal constants.** "15 minutes of rest" exists only as a profile value. Published profile templates cite their source, or are labelled COMMON PRACTICE.

**Post-result scheduling.** Some schedules depend on results:

- golf round 3 tee times ordered by score (CP6 6G(1));
- final lanes by semi times;
- bowling stepladder sequence.

The scheduler accepts **resolved** entries as input, so these assignments happen after advancement and never before.

---

## 28. Resource Model

```
Venue (exists: venue organization + location label)
 └─ Resource { id, competitionId, label, type, attributes, exclusivityGroup? }        [NEW, OP]
      └─ AvailabilityWindow { start, end }                                             [NEW, OP]
ResourceType (catalog vocabulary — data):
  TENNIS_COURT | PADEL_COURT | BASKETBALL_COURT | BASKETBALL_HALF_COURT
  | BOWLING_LANE_PAIR | POOL { lanes: 6|8|10, length: 25|50 }
  | TRACK { lanes: 8|9 } | ROAD_COURSE { distance, certified? } | OPEN_WATER_COURSE
  | CYCLING_COURSE { lapLength? } | GOLF_COURSE { holes: [{ par, strokeIndex }], startingTees: [1,10], teeSets? }
```

- **Overlapping resources:**
  - a basketball court = 2 half courts;
  - a tennis court relined;
  - lanes 1–8 as pairs (1–2, 3–4, …).

  Each is modelled as several Resources sharing an **exclusivity group**. Booking one blocks its overlapping siblings, with no special code.
- **Capacity resources:**
  - a course is *shared* by everyone in a wave, so its capacity is waveCapacity, not exclusivity;
  - a golf course is shared by many tee groups, with time offsets per starting tee;
  - the scheduler treats these as **interval or capacity** resources rather than exclusive ones.
- **Course data** (golf par/stroke index, road distance) is **resource data** that the ruleset reads. It is not a discipline rule.
- **Today:** `contest_schedule.court_label` is free text. It becomes a `resource_id` with the label kept for display. **This is a migration [ADR], deferred.**

---

## 29. Roster / Lineup Model

`DisciplineVersion.participation` today has one `lineupSize`. It is extended (new spec version **@2**):

```
participation: {
  participantKinds: [INDIVIDUAL] | [TEAM]
  roster:     { min, max, reserves? }        // frozen at field lock (snapshot)        relay 4..6; 3x3 4..4; pair 2..2; scramble 2..4
  lineup:     { min, max, ordered: boolean, legs?: [{ ordinal, constraint? }] }   // per contest declared lineup (ADR-0026)
  onCourt?:   { count, minToContinue }        // rule data only; never stored per contest   5v5 5/2; 3x3 3
  substitution: NONE | ROLLING | BETWEEN_GAMES | BETWEEN_STAGES | MEDICAL_ONLY | LIMITED(n)
  composition?: [{ by: DECLARED_GENDER, pattern: "M-W-M-W" | "2M+2W" }]   // mixed relays; declared, never inferred
  positions?: [{ code, min, max }]           // optional; recorded, not validated in v1
  lineupConstraint?: { sumOf: entryAttribute, scope: ON_COURT, max }   // wheelchair: Σ classPts ≤ 14.0 [IWBF-C]; recorded, not validated in v1
}
```

| Modality | roster | lineup | ordered | substitution |
|---|---|---|---|---|
| Tennis doubles, padel, golf four-ball | 2..2 | 2 | no | NONE (pair atomic) |
| Running relay [WA TR 24] | 4..6 | 4 | **yes** (legs; mixed pattern) | up to 2 after start (BETWEEN_STAGES) |
| Swimming relay [WAq] | 4..n | 4 | **yes** (+ stroke per leg, medley) | BETWEEN_STAGES; MEDICAL_ONLY after deadline |
| Bowling team [IBF23] | n..n+reserves | n | **yes** (frame order, Baker) | BETWEEN_GAMES |
| Golf scramble | 2..4 | all | no | NONE |
| Basketball 5v5 [OBR] | ≤ 12 match-eligible | ≤ 12 dressed | no | ROLLING (on court 5) |
| Basketball 3x3 | 4 | 4 | no | ROLLING (on court 3) |
| Wheelchair basketball [IWBF-R, IWBF-C] | ≤ 12 | ≤ 12 dressed | no | ROLLING (on court 5; `lineupConstraint` Σ classPts ≤ 14.0 on court — recorded, not validated in v1) |

- **Existing `lineupSize` maps to `lineup`.** `padel.doubles@1`, `tennis.singles@1` and `tennis.doubles@1` stay valid and pinned. `@2` versions are a deliberate operator publication (ONCF-03A conflict behaviour).
- **Roster snapshot at field lock** **[ADR]**. Today a lineup is validated against ACTIVE memberships **at submission time**, so a squad can change after the lock and "the roster this entrant entered with" is not recorded. **Proposal:** at `lockField`, snapshot each TEAM participant's ACTIVE members (hashed into the field document). Amendments are explicit, audited and bounded by `roster.max`.
- **Declared vs credited lineup** stays as ADR-0026 decided: the declared lineup is operational, and achievements credit through the Result-content lineup.
- **Mixed composition** is **eligibility**, declared by the entrant and accepted by the organizer, never inferred.

---

## 30. Result Model

The existing Result model (BRT-01 §6; `@br/domain` `ResultEntry`, `Performance`, `Mark`) already represents most of what is needed:

| Need | Representation | Status |
|---|---|---|
| Winner / loser / draw | `outcome` WIN/LOSS/DRAW, WALKOVER_WIN/LOSS, RETIRED, NO_CONTEST | ✔ |
| Finish order | `outcome: RANKED`, `rank` (ties share rank) | ✔ |
| Elapsed time | `primaryMark` DURATION (decimal string; no float) | ✔ |
| Score, points, sets, games | `components` (ruleset-typed) + metrics `setsWon`, `gamesWon`, `pointsFor` | ✔ schema; components richer per ruleset (§22) |
| Frames | Performance per game (ordinal) with `components.frames` | ✔ (BRT-01 walkthrough) |
| Strokes / holes | Performance per hole (ordinal 1..18) mark = strokes; `components` per round | ✔ shape; par/SI from course |
| Cumulative score | **Classification** ResultVersion (`derivedFrom` rounds) | ✔ (ADR-0047) |
| Qualification | `ResultEntry.advancement` (operational) + resolution fact (§26) | shape ✔; resolution ✘ |
| DNF / DNS / DSQ | `outcome` DNF / DNS / **DQ** (+ rule reference in penalties) | ✔ (DQ = DSQ) |
| Not placed (UCI > 8%), pulled/lapped (−n laps) | — | ✘ new outcomes `NOT_PLACED`, `PULLED` + `lapsDown` component **[ADR]** |
| Forfeit vs default (FIBA: 0 vs 1 pt) | WALKOVER_LOSS (forfeit) vs LOSS + `decidedBy: DEFAULT` | ✔ via a `decidedBy` component |
| Time adjustments (bonus, same-time, 3-km) | `components.adjustments[{kind, seconds, reason}]` + adjusted mark | ✘ convention to define |
| Gross / net | two marks (`primaryMark` gross, `tieBreakKeys`/components net) | ✔ convention to define |
| Team result from individuals | Classification (team-derived) | ✘ engine (§23) |

**Not** "winner = X, loser = Y". MATCH results are one shape of ResultEntry among several. FIELD results are `RANKED` with marks.

---

## 31. Sport-specific vs Generic Rules

| Rule | Class | Where it lives |
|---|---|---|
| Winner advances to next bracket slot | GENERIC | `KNOCKOUT` + `WINNER_OF` |
| Byes go to top seeds | GENERIC (policy default) | DrawPolicy |
| Seed count by draw size (ITF 32→8) | FORMAT-SPECIFIC (data) | Draw-policy template |
| Seed lines (ITF vs FIP) | FORMAT-SPECIFIC (data) | Draw-policy template |
| Group-size table by field size; 2-pair group plays twice | FORMAT-SPECIFIC (FIP) | Draw-policy template |
| Fixed crossover 1A–2B | FORMAT-SPECIFIC | Stage-graph transition |
| Best of 3 sets, tie-break at 6–6 | SPORT-SPECIFIC (ruleset family `SETS_OF_GAMES`) | Ruleset |
| Star point / golden point / advantage | SPORT-SPECIFIC (padel) → EVENT-SPECIFIC choice | Ruleset parameter |
| Match tie-break replaces third set | EVENT-SPECIFIC | Ruleset parameter (per stage) |
| Rest = f(previous match duration) | FORMAT/EVENT-SPECIFIC (ITF template) | SchedulingProfile |
| Wins → H2H → %sets → %games | FORMAT-SPECIFIC (ITF RR) | Standings template |
| Win 2 / loss 1 / forfeit 0 points | SPORT-SPECIFIC (FIBA) | Standings template |
| 10 min or first to 21 | SPORT-SPECIFIC (3x3) | Ruleset |
| Five players active on court | SPORT-SPECIFIC (basketball) | DisciplineVersion `onCourt` |
| On-court classification points ≤ 14.0 | SPORT-SPECIFIC (wheelchair basketball, IWBF) | DisciplineVersion `lineupConstraint` over a declared entry attribute |
| Roster ≤ 12 | SPORT-SPECIFIC default; EVENT-SPECIFIC override | DisciplineVersion + event |
| Lowest elapsed time wins | GENERIC (metric `ASC`) | Classification policy |
| Gun time official, net informational | SPORT-SPECIFIC (WA); EVENT-SPECIFIC in Gran Fondo | TimingRules |
| Round up to whole second on road | SPORT-SPECIFIC (WA) | TimingRules |
| Same time for a bunch | SPORT-SPECIFIC (UCI) | TimingRules |
| Lane order 4,5,3,6,2,7,1,8 | SPORT-SPECIFIC (WAq) data | HeatPolicy template |
| Circle-seed last 3 heats | SPORT-SPECIFIC (WAq) | HeatPolicy |
| Q by place + q by time | GENERIC transition; values FORMAT-SPECIFIC | Transition params |
| Top 8 to final | FORMAT-SPECIFIC | Transition params |
| Equal times = equal places | SPORT-SPECIFIC (WAq) | TimingRules `tieRule` |
| Swim-off / roll-off / play-off | GENERIC mechanism (extra contest by decision); triggers SPORT-SPECIFIC | Advancement + organizer command |
| 10 frames, max 300 | SPORT-SPECIFIC | Ruleset `FRAMES_PINFALL` |
| Handicap = % × (basis − average) | SPORT-SPECIFIC formula; EVENT-SPECIFIC values | Ruleset + entry attribute |
| Lane pair, lane moves per game | SPORT-SPECIFIC | Resource + HeatPolicy |
| Stepladder | GENERIC primitive (degenerate KO); use FORMAT-SPECIFIC | DrawPolicy |
| Bonus pins per match win | FORMAT-SPECIFIC (ABF Masters) | Derived metric |
| Hole scores certified by marker | SPORT-SPECIFIC (Rules of Golf) | Result/attestation (existing trust layer) |
| Lowest cumulative strokes wins | GENERIC (aggregate SUM + ASC) | Classification policy |
| Stableford points table | SPORT-SPECIFIC | Ruleset `STABLEFORD` |
| Cut after round 2 (top 65 and ties) | EVENT-SPECIFIC | `CUT` transition params |
| Count-back last 9/6/3/1 | SPORT-SPECIFIC (Committee Procedures) | Tie-break `COUNT_BACK` |
| Allowance 95% / 85% / scramble % | SPORT-SPECIFIC (WHS) values; FORMAT-SPECIFIC selection | Ruleset |
| GC = Σ stage times − bonuses | GENERIC aggregate + SPORT-SPECIFIC adjustments | Classification + result content |
| Team score = Σ best N | GENERIC (team-derived); N EVENT-SPECIFIC | Classification policy |
| Age category on 31 Dec | SPORT-SPECIFIC (WA, UCI) | Category label (declared) |
| Mixed composition M-W-M-W | SPORT-SPECIFIC | `participation.composition` (declared) |

---

## 32. Existing Catalog Mapping

**Current canonical catalog** (ONCF-03A `CANONICAL_CATALOG`, provisioned by `pnpm db:catalog:provision`):

| Entity | Content | Maps to | Status |
|---|---|---|---|
| Sport `padel` | discipline `padel.doubles@1` (TEAM, lineup 2..2) | Padel modalities 1–3 = this + category | ✔ reusable unchanged |
| Sport `tennis` | `tennis.singles@1` (INDIVIDUAL, 1..1), `tennis.doubles@1` (TEAM, 2..2) | Tennis modalities 1–3 | ✔ reusable unchanged |
| Result schema (shared racket) | `{setsWon 0..5, gamesWon 0..99}`; bound `setsWon ≤ 3` | `SETS_OF_GAMES` ruleset components | ⚠ aggregate only (no per-set scores, tie-break, deuce mode); @2 needed for validation |
| Comparator | `HEAD_TO_HEAD_WINNER`, keys setsWon, gamesWon | Discipline default tie-break hint | ✔ kept; standings policies decide tables |
| Contest types | `MATCH` | — | ✔ |
| Formats | `single-elimination/1` (2–256, power-of-two, no config); `round-robin/1` (2–64, one group, no config) | `KNOCKOUT` and `ROUND_ROBIN` stage engines, one-stage graphs | ✔ valid forever; new behaviour = new versions |
| Format configuration schemas | both `{}` | Stage graph + draw/heat policy | ⚠ empty |
| Dev seed only | `running.5k@1` (HEAT, `elapsedTimeMs` ASC, min 600 000 ms) | Running road race | ⚠ no engine for HEAT contests; distance as discipline (not as a parameter) |

**Reusable existing abstractions:**

- Sport / Discipline / DisciplineVersion / FormatVersion;
- contest types (all 8 sports fit), outcome models, comparator primitives;
- `EventCategory` (gender incl. MIXED, age, skill, division);
- Team kinds; Registration / Participant; declared Lineup;
- `br-draw/1`; immutable plans;
- slot sources `WINNER_OF_CONTEST`, `LOSER_OF_CONTEST`, `RANK_FROM_STAGE`;
- round types `QUALIFYING, GROUP, HEAT, KNOCKOUT, REPECHAGE, FINAL, SESSION`;
- ClassificationPolicy and the classification engine;
- ResultEntry / Performance / Mark;
- the ingestion boundary (ADR-0017).

**Naming conflicts:**

| Conflict | Resolution |
|---|---|
| "Ranking" (ticket: in-event order) vs `@br/rankings` (cross-competition, ADR-0048) | Use **classification** for in-event order |
| "Format" in the ticket vs FormatTemplate (structure only) | Format = structure; **Ruleset** = scoring; never one "format" field |
| "Modality" vs Discipline | Modality = Discipline + Category (+ params); stored only as those |
| `lineupSize` | Means lineup, not roster → `lineup`; `roster` added |
| `running.5k` | Distance as a discipline code → recommend `running.road` with a distance parameter (5k stays valid; dev-only) |
| `RANK_FROM_STAGE` | Has `source_rank` but **no stage/group reference** → ambiguous with several groups; needs a group reference |

**Migrations that will eventually be required** (not created; listed for ONCF-05B+ planning):

1. Stage reference on rounds/contests and a richer `contestant` source (group ref, transition ref; lift the `slot ≤ 64` cap or add a field-entry table).
2. Participant entry attributes.
3. Participant roster snapshot.
4. Slot/field resolution facts (advancement).
5. Seeding method extension.
6. Ruleset catalog tables (`sports.ruleset`, `ruleset_version`).
7. Resource + availability tables, and `contest_schedule.resource_id`.
8. New result outcome codes (`NOT_PLACED`, `PULLED`).

---

## 33. Gap Analysis

| # | Gap | Blocks | Proposed home |
|---|---|---|---|
| G-1 | No **Stage** / stage graph / transitions | All multi-stage formats (P→KO, H→F, Q→F, cut) | ONCF-05B **[ADR]** |
| G-2 | `contestant.slot` CHECK `1..64`; contest = fixed slots | Any field > 64 (road race, Gran Fondo, open water) | ONCF-05B **[ADR]** |
| G-3 | No participant **entry attributes** (entry time, average, handicap index, bib, team affiliation) | Swimming heats, bowling handicap, golf net, bib numbers | ONCF-05B |
| G-4 | Seeding: no hybrid ranked + drawn; no attribute-based seeding | Tennis/padel draws; swimming heats | ONCF-05B |
| G-5 | `KNOCKOUT`: no explicit draw size, seed table or banded placement, third place or stepladder | Tennis, padel, bowling finals, golf match play | ONCF-05B |
| G-6 | `ROUND_ROBIN`: one group only; no group tables or repeat | Padel, tennis RR → KO, basketball pools | ONCF-05B |
| G-7 | No `FIELD` / `HEATS` engines; HEAT disciplines cannot run (the reason running was excluded in ONCF-03A) | Running, swimming, cycling, bowling, golf | ONCF-05C |
| G-8 | No **Ruleset** axis; racket result schema aggregate-only; no time, frame or hole rulesets | Score validation in all sports | ONCF-05C **[ADR]** |
| G-9 | Classification engine `/1`: keys = DV comparator; no H2H, difference, ratio, count-back, BEST_N, team-derived, category subsets, status order | Every table and leaderboard | ONCF-05C **[ADR]** (supersedes ADR-0049 §1 in part) |
| G-10 | No advancement / resolution; `RANK_FROM_STAGE` lacks a group reference | Any round after the first | ONCF-05D **[ADR]** |
| G-11 | No organizer/official result-entry path into the ResultLedger; no timing import | Advancement and classifications | ONCF-05D (+ ADR-0017 adapter) |
| G-12 | Roster not frozen at field lock | Team sports, relays | ONCF-05B **[ADR]** |
| G-13 | `lineupSize` conflates roster, lineup and on-court; no ordered legs | Relays, Baker, basketball | ONCF-05C (DV @2) |
| G-14 | No Resource entity; court is free text; no lane pair, pool, course or tee | Scheduling for all sports | ONCF-05E |
| G-15 | No cross-event athlete conflict or rest checking | Multi-event athletes | ONCF-05E |
| G-16 | No team formation UI/API (ONCF-04 out of scope) | Every TEAM category end to end (all padel today) | Prerequisite of the first pair/team event |
| G-17 | Outcomes `NOT_PLACED` / `PULLED`; adjustment conventions | Cycling | ONCF-05C |
| G-18 | Platform rankings BEST_MARK only; no H2H ranking source | Ranked seeding from platform data | Later (declared external meanwhile) |
| G-19 | Draws reproducible but not provably fair | Public trust | Later (commit–reveal) |

### Implementation prerequisites for ONCF-05B

These are **required code changes discovered** during ONCF-05A. **None was made.** Each needs approval and, where marked, an ADR.

| # | Prerequisite | Affected code (existing) | ADR |
|---|---|---|---|
| P-1 | Stage graph in the plan document; stage reference on rounds/contests; contestant sources with group/transition reference; **remove or redesign `slot BETWEEN 1 AND 64`** (field-entry table for FIELD stages) | `packages/competition/src/format/engine.ts` (PlanDocument), `competition-structure-store`, `0008` contestant CHECK | ✔ |
| P-2 | Seeding methods `RANKED_THEN_DRAWN`, `BY_ENTRY_ATTRIBUTE`; seed values + sources + audited overrides | `event_seeding.method` CHECK, seeding schema `br:competition-seeding@2`, store command | ✔ |
| P-3 | Participant entry attributes (declared, typed by the DisciplineVersion), captured at registration or before lock | registration/participant tables, ONCF-04 registration flow (**read-only extension; ONCF-04 behaviour unchanged**) | ✔ |
| P-4 | Roster snapshot at `lockField` (hashed into the field document) | `lockField` in the competition store; `br:competition-field@2` | ✔ |
| P-5 | New engine versions: `knockout/2` (draw size, seed table, banded seeds, third place, stepladder), `round-robin-groups/1`; registry entries; config schemas | `packages/competition/src/format/*`, `registry.ts` | — (covered by ADR-0024) |
| P-6 | Team/pair entry UI and team read API over the existing Team model | apps/api, apps/web | — |
| P-7 | Organizer draw/plan UI and readiness checklist | apps/web | — |

---

## 34. First Implementation Matrix

**Principle.** ONCF-05B represents **all eight sports, 24 modalities and 24 formats in the domain model**:

- catalog specs, capabilities, Ruleset and ClassificationPolicy vocabularies;
- stage graphs and entry attributes.

These are validated by unit tests over all 72 combinations. **Execution** is proven first on six cases, chosen so that every stage engine, both partition kinds, both classification families, both entrant structures and the scale requirement are each exercised at least once.

### 34.1 Six proof cases

| # | Proof case | Proves | Rules and structures exercised | Main new capabilities |
|---|---|---|---|---|
| **A** | Tennis singles — single elimination | `KNOCKOUT` | ITF draw sizes incl. non-power-of-two, seed table, banded seed lines, byes to top seeds [J] | `knockout/2`, seeding `RANKED_THEN_DRAWN` |
| **B** | Padel doubles (M/W/X) — groups → knockout | `ROUND_ROBIN` + standings + pair entrant | FIP group-size table incl. a 2-pair double round robin, fixed crossover, three-way-tie rule [PR] | `round-robin-groups/1`, `RFG` transition, `fip_groups` standings policy, pair entry |
| **C** | Running road race — wave start | `FIELD` + logistic partitions + scale | Gun time official per wave, net informational, road rounding [WA]; waves (CP); age/gender subsets; thousands of entrants | `FIELD` engine, field entries beyond 64, entry attributes (bib, ageBand, predTime), timing import |
| **D** | Swimming individual — heats → final | `HEATS` + entry-time seeding + qualification | Entry-time seeding, circle seeding, lane table 4,5,3,6,2,7,1,8, top 8 by time, equal times = equal places, swim-off by decision [WAq] | `HEATS` engine, `BY_ENTRY_ATTRIBUTE` seeding, `QPT` transition, lane assignment |
| **E** | Golf individual stroke play — multi-round + cut | Cumulative classification + cut | Hole scores, round totals computed, SUM over rounds, cut top N and ties, count-back 9/6/3/1 [RoG3, CP5]; tee groups (LOG) | Multi-round `FIELD`, `CUT` with dynamic field size, `MET-Σ` classification, course resource data |
| **F** | Basketball 3x3 — pools → knockout | Team roster/lineup + timed/target scoring + resource constraints | Roster 4 / 3 on court, 10 min or 21, standings capped at 21 points per game, seeding by sum of the 3 best members [3x3-26]; half-court resources | Roster snapshot, squad lineup, `TIMED_OR_TARGET`, `fiba_3x3` standings, half-court exclusivity groups |

### 34.2 When each proof case is complete

Each proof case is **structural** in ONCF-05B and **end to end** after ONCF-05D/E:

| Case | 05B (structure) | 05C (ruleset + classification) | 05D (results + advancement) | 05E (schedule + resources) |
|---|---|---|---|---|
| A | draw + plan | `SOG` validation | winner advancement | courts, ITF rest table |
| B | groups + KO plan with RFG slots | `fip_groups` tables | group → KO resolution | courts |
| C | wave partitions; > 64 entries | `ET` timing rules, subsets | timing import → classification | waves (capacity) |
| D | heats + lanes from entry times | `ET` | top-8 qualification, re-laning | pool sessions |
| E | round 1 field + tee groups; dynamic later rounds | `STK` + `MET-Σ` + count-back | cut resolution | tee times |
| F | pools + KO, roster snapshot | `TOT` + `fiba_3x3` | pool → KO resolution | half courts (exclusivity) |

### 34.3 Next combinations

**v1.1** (reuses v1 primitives; each adds one concern):

| Combination | Adds |
|---|---|
| Bowling singles — aggregate pinfall → stepladder | handicap, cross-event scratch/handicap, roll-off |
| Cycling individual TT — interval start | start slots |
| Basketball 5v5 / wheelchair — pool → knockout | `TIMED_PERIODS`, declared classification points |

**v1.2:**

- tennis and padel doubles across all three formats;
- swimming relays (ordered lineup);
- running track heats → final (Q/q) and relays;
- swimming open water;
- golf Stableford, four-ball and scramble (CP);
- golf match play;
- bowling match play (Baker teams);
- cycling mass start and multi-stage GC;
- MTB XC.

**Not supported yet (explicit):**

- the ✘ cells of §16.3;
- padel Americano (CP);
- consolation and double elimination;
- 3x3 Shoot-Out (format unverified);
- cross-competition qualification (Gran Fondo top 25%): this is ADR-0050 territory.

**Football, futsal, volleyball, pickleball and every other non-canonical sport are not in any release scope.** They appear only in §35.

---

## 35. Future Extensions

| Item | New requirement | Note |
|---|---|---|
| Padel Americano / Mexicano | Rotating-partner SESSION engine; individual entrant, dynamic pairs | COMMON PRACTICE; very popular socially |
| Consolation / feed-in draws (tennis club practice) | `LOSER_OF` into a consolation stage | Not FIP-recognised |
| Double elimination | DE stage engine | No source requires it among the eight sports |
| Track cycling, criterium points race | Sprint points, laps | UCI Part 3 / 2.7 |
| Swimming heats → semis → final; swim-off automation | Extra `HEATS` stage | Parameter of format 2 |
| Cross-country (team sum of places) | Team-derived classification | WA championship regulations |
| Trail / mountain running | `running.trail` discipline on the road model | Course resource only |
| Basketball 3x3 Shoot-Out skills contest (FIBA) | `ATTEMPT_POINTS_TIME` ruleset; qualifying → final (FIELD → FIELD) | Not canonical until a primary FIBA format source is verified (only [S] today) |
| Golf Foursomes, Par/Bogey, Maximum Score | Ruleset families | Rules 21–22 |
| Bowling all-events | Parallel classification across events | Cross-event derivation exists in concept |
| Non-canonical sports: football / futsal, volleyball / beach volleyball, pickleball, table tennis, badminton | Mostly parameters of existing families: `TIMED_PERIODS` with draws and shoot-outs; `SETS_TO_TARGET`; `GAMES_TO_TARGET`; **ties of rubbers** (nested contests: table tennis, badminton and FIP team events) **[ADR]** | **Out of canonical scope** |
| Provably fair draws | Commit–reveal or beacon | BRT-05 known limitation |
| Points-table ranking systems | ADR-0048 deferred method | Enables platform-ranked seeding for H2H sports |

---

## 36. Architectural Risks

| Risk | Mitigation |
|---|---|
| **Generic engine becomes a DSL.** Rules expressed as scripts. | Closed vocabularies only (families, criteria, transitions), as in ADR-0049. A new rule = a new vocabulary member + engine version, never an expression language |
| **Logistic vs competitive partition confusion** (e.g. ranking a swimming timed final per heat) | Separate primitives (`FIELD` vs `HEATS`); policy validation refuses per-partition classification for LOGISTIC partitions |
| **Scale** (thousands of entrants in one race; per-hole Performances × 4 rounds × 150 golfers) | Field-entry table instead of 64 slots; results by bulk timing import; classification inputs digested; measured in ONCF-05C |
| **Engine-version sprawl** | Options in config schemas from day one (`knockout/2` carries draw size, seeds, third place, stepladder) |
| **ADR-0049 tension** (policy keys ≠ DV comparator) | Superseding ADR scoped to in-event classifications; `/1` stays valid; golden vectors for both |
| **Advancement before result entry** stalls brackets | Sequence result entry (05D) before advertising multi-round formats as runnable; draws are still useful alone |
| **Late corrections after a dependent contest started** | ADR-0008 LATE ruling; resolutions frozen at start; UI shows "advanced on provisional result" |
| **Roster drift** in team events | Roster snapshot at lock (P-4) before any team event goes live |
| **Over-modelling** (spec fields nobody validates) | Every field is either validated or explicitly "recorded, not validated in v1" |
| **Declared data presented as verified** (seeds, handicaps, entry times, mixed eligibility) | Existing honesty rule: "declared" is shown and hashed, never called verified |
| **Timing-system heterogeneity** | One ingestion adapter per vendor format behind ADR-0017; canonical timing content schema |
| **Catalog churn** (`@1` → `@2`) | Old versions remain pinnable until retired; the provisioner reports conflicts; operator publishes deliberately |
| **Common-practice formats mistaken for rules** (scramble, waves, stepladder, Americano) | Templates carry a `basis: GOVERNING_RULE(source) \| COMMON_PRACTICE` label shown to organizers |

---

## 37. Open Questions

**Resolved by the ONCF-05A review:**

- the canonical scope is the eight sports;
- golf modalities are individual stroke play, four-ball and scramble (CP);
- the Shoot-Out is not canonical;
- there are six proof cases.

**Still open:**

1. **Basketball modality 3 = wheelchair basketball.** Confirm. This revision chose it because it is the only verified, governing-body-codified third modality. The alternative is to leave basketball with a skills-contest placeholder until the Shoot-Out format is verified.
2. **Running modality 2.** Track (chosen: it is the only running modality needing heats and lanes) or trail (same model as road)?
3. **Official time per event.** May organizers declare net time as official? The UCI Gran Fondo allows either; World Athletics does not. The recommendation is yes, as an event-level timing rule shown publicly.
4. **Who enters results** in amateur events: the organizer, a designated official, both sides with counter-confirmation, or a timing vendor? This decides the authority grants in ONCF-05D.
5. **Score granularity in v1:** per set, frame or hole, or totals only?
6. **Ties at a qualification boundary.** Swim-offs, roll-offs and play-offs: always an organizer decision (recommended)?
7. **Golf course data.** Do organizers enter par and stroke index per event, or is there a shared course catalog?
8. **Declared handicaps, averages and classification points.** Free-text source (recommended) or required evidence?
9. **Team classifications derived from individuals** (cross-country, cycling teams, bowling all-events): v1.2 or later?
10. **Per-stage rulesets** (e.g. round robin with 2 sets + a match tie-break, and the knockout best of 3): allowed in v1?
11. **Discipline granularity.** One discipline per family with distance and stroke parameters (recommended), or one per distance (as the dev-only `running.5k`)?

---

## 38. Recommended ONCF-05B Implementation Sequence

### 38.1 Remaining ADR decisions (to write and approve before or with ONCF-05B)

| ADR | Decision | Needed by |
|---|---|---|
| **ADR-A** Capability-driven compatibility & no sport branching | Capabilities provided by DisciplineVersion @2, required by stage engines, transitions and rulesets; one generic compatibility function; sport codes never in engine control flow | 05B |
| **ADR-B** Stage graph, transitions and dynamic field entries | FormatVersion = stage graph; stage reference on rounds/contests; contestant sources with group/transition refs; field-entry table for `FIELD`/`HEATS` replacing the 64-slot ceiling; dynamic entry after `CUT`; one immutable plan per event preserved | 05B |
| **ADR-C** Logistic vs competitive partitions | Two partition kinds; classification over a LOGISTIC partition is refused | 05B |
| **ADR-D** Entry attributes | Typed, declared per-participant values (types from the DisciplineVersion); hashed into the field; never verified | 05B |
| **ADR-E** Seeding v2 | `RANKED_THEN_DRAWN`, `BY_ENTRY_ATTRIBUTE`, `BY_PREVIOUS_STAGE`; declared sources; audited overrides; one seeding per stage | 05B |
| **ADR-F** Roster snapshot at field lock | Snapshot ACTIVE members into the field document; explicit audited roster amendments | 05B |
| **ADR-G** Ruleset as a versioned catalog axis | Families + parameter schemas; pinned per Event with per-stage override; allowed families declared by the DisciplineVersion | 05B (data model), 05C (validators) |
| **ADR-H** Classification engine v2 | METRIC and STANDINGS policy families; criteria vocabulary (H2H, tied-subset, difference, ratio, count-back, BEST_N, category subsets, team-derived, status order); supersedes ADR-0049 §1 for in-event classifications | 05B (vocabulary), 05C (engine) |
| **ADR-I** Advancement resolutions | Append-only resolution facts referencing exact result/classification versions; frozen at dependent-contest start; decided extra contests (swim-off, roll-off, play-off) | 05D |
| **ADR-J** Result outcome additions | `NOT_PLACED`, `PULLED` (+ `lapsDown`); conventions for adjustments and gross/net marks | 05C |
| **ADR-K** Organizer/official result authority and timing ingestion | Who may submit contest results; timing-file adapters behind ADR-0017 | 05D |
| **ADR-L** Resource model & SchedulingProfile | Resources, exclusivity groups, capacity resources, availability; `contest_schedule.resource_id`; rest rules as tables | 05E |
| **ADR-M** Discipline granularity | Distance and stroke as parameters vs disciplines; effect on ranking universes and authority scopes | 05B |

### 38.2 Exact ONCF-05B scope

**ONCF-05B: the competition domain model for all eight sports, plus executable structure for proof cases A–F.**

*In scope:*

1. **Domain model for all eight sports.** These are types and validators in `@br/competition` / `@br/domain`:
   - **DisciplineVersion spec @2:** participation with roster, lineup (ordered legs), onCourt, substitution and composition; declared entry-attribute schema; provided capabilities; allowed ruleset families; required resource types.
   - **Ruleset family vocabulary** with parameter schemas for all ten families of §22. These are spec validation only; scoring execution is 05C.
   - **ClassificationPolicy v2 vocabulary** (METRIC + STANDINGS) with spec validation, and the published templates (`itf_rr`, `fip_groups`, `fiba_5x5`, `fiba_3x3`, road/swim/golf metric policies). Computing classifications is 05C.
   - **Stage graph, transitions, partition kinds, draw and heat policy schemas.**
   - **Seeding v2 and entry-attribute types.**
   - **The generic capability-compatibility function (ADR-A).**
   - **A unit test asserting the full §16.3 matrix (72 combinations)** from catalog data alone.
2. **Catalog manifest for the eight sports.**
   - DisciplineVersions for all 24 modalities, and FormatVersions for all 24 format templates.
   - The ✘ cells of §16.3 must come out of the compatibility function.
   - Provisioning stays **operator-gated**: new versions are published deliberately, and existing `@1` versions stay valid.
3. **Pure stage engines** (ADR-0024 versioned):
   - `knockout/2`: draw size, seed table, banded lines, byes, third place, stepladder.
   - `round-robin-groups/1`: group table, repeat, serpentine.
   - `field/1`: rounds, logistic partitions, start slots and tee groups as partition positions.
   - `heats/1`: circle/zigzag composition, lane tables.
   - Transitions are **structural only**: `W/L`, `RFG`, `QPT`, `CUT`, `STEP` as dependent slots or entries, unresolved.
4. **Persistence (migrations, with ADR-B/D/E/F):**
   - stage refs;
   - a field-entry table (no 64 cap for FIELD/HEATS);
   - contestant source refs;
   - entry attributes;
   - seeding v2;
   - roster snapshot at `lockField`;
   - plan document `br:competition-plan@2`.

   Existing `@1` plans and hashes are untouched.
5. **Executable structure for A–F:**
   - seeding → plan generation → materialized structure;
   - public structure read (bracket, groups, waves, heats + lanes, round-1 tee groups, pools).
6. **Organizer UI:**
   - entry-attribute capture;
   - team/pair entry over the existing Team model (needed by B and F);
   - seeding with audited overrides;
   - draw/structure preview and generation;
   - a readiness checklist.

   ONCF-04 behaviour is unchanged; this is additive.

*Out of ONCF-05B:*

- **05C:** score validation; classification computation.
- **05D:** result entry; timing import; advancement resolution.
- **05E:** scheduling; resources.
- Any non-canonical sport.

### 38.3 Sequence after ONCF-05B

| Step | Scope | Outcome |
|---|---|---|
| **ONCF-05C** — rulesets & classification | Ruleset validators/normalizers (all families of the domain model; proof-case families first: SOG, ET, STK, TOT); `classification-engine/2`; outcome additions (ADR-J) | Valid scores; provisional tables and leaderboards for A–F |
| **ONCF-05D** — results & advancement | Result entry (ADR-K); timing import adapter; advancement engine + resolution facts; decided extra contests | A–F runnable end to end (apart from scheduling) |
| **ONCF-05E** — scheduling & resources | Resource model (ADR-L), SchedulingProfile templates (ITF rest table, WA round gaps), deterministic greedy proposal, cross-event athlete conflicts | A–F fully proven, incl. F's half-court constraints |
| **ONCF-05F** — v1.1 | Bowling pinfall → stepladder, cycling ITT, basketball 5v5 / wheelchair | Executable coverage widens; the domain model is already complete |

---

## Appendix A — Consistency Audit (ONCF-05A final revision)

| Check | Result | Evidence |
|---|---|---|
| No duplicated section headers | **Pass** | 38 numbered `##` sections, each once, plus this appendix; subsection numbers unique (verified by heading listing) |
| No stale six-sport scope | **Pass** | The six-sport draft (tennis, padel, pickleball, basketball, football, volleyball) was replaced in full; "six" now refers only to the six proof cases |
| No football/futsal in canonical or v1 scope | **Pass** | Football, futsal, volleyball, pickleball, table tennis and badminton appear only in §2 (excluded) and §35 (future), and in §34 explicitly as "not in any release scope" |
| No sport-specific engine branches proposed | **Pass** | §1 binding rule; §18.4 capability rule; all sport variation is in Ruleset/Draw/Heat/Classification templates and parameters (§31) |
| No modality/format terminology collisions | **Pass** | §1 and §3: modality = discipline + category (entrant structure); format = stage graph. "Ranking" is reserved for ADR-0048; in-event order is "classification" (§23). Matrix columns separate the two |
| No unsupported governing-body claims presented as facts | **Pass, with labels** | Facts carry a source tag ([J], [R], [FR], [CT], [PR], [WA], [WAq], [OW], [UCI-2], [GF], [IBF23], [ABF], [USBC], [OBR], [3x3-26], [IWBF-R], [IWBF-C], [RoG3], [RoG21], [CP5], [CP6], [WHS-C]). Product judgements (e.g. local popularity) are stated as judgements, not statistics |
| Every COMMON PRACTICE item labelled | **Pass** | Running waves; Gran Fondo 1-min TT interval; stepladder (PBA); "90% of 220" handicap; scramble; shotgun start; padel Americano/Mexicano; 3x3 20-min slots; single elimination in basketball; better-ball Stableford; MTB stage races; relay wave starts. All are marked CP or COMMON PRACTICE where they appear |
| Every unverified item labelled | **Pass** | [S] or UNVERIFIED: FIP pair ranking "points vs positions"; Premier Padel rulebook; 3x3 shot clock; canonical fiba3x3 PDF (403; Korean 2026 edition used); Shoot-Out format; IWBF full rulebook; UCI Part 4 MTB (80% rule, grid); USGA pages; PGA Tour cut; WHS scramble/four-ball allowances; WMA masters bands; IBF frame rules (300 max); bowling all-events history |

*End of ONCF-05A (final revision). Awaiting approval. Nothing committed, pushed or deployed; no code, migration, catalog or API change made.*

# ADR-0055 — Logistic and competitive partitions are distinct

- **Status:** Proposed
- **Date:** 2026-10-07
- **Origin:** ONCF-05A §4, §20 (ADR-C); implemented in ONCF-05B

## Context

Splitting a field into smaller groups means two different things:

- **Logistic partitions** only schedule the field; everyone is classified together. Examples: running waves, swimming timed-final heats, golf tee groups, bowling squads, cycling start slots.
- **Competitive partitions** classify within the partition for qualification. Examples: padel groups, track heats, swimming championship heats.

Confusing the two would, for example, rank a swimming timed final heat by heat.

## Decision

1. **Every partitioned stage declares its partition** as `{kind: LOGISTIC | COMPETITIVE, method}`. The method is one of SINGLE_START, WAVE_START, INTERVAL_START, LANE_HEATS, GROUPED_ENTRANTS or GROUPS. It is hashed in the plan and stored on `stage`.
2. **Disciplines declare which partition kinds they provide**, and engines require them (ADR-0053). For example, heats → final requires COMPETITIVE and timed finals require LOGISTIC.
3. **The `FIELD` primitive partitions logistically; `HEATS` and grouped `ROUND_ROBIN` partition competitively.**
4. **Classification policies (ONCF-05C) must refuse** a per-partition classification over a LOGISTIC partition.

## Consequences

- Public reads and the organizer UI label partitions correctly ("wave", "heat", "tee group", "group").
- Contests carry a `partition_key`. A per-entrant contest (golf round, bowling block) belongs to a logistic scheduling group without the group being a contest.

## Alternatives considered

- **A single "heat" concept:** rejected. It was the most likely modelling error found in ONCF-05A.

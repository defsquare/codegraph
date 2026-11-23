-- page: discover/stimuli.md
-- what: the entry points grouped by what their chains share: one group, one candidate use case
-- parameters: :chains — the saved rows of chains.sql, :min — the share of types two chains must have in common, in percent

WITH RECURSIVE
member(entry, type) AS MATERIALIZED (   -- the code's own types only
  SELECT DISTINCT json_extract(r.value, '$[0]'), json_extract(r.value, '$[1]')
    FROM json_each(:chains, '$.rows') r
   WHERE json_extract(r.value, '$[2]') = 0),
entries(entry) AS MATERIALIZED (
  SELECT DISTINCT entry FROM member),
plumbing(type) AS MATERIALIZED (        -- what more than half the chains reach tells no two apart
  SELECT type FROM member GROUP BY type
  HAVING 2 * count(*) > (SELECT count(*) FROM entries)),
own(entry, type) AS MATERIALIZED (
  SELECT entry, type FROM member
   WHERE type NOT IN (SELECT type FROM plumbing)),
size(entry, n) AS MATERIALIZED (
  SELECT entry, count(*) FROM own GROUP BY entry),
near(a, b) AS MATERIALIZED (            -- shared types over all the types of the two chains
  SELECT x.entry, y.entry
    FROM own x
    JOIN own y   ON y.type = x.type AND y.entry <> x.entry
    JOIN size sx ON sx.entry = x.entry
    JOIN size sy ON sy.entry = y.entry
   GROUP BY x.entry, y.entry
  HAVING 100.0 * count(*) / (max(sx.n) + max(sy.n) - count(*)) >= :min),
spread(entry, label) AS (               -- a group is whatever is near something in it
  SELECT entry, entry FROM entries
  UNION
  SELECT n.b, s.label FROM spread s JOIN near n ON n.a = s.entry),
grouped(entry, label) AS (
  SELECT entry, min(label) FROM spread GROUP BY entry)
SELECT g.label AS group_of,
       count(*) OVER (PARTITION BY g.label) AS entry_points,
       g.entry AS entry_point,
       (SELECT count(*) FROM member m WHERE m.entry = g.entry) AS types
  FROM grouped g
 ORDER BY entry_points DESC, group_of, entry_point;

-- page: discover/stimuli.md
-- what: one row per chain: how much it reaches, and how many of step 3's hotspots it passes through
-- parameters: :chains — the saved rows of chains.sql, :hotspots — step 3's joined hotspot report as saved, or {"rows":[]}

WITH member(entry, external, depth, file) AS (
  SELECT json_extract(r.value, '$[0]'), json_extract(r.value, '$[2]'),
         json_extract(r.value, '$[3]'), json_extract(r.value, '$[4]')
    FROM json_each(:chains, '$.rows') r),
hot(file) AS (               -- the first ten rows of the report, by the file the model knows
  SELECT json_extract(h.value, '$.model')
    FROM json_each(:hotspots, '$.rows') h
   WHERE h.key < 10)
SELECT m.entry AS entry_point,
       sum(m.external = 0) AS types,
       sum(m.external = 1) AS exits,
       max(m.depth)        AS depth,
       count(DISTINCT CASE WHEN m.file IN (SELECT file FROM hot) THEN m.file END) AS hotspots
  FROM member m
 GROUP BY m.entry
 ORDER BY hotspots DESC, types DESC, entry_point;

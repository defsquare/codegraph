-- page: discover/stimuli.md
-- what: the inventory grouped by kind of stimulus, with the layer and the name that found each group
-- parameters: :inventory — the saved rows of entry-points.sql

WITH found(entry, layer, evidence, stimulus) AS (
  SELECT json_extract(r.value, '$[0]'), json_extract(r.value, '$[2]'),
         json_extract(r.value, '$[3]'), json_extract(r.value, '$[4]')
    FROM json_each(:inventory, '$.rows') r)
SELECT coalesce(f.stimulus, 'unclassified') AS stimulus, f.layer, f.evidence,
       count(DISTINCT f.entry) AS entry_points, min(f.entry) AS example
  FROM found f
 GROUP BY f.stimulus, f.layer, f.evidence
 -- what no table names comes last
 ORDER BY f.stimulus IS NULL, f.stimulus, entry_points DESC, f.layer, f.evidence;

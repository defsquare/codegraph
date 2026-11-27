-- page: discover/stimuli.md
-- what: the types of the code that the most chains pass through: the shared kernel, or the plumbing
-- parameters: :chains — the saved rows of chains.sql

WITH member(entry, type) AS (
  SELECT DISTINCT json_extract(r.value, '$[0]'), json_extract(r.value, '$[1]')
    FROM json_each(:chains, '$.rows') r
   WHERE json_extract(r.value, '$[2]') = 0)
SELECT m.type, count(*) AS chains,
       round(100.0 * count(*) / (SELECT count(DISTINCT entry) FROM member), 1) AS pct
  FROM member m
 GROUP BY m.type
 ORDER BY chains DESC, m.type
 LIMIT 20;

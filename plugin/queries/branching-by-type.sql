-- page: discover/structure.md
-- what: cyclomatic complexity summed per type, and the worst operation in each
-- parameters: none

WITH RECURSIVE types AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TType'),
climb(op, at) AS (
  SELECT em.entity_id, e.parent_id
    FROM entity_metric em JOIN entity e ON e.id = em.entity_id
   WHERE em.key = 'cyclomatic'
  UNION ALL
  SELECT c.op, e.parent_id
    FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NOT NULL
     AND e.trait_set_id NOT IN (SELECT trait_set_id FROM types))
SELECT o.id AS owner, o.kind,
       sum(em.value) AS cyclomatic,
       max(em.value) AS worst,
       count(*)      AS operations
  FROM climb c
  JOIN entity e ON e.id = c.at
  JOIN node   o ON o.ref = c.at
  JOIN entity_metric em ON em.entity_id = c.op AND em.key = 'cyclomatic'
 WHERE e.parent_id IS NULL
    OR e.trait_set_id IN (SELECT trait_set_id FROM types)
 GROUP BY o.ref ORDER BY cyclomatic DESC, o.id
 LIMIT 20;

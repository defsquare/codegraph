-- page: discover/structure.md
-- what: source lines per module, with its share of the whole
-- parameters: none

WITH types AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TType'),
top_type AS (
  SELECT e.parent_id AS module_id, em.value AS sloc
    FROM entity_metric em JOIN entity e ON e.id = em.entity_id
   WHERE em.key = 'sloc'
     AND e.parent_id = e.module_id
     AND e.trait_set_id IN (SELECT trait_set_id FROM types)),
module_size AS (
  SELECT m.symbol AS module,
         coalesce((SELECT em.value FROM entity_metric em
                    WHERE em.entity_id = m.id AND em.key = 'sloc'),
                  (SELECT sum(t.sloc) FROM top_type t WHERE t.module_id = m.id)) AS sloc,
         (SELECT count(*) FROM top_type t WHERE t.module_id = m.id) AS types
    FROM entity m
   WHERE m.id = m.module_id AND m.is_stub IS NOT 1)
SELECT module, sloc, types,
       round(100.0 * sloc / (SELECT sum(sloc) FROM module_size), 1) AS pct
  FROM module_size
 WHERE sloc IS NOT NULL
 ORDER BY sloc DESC, module;

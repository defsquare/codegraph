-- page: discover/structure.md
-- what: the largest types, where an outlier shows up first
-- parameters: none

SELECT n.id, n.kind, em.value AS sloc
  FROM entity_metric em JOIN node n ON n.ref = em.entity_id
 WHERE em.key = 'sloc'
   AND n.trait_set_id IN (
         SELECT m.trait_set_id
           FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
          WHERE t.name = 'TType')
 ORDER BY em.value DESC, n.id
 LIMIT 20;

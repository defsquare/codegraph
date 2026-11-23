-- page: discover/boundaries.md
-- what: everything that carries one of the named annotations, with the arguments as written
-- parameters: :names — a JSON array of annotation names, as '["GetMapping","PostMapping"]'

SELECT a.name AS annotation, x.arguments, n.id AS annotated
  FROM edge x
  JOIN edge_kind ek ON ek.id = x.kind_id
  JOIN entity a     ON a.id  = x.to_id
  JOIN node n       ON n.ref = x.from_id
 WHERE ek.name = 'annotationUse'
   AND a.name IN (SELECT value FROM json_each(:names))
 ORDER BY annotated, annotation;

-- page: discover/boundaries.md
-- what: every annotation, attribute or decorator in use, with where it is declared
-- parameters: none

SELECT a.name AS annotation, am.symbol AS declared_in, count(*) AS uses
  FROM edge x
  JOIN edge_kind ek ON ek.id = x.kind_id
  JOIN entity a     ON a.id  = x.to_id
  JOIN entity am    ON am.id = a.module_id
 WHERE ek.name = 'annotationUse'
 GROUP BY a.id ORDER BY uses DESC, annotation, declared_in;

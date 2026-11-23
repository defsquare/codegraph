-- page: discover/structure.md
-- what: how many of each kind of element, stubs excluded
-- parameters: none

SELECT k.name AS kind, count(*) AS n
  FROM entity e JOIN kind k ON k.id = e.kind_id
 WHERE e.is_stub IS NOT 1
 GROUP BY k.name ORDER BY n DESC, kind;

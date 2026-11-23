-- page: discover/boundaries.md
-- what: the modules the code references and does not declare, by number of references
-- parameters: none

SELECT m.symbol AS external_module,
       m.is_stub IS NOT 1 AS own,
       count(*) AS refs
  FROM dep d
  JOIN node n   ON n.ref = d.to_ref
  JOIN entity m ON m.id  = n.module_ref
 WHERE n.is_stub = 1
 GROUP BY m.id ORDER BY refs DESC, external_module
 LIMIT 40;

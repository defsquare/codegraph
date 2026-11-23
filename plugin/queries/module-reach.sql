-- page: discover/boundaries.md
-- what: which module of the code reaches which external module, and how often
-- parameters: none

SELECT src.symbol AS module, ext.symbol AS reaches, count(*) AS refs
  FROM dep d
  JOIN node f     ON f.ref = d.from_ref
  JOIN entity src ON src.id = f.module_ref
  JOIN node t     ON t.ref = d.to_ref
  JOIN entity ext ON ext.id = t.module_ref
 WHERE t.is_stub = 1 AND f.is_stub IS NOT 1 AND ext.is_stub = 1
 GROUP BY src.id, ext.id
 ORDER BY module, refs DESC, reaches;

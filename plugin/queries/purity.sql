-- page: discover/domain.md
-- what: per module of the code, the share of its references that land on the code rather than on a library, the standard library left out
-- parameters: :stdlib — the standard library's modules, a JSON list of GLOB patterns (the page's table)

WITH std(pattern) AS MATERIALIZED (
  SELECT value FROM json_each(:stdlib))
SELECT m.symbol AS module,
       count(*) AS refs,
       sum(t.is_stub) AS external,
       round(100.0 * (count(*) - sum(t.is_stub)) / count(*), 1) AS purity_pct
  FROM dep d
  JOIN node f    ON f.ref = d.from_ref
  JOIN entity m  ON m.id  = f.module_ref
  JOIN node t    ON t.ref = d.to_ref
  JOIN entity tm ON tm.id = t.module_ref
 WHERE f.is_stub IS NOT 1
   AND NOT EXISTS (SELECT 1 FROM std s WHERE tm.symbol GLOB s.pattern)
 GROUP BY m.id ORDER BY purity_pct DESC, refs DESC, module;

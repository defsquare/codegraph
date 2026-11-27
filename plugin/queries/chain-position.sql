-- page: discover/meaning.md
-- what: where each type of the code sits in step 4's chains: where a chain starts, inside it, or at its edge, where it reaches a library itself
-- parameters: :chains — the saved rows of chains.sql, :stdlib — the standard library's modules, a JSON list of GLOB patterns

WITH RECURSIVE
member(entry, type, depth) AS MATERIALIZED (
  SELECT json_extract(r.value, '$[0]'), json_extract(r.value, '$[1]'), json_extract(r.value, '$[3]')
    FROM json_each(:chains, '$.rows') r
   WHERE json_extract(r.value, '$[2]') = 0),
std(pattern) AS MATERIALIZED (
  SELECT value FROM json_each(:stdlib)),
types AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TType'),
leaving(ref) AS MATERIALIZED (   -- code that calls or reads a library, or a type a library is above, as written
  SELECT DISTINCT d.from_ref
    FROM dep d
    JOIN node t    ON t.ref = d.to_ref
    JOIN entity tm ON tm.id = t.module_ref
   WHERE d.kind IN ('invocation', 'access', 'inheritance', 'interfaceImplementation', 'traitUsage')
     AND d.provenance = 'declared'
     AND t.is_stub = 1
     AND NOT EXISTS (SELECT 1 FROM std s WHERE tm.symbol GLOB s.pattern)),
climb(ref, at) AS (              -- from that code up to the nearest type around it
  SELECT ref, ref FROM leaving
  UNION ALL
  SELECT c.ref, e.parent_id FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NOT NULL
     AND e.trait_set_id NOT IN (SELECT trait_set_id FROM types)),
edge_type(id) AS MATERIALIZED (
  SELECT n.id FROM node n
   WHERE n.ref IN (SELECT c.at FROM climb c JOIN entity e ON e.id = c.at
                    WHERE e.trait_set_id IN (SELECT trait_set_id FROM types)))
SELECT m.type,
       count(*) AS chains,
       sum(m.depth = 0) AS entry,
       sum(m.depth > 0 AND m.type IN (SELECT id FROM edge_type)) AS edge,
       sum(m.depth > 0 AND m.type NOT IN (SELECT id FROM edge_type)) AS inside
  FROM member m
 GROUP BY m.type
 ORDER BY chains DESC, m.type;

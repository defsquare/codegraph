-- page: discover/stimuli.md
-- what: the chain behind every classified entry point at once: the types it reaches, the nearest first
-- parameters: :inventory — the saved rows of entry-points.sql, :candidates — 0 for declared facts only, 1 to add the candidates

WITH RECURSIVE
operation AS (               -- what can be called, whatever its kind is named
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TInvocable'),
types AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TType'),
above(type, super) AS (      -- a type, with every type above it
  SELECT d.from_ref, d.to_ref FROM dep d
   WHERE d.kind IN ('inheritance', 'interfaceImplementation', 'traitUsage')
  UNION
  SELECT a.type, d.to_ref FROM above a JOIN dep d ON d.from_ref = a.super
   WHERE d.kind IN ('inheritance', 'interfaceImplementation', 'traitUsage')),
arity(ref, n) AS (
  SELECT entity_id, count(*) FROM entity_parameter GROUP BY entity_id),
step(src, dst) AS (
  -- a call or an access, as written
  SELECT d.from_ref, d.to_ref FROM dep d
   WHERE d.kind IN ('invocation', 'access')
     AND (:candidates = 1 OR d.provenance = 'declared')
  UNION
  -- an operation written inside another runs with it: a lambda, a local function
  SELECT c.parent_id, c.id FROM entity c JOIN entity p ON p.id = c.parent_id
   WHERE c.trait_set_id IN (SELECT trait_set_id FROM operation)
     AND p.trait_set_id IN (SELECT trait_set_id FROM operation)
  UNION
  -- candidates: the targets an edge lists without choosing one
  SELECT x.from_id, c.candidate_id FROM edge_candidate c JOIN edge x ON x.id = c.edge_id
   WHERE :candidates = 1
  UNION
  -- candidates: a call may run the operation of the same name in any type below
  SELECT s.id, o.id
    FROM above a
    JOIN entity s ON s.parent_id = a.super
    JOIN entity o ON o.parent_id = a.type AND o.name = s.name
    LEFT JOIN arity sn ON sn.ref = s.id
    LEFT JOIN arity om ON om.ref = o.id
   WHERE :candidates = 1
     AND s.trait_set_id IN (SELECT trait_set_id FROM operation)
     AND o.trait_set_id IN (SELECT trait_set_id FROM operation)
     AND coalesce(sn.n, 0) = coalesce(om.n, 0)),
classified(id) AS MATERIALIZED (   -- the inventory's rows that have a stimulus
  SELECT json_extract(r.value, '$[0]')
    FROM json_each(:inventory, '$.rows') r
   WHERE json_extract(r.value, '$[4]') IS NOT NULL),
seed(ref) AS (               -- those of them that are operations
  SELECT n.ref FROM node n
   WHERE n.id IN (SELECT id FROM classified)
     AND n.trait_set_id IN (SELECT trait_set_id FROM operation)),
reach(entry, ref, depth) AS (
  SELECT ref, ref, 0 FROM seed
  UNION
  SELECT r.entry, s.dst, r.depth + 1 FROM reach r JOIN step s ON s.src = r.ref
   WHERE r.depth < 20),
climb(ref, at) AS (          -- from what is reached up to the nearest type around it
  SELECT DISTINCT ref, ref FROM reach
  UNION ALL
  SELECT c.ref, e.parent_id FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NOT NULL
     AND e.trait_set_id NOT IN (SELECT trait_set_id FROM types)),
owner(ref, type) AS (
  SELECT c.ref, c.at FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NULL
      OR e.trait_set_id IN (SELECT trait_set_id FROM types))
SELECT s.id AS entry_point, t.id AS type, t.is_stub AS external,
       min(r.depth) AS depth, f.path AS file
  FROM reach r
  JOIN owner o  ON o.ref = r.ref
  JOIN node s   ON s.ref = r.entry
  JOIN node t   ON t.ref = o.type
  JOIN entity e ON e.id  = o.type
  LEFT JOIN file f ON f.id = e.anchor_file_id
 GROUP BY r.entry, o.type
 ORDER BY entry_point, depth, type;

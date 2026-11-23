-- page: discover/stimuli.md
-- what: what one entry point reaches, hop by hop: on facts only, or with the candidates
-- parameters: :id — the entry point's id, :candidates — 0 for declared facts only, 1 to add the candidates

WITH RECURSIVE
operation AS (               -- what can be called, whatever its kind is named
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TInvocable'),
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
reach(ref, depth) AS (
  SELECT ref, 0 FROM node WHERE id = :id
  UNION
  SELECT s.dst, r.depth + 1 FROM reach r JOIN step s ON s.src = r.ref
   WHERE r.depth < 20)
SELECT n.id, n.is_stub AS external, min(r.depth) AS depth
  FROM reach r JOIN node n ON n.ref = r.ref
 GROUP BY n.ref ORDER BY depth, n.id;

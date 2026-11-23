-- page: discover/stimuli.md
-- what: the entry-point inventory, each row with the layer that found it: an annotation, a supertype, a name, no caller
-- parameters: :stack — a stack table as JSON: annotations, supertypes, types, operations, conventional, entries

WITH RECURSIVE
-- the stack table, read once
by_annotation(name, stimulus) AS MATERIALIZED (
  SELECT key, value FROM json_each(:stack, '$.annotations')),
by_supertype(name, stimulus) AS MATERIALIZED (
  SELECT key, value FROM json_each(:stack, '$.supertypes')),
by_type_name(pattern, stimulus) AS MATERIALIZED (
  SELECT key, value FROM json_each(:stack, '$.types')),
by_name(name, stimulus) AS MATERIALIZED (
  SELECT key, value FROM json_each(:stack, '$.operations')),
by_hand(id, stimulus) AS MATERIALIZED (
  SELECT key, value FROM json_each(:stack, '$.entries')),
conventional(name) AS MATERIALIZED (
  SELECT value FROM json_each(:stack, '$.conventional')),
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
called(ref) AS (             -- the target of a call, or one of its candidates
  SELECT to_ref FROM dep WHERE kind = 'invocation'
  UNION
  SELECT candidate_id FROM edge_candidate),
arity(ref, n) AS (
  SELECT entity_id, count(*) FROM entity_parameter GROUP BY entity_id),
overriding(ref) AS (         -- called through a type above its own: same name, same number of parameters
  SELECT o.id
    FROM called c
    JOIN entity s ON s.id = c.ref
    JOIN above a  ON a.super = s.parent_id
    JOIN entity o ON o.parent_id = a.type AND o.name = s.name
    LEFT JOIN arity sn ON sn.ref = s.id
    LEFT JOIN arity om ON om.ref = o.id
   WHERE coalesce(sn.n, 0) = coalesce(om.n, 0)),
uncalled(ref, type, name) AS MATERIALIZED (
  SELECT e.id, e.parent_id, e.name
    FROM entity e
    LEFT JOIN entity p ON p.id = e.parent_id
   WHERE e.trait_set_id IN (SELECT trait_set_id FROM operation)
     AND e.is_stub IS NOT 1
     AND e.name IS NOT NULL
     AND e.kind_id NOT IN (SELECT id FROM kind WHERE name = 'constructor')
     -- a lambda or a local function runs with the operation it is written in
     AND (p.id IS NULL OR p.trait_set_id NOT IN (SELECT trait_set_id FROM operation))
     AND e.id NOT IN (SELECT ref FROM called)
     AND e.id NOT IN (SELECT ref FROM overriding)),
found(ref, id, layer, evidence, stimulus, arguments) AS MATERIALIZED (
  SELECT x.from_id, NULL, 'annotation', a.name, w.stimulus, x.arguments
    FROM by_annotation w
    JOIN entity a     ON a.name = w.name
    JOIN edge x       ON x.to_id = a.id
    JOIN edge_kind ek ON ek.id = x.kind_id AND ek.name = 'annotationUse'
  UNION ALL
  SELECT u.ref, NULL, 'supertype', s.name, w.stimulus, NULL
    FROM by_supertype w
    JOIN entity s   ON s.name = w.name
    JOIN above a    ON a.super = s.id
    JOIN uncalled u ON u.type = a.type
  UNION ALL
  SELECT n.ref, w.id, 'by hand', NULL, w.stimulus, NULL
    FROM by_hand w
    LEFT JOIN node n ON n.id = w.id
  UNION ALL
  SELECT u.ref, NULL, 'type name', w.pattern, w.stimulus, NULL
    FROM by_type_name w
    JOIN entity t   ON t.name GLOB w.pattern
    JOIN uncalled u ON u.type = t.id
  UNION ALL
  SELECT u.ref, NULL, 'no caller', NULL, w.stimulus, NULL
    FROM uncalled u
    LEFT JOIN by_name w ON w.name = u.name
   -- a name the language itself calls is not a stimulus, unless the table says so
   WHERE w.name IS NOT NULL
      OR u.name NOT IN (SELECT name FROM conventional))
SELECT coalesce(n.id, f.id) AS entry_point, n.kind, f.layer, f.evidence, f.stimulus,
       (SELECT count(*) FROM dep o
         WHERE o.from_ref = f.ref AND o.kind = 'invocation') AS calls,
       f.arguments
  FROM found f
  LEFT JOIN node n ON n.ref = f.ref
 WHERE f.layer = 'annotation'
    OR (f.layer = 'supertype'
        AND f.ref NOT IN (SELECT ref FROM found WHERE layer = 'annotation'))
    OR (f.layer = 'by hand'
        AND (f.ref IS NULL OR f.ref NOT IN (
              SELECT ref FROM found WHERE layer IN ('annotation', 'supertype'))))
    OR (f.layer = 'type name'
        AND f.ref NOT IN (SELECT ref FROM found
                           WHERE layer IN ('annotation', 'supertype', 'by hand')
                             AND ref IS NOT NULL))
    OR (f.layer = 'no caller'
        AND f.ref NOT IN (SELECT ref FROM found
                           WHERE layer <> 'no caller' AND ref IS NOT NULL))
 ORDER BY CASE f.layer WHEN 'annotation' THEN 1 WHEN 'supertype' THEN 2
                       WHEN 'by hand' THEN 3 WHEN 'type name' THEN 4 ELSE 5 END,
          f.stimulus IS NULL, calls DESC, entry_point, f.evidence;

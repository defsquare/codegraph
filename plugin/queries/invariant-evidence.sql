-- page: discover/domain.md
-- what: per type of the code, where its rules leave evidence: operations that write its own fields, throw sites, both in one operation, and the enum-typed fields it drives
-- parameters: none

WITH RECURSIVE
types AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TType'),
operation AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TInvocable'),
climb(ref, at) AS (          -- every entity of the code, up to the nearest type around it
  SELECT e.id, e.id FROM entity e WHERE e.is_stub IS NOT 1
  UNION ALL
  SELECT c.ref, e.parent_id FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NOT NULL
     AND e.trait_set_id NOT IN (SELECT trait_set_id FROM types)),
owner(ref, type) AS MATERIALIZED (
  SELECT c.ref, c.at FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.trait_set_id IN (SELECT trait_set_id FROM types)),
own_write(op, field) AS MATERIALIZED (   -- a write to a field of the operation's own type
  SELECT x.from_id, x.to_id
    FROM edge x
    JOIN edge_kind k ON k.id = x.kind_id
    JOIN owner o ON o.ref = x.from_id
    JOIN owner f ON f.ref = x.to_id
   WHERE k.name = 'access' AND x.is_write = 1 AND o.type = f.type AND x.from_id <> o.type),
thrower(op) AS MATERIALIZED (
  SELECT DISTINCT from_ref FROM dep WHERE kind = 'throws'),
state(type, field) AS (      -- a field typed by an enum of the code, written by its own type
  SELECT DISTINCT o.type, fe.name
    FROM own_write w
    JOIN owner o   ON o.ref = w.op
    JOIN entity fe ON fe.id = w.field
    JOIN entity dt ON dt.id = fe.declared_type_id
    JOIN kind dk   ON dk.id = dt.kind_id
   WHERE dk.name = 'enum' AND dt.is_stub IS NOT 1),
ops(type, op, writes, throws) AS (
  SELECT o.type, o.ref,
         o.ref IN (SELECT op FROM own_write),
         o.ref IN (SELECT op FROM thrower)
    FROM owner o JOIN entity e ON e.id = o.ref
   WHERE e.trait_set_id IN (SELECT trait_set_id FROM operation)),
counted(type, operations, writes, throws, guarded) AS (
  SELECT type, count(*), sum(writes), sum(throws), sum(writes AND throws)
    FROM ops GROUP BY type),
fields(type, list) AS (
  SELECT type, group_concat(field, ', ')
    FROM (SELECT type, field FROM state ORDER BY type, field)
   GROUP BY type)
SELECT n.id AS type,
       c.operations, c.writes, c.throws, c.guarded,
       s.list AS state
  FROM counted c
  JOIN node n ON n.ref = c.type
  LEFT JOIN fields s ON s.type = c.type
 WHERE c.writes > 0 OR c.throws > 0
 ORDER BY c.guarded DESC, s.list IS NULL, c.throws DESC, c.writes DESC, n.id;

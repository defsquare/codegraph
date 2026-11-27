-- page: discover/stimuli.md
-- what: the types nothing that starts at an entry point mentions, with the revisions of their file
-- parameters: :inventory — the saved rows of entry-points.sql, :activity — step 3's joined hotspot report for every file, or {"rows":[]}

WITH RECURSIVE
types AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TType'),
operation AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TInvocable'),
climb(ref, at) AS (          -- from each entity up to the nearest type around it
  SELECT id, id FROM entity
  UNION ALL
  SELECT c.ref, e.parent_id FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NOT NULL
     AND e.trait_set_id NOT IN (SELECT trait_set_id FROM types)),
owner(ref, type) AS MATERIALIZED (
  SELECT c.ref, c.at FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NULL
      OR e.trait_set_id IN (SELECT trait_set_id FROM types)),
uses(a, b) AS MATERIALIZED ( -- type a mentions type b: any edge, any provenance
  SELECT f.type, t.type FROM edge x
    JOIN owner f ON f.ref = x.from_id JOIN owner t ON t.ref = x.to_id
  UNION
  SELECT f.type, t.type FROM edge_candidate c JOIN edge x ON x.id = c.edge_id
    JOIN owner f ON f.ref = x.from_id JOIN owner t ON t.ref = c.candidate_id
  UNION                      -- the declared type of a field or a parameter
  SELECT f.type, t.type FROM entity e
    JOIN owner f ON f.ref = e.id JOIN owner t ON t.ref = e.declared_type_id
  UNION                      -- a part written elsewhere and the type it belongs to, both ways
  SELECT f.type, t.type FROM entity e
    JOIN owner f ON f.ref = e.id JOIN owner t ON t.ref = e.attached_to_id
  UNION
  SELECT t.type, f.type FROM entity e
    JOIN owner f ON f.ref = e.id JOIN owner t ON t.ref = e.attached_to_id
  UNION                      -- a type and a type written inside it, both ways
  SELECT p.id, e.id FROM entity e JOIN entity p ON p.id = e.parent_id
   WHERE e.trait_set_id IN (SELECT trait_set_id FROM types)
     AND p.trait_set_id IN (SELECT trait_set_id FROM types)
  UNION
  SELECT e.id, p.id FROM entity e JOIN entity p ON p.id = e.parent_id
   WHERE e.trait_set_id IN (SELECT trait_set_id FROM types)
     AND p.trait_set_id IN (SELECT trait_set_id FROM types)),
classified(id) AS MATERIALIZED (   -- the inventory's rows that have a stimulus
  SELECT json_extract(r.value, '$[0]')
    FROM json_each(:inventory, '$.rows') r
   WHERE json_extract(r.value, '$[4]') IS NOT NULL),
touched(type) AS (           -- from the classified entry points, through every mention
  SELECT o.type
    FROM node n JOIN owner o ON o.ref = n.ref
   WHERE n.id IN (SELECT id FROM classified)
  UNION
  SELECT u.b FROM touched t JOIN uses u ON u.a = t.type),
activity(file, revisions) AS MATERIALIZED (
  SELECT json_extract(h.value, '$.model'), json_extract(h.value, '$.revisions')
    FROM json_each(:activity, '$.rows') h)
SELECT n.id AS type, n.kind, f.path AS file,
       (SELECT em.value FROM entity_metric em
         WHERE em.entity_id = n.ref AND em.key = 'sloc') AS sloc,
       -- no history given: not measured, which is not zero
       CASE WHEN (SELECT count(*) FROM activity) = 0 THEN NULL
            ELSE coalesce(a.revisions, 0) END AS revisions
  FROM node n
  JOIN entity e ON e.id = n.ref
  LEFT JOIN file f     ON f.id = e.anchor_file_id
  LEFT JOIN activity a ON a.file = f.path
 WHERE NOT n.is_stub
   AND n.ref NOT IN (SELECT type FROM touched)
   -- a type; or, where functions are written straight in a file, that file
   AND (n.trait_set_id IN (SELECT trait_set_id FROM types)
        OR (e.parent_id IS NULL
            AND EXISTS (SELECT 1 FROM entity c
                         WHERE c.parent_id = n.ref AND c.is_stub IS NOT 1
                           AND c.trait_set_id IN (SELECT trait_set_id FROM operation)
                           AND c.trait_set_id NOT IN (SELECT trait_set_id FROM types))))
 ORDER BY revisions DESC, sloc DESC, type;

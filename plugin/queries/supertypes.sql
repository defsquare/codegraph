-- page: discover/stimuli.md
-- what: the external types the code extends, implements or mixes in, and how many of its types do
-- parameters: none

SELECT t.id AS supertype, d.kind AS relation,
       count(DISTINCT d.from_ref) AS types, min(n.id) AS example
  FROM dep d
  JOIN node t ON t.ref = d.to_ref
  JOIN node n ON n.ref = d.from_ref
 WHERE d.kind IN ('inheritance', 'interfaceImplementation', 'traitUsage')
   AND t.is_stub AND NOT n.is_stub
 GROUP BY t.ref, d.kind
 ORDER BY types DESC, supertype, relation
 LIMIT 40;

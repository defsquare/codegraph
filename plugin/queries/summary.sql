-- page: how-to/query-model-db.md
-- what: the model in one row — its language and how much it holds
-- parameters: none

SELECT (SELECT value FROM meta WHERE key = 'lang')     AS lang,
       (SELECT count(*) FROM entity)                   AS entities,
       (SELECT count(*) FROM entity WHERE is_stub = 1) AS stubs,
       (SELECT count(*) FROM edge)                     AS edges,
       (SELECT count(*) FROM file)                     AS files;

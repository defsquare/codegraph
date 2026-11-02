PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
INSERT INTO meta VALUES('eof','{"t":"eof","counts":{"records":6,"llm":2,"template":0,"reused":4,"failed":2},"usage":{"promptTokens":3200,"completionTokens":1100,"cost":0.0009},"generatedAt":"2026-10-27T10:05:00.000Z"}');
INSERT INTO meta VALUES('exported','{"path":"model.insights.jsonl","size":4321,"mtimeMs":1760950800000}');
INSERT INTO meta VALUES('header','{"t":"header","kind":"codegraph.insights/1","generatedBy":"@codegraph/insights","promptVersion":"2","metamodel":"specy.domain/3","models":{"leaf":"openai/gpt-5.6-luna","rollup":"openai/gpt-5.6-luna"},"provider":"openrouter","depth":1,"source":{"paths":["model.jsonl"],"langs":["java"],"view":{"name":"all","filters":[]}}}');
CREATE TABLE run (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  pid INTEGER,
  provider TEXT,
  leaf TEXT NOT NULL,
  rollup TEXT NOT NULL,
  depth INTEGER NOT NULL,
  llm INTEGER, template INTEGER, reused INTEGER, failed INTEGER, calls INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
  aborted TEXT
);
INSERT INTO run VALUES(1,'2026-10-27T10:00:00.000Z','2026-10-27T10:05:00.000Z',4242,'openrouter','openai/gpt-5.6-luna','openai/gpt-5.6-luna',1,2,0,4,2,2,3200,1100,0.0009,NULL);
CREATE TABLE insight (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  file TEXT,
  key_lang TEXT, key_module TEXT, key_symbol TEXT, key_disambiguator TEXT,
  scc TEXT,
  origin TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
  metadata TEXT,
  block TEXT NOT NULL,
  concept TEXT GENERATED ALWAYS AS (block ->> '$.concept') VIRTUAL,
  confidence REAL GENERATED ALWAYS AS (block ->> '$.confidence') VIRTUAL,
  run_id INTEGER REFERENCES run(id)
);
INSERT INTO insight VALUES('java:com.acme.order/Basket.add(com.acme.order.Basket.Line)',0,'method',NULL,NULL,'java','com.acme.order','Basket.add','(com.acme.order.Basket.Line)','["java:com.acme.order/Basket.add(com.acme.order.Basket.Line)"]','llm','1111111111111111111111111111111111111111111111111111111111111111','openai/gpt-5.6-luna',1400,450,0.0004,NULL,'{"name":"add","description":"Adds a line — « déjà » 注文 📦.","safe":true,"idempotent":true,"owner":"entity","handlesCommand":null,"emits":[],"preconditions":[],"postconditions":[],"invariantsEnforced":[],"usesSpi":[],"domainTerms":["order"],"confidence":0.8}',NULL);
INSERT INTO insight VALUES('java:com.acme.order/Order.reference()',0,'method','reference','com/acme/order/Order.java','java','com.acme.order','Order.reference','()',NULL,'template','1111111111111111111111111111111111111111111111111111111111111111',NULL,NULL,NULL,NULL,NULL,'{"name":"reference","description":"Returns the reference.","safe":true,"idempotent":true,"owner":"entity","handlesCommand":null,"emits":[],"preconditions":[],"postconditions":[],"invariantsEnforced":[],"usesSpi":[],"domainTerms":["order"],"confidence":0.8}',NULL);
INSERT INTO insight VALUES('java:com.acme.order/Order.total()',0,'method','total','com/acme/order/Order.java','java','com.acme.order','Order.total','()',NULL,'llm','1111111111111111111111111111111111111111111111111111111111111111','openai/gpt-5.6-luna',1400,450,0.0004,NULL,'{"name":"total","description":"Sums the order''s lines.","safe":true,"idempotent":true,"owner":"entity","handlesCommand":null,"emits":[],"preconditions":[],"postconditions":[],"invariantsEnforced":[],"usesSpi":[],"domainTerms":["order"],"confidence":0.8}',NULL);
INSERT INTO insight VALUES('java:com.acme.order/Basket',1,'class','Basket',NULL,'java','com.acme.order','Basket',NULL,NULL,'llm','1111111111111111111111111111111111111111111111111111111111111111','openai/gpt-5.6-luna',1400,450,0.0004,NULL,'{"name":"Basket","description":"A customer''s order.","concept":"entity","eventKind":null,"interfaceRole":null,"aggregateRoot":false,"containedIn":null,"syncPattern":null,"identity":"reference","fields":[],"invariants":[],"stateMachine":null,"relatesTo":[],"exposes":[],"dependsOn":[],"domainTerms":["order"],"confidence":0.9}',NULL);
INSERT INTO insight VALUES('java:com.acme.order/Order',1,'class','Order','com/acme/order/Order.java','java','com.acme.order','Order',NULL,NULL,'llm','2222222222222222222222222222222222222222222222222222222222222222','openai/gpt-5.6-luna',1400,450,0.0004,NULL,'{"name":"Order","description":"A customer''s order.","concept":"aggregate","eventKind":null,"interfaceRole":null,"aggregateRoot":true,"containedIn":null,"syncPattern":null,"identity":"reference","fields":[],"invariants":[],"stateMachine":null,"relatesTo":[],"exposes":[],"dependsOn":[],"domainTerms":["order"],"words":[{"word":"order","in":["Order"],"concern":"domain","sense":"a customer''s request","meaning":"What a customer asked to buy.","confidence":0.9},{"word":"reference","in":["reference"],"concern":"domain","sense":"the order''s identity","meaning":"How an order is told apart.","confidence":0.7}],"confidence":0.9}',1);
INSERT INTO insight VALUES('java:com.acme.order',2,'package','com.acme.order',NULL,'java','com.acme.order','com.acme.order',NULL,NULL,'llm','2222222222222222222222222222222222222222222222222222222222222222','openai/gpt-5.6-luna',1400,450,0.0004,NULL,'{"name":"Ordering","description":"Takes orders.","apis":[],"spis":[],"dependsOn":[],"concepts":[{"name":"Order","concept":"aggregate"}],"boundedContextHint":{"name":"Ordering","rationale":"its own words"},"sharedKernelHint":null,"ubiquitousLanguage":[],"words":[{"word":"order","in":["com.acme.order"],"concern":"domain","sense":"the ordering business","meaning":"The package that takes orders.","confidence":0.8}],"glossary":[{"word":"order","concern":"domain","sense":"a customer''s request","meaning":"What a customer asked to buy.","polysemous":false,"senses":[]}],"confidence":0.6}',1);
CREATE TABLE failure (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  members TEXT NOT NULL,
  key_lang TEXT, key_module TEXT, key_symbol TEXT, key_disambiguator TEXT,
  model TEXT NOT NULL,
  reason TEXT NOT NULL,
  reason_kind TEXT GENERATED ALWAYS AS (reason ->> '$.kind') VIRTUAL,
  status INTEGER GENERATED ALWAYS AS (reason ->> '$.status') VIRTUAL,
  attempts INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
  run_id INTEGER REFERENCES run(id)
);
INSERT INTO failure VALUES('java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object)',0,'["java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object)"]',NULL,NULL,NULL,NULL,'openai/gpt-5.6-luna','{"kind":"provider","message":"no credits","status":402,"retryable":false}',1,1,NULL,NULL,NULL,1);
INSERT INTO failure VALUES('java:com.acme.order.legacy/List',1,'["java:com.acme.order.legacy/List","java:com.acme.order.legacy/Node"]','java','com.acme.order.legacy','List',NULL,'openai/gpt-5.6-luna','{"kind":"invalid-answer","message":"missing `fields`"}',2,2,3000,900,NULL,1);
CREATE INDEX insight_concept ON insight(concept) WHERE concept IS NOT NULL;
CREATE INDEX insight_run ON insight(run_id) WHERE run_id IS NOT NULL;
COMMIT;
-- '.dump' carries neither: the version-1 build stamped the file with both.
PRAGMA application_id = 1128745265;
PRAGMA user_version = 1;

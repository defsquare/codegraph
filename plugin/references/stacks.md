# Stack tables: which names mean "called from outside"

Step 4 finds entry points from a **stack table**: one JSON file of names, each
with the kind of stimulus it stands for. The method is the page's
(https://codegraph.biz/docs/discover/stimuli/#the-stack-table); the tables are
in `stacks/`, beside this file. A table is data you copy into the workspace
and extend there. You never edit the plugin's copy.

## The maps of a table

| Map | A key is | It finds |
|---|---|---|
| `annotations` | an annotation's name, as the census of step 2 prints it | whatever carries it |
| `supertypes` | the name of a type the framework calls, as the supertype census prints it | the uncalled operations of every type below it |
| `types` | a pattern on a type's name: `*Controller`, `Mix.Tasks.*` | the uncalled operations of the types it matches |
| `operations` | an operation's name: `main`, `perform` | the uncalled operations of that name |
| `entries` | an id | that entity: what a person said is an entry point |
| `conventional` | (a list) the names the language itself calls | nothing: those are left out of the `no caller` rows |

A value is one of eight kinds, the page's: `inbound command`,
`inbound query`, `inbound request` (the name does not say whether it reads or
changes), `external event`, `internal event`, `temporal`, `lifecycle`,
`framework callback`. Write no other word: a row with another word is a row
the chains still walk and no reader can file.

`conventional` is the language profile's list. Leave it as shipped.

## The tables that ship, and what each was checked on

Each was run on a real codebase and its rows read. "Checked" means that: the
names in it were seen to find what they claim there. A name that found
nothing on the corpus is in the table because the framework documents it.

| Table | Language | Pick it when step 2 shows | Checked on | Found there |
|---|---|---|---|---|
| `spring.json` | Java | `org.springframework` modules | spring-petclinic `500158f` | 32 by annotation, exactly the entry points of `--report wiring`; 6 by supertype; `main`; 16 unclassified |
| `aspnet.json` | C# | `Microsoft.AspNetCore` modules | dotnet/eShop `ab10e4c`; OrchardCore `045b6d1` | eShop: 14 by attribute, 44 by supertype, 392 unclassified. OrchardCore: 399 and 587, 2 252 unclassified |
| `nestjs.json` | TypeScript | decorators named `Controller`, `Injectable`, `Module` | the 39 sample apps of nestjs/nest `94df49d` | 130 by decorator, 33 by supertype, 35 unclassified |
| `phoenix.json` | Elixir | `Phoenix` and `Plug` under `<deps>` | plausible/analytics `418da46` | 170 by type name, 253 by operation name, 11 by behaviour, 839 unclassified |
| `rails.json` | Ruby | `ActionController::Base`, `ActiveRecord::Base` under `<gems>` | mastodon `v4.3.0` | 1 543 by supertype, 1 277 unclassified |

## What each table does not find — say it before the person asks

- **Spring.** A getter a template reads and a setter a binder calls: they are
  the unclassified `no caller` rows, and they are not entry points. XML bean
  definitions, a `@ComponentScan` filter, a custom annotation that is itself
  annotated (`@MyService`): read the annotation census for those names. On
  PetClinic one row is wrong: `cacheConfiguration()` is called inside a
  lambda, as the argument of a call on a parameter with no written type, and
  the extractor does not draw that call.
- **ASP.NET Core.** A minimal API route: `app.MapGet("/items", GetAllItems)`
  passes the handler as a value, and that is not an edge. The handlers are
  unclassified `no caller` rows (eShop's `OrdersApi.CreateOrderAsync`), or
  missing when another handler calls them. A gRPC service extends a generated
  base class whose name is the application's: add it to `supertypes` from the
  census. Convention-routed MVC actions are found by `Controller`; so are a
  controller's public helpers.
- **NestJS.** `Query` is a GraphQL resolver's decorator and a REST parameter's:
  its rows of kind `parameter` are bindings. When `@nestjs/common` resolves to
  source outside the extracted roots (a monorepo path mapping), a decorator is
  filed as its file, not by name, and the table finds nothing: extract the
  application alone.
- **Phoenix.** Which controller function is routed: `router.ex` says it with
  macros, which are not edges, so every uncalled function of a `*Controller`
  module is listed. `use GenServer`, `use Oban.Worker`, `use Phoenix.LiveView`
  are not supertypes unless a compiler trace was merged (`capabilities.md`):
  the callbacks are found by their name instead (`handle_info`, `perform`,
  `mount`), in any module.
- **Rails.** Which controller method is an action and which a `before_action`
  filter or a private helper: the model has no visibility, all are listed. A
  Rake task and a route are blocks of a DSL, not operations. A controller
  that extends a gem's controller (Devise, Doorkeeper) is found only when
  that class is added to `supertypes` from the census.

## A framework with no table: not covered

Jakarta EE and JAX-RS, Micronaut, Quarkus, Azure Functions, Express, Fastify,
Next.js, Sinatra, Grape, Hanami, and anything in-house. Say "no table for this
framework", then build one, and say it is yours:

1. Copy the table of the same language. Keep `operations` and `conventional`.
2. From `annotations`, `supertypes` and `types`, remove every name the two
   censuses do not show.
3. Add the names the censuses show that mean "called from outside". Each one
   you add on your own reading is a guess: the finding's `note` lists them.

## Extending a table with what a person says

- "These classes are all commands" → a line in `types`: `"*Handler": "inbound command"`.
- "That base class is ours, the framework calls its children" → a line in
  `supertypes`.
- "This one method is called by the scheduler" → a line in `entries`, with its
  id as the inventory prints it.

Then run the inventory again. What a person said is a `said` finding of its
own (`evidence.md`); the table in the workspace is where it takes effect.

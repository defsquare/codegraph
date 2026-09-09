---
title: Serve the navigator and city on a network
linkTitle: Serve on a network
weight: 11
---

`codegraph serve` starts a small HTTP server with both artifacts loaded: the
navigator, with the 3D city as one of its tabs. By default it binds **every**
interface, which is convenient on a LAN and wrong for a codebase you would not
email. This guide covers both, and the route that needs no server from codegraph
at all.

**Before you start:** a built workspace — `serve` needs the built frontend
(`pnpm -r build`).

## Keep it on this machine

```bash
codegraph serve model.jsonl --host 127.0.0.1
```

```text
codegraph at http://localhost:4177/ — Ctrl-C to stop.
```

`serve` defaults to port 4177. `replay --serve` and `history --serve` open the
standalone city viewer on a replay and also default to 4177 — run them one at a
time, or give each its own port.

## Share it on a LAN

The default `--host 0.0.0.0` already does this. The announcement never prints
`http://0.0.0.0:4177/`, which nobody can type; it prints the local URL and states
the reach beside it — `(every interface — reachable from other machines)`.
Colleagues reach it at your machine's own address on that port.

{{< callout type="warning" >}}
The server has no authentication and serves the whole model — every type, every
member, every source anchor. On a shared network, `--host 127.0.0.1` is the
setting you want unless you have decided otherwise.
{{< /callout >}}

## Pick a port

```bash
codegraph serve model.jsonl --host 127.0.0.1 --port 0
```

`--port 0` takes any free port and announces the one it got:

```text
codegraph at http://localhost:38885/ — Ctrl-C to stop.
```

**If the port is taken:**

```text
codegraph: port 4177 is already in use — pick another with --port (0 = any free port).
```

**If the address does not exist on this machine:**

```text
codegraph: cannot bind 10.0.0.5 — no interface on this machine has that address. Use --host 0.0.0.0 for every interface, or 127.0.0.1 for this machine only.
```

## Serve it yourself, in two steps

`serve` is a convenience. The artifacts and the viewer are separate things, so
you can put the artifacts on any static host — behind your own authentication,
in a CI job's pages, or on a share.

1. Write the artifacts. The city must be **laid out**; `serve` does that
   implicitly, `city --out` does not.

   ```bash
   codegraph city model.jsonl --layout --internal-only --out city.json
   codegraph navigator model.jsonl --out navigator.json
   ```

2. Publish them next to the built frontend. `packages/navigator-ui/dist` loads
   `navigator.json` and `city.json` from beside its `index.html` (the City tab
   loads the city on first visit). Both accept an explicit URL — `?src=URL` for
   the navigator artifact, `?city=URL` for the city — which is how one deployed
   bundle serves several corpora. The standalone city viewer in
   `packages/viz/dist` still loads a `city.json` (or `?src=URL`) on its own.

Both artifacts are plain JSON and deterministic, so they cache well and diff
cleanly.

## Related

- [Your first code city](/docs/tutorials/first-city/)
- [Finding what depends on a class](/docs/tutorials/navigator/)
- [`codegraph serve`](/docs/reference/cli/serve/)
- [`codegraph city`](/docs/reference/cli/city/)
- [`codegraph navigator`](/docs/reference/cli/navigator/)
- [`city.json` reference](/docs/reference/artifacts/city-json/)

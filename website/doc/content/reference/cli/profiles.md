---
title: "profiles"
weight: 14
---

Print the language profiles core ships.

## Synopsis

```
codegraph profiles [--lang LANG] [--json]
```

## Options

| Option | Meaning | Default |
|---|---|---|
| `--lang LANG` | Print only this language's profile (the EntityId prefix, e.g. java). | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` is not returned: the command reads no model.

## Example

```console
$ codegraph profiles
lang    kinds  notes  edge kinds
clj        10     13  import, interfaceImplementation, invocation, access, reference
csharp     14      7  import, inheritance, interfaceImplementation, invocation, access, reference
go         10      9  import, interfaceImplementation, invocation, access, reference, embedding
java       12     15  import, inheritance, interfaceImplementation, invocation, access, reference, annotationUse, throws
js          8     13  import, inheritance, invocation, access, reference
php        12     10  import, inheritance, interfaceImplementation, invocation, access, reference, traitUsage, fileInclude
python      9     10  import, inheritance, interfaceImplementation, invocation, access, reference
```

Trimmed to seven of the nine profiles.

## See also

[Language profiles](/reference/profiles/) · [Profiles (metamodel)](/reference/metamodel/profiles/) · [CLI conventions](/reference/cli/)

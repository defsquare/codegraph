#!/usr/bin/env python3
"""codegraph-trace — what a running Python program holds that its source does not
write, for `codegraph-python --trace` (PLAN.md §23.5).

Run the program THROUGH it, from the directory given to `--src`:

    python /path/to/codegraph_trace.py -m pytest
    CODEGRAPH_TRACE_CALLS=1 python /path/to/codegraph_trace.py -m pytest tests/
    python /path/to/codegraph_trace.py manage.py check

It runs YOUR code, which the extractor never does: that is why it is a separate
step, yours to take, in a project that still imports. One file, the standard
library alone, Python 3.8 or later, nothing patched: it reads the interpreter
when the program exits and, when asked, listens to the calls it makes
(`sys.monitoring` from 3.12, `sys.setprofile` before).

    CODEGRAPH_TRACE_ROOT   the directory given to `--src` (default: the working directory)
    CODEGRAPH_TRACE_OUT    the file to write (default: codegraph-trace.jsonl)
    CODEGRAPH_TRACE_CALLS  1 to record calls too — every call is slowed, so run the tests, not production

THE FORMAT. One JSON object per line: the header, then each kind sorted, then
the end. A path is below the root, with `/`; a name is Python's own
(`__qualname__`, `<locals>` kept); nothing is a key — the extractor finds its
own entities from names, files and lines.

    {"t":"header","tool":"codegraph-trace","version":"0.1.0","python":"3.12.3","root":"/abs/root"}
    {"t":"base","file":F,"class":Q,"index":I,"module":M,"name":N[,"at":F2]}
        the I-th of `__bases__` of the class Q whose module is the file F: its
        `__module__` M, its `__qualname__` N and, when it is defined below the
        root, the file F2 of its module
    {"t":"function","file":F,"line":L,"name":Q}
        a function the interpreter holds whose code is in F, starting on line L
        (`co_firstlineno`: a decorated def's first decorator)
    {"t":"call","file":F,"line":L,"name":N,"at":F2,"def":L2}
        a call made on line L of F that entered the function N whose code starts
        on line L2 of F2
    {"t":"eof","bases":n,"functions":n,"calls":n}
"""
import atexit
import gc
import inspect
import json
import os
import runpy
import sys
import threading
import types

VERSION = "0.1.0"
TOOL = "codegraph-trace"
ROOT = os.path.realpath(os.environ.get("CODEGRAPH_TRACE_ROOT") or os.getcwd())
OUT = os.path.abspath(os.environ.get("CODEGRAPH_TRACE_OUT") or "codegraph-trace.jsonl")
CALLS = os.environ.get("CODEGRAPH_TRACE_CALLS") == "1"

_below = {}
_calls = set()
_stop = []


def relative(path):
    """`path` below the root, with `/`; None for anything else — a library's, `<string>`."""
    if not isinstance(path, str) or not path or path.startswith("<"):
        return None
    found = _below.get(path, False)
    if found is False:
        full = os.path.realpath(path)
        found = None
        if full.startswith(ROOT + os.sep):
            found = full[len(ROOT) + 1:].replace(os.sep, "/")
        _below[path] = found
    return found


def module_file(name):
    module = sys.modules.get(name) if isinstance(name, str) else None
    return relative(getattr(module, "__file__", None))


def is_function(code):
    """A function's code — not a module's or a class body's, nor a lambda's or a comprehension's."""
    return bool(code.co_flags & inspect.CO_OPTIMIZED) and not code.co_name.startswith("<")


def record_call(code, caller):
    at = relative(code.co_filename)
    if at is None or caller is None or not is_function(code):
        return
    file = relative(caller.f_code.co_filename)
    if file is not None:
        _calls.add((file, caller.f_lineno, code.co_name, at, code.co_firstlineno))


def listen():
    monitoring = getattr(sys, "monitoring", None)
    if monitoring is not None:
        tool = next(
            (candidate for candidate in range(6) if monitoring.get_tool(candidate) is None),
            None,
        )
        if tool is not None:
            monitoring.use_tool_id(tool, TOOL)

            def started(code, offset):
                # Frame 1 is the function just started; its caller made the call.
                if relative(code.co_filename) is None or not is_function(code):
                    return monitoring.DISABLE
                record_call(code, sys._getframe(1).f_back)
                return None

            monitoring.register_callback(tool, monitoring.events.PY_START, started)
            monitoring.set_events(tool, monitoring.events.PY_START)
            _stop.append(lambda: monitoring.set_events(tool, 0))
            return

    def profile(frame, event, arg):
        if event == "call":
            record_call(frame.f_code, frame.f_back)

    sys.setprofile(profile)
    threading.setprofile(profile)
    _stop.append(lambda: sys.setprofile(None))


def line(record):
    return json.dumps(record, separators=(",", ":"))


def records():
    bases, functions = set(), set()
    for obj in gc.get_objects():
        try:
            if isinstance(obj, types.FunctionType):
                code = obj.__code__
                file = relative(code.co_filename)
                if file is not None and not obj.__name__.startswith("<"):
                    name = getattr(obj, "__qualname__", obj.__name__)
                    functions.add(line({"t": "function", "file": file, "line": code.co_firstlineno, "name": name}))
            elif isinstance(obj, type):
                # A class may redefine its attributes: ask `type`, not the class.
                module = type.__getattribute__(obj, "__module__")
                file = module_file(module)
                if file is None:
                    continue
                qualname = type.__getattribute__(obj, "__qualname__")
                for index, base in enumerate(type.__getattribute__(obj, "__bases__")):
                    base_module = type.__getattribute__(base, "__module__")
                    record = {
                        "t": "base",
                        "file": file,
                        "class": qualname,
                        "index": index,
                        "module": base_module,
                        "name": type.__getattribute__(base, "__qualname__"),
                    }
                    at = module_file(base_module)
                    if at is not None:
                        record["at"] = at
                    bases.add(line(record))
        except Exception:
            continue
    calls = {
        line({"t": "call", "file": file, "line": number, "name": name, "at": at, "def": start})
        for file, number, name, at, start in _calls
    }
    return sorted(bases), sorted(functions), sorted(calls)


def write():
    for stop in _stop:
        stop()
    bases, functions, calls = records()
    header = {"t": "header", "tool": TOOL, "version": VERSION, "python": "%d.%d.%d" % sys.version_info[:3], "root": ROOT}
    eof = {"t": "eof", "bases": len(bases), "functions": len(functions), "calls": len(calls)}
    with open(OUT, "w", encoding="utf-8") as out:
        out.write("\n".join([line(header)] + bases + functions + calls + [line(eof)]) + "\n")
    sys.stderr.write(
        "codegraph-trace: %d bases, %d functions, %d calls -> %s\n" % (len(bases), len(functions), len(calls), OUT)
    )


def main(argv):
    if not argv or argv[0] in ("-h", "--help") or (argv[0] == "-m" and len(argv) < 2):
        sys.stderr.write("usage: codegraph_trace.py -m <module> [args…] | <script.py> [args…]\n")
        return 2
    atexit.register(write)
    if CALLS:
        listen()
    if argv[0] == "-m":
        # As `python -m`: the module runs as __main__, the working directory first on the path.
        sys.argv = argv[1:]
        sys.path[0] = os.getcwd()
        runpy.run_module(argv[1], run_name="__main__", alter_sys=True)
    else:
        sys.argv = argv
        sys.path[0] = os.path.dirname(os.path.abspath(argv[0]))
        runpy.run_path(argv[0], run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

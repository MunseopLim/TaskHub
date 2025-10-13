#!/usr/bin/env python
"""
Small helper to inspect the runtime encoding that TaskHub passes to Python.
The script prints the detected encodings for stdin/stdout/stderr along with the
value of PYTHONIOENCODING, then attempts to emit a short unicode sample.
It exits with code 0 even if the unicode write fails so you can observe the
behaviour in the terminal.
"""

from __future__ import print_function

import locale
import os
import sys


def safe_print(tag, value):
    try:
        print("[%s] %s" % (tag, value))
    except Exception as exc:  # noqa: BLE001 - intentionally broad for demo
        sys.stderr.write("[ERROR] failed to print %s: %s\n" % (tag, exc))


def main():
    safe_print("sys.version", sys.version.replace("\n", " "))
    safe_print("sys.getdefaultencoding", sys.getdefaultencoding())
    safe_print("locale.getpreferredencoding", locale.getpreferredencoding(False))
    safe_print("stdin.encoding", getattr(sys.stdin, "encoding", None))
    safe_print("stdout.encoding", getattr(sys.stdout, "encoding", None))
    safe_print("stderr.encoding", getattr(sys.stderr, "encoding", None))
    safe_print("PYTHONIOENCODING", os.environ.get("PYTHONIOENCODING"))

    sample = u"unicode sample: café, 한글, 😀"
    safe_print("write_test", sample)

    try:
        sys.stdout.flush()
    except Exception as exc:  # noqa: BLE001 - demonstration path
        sys.stderr.write("[ERROR] flush failed: %s\n" % exc)

    return 0


if __name__ == "__main__":
    sys.exit(main())

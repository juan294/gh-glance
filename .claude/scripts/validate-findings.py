#!/usr/bin/env python3
"""Validate a pre-launch report against the /pre-launch Output Contract.

/remediate runs this as a deterministic gate before parsing findings. The
consumer regex silently drops malformed findings, which would violate Rule #58
(100% coverage) -- so a malformed report has to fail loudly here instead.

Checks, over sections 4-11 only (the finding sections):
  - every `####` heading is a well-formed `<DOMAIN>-<SEVERITY><N> <Title>`
  - Finding IDs are unique
  - all ten required fields are present
  - the Severity field agrees with the severity letter in the ID
  - Files carries at least one `path:line` reference

Usage: validate-findings.py <report-path>
Exit 0 = contract satisfied. Exit 1 = violations (listed on stderr).
Exit 2 = report unreadable.
"""

import re
import sys

DOMAINS = ("AR", "FE", "BE", "PE", "DO", "SE", "QA", "UX")
SEVERITY_BY_LETTER = {
    "B": "launch-blocker",
    "H": "high",
    "M": "medium",
    "L": "low",
    "S": "strategic",
}
REQUIRED_FIELDS = (
    "Severity",
    "Time horizon",
    "Evidence type",
    "Files",
    "What's happening",
    "Why it matters",
    "Recommendation",
    "Regression risk",
    "Expected impact",
    "Effort estimate",
)
FINDING_SECTIONS = range(4, 12)  # sections 4-11 inclusive

SECTION_RE = re.compile(r"^##\s+(\d+)\.")
HEADING_RE = re.compile(r"^####\s+(.*)$")
FINDING_ID_RE = re.compile(r"^(%s)-(B|H|M|L|S)([0-9]+)$" % "|".join(DOMAINS))
# `- **Field:** value`, tolerating extra leading whitespace.
FIELD_RE = re.compile(r"^\s*[-*]\s+\*\*([^:*]+):\*\*\s*(.*)$")
# A file:line ref -- `path/to/file.ext:42` or `file.ext:42-88`.
FILE_REF_RE = re.compile(r"[\w./\\-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?")


def parse_findings(lines):
    """Yield (finding_id, title, line_no, fields) for each finding in 4-11."""
    section = None
    current = None

    for line_no, raw in enumerate(lines, start=1):
        line = raw.rstrip("\n")

        section_match = SECTION_RE.match(line)
        if section_match:
            if current:
                yield current
                current = None
            section = int(section_match.group(1))
            continue

        # A fenced block inside section 2 of the spec shows the template; only
        # real headings at the top level of a finding section count.
        heading_match = HEADING_RE.match(line)
        if heading_match and section in FINDING_SECTIONS:
            if current:
                yield current
            head = heading_match.group(1).strip()
            finding_id, _, title = head.partition(" ")
            current = (finding_id.strip(), title.strip(), line_no, {})
            continue

        if current is not None:
            field_match = FIELD_RE.match(line)
            if field_match:
                name = field_match.group(1).strip()
                current[3][name] = field_match.group(2).strip()

    if current:
        yield current


def main():
    if len(sys.argv) != 2:
        print("usage: validate-findings.py <report-path>", file=sys.stderr)
        return 2

    path = sys.argv[1]
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError as err:
        print(f"cannot read report: {err}", file=sys.stderr)
        return 2

    errors = []
    seen = {}
    count = 0

    for finding_id, title, line_no, fields in parse_findings(lines):
        count += 1
        where = f"{path}:{line_no}"

        id_match = FINDING_ID_RE.match(finding_id)
        if not id_match:
            errors.append(
                f"{where}: malformed Finding-ID {finding_id!r} -- expected "
                f"<{'|'.join(DOMAINS)}>-<B|H|M|L|S><N>"
            )
            continue

        if not title:
            errors.append(f"{where}: {finding_id} has no title")

        if finding_id in seen:
            errors.append(
                f"{where}: {finding_id} reuses an ID already defined at line {seen[finding_id]}"
            )
        else:
            seen[finding_id] = line_no

        missing = [name for name in REQUIRED_FIELDS if not fields.get(name)]
        if missing:
            errors.append(f"{where}: {finding_id} missing field(s): {', '.join(missing)}")

        declared = fields.get("Severity", "").strip().lower()
        expected = SEVERITY_BY_LETTER[id_match.group(2)]
        if declared and declared != expected:
            errors.append(
                f"{where}: {finding_id} severity letter {id_match.group(2)!r} means "
                f"{expected!r} but Severity says {declared!r}"
            )

        files = fields.get("Files", "")
        if files and not FILE_REF_RE.search(files):
            errors.append(
                f"{where}: {finding_id} Files has no file:line ref (got {files!r}) -- "
                "no refs = no finding"
            )

    if not count:
        errors.append(f"{path}: no findings parsed from sections 4-11")

    if errors:
        print(f"FAIL: {len(errors)} contract violation(s) in {path}\n", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        print(
            f"\n{count} finding(s) parsed. Fix the report before running /remediate.",
            file=sys.stderr,
        )
        return 1

    print(f"OK: {count} finding(s) satisfy the Output Contract in {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

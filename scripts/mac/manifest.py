"""Release metadata; all inputs are local files and no credential is printed."""
import datetime
import hashlib
import json
import pathlib
import re
import sys


def version(value):
    match = re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", value)
    if not match:
        raise ValueError("Release versions must be stable major.minor.patch versions")
    return tuple(map(int, match.groups()))


def main(args):
    command = args[0]
    if command == "version":
        package = re.search(r"(?ms)^\[package\]\s*$(.*?)(?=^\[|\Z)", pathlib.Path("apps/mac/Cargo.toml").read_text())
        if package is None:
            raise ValueError("Missing Cargo package")
        match = re.search(r'(?m)^version\s*=\s*"([^"]+)"\s*$', package.group(1))
        if match is None:
            raise ValueError("Missing Cargo package version")
        value = match.group(1)
        version(value)
        print(value)
    elif command == "newer":
        previous = json.loads(pathlib.Path(args[2]).read_text())
        if version(args[1]) <= version(previous["version"]):
            raise ValueError("Version must be newer than the published release")
    elif command == "manifest":
        version(args[1])
        dmg = pathlib.Path(args[2])
        sha = hashlib.sha256()
        with dmg.open("rb") as source:
            while block := source.read(1024 * 1024):
                sha.update(block)
        pathlib.Path(args[3]).write_text(json.dumps({
            "version": args[1], "sha256": sha.hexdigest(), "size": dmg.stat().st_size,
            "publishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }) + "\n")
    else:
        raise ValueError("Unknown command")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, KeyError, OSError, IndexError) as error:
        sys.exit(str(error))

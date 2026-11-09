#!/usr/bin/env python3
"""Validate and package the Budna plugin without third-party dependencies."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
VERSION_PATTERN = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
PUBLIC_ENDPOINT = "https://api.budna.se/mcp"
PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
SKILLS = {
    "recommerce-buy", "recommerce-collect", "recommerce-inspect",
    "recommerce-keep", "recommerce-kits", "recommerce-second-look",
}
MANIFESTS = (
    "plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json",
    "gemini-extension.json",
)
COMMON_FILES = {"README.md", "LICENSE", "plugin.json", "mcp.json", ".mcp.json", "gemini-extension.json"}
RUNTIME_FILES = {
    *MANIFESTS, ".claude-plugin/marketplace.json", ".mcp.json", "mcp.json",
    "README.md", "LICENSE",
}
TARGET_FILES = {
    "claude": {".claude-plugin/plugin.json"},
    "openai": {".codex-plugin/plugin.json"},
    "gemini": set(),
    "cursor": set(),
    "copilot": set(),
    "grok": {".claude-plugin/plugin.json"},
}
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_FILES = 256


def require(condition, message):
    if not condition:
        raise ValueError(message)


def release_version(tag):
    require(isinstance(tag, str) and re.fullmatch("v" + VERSION_PATTERN, tag),
            "tag must be vMAJOR.MINOR.PATCH with no leading zeroes or prerelease suffix")
    return tag[1:]


def archive_name(tag, target=None):
    release_version(tag)
    return f"budna-{tag}{'-' + target if target else ''}.zip"


def asset_names(tag):
    return {archive_name(tag), *(archive_name(tag, target) for target in TARGET_FILES)}


def safe_path(name):
    require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.\-/]+", name),
            f"unsafe file path: {name!r}")
    require(all(part not in ("", ".", "..", ".git") for part in name.split("/")),
            f"unsafe file path: {name!r}")
    require(name in RUNTIME_FILES or name.startswith(("assets/", "skills/")),
            f"unexpected runtime file: {name}")


def read_json(files, name):
    try:
        result = json.loads(files[name])
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid or missing JSON: {name}") from error
    require(isinstance(result, dict), f"JSON object required: {name}")
    return result


def file_reference(files, reference, directory=False):
    require(isinstance(reference, str) and reference.startswith("./"),
            f"repository-relative reference required: {reference!r}")
    name = reference[2:].rstrip("/") if directory else reference[2:]
    safe_path(name + "/SKILL.md" if directory else name)
    require(any(path.startswith(name + "/") for path in files) if directory else name in files,
            f"missing referenced path: {reference}")


def validate_snapshot(files, tag):
    version = release_version(tag)
    require(len(files) <= MAX_FILES, "too many runtime files")
    require(sum(map(len, files.values())) <= MAX_TOTAL_BYTES, "runtime payload too large")
    folded_paths = {name.casefold() for name in files}
    require(len(folded_paths) == len(files),
            "case-insensitive file path collision")
    for name, content in files.items():
        safe_path(name)
        require(not any("/".join(name.split("/")[:index]).casefold() in folded_paths
                        for index in range(1, len(name.split("/")))),
                f"file/directory path collision: {name}")
        require(0 < len(content) <= MAX_FILE_BYTES, f"empty or oversized file: {name}")
    require(RUNTIME_FILES <= files.keys(), "required runtime file missing")
    manifests = {name: read_json(files, name) for name in MANIFESTS}
    metadata_fields = {"name", "version", "description", "author", "homepage", "repository", "license"}
    allowed_fields = {
        "plugin.json": metadata_fields | {"$schema"},
        ".claude-plugin/plugin.json": metadata_fields | {"icon", "privacyPolicyUrl"},
        ".codex-plugin/plugin.json": metadata_fields | {"skills", "mcpServers", "interface", "extensions"},
        "gemini-extension.json": {"name", "version", "description", "mcpServers"},
    }
    for name, manifest in manifests.items():
        require(manifest.keys() <= allowed_fields[name], f"unexpected manifest fields: {name}")
        require(manifest.get("version") == version, f"version does not match {tag}: {name}")
        require(manifest.get("name") == "budna", f"plugin name must be budna: {name}")
        require(isinstance(manifest.get("description"), str) and manifest["description"].strip(),
                f"description required: {name}")
    portable = manifests["plugin.json"]
    require(portable.get("$schema") == PLUGIN_SCHEMA, "Agent Plugins 1.0 schema required")
    for name in MANIFESTS[:3]:
        manifest = manifests[name]
        for key, expected in {
            "description": portable["description"],
            "author": {"name": "Budna Marketplace AB", "url": "https://budna.se"},
            "homepage": "https://budna.se",
            "repository": "https://github.com/budna-marketplace/plugins",
            "license": "MIT",
        }.items():
            require(manifest.get(key) == expected, f"invalid or inconsistent {key}: {name}")
    claude = manifests[".claude-plugin/plugin.json"]
    require(claude.get("privacyPolicyUrl") == "https://legal.budna.se/privacy-policy",
            "Claude privacy policy required")
    file_reference(files, claude.get("icon"))
    codex = manifests[".codex-plugin/plugin.json"]
    require(codex.get("skills") == "./skills/", "Codex must use the shared skills directory")
    file_reference(files, codex["skills"], directory=True)
    require(codex.get("mcpServers") in ("./.mcp.json", "./mcp.json"),
            "Codex must reference a bundled MCP configuration")
    file_reference(files, codex["mcpServers"])
    interface = codex.get("interface", {})
    require(isinstance(interface, dict), "Codex interface required")
    for field, expected in {
        "websiteURL": "https://budna.se",
        "supportURL": "https://connect.budna.se/contact-us",
        "privacyPolicyURL": "https://legal.budna.se/privacy-policy",
        "termsOfServiceURL": "https://legal.budna.se/terms-of-service",
    }.items():
        require(interface.get(field) == expected, f"OpenAI {field} required")
    require(interface.get("capabilities") == ["Read"], "Codex must describe only the public read capability")
    for field in ("composerIcon", "logo"):
        file_reference(files, interface.get(field))
    extensions = codex.get("extensions", {})
    require(isinstance(extensions, dict) and extensions.keys() == {"com.openai"},
            "OpenAI review extension required")
    openai = extensions["com.openai"]
    require(isinstance(openai, dict) and openai.keys() == {"review"}, "OpenAI review metadata required")
    review = openai["review"]
    require(isinstance(review, dict) and review.keys() == {"test_cases"}, "OpenAI review cases required")
    cases = review["test_cases"]
    require(isinstance(cases, dict) and cases.keys() == {"positive", "negative"},
            "OpenAI positive and negative review cases required")
    for kind, count in (("positive", 5), ("negative", 3)):
        require(isinstance(cases[kind], list) and len(cases[kind]) == count,
                f"OpenAI review requires exactly {count} {kind} cases")
        for case in cases[kind]:
            fields = {"description", "prompt", "expected_behavior"}
            if kind == "positive":
                fields.add("tools_triggered")
            require(isinstance(case, dict) and case.keys() == fields,
                    f"invalid OpenAI {kind} review case fields")
            require(all(isinstance(case[field], str) and case[field].strip() for field in fields),
                    f"nonempty OpenAI {kind} review case fields required")
    expected_compat = {"mcpServers": {"budna": {"type": "http", "url": PUBLIC_ENDPOINT}}}
    require(read_json(files, ".mcp.json") == expected_compat,
            "compatibility MCP must use only the public endpoint without credentials")
    require(read_json(files, "mcp.json") == {
        "$schema": MCP_SCHEMA,
        "mcpServers": {"budna": {"type": "streamable-http", "url": PUBLIC_ENDPOINT}},
    }, "portable MCP schema and public endpoint required; credentials are forbidden")
    require(manifests["gemini-extension.json"].get("mcpServers") ==
            {"budna": {"httpUrl": PUBLIC_ENDPOINT}},
            "Gemini must use only the public endpoint without credentials")
    catalog = read_json(files, ".claude-plugin/marketplace.json")
    require(catalog.get("name") == "budna-marketplace" and
            isinstance(catalog.get("owner"), dict) and
            catalog["owner"].get("name") == "Budna Marketplace AB",
            "invalid marketplace identity")
    entries = catalog.get("plugins")
    require(isinstance(entries, list) and len(entries) == 1 and
            isinstance(entries[0], dict) and entries[0].get("name") == "budna" and
            entries[0].get("source") == "./" and entries[0].get("version", version) == version,
            "marketplace must reference the bundled plugin at its release version")
    require(entries[0].keys() <= {"name", "source", "version"}, "marketplace overrides are forbidden")
    require({name.split("/")[1] for name in files if name.startswith("skills/")} == SKILLS,
            "exactly the six Recommerce skill folders are required")
    for skill in SKILLS:
        for basename in ("SKILL.md", "LICENSE"):
            require(f"skills/{skill}/{basename}" in files, f"missing {skill}/{basename}")
        try:
            text = files[f"skills/{skill}/SKILL.md"].decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(f"invalid skill text: {skill}") from error
        frontmatter = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", text, re.S)
        require(frontmatter is not None, f"skill frontmatter required: {skill}")
        require(re.search(rf"^name: {re.escape(skill)}\s*$", frontmatter[1], re.M),
                f"skill name does not match directory: {skill}")
        require(re.search(r"^description:\s*\S", frontmatter[1], re.M),
                f"skill description required: {skill}")


def collect_runtime(root):
    require(not (root / ".gitmodules").exists(), "submodules are not allowed")
    if (root / ".git").exists():
        tracked = subprocess.run(["git", "-C", str(root), "ls-files", "--stage"],
                                 check=True, capture_output=True, text=True).stdout
        require(not any(line.startswith("160000 ") for line in tracked.splitlines()),
                "submodules are not allowed")
    paths = [root / name for name in RUNTIME_FILES]
    for directory in ("assets", "skills"):
        base = root / directory
        require(base.is_dir() and not base.is_symlink(), f"regular directory required: {directory}")
        for current, directories, names in os.walk(base, followlinks=False):
            for name in directories:
                require(not (Path(current) / name).is_symlink(), "symlinks are not allowed")
            paths.extend(Path(current) / name for name in names if name != ".DS_Store")
    require(len(paths) <= MAX_FILES, "too many runtime files")
    files = {}
    total = 0
    for path in paths:
        relative = path.relative_to(root).as_posix()
        for parent in path.parents:
            if parent == root:
                break
            require(not parent.is_symlink(), f"symlinks are not allowed: {relative}")
        require(stat.S_ISREG(path.lstat().st_mode), f"regular file required: {relative}")
        size = path.stat().st_size
        total += size
        require(size <= MAX_FILE_BYTES and total <= MAX_TOTAL_BYTES, f"oversized payload: {relative}")
        files[relative] = path.read_bytes()
    return files


def check(root, tag=None):
    files = collect_runtime(root)
    if tag is None:
        tag = "v" + str(read_json(files, "plugin.json").get("version", ""))
    validate_snapshot(files, tag)
    return files, tag


def zip_bytes(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(files):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(entry, files[name])
    return output.getvalue()


def target_snapshot(files, target):
    require(target in TARGET_FILES, f"unknown target: {target}")
    result = {name: content for name, content in files.items()
              if name in TARGET_FILES[target] or name in COMMON_FILES
              or name.startswith(("assets/", "skills/"))}
    if target == "openai":
        mcp = read_json(result, "mcp.json")
        mcp["mcpServers"]["budna"]["extensions"] = {"com.openai": {"auth": {"type": "none"}}}
        result["mcp.json"] = (json.dumps(mcp, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    return result


def digest(content):
    return hashlib.sha256(content).hexdigest()


def write_file(path, content):
    require(not path.parent.is_symlink(), "output directory cannot be a symlink")
    path.parent.mkdir(parents=True, exist_ok=True)
    require(not path.exists() or stat.S_ISREG(path.lstat().st_mode),
            f"output must be a regular file: {path}")
    require(not path.is_symlink(), f"output cannot be a symlink: {path}")
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary.write(content)
        temporary_name = temporary.name
    try:
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def build(root, tag, out):
    files, _ = check(root, tag)
    archives = {archive_name(tag): zip_bytes(files)}
    archives.update({archive_name(tag, target): zip_bytes(target_snapshot(files, target))
                     for target in TARGET_FILES})
    checksums = "".join(f"{digest(archives[name])}  {name}\n" for name in sorted(archives))
    for name, content in archives.items():
        write_file(out / name, content)
    write_file(out / "SHA256SUMS", checksums.encode("ascii"))


def read_checksums(path, tag):
    require(path.stat().st_size <= 4096 and stat.S_ISREG(path.lstat().st_mode),
            "invalid checksum file")
    checksums = {}
    for line in path.read_text(encoding="ascii").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9.\-]+)", line)
        require(match is not None, "invalid SHA256SUMS line")
        value, name = match.groups()
        require(name not in checksums, "duplicate checksum entry")
        checksums[name] = value
    require(checksums.keys() == asset_names(tag), "SHA256SUMS must list exactly the seven release ZIPs")
    return checksums


def load_release(source, checksums_path, tag):
    checksums = read_checksums(checksums_path, tag)
    require(source.name == archive_name(tag), "unexpected universal ZIP name")
    require(stat.S_ISREG(source.lstat().st_mode) and source.stat().st_size <= MAX_ARCHIVE_BYTES,
            "universal ZIP must be a bounded regular file")
    content = source.read_bytes()
    require(digest(content) == checksums[source.name], "universal ZIP checksum mismatch")
    files = {}
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        entries = archive.infolist()
        require(len(entries) <= MAX_FILES, "too many ZIP entries")
        require(sum(entry.file_size for entry in entries) <= MAX_TOTAL_BYTES, "ZIP payload too large")
        for entry in entries:
            safe_path(entry.filename)
            require(entry.filename not in files, "duplicate ZIP entry")
            mode = stat.S_IFMT(entry.external_attr >> 16)
            require(mode in (0, stat.S_IFREG) and not entry.is_dir(),
                    f"ZIP entry must be a regular file: {entry.filename}")
            require(0 < entry.file_size <= MAX_FILE_BYTES, f"empty or oversized ZIP entry: {entry.filename}")
            require(not entry.flag_bits & 1 and entry.compress_type in
                    (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "unsupported ZIP encoding")
            files[entry.filename] = archive.read(entry)
    validate_snapshot(files, tag)
    return files, checksums


def export(tag, target, source, checksums_path, out):
    files, checksums = load_release(source, checksums_path, tag)
    name = archive_name(tag, target)
    content = zip_bytes(target_snapshot(files, target))
    require(digest(content) == checksums[name], f"derived target checksum mismatch: {target}")
    write_file(out / name, content)
    write_file(out / (name + ".sha256"), f"{digest(content)}  {name}\n".encode("ascii"))


def verify(tag, directory):
    require({path.name for path in directory.iterdir()} == asset_names(tag) | {"SHA256SUMS"},
            "release directory must contain exactly seven ZIPs and SHA256SUMS")
    files, checksums = load_release(directory / archive_name(tag), directory / "SHA256SUMS", tag)
    for target in TARGET_FILES:
        name = archive_name(tag, target)
        path = directory / name
        require(stat.S_ISREG(path.lstat().st_mode) and path.stat().st_size <= MAX_ARCHIVE_BYTES,
                f"target ZIP must be a bounded regular file: {name}")
        require(digest(path.read_bytes()) == checksums[name] ==
                digest(zip_bytes(target_snapshot(files, target))), f"target ZIP checksum mismatch: {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check_parser = commands.add_parser("check")
    check_parser.add_argument("--tag")
    for command in ("build", "verify", "export"):
        subparser = commands.add_parser(command)
        subparser.add_argument("--tag", required=True)
        if command == "verify":
            subparser.add_argument("--directory", type=Path, required=True)
        else:
            subparser.add_argument("--out", type=Path, required=True)
        if command == "export":
            subparser.add_argument("--target", choices=TARGET_FILES, required=True)
            subparser.add_argument("--source", type=Path, required=True)
            subparser.add_argument("--checksums", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "check":
            _, tag = check(ROOT, args.tag)
            print(f"Validated Budna {tag}")
        elif args.command == "build":
            build(ROOT, args.tag, args.out)
            print(f"Built seven release ZIPs and SHA256SUMS in {args.out}")
        elif args.command == "verify":
            verify(args.tag, args.directory)
            print(f"Verified Budna {args.tag} release assets")
        else:
            export(args.tag, args.target, args.source, args.checksums, args.out)
            print(f"Exported {archive_name(args.tag, args.target)} from the verified release snapshot")
    except (ValueError, OSError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        parser.exit(1, f"release: {error}\n")


if __name__ == "__main__":
    main()

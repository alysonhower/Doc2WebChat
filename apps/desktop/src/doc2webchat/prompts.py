from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Any

MAX_PROMPT_BYTES = 64 * 1024 * 1024
TAG_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9._-]*$")
TAG_TOKEN_PATTERN = re.compile(r"</?([A-Za-z_][A-Za-z0-9._-]*)>")
INVALID_XML_CONTROL_PATTERN = re.compile(
    "[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]"
)


class PromptBuildError(ValueError):
    pass


@dataclass(frozen=True)
class TagValue:
    name: str
    raw: str
    trimmed: str
    start: int
    end: int
    parent_index: int | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "raw": self.raw,
            "trimmed": self.trimmed,
            "start": self.start,
            "end": self.end,
            "parentIndex": self.parent_index,
        }


@dataclass(frozen=True)
class ParseWarning:
    code: str
    message: str
    tag_name: str | None = None
    parent_index: int | None = None

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.tag_name is not None:
            value["tagName"] = self.tag_name
        if self.parent_index is not None:
            value["parentIndex"] = self.parent_index
        return value


@dataclass(frozen=True)
class ParsedResponse:
    values: list[TagValue]
    warnings: list[ParseWarning]


@dataclass(frozen=True)
class RenderedInstruction:
    text: str
    letter_offsets: tuple[int, ...]


@dataclass
class OpenTag:
    identity: int
    name: str
    start: int
    content_start: int
    parent_identity: int | None


@dataclass(frozen=True)
class ClosedTag:
    identity: int
    name: str
    raw: str
    start: int
    end: int
    parent_identity: int | None


def validate_structured_prompt(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("version") != 1:
        raise PromptBuildError("structured prompt version must be 1")
    root = value.get("root")
    definitions = value.get("definitions")
    if not isinstance(definitions, dict):
        raise PromptBuildError("definitions must be an object")
    seen_occurrences: set[str] = set()
    validate_document(root, seen_occurrences)
    for name, document in definitions.items():
        if not isinstance(name, str) or TAG_NAME_PATTERN.fullmatch(name) is None:
            raise PromptBuildError(f"invalid tag name: {name}")
        if document is not None:
            validate_document(document, seen_occurrences)
    return value


def validate_document(value: Any, seen_occurrences: set[str]) -> None:
    if not isinstance(value, dict) or value.get("version") != 1:
        raise PromptBuildError("instruction document version must be 1")
    nodes = value.get("nodes")
    if not isinstance(nodes, list):
        raise PromptBuildError("instruction document nodes must be an array")
    for node in nodes:
        if not isinstance(node, dict):
            raise PromptBuildError("instruction node must be an object")
        node_type = node.get("type")
        if node_type == "text":
            if set(node) != {"type", "text"} or not isinstance(node.get("text"), str):
                raise PromptBuildError("invalid text node")
            continue
        if node_type != "tag" or set(node) != {"type", "occurrenceId", "name"}:
            raise PromptBuildError("invalid instruction node")
        occurrence_id = node.get("occurrenceId")
        name = node.get("name")
        if not isinstance(occurrence_id, str) or not occurrence_id:
            raise PromptBuildError("tag occurrence ID must be a non-empty string")
        if occurrence_id in seen_occurrences:
            raise PromptBuildError(f"duplicate occurrence ID: {occurrence_id}")
        seen_occurrences.add(occurrence_id)
        if not isinstance(name, str) or TAG_NAME_PATTERN.fullmatch(name) is None:
            raise PromptBuildError(f"invalid tag name: {name}")


def serialize_instructions(value: Any) -> str:
    prompt = validate_structured_prompt(value)
    definitions = prompt["definitions"]
    defined_names: set[str] = set()

    def serialize_document(document: dict[str, Any]) -> RenderedInstruction:
        pieces: list[RenderedInstruction] = []
        for node in document["nodes"]:
            if node["type"] == "text":
                pieces.append(render_text(node["text"]))
                continue
            name = node["name"]
            nested = definitions.get(name)
            if name in defined_names:
                pieces.append(RenderedInstruction(f"<{name}>", ()))
                continue
            defined_names.add(name)
            normalized = (
                RenderedInstruction("", ())
                if nested is None
                else normalize_rendered_instruction(serialize_document(nested))
            )
            prefix = f"<{name}>["
            pieces.append(
                RenderedInstruction(
                    f"{prefix}{normalized.text}]</{name}>",
                    tuple(offset + len(prefix) for offset in normalized.letter_offsets),
                )
            )
        return concatenate_rendered(pieces)

    return serialize_document(prompt["root"]).text


def normalize_definition(value: str) -> str:
    inside_tag = False
    offsets: list[int] = []
    for index, character in enumerate(value):
        if character == "<":
            inside_tag = True
        elif character == ">":
            inside_tag = False
        elif not inside_tag and character.isalpha():
            offsets.append(index)
    return normalize_rendered_instruction(
        RenderedInstruction(value, tuple(offsets))
    ).text


def render_text(value: str) -> RenderedInstruction:
    return RenderedInstruction(
        value,
        tuple(index for index, character in enumerate(value) if character.isalpha()),
    )


def concatenate_rendered(values: list[RenderedInstruction]) -> RenderedInstruction:
    pieces: list[str] = []
    offsets: list[int] = []
    current_length = 0
    for value in values:
        pieces.append(value.text)
        offsets.extend(current_length + offset for offset in value.letter_offsets)
        current_length += len(value.text)
    return RenderedInstruction("".join(pieces), tuple(offsets))


def normalize_rendered_instruction(
    value: RenderedInstruction,
) -> RenderedInstruction:
    left = len(value.text) - len(value.text.lstrip())
    right = len(value.text.rstrip())
    text = value.text[left:right]
    if not text:
        return RenderedInstruction("", ())
    offsets = [
        offset - left for offset in value.letter_offsets if left <= offset < right
    ]
    if offsets:
        first = offsets[0]
        uppercase = text[first].upper()
        text = f"{text[:first]}{uppercase}{text[first + 1 :]}"
        shift = len(uppercase) - 1
        if shift:
            offsets = [
                offset if offset <= first else offset + shift for offset in offsets
            ]
    if not text.endswith("."):
        text += "."
    return RenderedInstruction(text, tuple(offsets))


def build_complete_prompt(
    instructions: str,
    documents: list[dict[str, Any]],
    *,
    maximum_bytes: int = MAX_PROMPT_BYTES,
) -> tuple[str, int]:
    rows: list[str] = []
    for document in sorted(documents, key=lambda item: int(item["id"])):
        document_id = int(document["id"])
        text = document.get("text")
        if not isinstance(text, str):
            raise PromptBuildError(f"document {document_id} has no extracted text")
        if INVALID_XML_CONTROL_PATTERN.search(text):
            raise PromptBuildError(
                f"document {document_id} contains invalid XML controls"
            )
        escaped = html.escape(text, quote=False)
        rows.append(f'  <file id="{document_id}">{escaped}</file>')
    files = "\n".join(rows)
    middle = f"<files>\n{files}\n</files>" if rows else "<files>\n</files>"
    complete = f"{instructions}\n{middle}\n{instructions}"
    size = len(complete.encode("utf-8"))
    if size > maximum_bytes:
        raise PromptBuildError("Complete prompt exceeds the 64 MiB limit")
    return complete, size


def parse_response(
    response: str, expected_children: dict[str, set[str]]
) -> ParsedResponse:
    known_names = set(expected_children)
    stack: list[OpenTag] = []
    closed: list[ClosedTag] = []
    warnings: list[ParseWarning] = []
    next_identity = 0
    for match in TAG_TOKEN_PATTERN.finditer(response):
        name = match.group(1)
        if name not in known_names:
            continue
        is_closing = response[match.start() + 1] == "/"
        if not is_closing:
            parent_identity = stack[-1].identity if stack else None
            stack.append(
                OpenTag(
                    next_identity, name, match.start(), match.end(), parent_identity
                )
            )
            next_identity += 1
            continue
        matching_index = next(
            (
                index
                for index in range(len(stack) - 1, -1, -1)
                if stack[index].name == name
            ),
            None,
        )
        if matching_index is None:
            warnings.append(
                ParseWarning(
                    "malformed-structure", f"Unexpected closing tag </{name}>", name
                )
            )
            continue
        if matching_index != len(stack) - 1:
            for unclosed in stack[matching_index + 1 :]:
                warnings.append(
                    ParseWarning(
                        "malformed-structure",
                        f"Unclosed tag <{unclosed.name}>",
                        unclosed.name,
                    )
                )
            del stack[matching_index + 1 :]
        opened = stack.pop()
        closed.append(
            ClosedTag(
                opened.identity,
                name,
                response[opened.content_start : match.start()],
                opened.start,
                match.end(),
                opened.parent_identity,
            )
        )
    for unclosed in stack:
        warnings.append(
            ParseWarning(
                "malformed-structure", f"Unclosed tag <{unclosed.name}>", unclosed.name
            )
        )

    ordered = sorted(closed, key=lambda item: item.start)
    index_by_identity = {item.identity: index for index, item in enumerate(ordered)}
    values = [
        TagValue(
            item.name,
            item.raw,
            item.raw.strip(),
            item.start,
            item.end,
            (
                index_by_identity.get(item.parent_identity)
                if item.parent_identity is not None
                else None
            ),
        )
        for item in ordered
    ]
    present_names = {value.name for value in values}
    for name in expected_children:
        if name not in present_names:
            warnings.append(
                ParseWarning(
                    "missing-required", f"Expected tag <{name}> was not found", name
                )
            )
    for index, value in enumerate(values):
        if not value.trimmed:
            warnings.append(
                ParseWarning(
                    "empty-occurrence", f"Tag <{value.name}> is empty", value.name
                )
            )
        descendant_names = {
            candidate.name
            for candidate in values
            if candidate.start > value.start and candidate.end < value.end
        }
        for child in expected_children.get(value.name, set()) - descendant_names:
            warnings.append(
                ParseWarning(
                    "missing-child",
                    f"Tag <{value.name}> is missing child <{child}>",
                    child,
                    index,
                )
            )
    return ParsedResponse(values, warnings)


def expected_children_from_prompt(value: Any) -> dict[str, set[str]]:
    prompt = validate_structured_prompt(value)
    definitions = prompt["definitions"]
    expected: dict[str, set[str]] = {}
    expanded: set[str] = set()

    def visit(document: dict[str, Any], parent_name: str | None) -> None:
        for node in document["nodes"]:
            if node["type"] != "tag":
                continue
            name = node["name"]
            expected.setdefault(name, set())
            if parent_name is not None:
                expected[parent_name].add(name)
            if name in expanded:
                continue
            expanded.add(name)
            nested = definitions.get(name)
            if nested is not None:
                visit(nested, name)

    visit(prompt["root"], None)
    return expected

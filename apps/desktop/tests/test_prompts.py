from __future__ import annotations

import pytest

from doc2webchat.prompts import (
    PromptBuildError,
    build_complete_prompt,
    expected_children_from_prompt,
    parse_response,
    serialize_instructions,
)


def text(value: str) -> dict[str, object]:
    return {"type": "text", "text": value}


def tag(occurrence_id: str, name: str) -> dict[str, object]:
    return {"type": "tag", "occurrenceId": occurrence_id, "name": name}


def document(*nodes: dict[str, object]) -> dict[str, object]:
    return {"version": 1, "nodes": list(nodes)}


def prompt(
    root: dict[str, object], definitions: dict[str, dict[str, object] | None]
) -> dict[str, object]:
    return {"version": 1, "root": root, "definitions": definitions}


def test_serializes_definitions_references_nesting_and_cycles() -> None:
    value = prompt(
        document(
            text("Answer "), tag("one", "result"), text(" then "), tag("two", "result")
        ),
        {
            "result": document(text(" include "), tag("three", "source"), text(" ")),
            "source": document(text(" quote "), tag("four", "result")),
        },
    )

    assert serialize_instructions(value) == (
        "Answer <result>[Include <source>[Quote <result>.]</source>.]</result>"
        " then <result>"
    )


@pytest.mark.parametrize(
    ("nested", "expected"),
    [
        (document(text("  hello  world  ")), "Hello  world."),
        (document(text("already!  ")), "Already!."),
        (document(text("123 abc")), "123 Abc."),
        (document(text(" \n\t ")), ""),
    ],
)
def test_normalizes_only_definition_edges(
    nested: dict[str, object], expected: str
) -> None:
    value = prompt(document(tag("one", "answer")), {"answer": nested})
    serialized = serialize_instructions(value)
    expected_serialized = f"<answer>[{expected}]</answer>"
    assert serialized == expected_serialized


def test_normalization_preserves_a_leading_nested_chip_name() -> None:
    value = prompt(
        document(tag("root", "answer")),
        {
            "answer": document(tag("nested", "source"), text(" then")),
            "source": document(text("quote")),
        },
    )
    assert serialize_instructions(value) == (
        "<answer>[<source>[Quote.]</source> then.]</answer>"
    )


def test_rejects_invalid_names_and_duplicate_occurrence_ids() -> None:
    with pytest.raises(PromptBuildError, match="invalid tag name"):
        serialize_instructions(prompt(document(tag("one", "bad name")), {}))
    with pytest.raises(PromptBuildError, match="duplicate occurrence"):
        serialize_instructions(prompt(document(tag("same", "a"), tag("same", "b")), {}))


def test_builds_exact_prompt_in_document_id_order_and_escapes_xml() -> None:
    instructions = "Read <answer>"
    complete, size = build_complete_prompt(
        instructions,
        [
            {"id": 4, "text": "later"},
            {"id": 2, "text": "A&B < C > D"},
        ],
    )

    assert complete == (
        "Read <answer>\n<files>\n"
        '  <file id="2">A&amp;B &lt; C &gt; D</file>\n'
        '  <file id="4">later</file>\n'
        "</files>\nRead <answer>"
    )
    assert size == len(complete.encode("utf-8"))


def test_build_rejects_xml_controls_and_oversize() -> None:
    with pytest.raises(PromptBuildError, match="document 9"):
        build_complete_prompt("go", [{"id": 9, "text": "bad\x01text"}])
    with pytest.raises(PromptBuildError, match="document 9"):
        build_complete_prompt("go", [{"id": 9, "text": "bad\ufffetext"}])
    with pytest.raises(PromptBuildError, match="64 MiB"):
        build_complete_prompt("é" * (32 * 1024 * 1024), [])


def test_build_preserves_xml_valid_c1_control_characters() -> None:
    complete, _ = build_complete_prompt(
        "go", [{"id": 9, "text": "valid\x7f\x85\x9ftext"}]
    )
    assert "valid\x7f\x85\x9ftext" in complete


def test_parser_preserves_balanced_nested_offsets_and_unknown_markup() -> None:
    response = "x <answer>  A <b>bold</b> <source>S</source>  </answer> y"
    parsed = parse_response(response, {"answer": {"source"}, "source": set()})

    assert [
        (item.name, item.raw, item.trimmed, item.parent_index) for item in parsed.values
    ] == [
        (
            "answer",
            "  A <b>bold</b> <source>S</source>  ",
            "A <b>bold</b> <source>S</source>",
            None,
        ),
        ("source", "S", "S", 0),
    ]
    assert parsed.values[0].start == response.index("<answer>")
    assert parsed.values[0].end == response.index("</answer>") + len("</answer>")
    assert parsed.warnings == []


def test_parser_recovers_and_reports_missing_empty_and_malformed() -> None:
    parsed = parse_response(
        "<answer></answer><answer><source>x</answer>",
        {"answer": {"source"}, "source": set(), "required": set()},
    )

    codes = [warning.code for warning in parsed.warnings]
    assert codes.count("empty-occurrence") == 1
    assert codes.count("missing-child") == 2
    assert "missing-required" in codes
    assert "malformed-structure" in codes
    assert [item.name for item in parsed.values] == ["answer", "answer"]


def test_parser_is_case_sensitive_and_leaves_unknown_markup_in_raw_text() -> None:
    response = (
        "<answer><Answer>case-sensitive unknown</Answer>"
        "<unknown>kept</unknown></answer>"
    )
    parsed = parse_response(response, {"answer": set(), "Answer": set()})
    assert [(value.name, value.raw) for value in parsed.values] == [
        (
            "answer",
            "<Answer>case-sensitive unknown</Answer><unknown>kept</unknown>",
        ),
        ("Answer", "case-sensitive unknown"),
    ]
    assert not any(warning.tag_name == "answer" for warning in parsed.warnings)


def test_parser_emits_only_closed_occurrences_and_recovers_after_crossing_tags() -> (
    None
):
    parsed = parse_response(
        "<answer>outer<source>lost</answer></source>"
        "<source>recovered</source><required>open",
        {"answer": {"source"}, "source": set(), "required": set()},
    )
    assert [(value.name, value.trimmed) for value in parsed.values] == [
        ("answer", "outer<source>lost"),
        ("source", "recovered"),
    ]
    assert (
        sum(warning.code == "malformed-structure" for warning in parsed.warnings) >= 2
    )
    assert any(
        warning.code == "missing-required" and warning.tag_name == "required"
        for warning in parsed.warnings
    )


def test_parser_warns_for_each_parent_missing_its_expected_child() -> None:
    parsed = parse_response(
        "<answer><source>one</source></answer><answer>two</answer>",
        {"answer": {"source"}, "source": set()},
    )
    missing = [
        warning
        for warning in parsed.warnings
        if warning.code == "missing-child" and warning.tag_name == "source"
    ]
    assert len(missing) == 1
    assert missing[0].parent_index == 2


def test_expected_children_ignores_orphans_and_uses_depth_first_references() -> None:
    value = prompt(
        document(tag("one", "answer"), tag("two", "answer")),
        {
            "answer": document(tag("three", "wrapper")),
            "wrapper": document(tag("four", "source"), tag("five", "source")),
            "source": None,
            "orphan": document(tag("unused", "ghost")),
            "ghost": None,
        },
    )
    assert expected_children_from_prompt(value) == {
        "answer": {"wrapper"},
        "wrapper": {"source"},
        "source": set(),
    }


def test_nested_descendant_satisfies_parent_but_outside_child_does_not() -> None:
    expected = {"answer": {"source"}, "wrapper": set(), "source": set()}
    inside = parse_response(
        "<answer><wrapper><source>x</source></wrapper></answer>", expected
    )
    assert not any(
        warning.code == "missing-child"
        and warning.tag_name == "source"
        and warning.parent_index == 0
        for warning in inside.warnings
    )

    outside = parse_response(
        "<answer><wrapper>x</wrapper></answer><source>elsewhere</source>", expected
    )
    assert any(
        warning.code == "missing-child"
        and warning.tag_name == "source"
        and warning.parent_index == 0
        for warning in outside.warnings
    )

import json
from backend.stream import parse_line


def j(o): return json.dumps(o)


def test_init_gives_session():
    assert parse_line(j({"type": "system", "subtype": "init", "session_id": "abc"})) == [
        {"kind": "session", "session_id": "abc"}]


def test_assistant_text_and_tool():
    line = j({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "hi"},
        {"type": "tool_use", "name": "Edit", "input": {"file_path": "/x/a.md", "old_string": "q"}}]}})
    assert parse_line(line) == [
        {"kind": "text", "text": "hi"},
        {"kind": "tool", "name": "Edit", "summary": "/x/a.md"}]


def test_result_success_gives_done_only():
    assert parse_line(j({"type": "result", "subtype": "success", "is_error": False,
                         "session_id": "s"})) == [
        {"kind": "done", "session_id": "s", "is_error": False}]


def test_result_error_gives_error_then_done():
    out = parse_line(j({"type": "result", "is_error": True, "session_id": "s"}))
    assert out[0]["kind"] == "error"
    assert out[1] == {"kind": "done", "session_id": "s", "is_error": True}


def test_result_non_success_subtype_reports_subtype():
    out = parse_line(j({"type": "result", "subtype": "error_max_turns", "is_error": False,
                        "session_id": "s"}))
    assert out[0]["kind"] == "error" and "error_max_turns" in out[0]["message"]
    assert out[1]["kind"] == "done" and out[1]["is_error"] is True


def test_non_dict_json_and_blocks_do_not_crash():
    assert parse_line("42") == []
    assert parse_line('["a"]') == []
    assert parse_line(j({"type": "assistant", "message": "str"})) == []
    assert parse_line(j({"type": "assistant", "message": {"content": "str"}})) == []
    assert parse_line(j({"type": "assistant", "message": {"content": [
        "x", None, {"type": "tool_use", "name": "Bash", "input": "ls"}]}})) == [
        {"kind": "tool", "name": "Bash", "summary": ""}]


def test_ignores_blank_and_unknown():
    assert parse_line("  \n") == []
    assert parse_line(j({"type": "user", "message": {}})) == []


def test_bad_json_is_error():
    assert parse_line("not json")[0]["kind"] == "error"

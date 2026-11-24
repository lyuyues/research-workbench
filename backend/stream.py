import json

_SUMMARY_KEYS = ("file_path", "command", "pattern", "path", "url", "description")


def _summarize(inp: dict) -> str:
    for key in _SUMMARY_KEYS:
        if key in inp:
            return str(inp[key])[:200]
    return ""


def parse_line(line: str) -> list[dict]:
    """Convert one Claude Code stream-json line into UI events. Never raises on bad input."""
    line = line.strip()
    if not line:
        return []
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        return [{"kind": "error", "message": f"unparseable: {line[:200]}"}]
    if not isinstance(msg, dict):
        return []
    kind = msg.get("type")
    if kind == "system" and msg.get("subtype") == "init":
        return [{"kind": "session", "session_id": msg.get("session_id")}]
    if kind == "assistant":
        message = msg.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            return []
        events = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and block.get("text"):
                events.append({"kind": "text", "text": str(block["text"])})
            elif block.get("type") == "tool_use":
                inp = block.get("input")
                events.append({"kind": "tool", "name": str(block.get("name", "")),
                               "summary": _summarize(inp) if isinstance(inp, dict) else ""})
        return events
    if kind == "result":
        subtype = msg.get("subtype")
        failed = bool(msg.get("is_error")) or (subtype not in (None, "success"))
        events = []
        if failed:
            detail = msg.get("result")
            text = f"claude result error ({subtype or 'is_error'})"
            if isinstance(detail, str) and detail:
                text += f": {detail[:500]}"
            events.append({"kind": "error", "message": text})
        events.append({"kind": "done", "session_id": msg.get("session_id"), "is_error": failed})
        return events
    return []

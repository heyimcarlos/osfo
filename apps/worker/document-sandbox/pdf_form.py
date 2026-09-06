"""Inspect and fill existing AcroForm widgets without flattening their source pages."""
import io
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.constants import UserAccessPermissions
from pypdf.generic import NameObject


PROTECTED = re.compile(r"signature|sign[ _-]?here|office|official|admin|staff|witness|certif", re.I)
OFFICE_SECTION = re.compile(r"(?:office|facility|microfilm|ministry).{0,20}use|use.{0,8}only|réserv", re.I)
SECTION = re.compile(r"^[A-Z][.)](?:\s|$)")
PURPOSE = re.compile(r"\b(name|address|street|apartment|city|province|postal|zip|country|phone|telephone|email|date|birth|contact|language|service|consent|applicant|member|citizenship|residency|gender|marital|occupation|employer)\b", re.I)


def open_template(data):
    if len(data) > 5 * 1024 * 1024:
        raise ValueError("PDF exceeds the template byte limit")
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        if not reader.decrypt(""):
            raise ValueError("PDF requires a password")
        if not reader.user_access_permissions & UserAccessPermissions.FILL_FORM_FIELDS:
            raise ValueError("PDF does not permit form filling")
    if not 1 <= len(reader.pages) <= 20:
        raise ValueError("PDF exceeds the template page limit")
    form = reader.trailer["/Root"].get("/AcroForm")
    if form is None or "/XFA" in form.get_object():
        raise ValueError("An AcroForm without XFA is required")
    return reader


def inherited(field, key):
    seen = set()
    while field is not None:
        field = field.get_object()
        identity = id(field)
        if identity in seen:
            raise ValueError("Cyclic field parent")
        seen.add(identity)
        if key in field:
            return field[key]
        field = field.get("/Parent")
    return None


def canonical_fields(reader):
    result = {}
    seen = set()

    def visit(ref, prefix=""):
        field = ref.get_object()
        identity = id(field)
        if identity in seen:
            raise ValueError("Ambiguous form tree")
        seen.add(identity)
        local = field.get("/T")
        name = ".".join(part for part in (prefix, str(local) if local is not None else "") if part)
        children = field.get("/Kids", [])
        named_children = [child for child in children if "/T" in child.get_object()]
        if named_children:
            for child in named_children:
                visit(child, name)
        else:
            if not name or name in result:
                raise ValueError("Missing or duplicate canonical field name")
            result[name] = field

    for ref in (reader.trailer["/Root"] if isinstance(reader, PdfReader) else reader.root_object)["/AcroForm"].get("/Fields", []):
        visit(ref)
    if len(result) > 300:
        raise ValueError("PDF exceeds the field limit")
    return result


def page_labels(reader):
    for page in reader.pages:
        if page.rotation % 360 != 0 or tuple(page.mediabox.lower_left) != (0, 0) or tuple(page.cropbox) != tuple(page.mediabox) or page.get("/UserUnit", 1) != 1:
            raise ValueError("Rotated, cropped or shifted PDF page geometry requires review")
    position = reader.stream.tell()
    reader.stream.seek(0)
    data = reader.stream.read()
    reader.stream.seek(position)
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "source.pdf"
        source.write_bytes(data)
        output = Path(directory) / "layout.xml"
        subprocess.run(["pdftotext", "-bbox-layout", str(source), str(output)],
                       check=True, timeout=8, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        root = ET.parse(output).getroot()
    pages = []
    for page in root.iter("{http://www.w3.org/1999/xhtml}page"):
        height = float(page.attrib["height"])
        lines = []
        for line in page.iter("{http://www.w3.org/1999/xhtml}line"):
            words = [{"text": word.text or "", "x": float(word.attrib["xMin"]),
                      "right": float(word.attrib["xMax"]), "y": height - float(word.attrib["yMax"])}
                     for word in line]
            if words:
                lines.append({"text": " ".join(word["text"] for word in words),
                              "x": words[0]["x"], "y": words[0]["y"], "words": words})
        pages.append(lines)
    if len(pages) != len(reader.pages):
        raise ValueError("Page label geometry does not match the PDF")
    return pages


def inspect_reader(reader):
    fields = canonical_fields(reader)
    widgets = {name: [] for name in fields}
    page_text = page_labels(reader)
    for number, page in enumerate(reader.pages, 1):
        labels = page_text[number - 1]
        for ref in page.get("/Annots", []):
            widget = ref.get_object()
            if widget.get("/Subtype") != "/Widget":
                continue
            parent = widget.get("/Parent", widget).get_object()
            matches = [name for name, field in fields.items() if field is parent]
            if len(matches) != 1:
                raise ValueError("Widget has no unambiguous canonical field")
            name = matches[0]
            rect = [float(value) for value in widget["/Rect"]]
            x0, x1 = sorted((rect[0], rect[2]))
            y0, y1 = sorted((rect[1], rect[3]))
            nearby = []
            for label in labels:
                if not y1 - 8 <= label["y"] <= y1 + 12:
                    continue
                words = [word for word in label["words"] if x0 <= (word["x"] + word["right"]) / 2 <= x1]
                if words:
                    nearby.append({"text": " ".join(word["text"] for word in words)[:500],
                                   "x": words[0]["x"], "y": words[0]["y"]})
            nearby.sort(key=lambda label: abs(label["y"] - y1))
            nearby = nearby[:1]
            protected_region = next((label["text"] for label in labels
                if OFFICE_SECTION.search(label["text"]) and y1 <= label["y"] + 12
                and y0 >= max([0] + [heading["y"] for heading in labels
                    if SECTION.search(heading["text"]) and heading["y"] < label["y"]])), None)
            widgets[name].append({"page": number, "rect": rect, "labels": nearby[:3],
                                  "protectedRegion": protected_region})
    result = []
    for name, field in fields.items():
        field_type = inherited(field, "/FT")
        flags = int(inherited(field, "/Ff") or 0)
        kind = "text" if field_type == "/Tx" else "radio" if field_type == "/Btn" and flags & (1 << 15) else "checkbox" if field_type == "/Btn" and not flags & (1 << 16) else "unsupported"
        label = field.get("/TU")
        metadata = re.sub(r"([a-z])([A-Z])", r"\1 \2", name) + " " + str(label or "")
        visible = " ".join(label["text"] for widget in widgets[name] for label in widget["labels"])
        restriction = None
        if flags & 1 or field_type == "/Sig" or PROTECTED.search(metadata) or PROTECTED.search(visible) or any(widget["protectedRegion"] for widget in widgets[name]):
            restriction = "is protected"
        elif kind == "unsupported" or not widgets[name] or not PURPOSE.search(metadata + " " + visible):
            restriction = "has no established purpose"
        exports = []
        for widget in field.get("/Kids", [field]):
            normal = widget.get_object().get("/AP", {}).get("/N")
            if normal is not None and hasattr(normal.get_object(), "keys") and kind in ("checkbox", "radio"):
                exports.extend(str(value)[1:] for value in normal.get_object().keys())
        if field_type == "/Sig" and inherited(field, "/V") is not None:
            raise ValueError("Signed PDFs cannot be rewritten")
        result.append({"name": name, "label": str(label) if label is not None else None,
                       "kind": kind, "restriction": restriction, "exportValues": sorted(set(exports)),
                       "widgets": widgets[name]})
    return {"pageCount": len(reader.pages), "encrypted": reader.is_encrypted, "fields": result}


def inspect(data):
    return inspect_reader(open_template(data))


def widget_appearance(widget):
    normal = widget.get("/AP", {}).get("/N")
    if normal is None:
        return None
    normal = normal.get_object()
    if hasattr(normal, "get_data"):
        return normal.get_data()
    return {str(key): value.get_object().get_data() for key, value in normal.items()}


def widget_snapshots(reader, fields):
    result = []
    for page in reader.pages:
        for ref in page.get("/Annots", []):
            widget = ref.get_object()
            if widget.get("/Subtype") != "/Widget":
                continue
            parent = widget.get("/Parent", widget).get_object()
            name = next((name for name, field in fields.items() if field is parent), None)
            result.append((name, tuple(widget["/Rect"]), widget.get("/AS"), widget_appearance(widget)))
    return result


def fill(data, source, output):
    reader = open_template(data)
    inspection = inspect_reader(reader)
    if source["pageCount"] != inspection["pageCount"]:
        raise ValueError("Template page count changed")
    fields = {field["name"]: field for field in inspection["fields"]}
    edits = source["fields"]
    if not 1 <= len(edits) <= 100 or len({edit["name"] for edit in edits}) != len(edits):
        raise ValueError("Invalid field edit count")
    values = {}
    for edit in edits:
        field = fields.get(edit["name"])
        if field is None or field["restriction"] is not None or field["kind"] != edit["kind"]:
            raise ValueError("Requested field is missing, protected or has no established purpose")
        value = edit["value"]
        if not isinstance(value, str) or len(value) > 1000:
            raise ValueError("Invalid field value")
        if edit["kind"] != "text":
            if value not in field["exportValues"]:
                raise ValueError("Unknown widget export state")
            value = NameObject("/" + value)
        values[edit["name"]] = value
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    writer.update_page_form_field_values(None, values, auto_regenerate=False)
    written_fields = canonical_fields(writer)
    for page in writer.pages:
        for ref in page.get("/Annots", []):
            widget = ref.get_object()
            parent = widget.get("/Parent")
            if parent is not None and any(field is parent.get_object() for name, field in written_fields.items() if name in values):
                # pypdf puts per-widget radio values on children. Keep the canonical parent authoritative.
                widget.pop(NameObject("/V"), None)
    serialized = io.BytesIO()
    writer.write(serialized)
    reopened = PdfReader(serialized, strict=True)
    written = canonical_fields(reopened)
    original = canonical_fields(reader)
    if set(written) != set(original):
        raise ValueError("Canonical fields changed unexpectedly")
    before_widgets = widget_snapshots(reader, original)
    after_widgets = widget_snapshots(reopened, written)
    if len(before_widgets) != len(after_widgets):
        raise ValueError("Widget count changed unexpectedly")
    for before, after in zip(before_widgets, after_widgets):
        if before[:2] != after[:2] or before[0] not in values and before != after:
            raise ValueError("Unrequested widget changed unexpectedly")
    for name, field in written.items():
        expected = values.get(name, inherited(original[name], "/V"))
        if inherited(field, "/V") != expected:
            raise ValueError("Canonical field value changed unexpectedly")
    for page in reopened.pages:
        for ref in page.get("/Annots", []):
            widget = ref.get_object()
            if widget.get("/Subtype") != "/Widget":
                continue
            parent = widget.get("/Parent", widget).get_object()
            name = next((name for name, field in written.items() if field is parent), None)
            if name not in values:
                continue
            if inherited(widget, "/V") != values[name] or not widget.get("/AP", {}).get("/N"):
                raise ValueError("Widget value or appearance is missing")
            if fields[name]["kind"] != "text":
                normal = widget["/AP"]["/N"].get_object()
                expected = values[name] if values[name] in normal else NameObject("/Off")
                if widget.get("/AS") != expected:
                    raise ValueError("Widget appearance state differs from the selected value")
    target = Path(output)
    pending = target.with_suffix(target.suffix + ".pending")
    pending.write_bytes(serialized.getvalue())
    pending.replace(target)
    return inspection["pageCount"]

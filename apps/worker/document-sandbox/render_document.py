import argparse
import datetime
import json
import re
import zipfile
from pathlib import Path

from docx import Document
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas


def read_source(path: Path) -> list[dict[str, object]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    pages = value.get("pages") if isinstance(value, dict) else None
    if not isinstance(pages, list) or not 1 <= len(pages) <= 20:
        raise ValueError("source must contain between 1 and 20 pages")
    for page in pages:
        if not isinstance(page, dict):
            raise ValueError("each page must be an object")
        title = page.get("title")
        lines = page.get("lines")
        if not isinstance(title, str) or not 1 <= len(title) <= 80:
            raise ValueError("each page title must contain 1 to 80 characters")
        if not isinstance(lines, list) or len(lines) > 30:
            raise ValueError("each page must contain at most 30 lines")
        if any(not isinstance(line, str) or len(line) > 80 for line in lines):
            raise ValueError("each line must contain at most 80 characters")
    return pages


def render_pdf(pages: list[dict[str, object]], output: Path) -> None:
    document = canvas.Canvas(str(output), pagesize=LETTER, invariant=1, pageCompression=1)
    for page in pages:
        document.setFont("Helvetica-Bold", 16)
        document.drawString(54, 738, page["title"])
        document.setFont("Helvetica", 11)
        y = 708
        for line in page["lines"]:
            document.drawString(54, y, line)
            y -= 20
        document.showPage()
    document.save()


def render_docx(pages: list[dict[str, object]], output: Path) -> None:
    document = Document()
    fixed_time = datetime.datetime(2000, 1, 1, tzinfo=datetime.timezone.utc)
    document.core_properties.created = fixed_time
    document.core_properties.modified = fixed_time
    for page_index, page in enumerate(pages):
        document.add_heading(page["title"], level=1)
        for line in page["lines"]:
            document.add_paragraph(line)
        if page_index + 1 < len(pages):
            document.add_page_break()
    temporary = output.with_suffix(".raw.docx")
    document.save(temporary)
    with zipfile.ZipFile(temporary, "r") as source, zipfile.ZipFile(
        output, "w", zipfile.ZIP_DEFLATED
    ) as target:
        for item in sorted(source.infolist(), key=lambda candidate: candidate.filename):
            content = source.read(item.filename)
            if item.filename == "docProps/app.xml":
                text = content.decode("utf-8")
                text = re.sub(r"<Pages>.*?</Pages>", f"<Pages>{len(pages)}</Pages>", text)
                content = text.encode("utf-8")
            deterministic = zipfile.ZipInfo(item.filename, (2000, 1, 1, 0, 0, 0))
            deterministic.compress_type = zipfile.ZIP_DEFLATED
            deterministic.external_attr = item.external_attr
            target.writestr(deterministic, content)
    temporary.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--format", choices=("pdf", "docx"), required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    pages = read_source(arguments.input)
    if arguments.format == "pdf":
        render_pdf(pages, arguments.output)
    else:
        render_docx(pages, arguments.output)


if __name__ == "__main__":
    main()

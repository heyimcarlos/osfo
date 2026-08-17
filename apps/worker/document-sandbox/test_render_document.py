import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader


class RenderDocumentTest(unittest.TestCase):
    def test_maximum_pdf_and_docx_are_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.json"
            source.write_text(
                json.dumps(
                    {
                        "pages": [
                            {
                                "title": f"Page {page}",
                                "lines": ["X" * 80 for _ in range(30)],
                            }
                            for page in range(1, 21)
                        ]
                    }
                ),
                encoding="utf-8",
            )

            for document_format in ("pdf", "docx"):
                first = root / f"first.{document_format}"
                second = root / f"second.{document_format}"
                for output in (first, second):
                    completed = subprocess.run(
                        [
                            "python3",
                            "/opt/osfo/render_document.py",
                            "--format",
                            document_format,
                            "--input",
                            str(source),
                            "--output",
                            str(output),
                        ],
                        check=True,
                        capture_output=True,
                        text=True,
                        timeout=60,
                    )
                    self.assertEqual(json.loads(completed.stdout), {"renderedPageCount": 20})
                    self.assertLessEqual(output.stat().st_size, 5_000_000)

                self.assertEqual(
                    hashlib.sha256(first.read_bytes()).digest(),
                    hashlib.sha256(second.read_bytes()).digest(),
                )
                self.assertEqual(self._rendered_pages(first, root), 20)

    def _rendered_pages(self, document: Path, root: Path) -> int:
        if document.suffix == ".pdf":
            return len(PdfReader(document).pages)
        rendered = root / "libreoffice"
        rendered.mkdir(exist_ok=True)
        subprocess.run(
            [
                "libreoffice",
                "--headless",
                "--convert-to",
                "pdf",
                "--outdir",
                str(rendered),
                str(document),
            ],
            check=True,
            capture_output=True,
            timeout=30,
        )
        return len(PdfReader(rendered / f"{document.stem}.pdf").pages)


if __name__ == "__main__":
    unittest.main()

import base64
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image
from pptx import Presentation


SCRIPT = Path("/opt/osfo/render_artifact.py")


class ArtifactRendererTest(unittest.TestCase):
    def test_presentation_renders_every_slide_and_retains_source_notes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.json"
            output = root / "deck.pptx"
            source.write_text(
                json.dumps(
                    {
                        "source": {
                            "audience": "Reviewers",
                            "purpose": "Explain",
                            "slides": [
                                {
                                    "body": ["One point"],
                                    "diagramContentId": None,
                                    "imageContentId": None,
                                    "sourceNotes": ["https://example.test/source"],
                                    "speakerNotes": "Explain the point.",
                                    "title": "First slide",
                                },
                                {
                                    "body": ["Second point"],
                                    "diagramContentId": None,
                                    "imageContentId": None,
                                    "sourceNotes": [],
                                    "speakerNotes": "",
                                    "title": "Second slide",
                                },
                            ],
                            "title": "Review",
                        },
                        "supportingVisuals": [],
                    }
                ),
                encoding="utf-8",
            )
            result = self.run_renderer("presentation", source, output)
            self.assertEqual(result["renderedSlideCount"], 2)
            self.assertEqual(result["issues"], [])
            presentation = Presentation(output)
            self.assertEqual(len(presentation.slides), 2)
            with zipfile.ZipFile(output) as archive:
                notes = "\n".join(
                    archive.read(name).decode("utf-8")
                    for name in archive.namelist()
                    if name.startswith("ppt/notesSlides/notesSlide") and name.endswith(".xml")
                )
            self.assertIn("[Sources]", notes)
            self.assertIn("https://example.test/source", notes)

    def test_presentation_rejects_embedded_line_breaks_before_render(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.json"
            output = root / "deck.pptx"
            source.write_text(
                json.dumps(
                    {
                        "source": {
                            "audience": "Reviewers",
                            "purpose": "Explain",
                            "slides": [
                                {
                                    "body": ["A\nB"],
                                    "diagramContentId": None,
                                    "imageContentId": None,
                                    "sourceNotes": [],
                                    "speakerNotes": "",
                                    "title": "Unsafe wrapping",
                                }
                            ],
                            "title": "Review",
                        },
                        "supportingVisuals": [],
                    }
                ),
                encoding="utf-8",
            )
            completed = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "--kind",
                    "presentation",
                    "--input",
                    str(source),
                    "--output",
                    str(output),
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertNotEqual(completed.returncode, 0)

    def test_diagram_and_provider_image_become_exact_pngs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            diagram_source = root / "diagram.json"
            diagram_output = root / "diagram.png"
            diagram_source.write_text(
                json.dumps(
                    {
                        "source": {
                            "direction": "leftToRight",
                            "edges": [{"from": "one", "label": "", "to": "two"}],
                            "height": 512,
                            "nodes": [
                                {"id": "one", "label": "One"},
                                {"id": "two", "label": "Two"},
                            ],
                            "title": "Flow",
                            "width": 768,
                        }
                    }
                ),
                encoding="utf-8",
            )
            diagram = self.run_renderer("diagram", diagram_source, diagram_output)
            self.assertEqual(diagram, {"height": 512, "kind": "visual", "width": 768})
            with Image.open(diagram_output) as rendered_diagram:
                self.assertEqual(rendered_diagram.size, (768, 512))

            input_image = root / "input.png"
            Image.new("RGB", (4, 4), "red").save(input_image)
            image_source = root / "image.json"
            image_output = root / "image.png"
            image_source.write_text(
                json.dumps(
                    {
                        "providerImageBase64": base64.b64encode(input_image.read_bytes()).decode(),
                        "source": {
                            "altText": "red",
                            "height": 64,
                            "prompt": "red",
                            "width": 96,
                        },
                    }
                ),
                encoding="utf-8",
            )
            image = self.run_renderer("image", image_source, image_output)
            self.assertEqual(image, {"height": 64, "kind": "visual", "width": 96})
            with Image.open(image_output) as rendered_image:
                self.assertEqual(rendered_image.size, (96, 64))

    def run_renderer(self, kind: str, source: Path, output: Path) -> dict[str, object]:
        completed = subprocess.run(
            ["python3", str(SCRIPT), "--kind", kind, "--input", str(source), "--output", str(output)],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if completed.returncode != 0:
            self.fail(completed.stderr)
        return json.loads(completed.stdout)


if __name__ == "__main__":
    unittest.main()

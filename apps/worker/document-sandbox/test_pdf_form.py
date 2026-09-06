import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, "/opt/osfo")
from pdf_form import fill, inspect
from pypdf import PdfReader, PdfWriter
from pypdf.constants import UserAccessPermissions
from pypdf.generic import NameObject, TextStringObject, DictionaryObject
from reportlab.pdfgen import canvas


def fixture(password="", permitted=True):
    stream = io.BytesIO()
    pdf = canvas.Canvas(stream)
    for name, label, y in [("a1", "Applicant name", 700), ("a2", "Unknown", 600),
                           ("a3", "Signature", 500), ("a4", "Office use only", 400)]:
        pdf.drawString(40, y + 23, label)
        pdf.acroForm.textfield(name=name, x=40, y=y, width=220, height=20,
                              value="Reserved" if name == "a4" else "")
    pdf.drawString(280, 723, "Unknown")
    pdf.acroForm.textfield(name="a5", x=280, y=700, width=150, height=20)
    pdf.acroForm.checkbox(name="ContactConsent", x=300, y=750, checked=False)
    pdf.acroForm.radio(name="ServiceChoice", value="New", x=350, y=750, selected=False)
    pdf.acroForm.radio(name="ServiceChoice", value="Renewal", x=400, y=750, selected=False)
    pdf.showPage()
    pdf.save()
    writer = PdfWriter(clone_from=PdfReader(stream))
    for ref in writer.pages[0]["/Annots"]:
        widget = ref.get_object()
        if widget.get("/T") == "ContactConsent":
            normal = widget["/AP"]["/N"].get_object()
            normal[NameObject("/Accepted")] = normal.pop(NameObject("/Yes"))
    writer.encrypt(password, owner_password="synthetic-owner",
                   permissions_flag=UserAccessPermissions.PRINT |
                   (UserAccessPermissions.FILL_FORM_FIELDS if permitted else 0), algorithm="AES-256")
    encrypted = io.BytesIO()
    writer.write(encrypted)
    return encrypted.getvalue()


class PdfFormTests(unittest.TestCase):
    def test_empty_password_fill_permission_and_visible_labels(self):
        data = fixture()
        observed = inspect(data)
        self.assertTrue(observed["encrypted"])
        fields = {field["name"]: field for field in observed["fields"]}
        self.assertIsNone(fields["a1"]["restriction"])
        self.assertEqual(fields["a2"]["restriction"], "has no established purpose")
        self.assertEqual(fields["a5"]["restriction"], "has no established purpose")
        self.assertEqual(fields["a3"]["restriction"], "is protected")
        self.assertEqual(fields["a4"]["restriction"], "is protected")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "filled.pdf"
            fill(data, {"pageCount": 1, "fields": [
                {"name": "a1", "kind": "text", "value": "Example Applicant"},
                {"name": "ContactConsent", "kind": "checkbox", "value": "Accepted"},
                {"name": "ServiceChoice", "kind": "radio", "value": "Renewal"}]}, output)
            result = PdfReader(output).get_fields()
            self.assertEqual(result["a1"]["/V"], "Example Applicant")
            self.assertEqual(result["ContactConsent"]["/V"], "/Accepted")
            self.assertEqual(result["ServiceChoice"]["/V"], "/Renewal")
            self.assertEqual(result["a2"]["/V"], "")
            self.assertEqual(result["a3"]["/V"], "")
            self.assertEqual(result["a4"]["/V"], "Reserved")

    def test_failed_preservation_check_never_publishes_recoverable_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "filled.pdf"
            with patch.object(PdfWriter, "update_page_form_field_values", return_value=None):
                with self.assertRaises(ValueError):
                    fill(fixture(), {"pageCount": 1, "fields": [
                        {"name": "a1", "kind": "text", "value": "Example Applicant"}]}, output)
            self.assertFalse(output.exists())

    def test_rejects_unmapped_page_geometry(self):
        for mode in ["rotation", "origin", "crop"]:
            reader = PdfReader(io.BytesIO(fixture()))
            reader.decrypt("")
            writer = PdfWriter(clone_from=reader)
            page = writer.pages[0]
            if mode == "rotation":
                page.rotate(90)
            elif mode == "origin":
                page.mediabox.lower_left = (10, 10)
            else:
                page.cropbox.upper_right = (400, 700)
            data = io.BytesIO()
            writer.write(data)
            with self.assertRaises(ValueError):
                inspect(data.getvalue())

    def test_rejects_xfa_signed_and_orphaned_widgets(self):
        for mode in ["xfa", "signed", "orphan"]:
            reader = PdfReader(io.BytesIO(fixture()))
            reader.decrypt("")
            writer = PdfWriter(clone_from=reader)
            form = writer.root_object["/AcroForm"]
            if mode == "xfa":
                form[NameObject("/XFA")] = TextStringObject("<xfa>retained</xfa>")
            elif mode == "signed":
                field = form["/Fields"][0].get_object()
                field[NameObject("/FT")] = NameObject("/Sig")
                field[NameObject("/V")] = DictionaryObject({NameObject("/Type"): NameObject("/Sig")})
            else:
                form["/Fields"].pop(0)
            data = io.BytesIO()
            writer.write(data)
            with self.assertRaises(ValueError):
                inspect(data.getvalue())

    def test_rejects_password_and_missing_fill_permission(self):
        for data in [fixture("required"), fixture(permitted=False)]:
            with self.assertRaises(ValueError):
                inspect(data)

    def test_rejects_protected_and_unknown_requested_fields(self):
        data = fixture()
        with tempfile.TemporaryDirectory() as directory:
            for name in ["a2", "a3", "a4", "missing"]:
                with self.assertRaises(ValueError):
                    fill(data, {"pageCount": 1, "fields": [
                        {"name": name, "kind": "text", "value": "Guess"}]}, Path(directory) / "bad.pdf")


if __name__ == "__main__":
    unittest.main()

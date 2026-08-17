FROM docker.io/cloudflare/sandbox:0.12.7-python

RUN python3 -m pip install --no-cache-dir python-docx==1.2.0 reportlab==4.4.3

COPY render_document.py /opt/osfo/render_document.py

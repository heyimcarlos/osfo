FROM docker.io/cloudflare/sandbox:0.12.7-python

RUN apt-get update \
    && apt-get install --no-install-recommends --yes libreoffice-writer-nogui \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir pypdf==6.1.1 python-docx==1.2.0 reportlab==4.4.3

COPY render_document.py /opt/osfo/render_document.py

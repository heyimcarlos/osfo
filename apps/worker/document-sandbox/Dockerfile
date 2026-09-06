FROM docker.io/cloudflare/sandbox:0.12.7-python@sha256:6dfa7301e69d3e5cd8e0404b92fd240026fe834ed7101ee29cb66337b0af0981 AS artifact-runtime

ARG LIBREOFFICE_VERSION=1:7.3.7-0ubuntu0.22.04.12
ARG LIBERATION_FONTS_VERSION=2.1.5-1
ARG LIBERATION_FONTS_DEB_SHA256=787ae3c986eb6d61daa383aa7c3be2e55e4f9bf0f903047caeb4c066038ccaec
ARG LIBREOFFICE_DEB_SHA256=1cef8467f03bba5b7fba279f800b88c630293849383fbfe109d08aa3e99ae6b2
ARG LIBREOFFICE_IMPRESS_DEB_SHA256=3a8ca335ad2d244e4af581dcb2dbc718c48af792e20794d426dc840c6c48ab5b
ARG POPPLER_UTILS_VERSION=22.02.0-2ubuntu0.13
ARG POPPLER_UTILS_DEB_SHA256=4b29486f5293907402f7f1d3f4cf84622759903720c866f52f7de5a1dab914a5
ARG UBUNTU_SNAPSHOT=20260714T000000Z
RUN printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy main restricted universe multiverse" \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy-updates main restricted universe multiverse" \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy-security main restricted universe multiverse" \
      > /etc/apt/sources.list \
    && apt-get update \
    && cd /tmp \
    && apt-get download \
      "fonts-liberation2=${LIBERATION_FONTS_VERSION}" \
      "libreoffice-impress=${LIBREOFFICE_VERSION}" \
      "libreoffice-writer=${LIBREOFFICE_VERSION}" \
      "poppler-utils=${POPPLER_UTILS_VERSION}" \
      'tesseract-ocr=4.1.1-2.1build1' \
      'tesseract-ocr-eng=1:4.00~git30-7274cfa-1.1' \
      'tesseract-ocr-fra=1:4.00~git30-7274cfa-1.1' \
    && echo "${LIBERATION_FONTS_DEB_SHA256}  fonts-liberation2_2.1.5-1_all.deb" | sha256sum --check \
    && echo "${LIBREOFFICE_IMPRESS_DEB_SHA256}  libreoffice-impress_1%3a7.3.7-0ubuntu0.22.04.12_amd64.deb" | sha256sum --check \
    && echo "${LIBREOFFICE_DEB_SHA256}  libreoffice-writer_1%3a7.3.7-0ubuntu0.22.04.12_amd64.deb" | sha256sum --check \
    && echo "${POPPLER_UTILS_DEB_SHA256}  poppler-utils_22.02.0-2ubuntu0.13_amd64.deb" | sha256sum --check \
    && echo '5d33a2cc1484aa5032d07f51a4375d414d6868347691239874f0cfc03280a18f  tesseract-ocr_4.1.1-2.1build1_amd64.deb' | sha256sum --check \
    && echo 'a4709bd43f71c83f9171071dddaf87a125f467d5258bd323048d49b054ef5eb8  tesseract-ocr-eng_1%3a4.00~git30-7274cfa-1.1_all.deb' | sha256sum --check \
    && echo '8e2a338a7100cac2989670310954087ee88d2c5ec8eaa168b38c64612dd70d4d  tesseract-ocr-fra_1%3a4.00~git30-7274cfa-1.1_all.deb' | sha256sum --check \
    && apt-get install --no-install-recommends --yes \
      ./fonts-liberation2_2.1.5-1_all.deb \
      ./libreoffice-impress_1%3a7.3.7-0ubuntu0.22.04.12_amd64.deb \
      ./libreoffice-writer_1%3a7.3.7-0ubuntu0.22.04.12_amd64.deb \
      ./poppler-utils_22.02.0-2ubuntu0.13_amd64.deb \
      ./tesseract-*.deb \
    && rm /tmp/libreoffice-*_1%3a7.3.7-0ubuntu0.22.04.12_amd64.deb \
    && rm /tmp/fonts-liberation2_2.1.5-1_all.deb \
    && rm /tmp/poppler-utils_22.02.0-2ubuntu0.13_amd64.deb \
    && rm /tmp/tesseract-*.deb \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/osfo-requirements.txt
RUN python3 -m pip install --no-cache-dir --require-hashes -r /tmp/osfo-requirements.txt
COPY render_document.py /opt/osfo/render_document.py
COPY render_artifact.py /opt/osfo/render_artifact.py

FROM artifact-runtime AS artifact-tested
COPY test_render_document.py /tmp/test_render_document.py
COPY test_render_artifact.py /tmp/test_render_artifact.py
RUN python3 /tmp/test_render_document.py -v \
    && python3 /tmp/test_render_artifact.py -v \
    && rm /tmp/test_render_document.py /tmp/test_render_artifact.py

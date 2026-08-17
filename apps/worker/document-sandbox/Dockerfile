FROM docker.io/cloudflare/sandbox:0.12.7-python@sha256:6dfa7301e69d3e5cd8e0404b92fd240026fe834ed7101ee29cb66337b0af0981

ARG LIBREOFFICE_VERSION=1:7.3.7-0ubuntu0.22.04.12
ARG LIBREOFFICE_DEB_SHA256=a888f0e5454ba7c7fc971b2ca3e0f9a9f0a44a17f82d0438d24b8a541bfe999d
ARG UBUNTU_SNAPSHOT=20260714T000000Z
RUN printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy main restricted universe multiverse" \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy-updates main restricted universe multiverse" \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy-security main restricted universe multiverse" \
      > /etc/apt/sources.list \
    && apt-get update \
    && cd /tmp \
    && apt-get download "libreoffice-writer-nogui=${LIBREOFFICE_VERSION}" \
    && echo "${LIBREOFFICE_DEB_SHA256}  libreoffice-writer-nogui_1%3a7.3.7-0ubuntu0.22.04.12_amd64.deb" | sha256sum --check \
    && apt-get install --no-install-recommends --yes ./libreoffice-writer-nogui_1%3a7.3.7-0ubuntu0.22.04.12_amd64.deb \
    && rm /tmp/libreoffice-writer-nogui_1%3a7.3.7-0ubuntu0.22.04.12_amd64.deb \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir charset-normalizer==3.5.1 lxml==6.1.1 pypdf==6.1.1 python-docx==1.2.0 reportlab==4.4.3

COPY render_document.py /opt/osfo/render_document.py
COPY test_render_document.py /tmp/test_render_document.py
RUN python3 /tmp/test_render_document.py -v && rm /tmp/test_render_document.py

FROM nvidia/cuda:12.9.1-devel-ubuntu24.04
ENV DEBIAN_FRONTEND=noninteractive QT_QPA_PLATFORM=offscreen
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake ninja-build git curl ca-certificates xz-utils ffmpeg poppler-utils \
    python3 python3-pip python3-venv libboost-program-options-dev libboost-graph-dev \
    libboost-system-dev libeigen3-dev libopenimageio-dev openimageio-tools libmetis-dev \
    libgoogle-glog-dev libgtest-dev libgmock-dev libsqlite3-dev libglew-dev qt6-base-dev \
    libqt6opengl6-dev libqt6openglwidgets6 qt6-svg-dev libcgal-dev libceres-dev \
    libcurl4-openssl-dev libssl-dev libmkl-full-dev libxrender1 libxi6 libxkbcommon0 libsm6 \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /usr/include/opencv4 && git clone --branch 4.2.0 --depth 1 https://github.com/colmap/colmap.git /tmp/colmap \
    && cmake -S /tmp/colmap -B /tmp/colmap/build -GNinja -DCMAKE_BUILD_TYPE=Release \
       -DCMAKE_CUDA_ARCHITECTURES=89 -DGUI_ENABLED=OFF -DBLA_VENDOR=Intel10_64lp \
    && cmake --build /tmp/colmap/build --parallel 4 && cmake --install /tmp/colmap/build \
    && rm -rf /tmp/colmap
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:/opt/blender:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN pip install --no-cache-dir pycolmap==4.2.0 open3d==0.19.0 numpy==2.2.6 Pillow==11.3.0
RUN curl -fsSL https://download.blender.org/release/Blender5.2/blender-5.2.1-linux-x64.tar.xz -o /tmp/blender.tar.xz \
    && curl -fsSL https://download.blender.org/release/Blender5.2/blender-5.2.1.sha256 -o /tmp/blender.sha256 \
    && python -c "import hashlib; from pathlib import Path; p=Path('/tmp/blender.tar.xz'); expected=next(l.split()[0] for l in Path('/tmp/blender.sha256').read_text().splitlines() if 'blender-5.2.1-linux-x64.tar.xz' in l); assert hashlib.sha256(p.read_bytes()).hexdigest()==expected" \
    && mkdir /opt/blender && tar -xf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 \
    && rm /tmp/blender.tar.xz /tmp/blender.sha256
COPY sandbox /opt/sandbox
COPY astratorial /opt/worker/astratorial
COPY assets/fetch_tutor.py /opt/fetch_tutor.py
RUN python /opt/fetch_tutor.py && blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python /opt/sandbox/build_tutor.py
RUN colmap -h >/dev/null && ffmpeg -version >/dev/null && blender --version >/dev/null \
    && dpkg-query -W > /opt/system-package-versions.txt
WORKDIR /job

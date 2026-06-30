FROM node:20-slim

# Install Python and system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    python3-pip \
    python3-dev \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    libgomp1 \
    libx11-6 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHON_PATH="/opt/venv/bin/python3"
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONPYCACHEPREFIX=/tmp/pycache
ENV NODE_ENV=production

# Install PyTorch CPU and Python dependencies
RUN pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
RUN pip install numpy scipy opencv-python matplotlib pillow
RUN pip install hydra-core==1.3.2 omegaconf==2.3.0
RUN pip install monai nibabel SimpleITK pydicom tqdm

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy dependency files and install Node dependencies
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prefer-offline

# Copy source code
COPY . .

# Build Next.js once. Railway must not run next dev, otherwise Python __pycache__
# writes can trigger Turbopack/HMR reloads during segmentation.
RUN pnpm next build

# Runtime startup script: download models if missing, then run production server.
RUN cat > /app/start.sh <<'EOF'
#!/bin/bash
set -e
export PATH="/opt/venv/bin:$PATH"
export PYTHON_PATH="/opt/venv/bin/python3"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPYCACHEPREFIX=/tmp/pycache
mkdir -p /tmp/pycache
mkdir -p /app/Seg-code-try2region-noise/work_dir/sam2_hiera_s_20251024_191552
mkdir -p /app/Seg-code-try2region-noise/checkpoints

if [ -n "$MEDICAL_MODEL_URL" ] && [ ! -f /app/Seg-code-try2region-noise/work_dir/sam2_hiera_s_20251024_191552/best_mean3d_model.pth ]; then
  echo "Downloading medical model..."
  curl -L -o /app/Seg-code-try2region-noise/work_dir/sam2_hiera_s_20251024_191552/best_mean3d_model.pth "$MEDICAL_MODEL_URL" || echo "Model download failed"
fi

if [ -n "$SAM_MODEL_URL" ] && [ ! -f /app/Seg-code-try2region-noise/checkpoints/sam2_hiera_small.pt ]; then
  echo "Downloading SAM model..."
  curl -L -o /app/Seg-code-try2region-noise/checkpoints/sam2_hiera_small.pt "$SAM_MODEL_URL" || echo "Model download failed"
fi

echo "Starting Next.js production server with Python venv..."
echo "Python path: $PYTHON_PATH"
exec node_modules/.bin/next start -p ${PORT:-3000}
EOF
RUN chmod +x /app/start.sh

ENV PORT=3000
EXPOSE 3000
CMD ["/app/start.sh"]

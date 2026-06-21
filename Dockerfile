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

# Install PyTorch (CUDA 11.8) in virtual environment - falls back to CPU automatically
RUN pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118

# Install Python dependencies for SAM2 in virtual environment
RUN pip install numpy scipy opencv-python matplotlib pillow
RUN pip install hydra-core==1.3.2 omegaconf==2.3.0
RUN pip install monai nibabel SimpleITK pydicom
RUN pip install tqdm

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prefer-offline

# Copy source code
COPY . .

# Build Next.js
RUN pnpm next build

# Create startup script that downloads models at runtime and uses venv Python
RUN echo '#!/bin/bash\n\
# Activate Python virtual environment\n\
export PATH="/opt/venv/bin:$PATH"\n\
export PYTHON_PATH="/opt/venv/bin/python3"\n\
# Create directories\n\
mkdir -p /app/Seg-code-try2region-noise/work_dir/sam2_hiera_s_20251024_191552\n\
mkdir -p /app/Seg-code-try2region-noise/checkpoints\n\
# Download models if not exists\n\
if [ -n "$MEDICAL_MODEL_URL" ] && [ ! -f /app/Seg-code-try2region-noise/work_dir/sam2_hiera_s_20251024_191552/best_mean3d_model.pth ]; then\n\
 echo "Downloading medical model..."\n\
 curl -L -o /app/Seg-code-try2region-noise/work_dir/sam2_hiera_s_20251024_191552/best_mean3d_model.pth "$MEDICAL_MODEL_URL" || echo "Model download failed"\n\
fi\n\
if [ -n "$SAM_MODEL_URL" ] && [ ! -f /app/Seg-code-try2region-noise/checkpoints/sam2_hiera_small.pt ]; then\n\
 echo "Downloading SAM model..."\n\
 curl -L -o /app/Seg-code-try2region-noise/checkpoints/sam2_hiera_small.pt "$SAM_MODEL_URL" || echo "Model download failed"\n\
fi\n\
echo "Starting Next.js with Python venv..."\n\
echo "Python path: $PYTHON_PATH"\n\
exec node_modules/.bin/next start -p ${PORT:-3000}' > /app/start.sh && chmod +x /app/start.sh

# Expose port (Railway uses PORT env variable, default to 3000)
ENV PORT=3000
EXPOSE 3000

# Start command - run startup script first to download models
CMD ["/app/start.sh"]

#!/usr/bin/env python3
"""
Medical SAM2 Segmentation Script with Box Prompt

This script loads the medical-sam2 model and performs segmentation
based on input image and box prompt.

Supports two modes:
1. Basic mode: Uses SAM2ImagePredictor for general image segmentation
2. Medical mode: Uses Medical SAM2 (from Seg-code-try2region-noise) for medical image segmentation
"""

import sys
import os

# Check if medical mode is enabled via environment variable
USE_MEDICAL_MODE = os.getenv('USE_MEDICAL_SAM2', 'false').lower() == 'true'

if USE_MEDICAL_MODE:
    print("Using Medical SAM2 mode (Seg-code-try2region-noise)", file=sys.stderr)
    # Import and use medical segmentation module
    sys.path.insert(0, '/workspace/projects/Seg-code-try2region-noise')
    exec(open('/workspace/projects/scripts/segment_medical.py').read())
    sys.exit(0)

import json
import base64
import argparse
from io import BytesIO
from typing import Tuple, Dict, Any, Optional

# Try to import SAM2 packages with fallback
try:
    import torch
    from PIL import Image
    import numpy as np
    TORCH_AVAILABLE = True
except ImportError:
    print("Warning: PyTorch, PIL, or numpy not installed. Using mock mode.", file=sys.stderr)
    TORCH_AVAILABLE = False

# Try to import SAM2 with fallback
SAM2_AVAILABLE = False
if TORCH_AVAILABLE:
    try:
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        SAM2_AVAILABLE = True
    except ImportError:
        print("Warning: segment-anything-2 not installed. Using mock mode.", file=sys.stderr)


# Model configuration
MODEL_CHECKPOINT = os.getenv(
    "MEDICAL_SAM2_CHECKPOINT",
    "sam2_hiera_base_plus.pt"  # Default model
)
MODEL_CONFIG = os.getenv(
    "MEDICAL_SAM2_CONFIG",
    "sam2_hiera_b+.yaml"  # Default config
)


def load_image_from_base64(base64_string: str):
    """Load image from base64 string."""
    if not TORCH_AVAILABLE:
        # Return raw bytes for mock mode
        if ',' in base64_string:
            base64_string = base64_string.split(',')[1]
        return base64.b64decode(base64_string)

    # Remove data URL prefix if present
    if ',' in base64_string:
        base64_string = base64_string.split(',')[1]

    image_data = base64.b64decode(base64_string)
    image = Image.open(BytesIO(image_data)).convert("RGB")
    return np.array(image)


def load_model(checkpoint_path: str = None):
    """Load the SAM2 model."""
    if not SAM2_AVAILABLE:
        print("Warning: SAM2 not available. Model loading skipped.", file=sys.stderr)
        return None

    checkpoint_path = checkpoint_path or MODEL_CHECKPOINT
    if not os.path.exists(checkpoint_path):
        print(f"Warning: Model checkpoint not found at {checkpoint_path}", file=sys.stderr)
        print("Using mock mode. Please download the model file.", file=sys.stderr)
        return None

    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading SAM2 model from {checkpoint_path} on {device}", file=sys.stderr)

        # Build model
        predictor = build_sam2(MODEL_CONFIG, checkpoint_path, device=device)
        return SAM2ImagePredictor(predictor)
    except Exception as e:
        print(f"Error loading model: {e}", file=sys.stderr)
        print("Using mock mode.", file=sys.stderr)
        return None


def segment_image(
    image,
    box: Dict[str, int],
    model,
) -> Tuple[str, bool]:
    """
    Perform segmentation on the image using the given box.

    Args:
        image: Input image (numpy array or bytes for mock)
        box: Dictionary with x, y, width, height of the bounding box
        model: Loaded model predictor (or None for mock mode)

    Returns:
        Tuple of (mask as base64 string, success status)
    """
    if not SAM2_AVAILABLE or model is None:
        # Use mock mode
        return create_mock_mask(image, box), True

    try:
        # Set image for the predictor
        model.set_image(image)

        # Convert box to SAM2 format [x1, y1, x2, y2]
        box_prompt = np.array([
            box['x'],
            box['y'],
            box['x'] + box['width'],
            box['y'] + box['height']
        ])

        # Predict masks
        masks, scores, logits = model.predict(
            box=box_prompt,
            multimask_output=True,
        )

        # Select the best mask (highest score)
        best_mask = masks[np.argmax(scores)]

        # Convert mask to image
        mask_image = Image.fromarray((best_mask * 255).astype(np.uint8))
        mask_with_alpha = Image.new("RGBA", mask_image.size, (0, 255, 0, 128))
        mask_with_alpha.paste(mask_image, mask=mask_image)

        # Save to bytes
        buffer = BytesIO()
        mask_with_alpha.save(buffer, format="PNG")
        mask_base64 = base64.b64encode(buffer.getvalue()).decode()

        return f"data:image/png;base64,{mask_base64}", True

    except Exception as e:
        import traceback
        print(f"[ERROR] Exception in segment_image(): {type(e).__name__}: {e}", file=sys.stderr)
        print("[ERROR] Full traceback:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        # Re-raise so the caller (main) can log it as a JSON error response
        # instead of silently falling back to mock masks
        raise


def create_mock_mask(image_data: bytes, box: Dict[str, int]) -> str:
    """Create a mock mask for demonstration purposes based on box."""
    if not TORCH_AVAILABLE:
        # Simple mock without PIL
        width, height = 512, 512
        import random
        random.seed(hash(str(box)))

        # Create SVG mask
        mask_x = (width - 256) // 2
        mask_y = (height - 256) // 2

        svg_data = f'''<svg width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg">
          <rect x="{mask_x}" y="{mask_y}" width="256" height="256" fill="rgba(0,255,0,0.5)" stroke="rgba(0,200,0,1)" stroke-width="3"/>
          <text x="{width//2}" y="{height//2}" text-anchor="middle" fill="white" font-size="20">
            Mock Mode - Model Not Loaded
          </text>
        </svg>'''

        base64_mask = base64.b64encode(svg_data.encode()).decode()
        return f"data:image/svg+xml;base64,{base64_mask}"

    # Use PIL for better mock
    from PIL import Image, ImageDraw
    import random

    width, height = 512, 512

    # Calculate box dimensions
    if box.get('width') and box.get('height'):
        max_dim = max(box['width'], box['height'])
        scale = min(width, height) / max_dim if max_dim > 0 else 1

        mask_width = int(box['width'] * scale)
        mask_height = int(box['height'] * scale)
        mask_x = (width - mask_width) // 2
        mask_y = (height - mask_height) // 2
    else:
        mask_width, mask_height = 256, 256
        mask_x, mask_y = (width - 256) // 2, (height - 256) // 2

    # Create mask image
    mask = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(mask)

    # Draw the box area
    draw.rectangle(
        [mask_x, mask_y, mask_x + mask_width, mask_y + mask_height],
        fill=(0, 255, 0, 128),
        outline=(0, 200, 0, 200),
        width=3
    )

    # Add some variation to simulate segmentation
    random.seed(hash(str(box)))
    for _ in range(min(10, max(3, mask_width // 20))):
        ox = random.randint(mask_x, mask_x + mask_width)
        oy = random.randint(mask_y, mask_y + mask_height)
        r = random.randint(5, min(30, min(mask_width, mask_height) // 4))
        draw.ellipse([ox-r, oy-r, ox+r, oy+r], fill=(0, 200, 0, 150))

    # Convert to base64
    buffer = BytesIO()
    mask.save(buffer, format="PNG")
    mask_base64 = base64.b64encode(buffer.getvalue()).decode()
    return f"data:image/png;base64,{mask_base64}"


def main():
    parser = argparse.ArgumentParser(description="Medical SAM2 Segmentation with Box Prompt")
    parser.add_argument("input_json", help="Input JSON with image and box")
    parser.add_argument("--checkpoint", help="Path to model checkpoint", default=None)
    args = parser.parse_args()

    try:
        # Parse input
        input_data = json.loads(args.input_json)
        image_b64 = input_data.get("image")
        box = input_data.get("box")

        if not image_b64 or not box:
            result = {"success": False, "error": "Missing image or box"}
            print(json.dumps(result))
            sys.exit(1)

        # Validate box dimensions
        if box.get('width', 0) <= 0 or box.get('height', 0) <= 0:
            result = {"success": False, "error": "Invalid box dimensions"}
            print(json.dumps(result))
            sys.exit(1)

        # Load image
        image = load_image_from_base64(image_b64)

        # Load model (will be None if not available)
        model = load_model(args.checkpoint)

        # Perform segmentation
        mask_b64, success = segment_image(image, box, model)

        if success:
            result = {"success": True, "mask": mask_b64}
            print(json.dumps(result))
            sys.exit(0)
        else:
            result = {"success": False, "error": "Segmentation failed"}
            print(json.dumps(result))
            sys.exit(1)

    except Exception as e:
        import traceback
        print(f"[ERROR] Unhandled exception in main(): {type(e).__name__}: {e}", file=sys.stderr)
        print("[ERROR] Full traceback:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        result = {"success": False, "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(result))
        sys.exit(1)


if __name__ == "__main__":
    main()

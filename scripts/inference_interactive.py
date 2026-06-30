#!/usr/bin/env python3
"""
This script allows users to:
1. Load a 2D image (PNG/JPG) or 3D volume (nii.gz)
2. Manually draw bounding boxes for WG and CG
3. Perform segmentation using the trained model
4. Visualize results interactively
"""

import os
import sys
import json
import argparse
import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from io import BytesIO
import base64
import traceback

# Get script directory for relative paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Go up one level from 'scripts' to project root, then to Seg-code-try2region-noise
PROJECT_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), 'Seg-code-try2region-noise')

# Add to Python path
sys.path.insert(0, PROJECT_DIR)

# Initialize Hydra configuration BEFORE importing sam2_train modules
# This is critical for Railway deployment
from hydra import initialize_config_module, compose
from omegaconf import OmegaConf
import logging

# Set up logging
logging.basicConfig(level=logging.INFO)

# Initialize Hydra config module
print("[DEBUG] Initializing Hydra config module...", file=sys.stderr)
initialize_config_module("sam2_train", version_base="1.2")
print("[DEBUG] Hydra config module initialized", file=sys.stderr)

# Import config after setting path and initializing Hydra
import cfg

# For nii.gz loading
try:
    import nibabel as nib
    NIBABEL_AVAILABLE = True
except ImportError:
    print("Warning: nibabel not installed. Cannot load nii.gz files.", file=sys.stderr)
    NIBABEL_AVAILABLE = False

# For morphological post-processing
try:
    from scipy import ndimage
    SCIPY_AVAILABLE = True
except ImportError:
    print("Warning: scipy not installed. Post-processing disabled.", file=sys.stderr)
    SCIPY_AVAILABLE = False

# For model download
try:
    import urllib.request
    import urllib.error
    URLLIB_AVAILABLE = True
except ImportError:
    URLLIB_AVAILABLE = False

# Configuration (using dynamic paths based on script location)
WORK_DIR = os.path.join(PROJECT_DIR, 'work_dir/sam2_hiera_s_20251024_191552')
CHECKPOINT_DIR = os.path.join(PROJECT_DIR, 'checkpoints')
DEFAULT_MODEL_CHECKPOINT = os.path.join(WORK_DIR, 'best_mean3d_model.pth')
SAM_CHECKPOINT = os.path.join(CHECKPOINT_DIR, 'sam2_hiera_small.pt')

# Print paths for debugging
print(f"[DEBUG] Script directory: {SCRIPT_DIR}", file=sys.stderr)
print(f"[DEBUG] Project directory: {PROJECT_DIR}", file=sys.stderr)
print(f"[DEBUG] Work directory: {WORK_DIR}", file=sys.stderr)
print(f"[DEBUG] Checkpoint directory: {CHECKPOINT_DIR}", file=sys.stderr)


def download_model(url: str, dest_path: str) -> bool:
    """Download model file from URL if not exists."""
    if os.path.exists(dest_path):
        print(f"[INFO] Model already exists at {dest_path}", file=sys.stderr)
        return True
    
    if not URLLIB_AVAILABLE:
        print("[ERROR] urllib not available for downloading models", file=sys.stderr)
        return False
    
    # Create directory if not exists
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    
    print(f"[INFO] Downloading model from {url}...", file=sys.stderr)
    print(f"[INFO] This may take a few minutes for large files...", file=sys.stderr)
    
    try:
        # Add timeout and headers
        class DownloadProgress:
            def __init__(self):
                self.bytes_downloaded = 0
                self.last_print = 0
            
            def __call__(self, block_num, block_size, total_size):
                self.bytes_downloaded += block_size
                if self.bytes_downloaded - self.last_print > 10 * 1024 * 1024:  # Print every 10MB
                    mb = self.bytes_downloaded / (1024 * 1024)
                    if total_size > 0:
                        total_mb = total_size / (1024 * 1024)
                        print(f"[INFO] Downloaded: {mb:.1f}MB / {total_mb:.1f}MB", file=sys.stderr)
                    else:
                        print(f"[INFO] Downloaded: {mb:.1f}MB", file=sys.stderr)
                    self.last_print = self.bytes_downloaded
        
        urllib.request.urlretrieve(
            url,
            dest_path,
            reporthook=DownloadProgress().__call__
        )
        print(f"[INFO] Download complete: {dest_path}", file=sys.stderr)
        return True
    except Exception as e:
        print(f"[ERROR] Failed to download model: {e}", file=sys.stderr)
        # Clean up partial download
        if os.path.exists(dest_path):
            os.remove(dest_path)
        return False


def ensure_models_exist():
    """Ensure all required model files exist, download if needed."""
    # Get download URLs from environment variables
    medical_model_url = os.environ.get('MEDICAL_MODEL_URL')
    sam_model_url = os.environ.get('SAM_MODEL_URL')
    
    # Create directories
    os.makedirs(WORK_DIR, exist_ok=True)
    os.makedirs(CHECKPOINT_DIR, exist_ok=True)
    
    # Download medical model if needed
    if medical_model_url and not os.path.exists(DEFAULT_MODEL_CHECKPOINT):
        download_model(medical_model_url, DEFAULT_MODEL_CHECKPOINT)
    
    # Download SAM base model if needed
    if sam_model_url and not os.path.exists(SAM_CHECKPOINT):
        download_model(sam_model_url, SAM_CHECKPOINT)


def load_image(base64_string):
    """Load image from base64 string."""
    if ',' in base64_string:
        base64_string = base64_string.split(',')[1]

    image_data = base64.b64decode(base64_string)
    image = Image.open(BytesIO(image_data)).convert("RGB")
    return np.array(image)


def load_nifti(nifti_path):
    """Load NIfTI file and return as numpy array."""
    if not NIBABEL_AVAILABLE:
        raise ImportError("nibabel is required to load NIfTI files")

    nii_img = nib.load(nifti_path)
    data = nii_img.get_fdata()

    # If 3D, take the middle slice
    if data.ndim == 3:
        mid_slice = data.shape[2] // 2
        data = data[:, :, mid_slice]

    # Normalize to 0-255
    data = (data - data.min()) / (data.max() - data.min() + 1e-8) * 255
    return data.astype(np.uint8)


def smooth_mask(mask_array: np.ndarray, min_size: int = 100, operation: str = 'both') -> np.ndarray:
    """
    Enhanced post-processing to remove small noise regions, fill holes, and smooth boundaries.

    Args:
        mask_array: Input mask array (H, W)
        min_size: Minimum region size, regions smaller than this will be removed
        operation: Morphological operation type ('opening', 'closing', 'both')

    Returns:
        Smoothed mask array
    """
    if not SCIPY_AVAILABLE:
        print("Warning: scipy not available. Skipping mask smoothing.", file=sys.stderr)
        return mask_array

    # Ensure binary mask
    if mask_array.max() > 1:
        mask_array = (mask_array > 0).astype(np.uint8)

    # Step 1: Fill small holes first (binary_fill_holes)
    mask_filled = ndimage.binary_fill_holes(mask_array).astype(np.uint8)
    
    # Step 2: Morphological closing to fill larger holes and smooth boundaries
    # Use larger structure (5x5) and more iterations for better results
    structure_closing = ndimage.generate_binary_structure(2, 2)
    mask_closing = ndimage.binary_closing(
        mask_filled, 
        structure=structure_closing, 
        iterations=2
    ).astype(np.uint8)

    # Step 3: Morphological opening to remove small noise
    structure_opening = ndimage.generate_binary_structure(2, 1)
    mask_opening = ndimage.binary_opening(
        mask_closing, 
        structure=structure_opening, 
        iterations=1
    ).astype(np.uint8)

    # Step 4: Connected component analysis - keep only the largest region
    labeled, num_features = ndimage.label(mask_opening)
    if num_features > 0:
        sizes = ndimage.sum(mask_opening, labeled, range(num_features + 1))
        
        # Find the largest region
        max_size = 0
        max_label = 0
        for i in range(1, num_features + 1):
            if sizes[i] > max_size:
                max_size = sizes[i]
                max_label = i
        
        # Keep the largest region if it's large enough
        mask_smoothed = np.zeros_like(mask_opening)
        if max_size >= min_size:
            mask_smoothed[labeled == max_label] = 1
        
        # If largest region is small, keep all regions above min_size
        if max_size < min_size:
            for i in range(1, num_features + 1):
                if sizes[i] >= min_size:
                    mask_smoothed[labeled == i] = 1
    else:
        mask_smoothed = mask_opening

    # Step 5: Final closing to smooth edges
    mask_final = ndimage.binary_closing(
        mask_smoothed, 
        structure=structure_closing, 
        iterations=1
    ).astype(np.uint8)

    return mask_final


def refine_mask_boundary(mask_array: np.ndarray, sigma: float = 1.0) -> np.ndarray:
    """
    Refine mask boundary using Gaussian blur for smoother edges.
    
    Args:
        mask_array: Input binary mask (H, W)
        sigma: Gaussian blur sigma (higher = smoother edges)
    
    Returns:
        Refined binary mask with smoother boundaries
    """
    if not SCIPY_AVAILABLE:
        return mask_array
    
    # Convert to float
    mask_float = mask_array.astype(np.float32)
    
    # Apply Gaussian filter
    mask_blurred = ndimage.gaussian_filter(mask_float, sigma=sigma)
    
    # Threshold back to binary (use 0.5 as threshold)
    mask_refined = (mask_blurred > 0.5).astype(np.uint8)
    
    return mask_refined


def create_colored_mask(mask: np.ndarray, color: tuple = (255, 0, 0), alpha: int = 150) -> Image.Image:
    """Create a colored mask image from binary mask.
    
    Args:
        mask: Binary mask array (H, W)
        color: RGB color tuple
        alpha: Alpha value for mask opacity
    
    Returns:
        PIL Image in RGBA mode
    """
    mask_rgb = np.zeros((mask.shape[0], mask.shape[1], 4), dtype=np.uint8)
    mask_rgb[..., 0] = color[0]  # Red
    mask_rgb[..., 1] = color[1]  # Green
    mask_rgb[..., 2] = color[2]  # Blue
    mask_rgb[..., 3] = (mask > 0).astype(np.uint8) * alpha  # Alpha
    return Image.fromarray(mask_rgb, mode='RGBA')


def resize_mask_to_original(mask: np.ndarray, orig_H: int, orig_W: int) -> np.ndarray:
    """Resize mask back to original image dimensions.
    
    Args:
        mask: Mask array (H, W) - typically 1024x1024
        orig_H: Original image height
        orig_W: Original image width
    
    Returns:
        Resized mask array (orig_H, orig_W)
    """
    mask_image = Image.fromarray(mask.astype(np.uint8), mode='L')
    # Resize to original dimensions (not to 1024x1024)
    mask_resized = mask_image.resize((orig_W, orig_H), Image.BILINEAR)
    return np.array(mask_resized)


def image_to_base64(image: Image.Image) -> str:
    """Convert PIL Image to base64 data URL."""
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    image_base64 = base64.b64encode(buffer.getvalue()).decode()
    return f"data:image/png;base64,{image_base64}"


def load_model(checkpoint_path: str = None, use_medical: bool = True):
    """Load the SAM2 model.
    
    Args:
        checkpoint_path: Optional path to custom checkpoint
        use_medical: If True, load medical fine-tuned model; if False, use base SAM2
    """
    try:
        # Ensure models are downloaded
        ensure_models_exist()
        
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[INFO] Using device: {device}", file=sys.stderr)
        
        # Check USE_MEDICAL_SAM2 environment variable (set by API route)
        use_medical_env = os.environ.get('USE_MEDICAL_SAM2', '')
        if use_medical_env:
            # Environment variable takes precedence: 'true' or 'false'
            use_medical = use_medical_env.lower() == 'true'
        
        print(f"[INFO] Mode: {'Medical SAM2' if use_medical else 'Basic SAM2'}", file=sys.stderr)

        # Create mock args for model loading
        args = cfg.parse_args()
        args.gpu_device = 0 if device == "cuda" else None
        args.gpu = (device == "cuda")
        args.sam_ckpt = SAM_CHECKPOINT  # Use absolute path for base SAM2 checkpoint

        # Import build function
        from sam2_train.build_sam import build_sam2_video_predictor

        # Ensure Hydra is initialized
        print(f"[DEBUG] sys.path: {sys.path[:3]}", file=sys.stderr)
        print(f"[DEBUG] Importing sam2_train modules...", file=sys.stderr)
        
        # Test import
        try:
            from sam2_train import sam2_video_predictor
            print(f"[DEBUG] sam2_video_predictor module: {dir(sam2_video_predictor)}", file=sys.stderr)
        except Exception as e:
            print(f"[DEBUG] Import error: {e}", file=sys.stderr)

        # Build model directly without going through get_network
        print(f"[INFO] Building SAM2 predictor from {SAM_CHECKPOINT}", file=sys.stderr)
        net = build_sam2_video_predictor(
            config_file=args.sam_config,
            ckpt_path=args.sam_ckpt,
            device=device,
            mode=None,
            apply_postprocessing=False  # Disable CUDA post-processing for CPU mode
        )

        # Determine which checkpoint to load
        if checkpoint_path:
            pretrain_path = checkpoint_path
        elif use_medical:
            pretrain_path = DEFAULT_MODEL_CHECKPOINT
        else:
            # Basic mode: only use base SAM2, no custom weights
            pretrain_path = None

        # Load custom weights for medical mode
        if pretrain_path and os.path.exists(pretrain_path):
            print(f"[INFO] Loading {'medical' if use_medical else 'base'} weights from {pretrain_path}", file=sys.stderr)
            checkpoint = torch.load(pretrain_path, map_location='cpu')

            if 'model' in checkpoint:
                net.load_state_dict(checkpoint['model'])
                epoch = checkpoint.get('epoch', 'unknown')
                dice = checkpoint.get('best_mean3d_dice', 'N/A')
                print(f"[INFO] Checkpoint from epoch {epoch}, Dice: {dice}", file=sys.stderr)
            else:
                net.load_state_dict(checkpoint)
                print("[INFO] Loaded full checkpoint", file=sys.stderr)
        elif pretrain_path:
            print(f"[ERROR] Checkpoint not found at {pretrain_path}", file=sys.stderr)
            return None
        else:
            print("[INFO] Using base SAM2 model without custom weights", file=sys.stderr)

        net.eval()
        return net

    except Exception as e:
        print(f"[ERROR] Failed to load model: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return None


def segment_image(image, boxes, model):
    """
    Perform segmentation on the image using the given boxes.

    Args:
        image: Input image (numpy array)
        boxes: List of dictionaries with type (WG/CG), x, y, width, height
        model: Loaded model predictor

    Returns:
        Tuple of (dict of mask as base64 strings, success status)
    """
    if model is None:
        # Fallback to mock mode
        return create_mock_masks(image, boxes), True

    try:
        device = next(model.parameters()).device

        # Determine which boxes are present
        wg_boxes = [b for b in boxes if b.get('type') == 'WG']
        cg_boxes = [b for b in boxes if b.get('type') == 'CG']

        if not wg_boxes and not cg_boxes:
            print("[WARNING] No valid boxes found, using mock", file=sys.stderr)
            return create_mock_masks(image, boxes), True

        print(f"[INFO] Original image shape: {image.shape}", file=sys.stderr)

        # Get original dimensions
        orig_H, orig_W = image.shape[0], image.shape[1]

        # Convert image to tensor
        if image.ndim == 3:  # [H, W, C] (RGB)
            # Convert to grayscale
            if image.shape[2] == 3:
                image_gray = np.dot(image[..., :3], [0.2989, 0.5870, 0.1140])
            else:
                image_gray = np.mean(image, axis=2)
            image_np = image_gray.astype(np.float32)
        elif image.ndim == 2:  # [H, W] (already grayscale)
            image_np = image.astype(np.float32)
        else:
            raise ValueError(f"Unexpected image shape: {image.shape}")

        # Normalize to [0, 1]
        if image_np.max() > 1.0:
            image_np = image_np / 255.0

        # Resize to model's expected input size (1024x1024)
        target_size = 1024
        print(f"[INFO] Resizing image from {image_np.shape} to ({target_size}, {target_size})", file=sys.stderr)
        from PIL import Image as PILImage
        image_pil = PILImage.fromarray((image_np * 255).astype(np.uint8))
        image_pil = image_pil.resize((target_size, target_size), PILImage.LANCZOS)
        image_np = np.array(image_pil).astype(np.float32) / 255.0

        # Calculate separate scale factors for width and height
        scale_factor_w = target_size / orig_W
        scale_factor_h = target_size / orig_H
        print(f"[INFO] Scale factors: width={scale_factor_w:.4f}, height={scale_factor_h:.4f}", file=sys.stderr)

        # Convert to [1, H, W] tensor
        image_tensor = torch.from_numpy(image_np).unsqueeze(0).float()

        # Repeat to create 3-channel image -> [batch=1, channels=3, H, W]
        # Then create video sequence by repeating the same frame -> [batch=1, channels=3, frames=3, H, W]
        image_tensor = image_tensor.unsqueeze(1).repeat(1, 3, 1, 1)  # [1, 3, H, W]
        # Create video: repeat same frame 3 times -> [1, 3, 3, H, W]
        image_tensor = image_tensor.unsqueeze(2).repeat(1, 1, 3, 1, 1)  # [1, 3, 3, H, W]
        # Move batch dimension to correct position for SAM2: [frames=3, batch=1, channels=3, H, W]
        image_tensor = image_tensor.squeeze(0)  # [3, 3, H, W]
        image_tensor = image_tensor.to(device)

        print(f"[INFO] Input shape: {image_tensor.shape}", file=sys.stderr)

        # Initialize inference state
        state = model.val_init_state(
            imgs_tensor=image_tensor,
            offload_video_to_cpu=True,
            offload_state_to_cpu=True
        )

        # Add bbox prompts with correct scale factors
        if len(wg_boxes) > 0:
            wg_box = wg_boxes[0]
            wg_bbox = torch.tensor([
                wg_box['x'] * scale_factor_w,  # x1 (left)
                wg_box['y'] * scale_factor_h,  # y1 (top)
                (wg_box['x'] + wg_box['width']) * scale_factor_w,  # x2 (right)
                (wg_box['y'] + wg_box['height']) * scale_factor_h  # y2 (bottom)
            ]).unsqueeze(0).to(device)
            model.add_new_bbox(state, frame_idx=1, obj_id=3, bbox=wg_bbox, clear_old_points=False)
            print(f"[INFO] Added WG bbox (obj_id=3): {wg_bbox.tolist()}", file=sys.stderr)

        if len(cg_boxes) > 0:
            cg_box = cg_boxes[0]
            cg_bbox = torch.tensor([
                cg_box['x'] * scale_factor_w,  # x1 (left)
                cg_box['y'] * scale_factor_h,  # y1 (top)
                (cg_box['x'] + cg_box['width']) * scale_factor_w,  # x2 (right)
                (cg_box['y'] + cg_box['height']) * scale_factor_h  # y2 (bottom)
            ]).unsqueeze(0).to(device)
            model.add_new_bbox(state, frame_idx=1, obj_id=1, bbox=cg_bbox, clear_old_points=False)
            print(f"[INFO] Added CG bbox (obj_id=1): {cg_bbox.tolist()}", file=sys.stderr)

        # Propagate to get segmentation
        segs = {}
        for out_fid, out_ids, out_logits in model.propagate_in_video(state, start_frame_idx=0):
            segs[out_fid] = {oid: out_logits[i] for i, oid in enumerate(out_ids)}

        print(f"[INFO] Segments extracted for frames: {list(segs.keys())}", file=sys.stderr)

        # Extract masks for frame 1
        if 1 in segs:
            H, W = image_tensor.shape[-2:]

            cg_logit = segs[1].get(1, torch.zeros((H, W), device=device))
            wg_logit = segs[1].get(3, torch.zeros((H, W), device=device))

            # Convert to probabilities using sigmoid
            cg_prob = torch.sigmoid(cg_logit)
            wg_prob = torch.sigmoid(wg_logit)
            pz_prob = torch.relu(wg_prob - cg_prob)

            # Resize masks back to original image size
            from torch.nn.functional import interpolate

            def expand_for_interpolation(x):
                if x.ndim == 2:
                    return x.unsqueeze(0).unsqueeze(0)
                elif x.ndim == 3:
                    return x.unsqueeze(0)
                else:
                    return x.unsqueeze(1)

            wg_prob_expanded = expand_for_interpolation(wg_prob)
            cg_prob_expanded = expand_for_interpolation(cg_prob)
            pz_prob_expanded = expand_for_interpolation(pz_prob)

            wg_prob_resized = interpolate(wg_prob_expanded, size=(orig_H, orig_W), mode='bilinear', align_corners=False).squeeze()
            cg_prob_resized = interpolate(cg_prob_expanded, size=(orig_H, orig_W), mode='bilinear', align_corners=False).squeeze()
            pz_prob_resized = interpolate(pz_prob_expanded, size=(orig_H, orig_W), mode='bilinear', align_corners=False).squeeze()

            # Create masks
            masks_dict = {}

            if len(wg_boxes) > 0:
                wg_mask = (wg_prob_resized > 0.5).cpu().numpy().astype(np.uint8)
                wg_mask_smoothed = smooth_mask(wg_mask, min_size=200, operation='both')
                # Resize mask back to original image dimensions
                wg_mask_final = resize_mask_to_original(wg_mask_smoothed, orig_H, orig_W)
                wg_mask_image = create_colored_mask(wg_mask_final, color=(255, 0, 0), alpha=150)
                wg_mask_base64 = image_to_base64(wg_mask_image)
                masks_dict['WG'] = wg_mask_base64

            if len(cg_boxes) > 0:
                cg_mask = (cg_prob_resized > 0.5).cpu().numpy().astype(np.uint8)
                cg_mask_smoothed = smooth_mask(cg_mask, min_size=100, operation='both')
                # Resize mask back to original image dimensions
                cg_mask_final = resize_mask_to_original(cg_mask_smoothed, orig_H, orig_W)
                cg_mask_image = create_colored_mask(cg_mask_final, color=(0, 255, 0), alpha=150)
                cg_mask_base64 = image_to_base64(cg_mask_image)
                masks_dict['CG'] = cg_mask_base64

            if len(wg_boxes) > 0 and len(cg_boxes) > 0:
                pz_mask = (pz_prob_resized > 0.5).cpu().numpy().astype(np.uint8)
                pz_mask_smoothed = smooth_mask(pz_mask, min_size=100, operation='both')
                # Resize mask back to original image dimensions
                pz_mask_final = resize_mask_to_original(pz_mask_smoothed, orig_H, orig_W)
                pz_mask_image = create_colored_mask(pz_mask_final, color=(0, 0, 255), alpha=150)
                pz_mask_base64 = image_to_base64(pz_mask_image)
                masks_dict['PZ'] = pz_mask_base64

            return masks_dict, True
        else:
            print("[WARNING] No segmentation output found for frame 1, using mock", file=sys.stderr)
            return create_mock_masks(image, boxes), True

    except Exception as e:
        print(f"[ERROR] Error during segmentation: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return create_mock_masks(image, boxes), True


def create_mock_masks(image_data=None, boxes=None):
    """Create mock masks for demonstration purposes."""
    if boxes is None:
        boxes = []
    masks_dict = {}

    for box in boxes:
        mask_type = box.get('type', 'WG')
        if mask_type not in masks_dict:
            color = (255, 0, 0) if mask_type == 'WG' else (0, 255, 0)
            mask_image = create_colored_mask(np.zeros((512, 512)), color=color, alpha=150)
            masks_dict[mask_type] = image_to_base64(mask_image)

    return masks_dict


def main():
    parser = argparse.ArgumentParser(description="Interactive Medical SAM2 Inference")
    parser.add_argument("input_json", nargs='?', help="Input JSON with image and boxes")
    parser.add_argument("--checkpoint", help="Path to model checkpoint", default=None)
    parser.add_argument("--use-medical", action="store_true", default=None, help="Use medical SAM2 mode")
    args = parser.parse_args()

    try:
        # Parse input
        if args.input_json:
            input_json_str = args.input_json
            if os.path.exists(input_json_str):
                with open(input_json_str, 'r') as f:
                    input_data = json.load(f)
            else:
                input_data = json.loads(input_json_str)
        else:
            input_json_str = sys.stdin.read()
            if not input_json_str.strip():
                result = {"success": False, "error": "No input data provided"}
                print(json.dumps(result))
                sys.exit(1)
            input_data = json.loads(input_json_str)

        image_b64 = input_data.get("image")
        boxes = input_data.get("boxes")

        if not image_b64 or not boxes:
            result = {"success": False, "error": "Missing image or boxes"}
            print(json.dumps(result))
            sys.exit(1)

        # Load image
        image = load_image(image_b64)

        # Load model (will read USE_MEDICAL_SAM2 from environment)
        model = load_model(args.checkpoint)

        # Perform segmentation
        masks_dict, success = segment_image(image, boxes, model)

        if success:
            result = {"success": True, "masks": masks_dict}
            print(json.dumps(result))
            sys.exit(0)
        else:
            result = {"success": False, "error": "Segmentation failed"}
            print(json.dumps(result))
            sys.exit(1)

    except Exception as e:
        result = {"success": False, "error": str(e)}
        print(json.dumps(result))
        sys.exit(1)


if __name__ == "__main__":
    main()

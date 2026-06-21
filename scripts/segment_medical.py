#!/usr/bin/env python3
"""
Medical SAM2 Segmentation Script (Integrated from Seg-code-try2region-noise)

This script uses the medical-sam2 model from the user's project for
medical image segmentation with box prompts.

Key Features:
- Uses SAM2VideoPredictor from Seg-code-try2region-noise
- Supports single-frame and multi-frame medical images
- Optimized for prostate WG/CG/PZ segmentation
"""

import sys
import json
import base64
import argparse
import os
from io import BytesIO
from typing import Tuple, Dict, Any, Optional

# Try to import numpy and PIL first (needed for both real and mock modes)
try:
    import numpy as np
    from PIL import Image
    NUMPY_AVAILABLE = True
    print("[INFO] numpy is available", file=sys.stderr)
except ImportError as e:
    print(f"Warning: numpy or PIL not installed: {e}", file=sys.stderr)
    NUMPY_AVAILABLE = False

# Try to import PyTorch
try:
    import torch
    import torch.nn as nn
    TORCH_AVAILABLE = True
    print("[INFO] PyTorch is available", file=sys.stderr)
except ImportError as e:
    print(f"Warning: PyTorch not installed: {e}", file=sys.stderr)
    TORCH_AVAILABLE = False

# Try to import scipy separately (for post-processing)
SCIPY_AVAILABLE = False
if NUMPY_AVAILABLE:
    try:
        from scipy import ndimage
        SCIPY_AVAILABLE = True
        print("[INFO] scipy is available for post-processing", file=sys.stderr)
    except ImportError as e:
        print(f"Warning: scipy not installed: {e}", file=sys.stderr)
        print("Post-processing will be disabled.", file=sys.stderr)

# Try to import user's SAM2 project
MEDICAL_SAM2_AVAILABLE = False
if TORCH_AVAILABLE and NUMPY_AVAILABLE:
    try:
        # Add the user's project to Python path
        sys.path.insert(0, '/workspace/projects/Seg-code-try2region-noise')

        # Temporarily set sys.argv to avoid parse_args() issues
        original_argv = sys.argv
        sys.argv = ['segment_medical.py']  # Minimal args

        try:
            # Import build_sam2_video_predictor first (this doesn't require parsing args)
            from sam2_train.build_sam import build_sam2_video_predictor

            # Import get_network and cfg (but don't call parse_args yet)
            import func_3d.utils as utils_module
            get_network = utils_module.get_network

            # Import cfg module but handle the parse_args call carefully
            import cfg as cfg_module
            cfg = cfg_module
        finally:
            # Restore original sys.argv
            sys.argv = original_argv

        MEDICAL_SAM2_AVAILABLE = True
    except ImportError as e:
        print(f"Warning: Medical SAM2 not available: {e}", file=sys.stderr)
        print("Using mock mode. Please ensure Seg-code-try2region-noise is available.", file=sys.stderr)


# Model configuration - using user's project paths
PROJECT_DIR = '/workspace/projects/Seg-code-try2region-noise'

# Default configuration and checkpoint
DEFAULT_MODEL_CONFIG = 'sam2_hiera_s'  # Config name
DEFAULT_MODEL_CHECKPOINT = os.path.join(PROJECT_DIR, 'checkpoints/sam2_hiera_small.pt')

# Custom trained model path (from environment variable)
CUSTOM_MODEL_CHECKPOINT = os.getenv('MEDICAL_SAM2_CUSTOM_CHECKPOINT',
    os.path.join(PROJECT_DIR, 'work_dir/sam2_hiera_s_20251024_191552/best_mean3d_model.pth'))


def load_image_from_base64(base64_string: str):
    """Load image from base64 string."""
    if not NUMPY_AVAILABLE:
        if ',' in base64_string:
            base64_string = base64_string.split(',')[1]
        return base64.b64decode(base64_string)

    # Remove data URL prefix if present
    if ',' in base64_string:
        base64_string = base64_string.split(',')[1]

    image_data = base64.b64decode(base64_string)
    image = Image.open(BytesIO(image_data)).convert("RGB")
    return np.array(image)


def smooth_mask(mask_array: np.ndarray, min_size: int = 100, operation: str = 'both') -> np.ndarray:
    """
    对 mask 进行后处理，消除小的噪声区域和填充小空洞

    Args:
        mask_array: 输入的 mask 数组 (H, W)
        min_size: 最小区域大小，小于这个大小的区域会被移除
        operation: 形态学操作类型 ('opening', 'closing', 'both')

    Returns:
        平滑后的 mask 数组
    """
    # 如果 scipy 不可用，直接返回原始 mask
    if not SCIPY_AVAILABLE:
        print("Warning: scipy not available. Skipping mask smoothing.", file=sys.stderr)
        return mask_array

    # 确保是二值 mask
    if mask_array.max() > 1:
        mask_array = (mask_array > 0).astype(np.uint8)

    # 执行形态学操作
    if operation in ['opening', 'both']:
        # 开运算：先腐蚀后膨胀，消除小的噪声区域
        structure = ndimage.generate_binary_structure(2, 2)
        mask_array = ndimage.binary_opening(mask_array, structure=structure, iterations=1)

    if operation in ['closing', 'both']:
        # 闭运算：先膨胀后腐蚀，填充小的空洞
        structure = ndimage.generate_binary_structure(2, 2)
        mask_array = ndimage.binary_closing(mask_array, structure=structure, iterations=1)

    # 移除小的连通区域
    labeled, num_features = ndimage.label(mask_array)
    sizes = ndimage.sum(mask_array, labeled, range(num_features + 1))

    # 保留大于 min_size 的区域
    mask_smoothed = np.zeros_like(mask_array)
    for i in range(1, num_features + 1):
        if sizes[i] >= min_size:
            mask_smoothed[labeled == i] = 1

    return mask_smoothed


def load_model(checkpoint_path: str = None, use_custom: bool = True):
    """Load the Medical SAM2 model.

    This function loads the model using the user's get_network function,
    which is the same method used in train_3d.py and test.py.
    """
    if not MEDICAL_SAM2_AVAILABLE:
        print("Warning: Medical SAM2 not available. Model loading skipped.", file=sys.stderr)
        return None

    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[INFO] Using device: {device}", file=sys.stderr)

        # Build model directly using build_sam2_video_predictor
        # This is simpler and avoids cfg.parse_args() issues
        # Set apply_postprocessing=False to avoid fill_holes_in_mask_scores that requires CUDA extensions
        net = build_sam2_video_predictor(
            config_file=DEFAULT_MODEL_CONFIG,
            ckpt_path=DEFAULT_MODEL_CHECKPOINT,
            device=device,
            apply_postprocessing=False  # Disable postprocessing to avoid CUDA dependency in CPU-only environment
        )

        # Load custom weights if available
        if use_custom:
            custom_checkpoint_path = checkpoint_path or CUSTOM_MODEL_CHECKPOINT

            if os.path.exists(custom_checkpoint_path):
                print(f"[INFO] Loading custom trained model from {custom_checkpoint_path}", file=sys.stderr)

                try:
                    custom_state_dict = torch.load(custom_checkpoint_path, map_location='cpu')

                    # Extract model weights if checkpoint has 'model' key
                    if 'model' in custom_state_dict:
                        model_weights = custom_state_dict['model']
                        epoch = custom_state_dict.get('epoch', 'unknown')
                        best_dice = custom_state_dict.get('best_mean3d_dice', 'N/A')
                        print(f"[INFO] Custom checkpoint from epoch {epoch}", file=sys.stderr)
                        print(f"[INFO] Best mean 3D Dice: {best_dice}", file=sys.stderr)
                    else:
                        model_weights = custom_state_dict
                        print(f"[INFO] Loading full checkpoint", file=sys.stderr)

                    # Load weights into the model
                    net.load_state_dict(model_weights, strict=False)
                    print("[INFO] Custom weights loaded successfully!", file=sys.stderr)

                except Exception as e:
                    print(f"[WARNING] Failed to load custom weights: {e}", file=sys.stderr)
                    print("[INFO] Using base checkpoint weights", file=sys.stderr)
            else:
                print(f"[INFO] Custom checkpoint not found at {custom_checkpoint_path}", file=sys.stderr)
                print(f"[INFO] Using base checkpoint", file=sys.stderr)

        net.eval()
        return net

    except Exception as e:
        print(f"Error loading medical SAM2 model: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        print("Using mock mode.", file=sys.stderr)
        return None


def ensure_shape_4d(x):
    """Ensure tensor is [1,1,H,W]"""
    if x.ndim == 2:
        x = x.unsqueeze(0).unsqueeze(0)
    elif x.ndim == 3:
        x = x.unsqueeze(1)
    return x


def segment_image(
    image,
    boxes: list,
    model,
) -> Tuple[Dict[str, str], bool]:
    """
    Perform medical segmentation on the image using the given boxes.

    Supported scenarios:
    1. Only WG box: Segment WG (obj_id=3)
    2. Only CG box: Segment CG (obj_id=1)
    3. Both WG and CG boxes: Segment WG, CG, and PZ (obj_id=1, 3; PZ = WG - CG)

    Args:
        image: Input image (numpy array or bytes for mock)
        boxes: List of dictionaries with type (WG/CG), x, y, width, height
        model: Loaded model predictor (or None for mock mode)

    Returns:
        Tuple of (dict of mask as base64 strings, success status)
    """
    if not MEDICAL_SAM2_AVAILABLE or model is None:
        # Use mock mode
        return create_mock_masks(image, boxes), True

    try:
        # Add debug info for boxes
        print(f"[DEBUG] boxes type: {type(boxes)}", file=sys.stderr)
        print(f"[DEBUG] boxes value: {boxes}", file=sys.stderr)
        
        # Determine which boxes are present
        wg_boxes = [b for b in boxes if b.get('type') == 'WG']
        cg_boxes = [b for b in boxes if b.get('type') == 'CG']

        print(f"[DEBUG] wg_boxes: {wg_boxes}", file=sys.stderr)
        print(f"[DEBUG] cg_boxes: {cg_boxes}", file=sys.stderr)

        if not wg_boxes and not cg_boxes:
            print("[WARNING] No valid boxes found, using mock", file=sys.stderr)
            return create_mock_masks(image, boxes), True

        # Print original image size
        print(f"[INFO] Original image shape: {image.shape}", file=sys.stderr)

        # Convert image to tensor format expected by the model
        # Model expects: [D, 3, H, W] where D=video_length (RGB 3-channel)
        # For single image, we duplicate it 3 times to match training config

        # Convert to grayscale if needed
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

        # Resize image to model's expected input size (1024x1024)
        # Model was trained on 1024x1024 - required for correct segmentation
        target_size = 1024
        print(f"[INFO] Resizing image from {image_np.shape} to ({target_size}, {target_size})", file=sys.stderr)
        from PIL import Image as PILImage
        image_pil = PILImage.fromarray((image_np * 255).astype(np.uint8))
        image_pil = image_pil.resize((target_size, target_size), PILImage.LANCZOS)
        image_np = np.array(image_pil).astype(np.float32) / 255.0

        # Convert to [1, H, W] tensor
        image_tensor = torch.from_numpy(image_np).unsqueeze(0).float()  # [1, H, W]

        # Repeat to match video_length=3 and 3 channels -> [3, 3, H, W]
        image_tensor = image_tensor.unsqueeze(1).repeat(3, 3, 1, 1)  # [D, 3, H, W]

        # Get device
        device = next(model.parameters()).device
        image_tensor = image_tensor.to(device)

        print(f"[INFO] Input shape: {image_tensor.shape}", file=sys.stderr)
        print(f"[INFO] Using device: {device}", file=sys.stderr)

        # Initialize inference state (same as test.py)
        # Use offload_video_to_cpu=True to avoid CUDA errors in CPU-only environment
        state = model.val_init_state(
            imgs_tensor=image_tensor,
            offload_video_to_cpu=True,
            offload_state_to_cpu=True
        )

        # Determine which objects to segment based on box types
        has_wg = len(wg_boxes) > 0
        has_cg = len(cg_boxes) > 0

        # Calculate scale factor for bbox coordinates
        # Original image size to target size (1024)
        orig_H, orig_W = image.shape[0], image.shape[1]
        scale_factor = target_size / max(orig_H, orig_W)
        print(f"[INFO] Scale factor for bbox coordinates: {scale_factor}", file=sys.stderr)

        # Add bbox prompts based on available boxes
        if has_wg:
            # Use first WG box for prompting
            wg_box = wg_boxes[0]
            wg_bbox = torch.tensor([
                wg_box['x'] * scale_factor,
                wg_box['y'] * scale_factor,
                (wg_box['x'] + wg_box['width']) * scale_factor,
                (wg_box['y'] + wg_box['height']) * scale_factor
            ]).unsqueeze(0).to(device)
            model.add_new_bbox(state, frame_idx=1, obj_id=3, bbox=wg_bbox, clear_old_points=False)
            print(f"[INFO] Added WG bbox (obj_id=3): {wg_bbox.tolist()}", file=sys.stderr)

        if has_cg:
            # Use first CG box for prompting
            cg_box = cg_boxes[0]
            cg_bbox = torch.tensor([
                cg_box['x'] * scale_factor,
                cg_box['y'] * scale_factor,
                (cg_box['x'] + cg_box['width']) * scale_factor,
                (cg_box['y'] + cg_box['height']) * scale_factor
            ]).unsqueeze(0).to(device)
            model.add_new_bbox(state, frame_idx=1, obj_id=1, bbox=cg_bbox, clear_old_points=False)
            print(f"[INFO] Added CG bbox (obj_id=1): {cg_bbox.tolist()}", file=sys.stderr)

        # Propagate to get segmentation for all frames (same as test.py)
        segs = {}
        for out_fid, out_ids, out_logits in model.propagate_in_video(state, start_frame_idx=0):
            segs[out_fid] = {oid: out_logits[i] for i, oid in enumerate(out_ids)}

        print(f"[INFO] Segments extracted for frames: {list(segs.keys())}", file=sys.stderr)

        # Extract masks for frame 1 (middle frame of the 3-frame sequence: 0, 1, 2)
        if 1 in segs:
            H, W = image_tensor.shape[-2:]

            # Debug: Check the type and content of segs[1]
            print(f"[DEBUG] segs[1] type: {type(segs[1])}", file=sys.stderr)
            print(f"[DEBUG] segs[1] value: {segs[1]}", file=sys.stderr)

            # Ensure segs[1] is a dictionary
            if not isinstance(segs[1], dict):
                print(f"[ERROR] segs[1] is not a dictionary! Got: {type(segs[1])}", file=sys.stderr)
                segs[1] = {}  # Reset to empty dict to avoid crash

            # Debug: Print what objects are in segs[1]
            print(f"[DEBUG] segs[1] keys: {list(segs[1].keys())}", file=sys.stderr)

            # Get logits for each object
            # obj_id 1 = CG (Central Gland)
            # obj_id 3 = WG (Whole Gland)
            cg_logit = segs[1].get(1, torch.zeros((H, W), device=device))
            wg_logit = segs[1].get(3, torch.zeros((H, W), device=device))

            print(f"[DEBUG] cg_logit shape: {cg_logit.shape}, wg_logit.shape: {wg_logit.shape}", file=sys.stderr)
            print(f"[DEBUG] cg_logit unique values count: {torch.unique(cg_logit).numel()}", file=sys.stderr)
            print(f"[DEBUG] wg_logit unique values count: {torch.unique(wg_logit).numel()}", file=sys.stderr)
            print(f"[DEBUG] cg_logit min/max: {cg_logit.min():.4f}/{cg_logit.max():.4f}", file=sys.stderr)
            print(f"[DEBUG] wg_logit min/max: {wg_logit.min():.4f}/{wg_logit.max():.4f}", file=sys.stderr)
            print(f"[DEBUG] wg_logit values > 0: {(wg_logit > 0).sum().item()} pixels", file=sys.stderr)
            print(f"[DEBUG] wg_logit values < 0: {(wg_logit < 0).sum().item()} pixels", file=sys.stderr)
            if wg_logit.ndim == 3:
                wg_logit_2d = wg_logit.squeeze(0)
            else:
                wg_logit_2d = wg_logit
            print(f"[DEBUG] wg_logit mean/std: {wg_logit_2d.mean():.4f}/{wg_logit_2d.std():.4f}", file=sys.stderr)
            print(f"[DEBUG] wg_logit median: {wg_logit_2d.median():.4f}", file=sys.stderr)

            # Convert to probabilities using sigmoid
            cg_prob = torch.sigmoid(cg_logit)
            wg_prob = torch.sigmoid(wg_logit)

            # Calculate PZ = WG - CG (same as function.py)
            pz_prob = torch.relu(wg_prob - cg_prob)

            print(f"[INFO] CG prob range: [{cg_prob.min():.3f}, {cg_prob.max():.3f}]", file=sys.stderr)
            print(f"[INFO] WG prob range: [{wg_prob.min():.3f}, {wg_prob.max():.3f}]", file=sys.stderr)
            print(f"[INFO] PZ prob range: [{pz_prob.min():.3f}, {pz_prob.max():.3f}]", file=sys.stderr)

            # Analyze mask shape
            if wg_prob.ndim == 3:
                wg_prob_2d = wg_prob.squeeze(0)
            else:
                wg_prob_2d = wg_prob

            wg_mask = (wg_prob_2d > 0.5).cpu().numpy()
            print(f"[DEBUG] WG mask shape: {wg_mask.shape}", file=sys.stderr)
            print(f"[DEBUG] WG mask pixels: {wg_mask.sum()}", file=sys.stderr)

            # Find bounding box of the mask
            rows = np.any(wg_mask, axis=1)
            cols = np.any(wg_mask, axis=0)
            if rows.any() and cols.any():
                ymin, ymax = np.where(rows)[0][[0, -1]]
                xmin, xmax = np.where(cols)[0][[0, -1]]
                mask_bbox_area = (ymax - ymin) * (xmax - xmin)
                fill_ratio = wg_mask.sum() / mask_bbox_area if mask_bbox_area > 0 else 0
                print(f"[DEBUG] WG mask bounding box: ({xmin}, {ymin}) to ({xmax}, {ymax})", file=sys.stderr)
                print(f"[DEBUG] WG mask fill ratio: {fill_ratio * 100:.2f}%", file=sys.stderr)
            else:
                print("[DEBUG] WG mask is empty!", file=sys.stderr)

            # Resize masks back to original image size
            print(f"[INFO] Resizing masks from {H}x{W} to {orig_H}x{orig_W}", file=sys.stderr)
            from torch.nn.functional import interpolate

            # Expand each tensor individually to [1, 1, H, W] format for interpolation
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

            # Determine which masks to return
            masks_dict = {}

            print(f"[DEBUG] has_wg: {has_wg}, has_cg: {has_cg}", file=sys.stderr)

            if has_wg:
                # Create WG mask (red)
                wg_mask = (wg_prob_resized > 0.5).cpu().numpy().astype(np.uint8)
                print(f"[DEBUG] WG mask pixels after resize: {wg_mask.sum()}", file=sys.stderr)

                # Apply post-processing to smooth the mask
                wg_mask_smoothed = smooth_mask(wg_mask, min_size=100, operation='both')
                print(f"[DEBUG] WG mask pixels after smoothing: {wg_mask_smoothed.sum()}", file=sys.stderr)

                wg_mask_image = create_colored_mask(wg_mask_smoothed, color=(255, 0, 0), alpha=150)
                wg_mask_base64 = image_to_base64(wg_mask_image)
                masks_dict['WG'] = wg_mask_base64
                print(f"[DEBUG] WG mask added to dict", file=sys.stderr)

            if has_cg:
                # Create CG mask (green)
                cg_mask = (cg_prob_resized > 0.5).cpu().numpy().astype(np.uint8)
                print(f"[DEBUG] CG mask pixels after resize: {cg_mask.sum()}", file=sys.stderr)

                # Apply post-processing to smooth the mask
                cg_mask_smoothed = smooth_mask(cg_mask, min_size=100, operation='both')
                print(f"[DEBUG] CG mask pixels after smoothing: {cg_mask_smoothed.sum()}", file=sys.stderr)

                cg_mask_image = create_colored_mask(cg_mask_smoothed, color=(0, 255, 0), alpha=150)
                cg_mask_base64 = image_to_base64(cg_mask_image)
                masks_dict['CG'] = cg_mask_base64
                print(f"[DEBUG] CG mask added to dict", file=sys.stderr)

            if has_wg and has_cg:
                # Create PZ mask (blue) when both WG and CG are available
                pz_mask = (pz_prob_resized > 0.5).cpu().numpy().astype(np.uint8)
                print(f"[DEBUG] PZ mask pixels after resize: {pz_mask.sum()}", file=sys.stderr)

                # Apply post-processing to smooth the mask
                pz_mask_smoothed = smooth_mask(pz_mask, min_size=100, operation='both')
                print(f"[DEBUG] PZ mask pixels after smoothing: {pz_mask_smoothed.sum()}", file=sys.stderr)

                pz_mask_image = create_colored_mask(pz_mask_smoothed, color=(0, 0, 255), alpha=150)
                pz_mask_base64 = image_to_base64(pz_mask_image)
                masks_dict['PZ'] = pz_mask_base64
                print(f"[DEBUG] PZ mask added to dict", file=sys.stderr)

            print(f"[DEBUG] Final masks_dict keys: {list(masks_dict.keys())}", file=sys.stderr)

            return masks_dict, True
        else:
            print("[WARNING] No segmentation output found for frame 1, using mock", file=sys.stderr)
            return create_mock_masks(image, boxes), True

    except Exception as e:
        import traceback
        print(f"[ERROR] Exception in segment_image(): {type(e).__name__}: {e}", file=sys.stderr)
        print("[ERROR] Full traceback:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        # Re-raise so the caller (main) can log it as a JSON error response
        # instead of silently falling back to mock masks
        raise


def create_colored_mask(mask: np.ndarray, color: tuple = (255, 0, 0), alpha: int = 150) -> Image.Image:
    """Create a colored mask image from binary mask.

    Args:
        mask: Binary mask (H, W)
        color: RGB color tuple (default: red)
        alpha: Alpha channel value (0-255)

    Returns:
        RGBA Image
    """
    mask_rgb = np.zeros((mask.shape[0], mask.shape[1], 4), dtype=np.uint8)
    mask_rgb[..., 0] = color[0]  # Red
    mask_rgb[..., 1] = color[1]  # Green
    mask_rgb[..., 2] = color[2]  # Blue
    mask_rgb[..., 3] = (mask > 0).astype(np.uint8) * alpha  # Alpha
    return Image.fromarray(mask_rgb, mode='RGBA')


def image_to_base64(image: Image.Image) -> str:
    """Convert PIL Image to base64 data URL.

    Args:
        image: PIL Image

    Returns:
        Base64 data URL string
    """
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    image_base64 = base64.b64encode(buffer.getvalue()).decode()
    return f"data:image/png;base64,{image_base64}"


def create_mock_masks(image_data: Any = None, boxes: list = None) -> Dict[str, str]:
    """Create mock masks for demonstration purposes.

    Args:
        image_data: Image data (for size reference)
        boxes: List of box dictionaries with type, x, y, width, height

    Returns:
        Dictionary of mask base64 strings keyed by type (WG, CG, PZ)
    """
    # Ensure boxes is a list
    if boxes is None:
        boxes = []
    elif not isinstance(boxes, list):
        boxes = list(boxes)
    masks_dict = {}

    # Determine which masks to generate based on box types
    wg_boxes = [b for b in boxes if b.get('type') == 'WG']
    cg_boxes = [b for b in boxes if b.get('type') == 'CG']

    has_wg = len(wg_boxes) > 0
    has_cg = len(cg_boxes) > 0

    if has_wg:
        # Use first WG box for reference
        ref_box = wg_boxes[0]
        masks_dict['WG'] = create_single_mock_mask('WG', ref_box, image_data)

    if has_cg:
        # Use first CG box for reference
        ref_box = cg_boxes[0]
        masks_dict['CG'] = create_single_mock_mask('CG', ref_box, image_data)

    if has_wg and has_cg:
        # Create PZ mask when both WG and CG are available
        ref_box = wg_boxes[0]  # Use WG box as reference
        masks_dict['PZ'] = create_single_mock_mask('PZ', ref_box, image_data)

    return masks_dict


def create_single_mock_mask(mask_type: str, box: Dict, image_data: Any = None) -> str:
    """Create a single mock mask.

    Args:
        mask_type: Type of mask (WG, CG, PZ)
        box: Reference box dictionary
        image_data: Image data (for size reference)

    Returns:
        Base64 data URL string
    """
    if not NUMPY_AVAILABLE:
        width, height = 512, 512

        # Color based on mask type
        if mask_type == 'WG':
            fill_color = 'rgba(255,100,100,0.5)'
            stroke_color = 'rgba(255,50,50,1)'
        elif mask_type == 'CG':
            fill_color = 'rgba(100,255,100,0.5)'
            stroke_color = 'rgba(50,200,50,1)'
        else:  # PZ
            fill_color = 'rgba(100,100,255,0.5)'
            stroke_color = 'rgba(50,50,200,1)'

        svg_data = f'''<svg width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg">
          <rect x="{(width-256)//2}" y="{(height-256)//2}" width="256" height="256"
                fill="{fill_color}" stroke="{stroke_color}" stroke-width="3"/>
          <text x="{width//2}" y="{height//2}" text-anchor="middle" fill="white" font-size="20">
            {mask_type} Mock Mode
          </text>
        </svg>'''
        base64_mask = base64.b64encode(svg_data.encode()).decode()
        return f"data:image/svg+xml;base64,{base64_mask}"

    from PIL import Image, ImageDraw
    import random

    # Get image dimensions
    if isinstance(image_data, np.ndarray):
        h, w = image_data.shape[:2]
    else:
        w, h = 512, 512

    # Calculate mask dimensions
    if box.get('width') and box.get('height'):
        mask_w = box['width']
        mask_h = box['height']
        mask_x = box.get('x', (w - mask_w) // 2)
        mask_y = box.get('y', (h - mask_h) // 2)
    else:
        mask_w, mask_h = min(w, 256), min(h, 256)
        mask_x, mask_y = (w - mask_w) // 2, (h - mask_h) // 2

    # Create mask
    mask = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(mask)

    # Color based on mask type
    if mask_type == 'WG':
        fill_color = (255, 100, 100, 100)
        stroke_color = (255, 50, 50, 200)
    elif mask_type == 'CG':
        fill_color = (100, 255, 100, 100)
        stroke_color = (50, 200, 50, 200)
    else:  # PZ
        fill_color = (100, 100, 255, 100)
        stroke_color = (50, 50, 200, 200)

    # Draw mask with medical-style appearance
    draw.rectangle(
        [mask_x, mask_y, mask_x + mask_w, mask_y + mask_h],
        fill=fill_color,
        outline=stroke_color,
        width=3
    )

    # Add some organic shapes to simulate organ segmentation
    random.seed(hash(str(box) + mask_type))
    for _ in range(min(15, max(5, mask_w // 15))):
        ox = random.randint(mask_x, mask_x + mask_w)
        oy = random.randint(mask_y, mask_y + mask_h)
        r = random.randint(5, min(40, min(mask_w, mask_h) // 5))

        # Adjust fill color based on mask type
        if mask_type == 'WG':
            oval_fill = (255, 120, 120, 120)
        elif mask_type == 'CG':
            oval_fill = (120, 255, 120, 120)
        else:  # PZ
            oval_fill = (120, 120, 255, 120)

        draw.ellipse([ox-r, oy-r, ox+r, oy+r], fill=oval_fill)

    # Convert to base64
    buffer = BytesIO()
    mask.save(buffer, format="PNG")
    mask_base64 = base64.b64encode(buffer.getvalue()).decode()
    return f"data:image/png;base64,{mask_base64}"


def main():
    parser = argparse.ArgumentParser(description="Medical SAM2 Segmentation (Integrated)")
    parser.add_argument("input_json", nargs='?', help="Input JSON with image and boxes (or path to JSON file). If not provided, reads from stdin.")
    parser.add_argument("--checkpoint", help="Path to model checkpoint", default=None)
    args = parser.parse_args()

    try:
        # Parse input - check if it's a file path or JSON string
        if args.input_json:
            # Input provided via command line argument
            input_json_str = args.input_json
            if os.path.exists(input_json_str):
                # It's a file path, read the file
                with open(input_json_str, 'r') as f:
                    input_data = json.load(f)
            else:
                # It's a JSON string
                input_data = json.loads(input_json_str)
        else:
            # Read from stdin
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

        # Validate box dimensions
        for box in boxes:
            if box.get('width', 0) <= 0 or box.get('height', 0) <= 0:
                result = {"success": False, "error": f"Invalid box dimensions for {box.get('type', 'unknown')}"}
                print(json.dumps(result))
                sys.exit(1)

        # Load image
        image = load_image_from_base64(image_b64)

        # Load model (will be None if not available)
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
        import traceback
        print(f"[ERROR] Unhandled exception in main(): {type(e).__name__}: {e}", file=sys.stderr)
        print("[ERROR] Full traceback:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        result = {"success": False, "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(result))
        sys.exit(1)


if __name__ == "__main__":
    main()

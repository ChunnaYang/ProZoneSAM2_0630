import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;


interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'WG' | 'CG';
}

interface SegmentRequestBody {
  image: string;
  boxes: Box[]; // Multiple boxes support
  useMedical?: boolean; // Use Medical SAM2 mode if true
}

interface SegmentResponse {
  success: boolean;
  masks?: {
    WG?: string;  // Whole Gland mask
    CG?: string;  // Central Gland mask
    PZ?: string;  // Peripheral Zone mask (WG - CG)
  };
  error?: string;
  mode?: 'basic' | 'medical';
}

export async function POST(request: NextRequest) {
  try {
    const body: SegmentRequestBody = await request.json();
    const { image, boxes, useMedical } = body;

    // Validate input
    if (!image || !boxes || boxes.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Image and at least one box are required' },
        { status: 400 }
      );
    }

    // Validate all boxes
    for (const box of boxes) {
      if (box.width <= 0 || box.height <= 0) {
        return NextResponse.json(
          { success: false, error: 'All boxes must have positive width and height' },
          { status: 400 }
        );
      }
    }

    // Call the Python segmentation script
    const segmentResult = await runSegmentation(image, boxes, useMedical);

    if (segmentResult.error) {
      return NextResponse.json(
        { success: false, error: segmentResult.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      masks: segmentResult.masks,
      mode: useMedical ? 'medical' : 'basic',
    });
  } catch (error) {
    console.error('Segmentation error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

async function runSegmentation(
  imageBase64: string,
  boxes: Box[],
  useMedical: boolean = false
): Promise<{ masks?: { WG?: string; CG?: string; PZ?: string }; error?: string }> {
  try {
    // Check if Python segmentation is enabled via environment variable
    const pythonEnabled = process.env.USE_PYTHON_SEGMENTATION === 'true';
    
    if (pythonEnabled) {
      console.log('[Segment] Using Python segmentation (USE_PYTHON_SEGMENTATION=true)');
      const result = await runPythonSegmentation(imageBase64, boxes, useMedical);
      if (result.masks) {
        return result;
      }
      console.log('[Segment] Python segmentation failed, using mock mode');
    }
    
    // Default: use mock mode
    const mockMasks = generateMockMasks(imageBase64, boxes, useMedical);
    return { masks: mockMasks };
  } catch (error) {
    console.error('[Segment] Error:', error);
    const mockMasks = generateMockMasks(imageBase64, boxes, useMedical);
    return { masks: mockMasks };
  }
}

async function runPythonSegmentation(
  imageBase64: string,
  boxes: Box[],
  useMedical: boolean = false
): Promise<{ masks?: { WG?: string; CG?: string; PZ?: string }; error?: string }> {
  const { spawn } = require('child_process');

  return new Promise((resolve) => {
    const inputData = JSON.stringify({ image: imageBase64, boxes });

    console.log('[Segment] Input data size:', inputData.length);
    console.log('[Segment] Boxes:', JSON.stringify(boxes, null, 2));

    // Get Python path from environment variable or use venv Python
    // In Railway, Python dependencies are in /opt/venv
    const pythonPath = process.env.PYTHON_PATH || '/opt/venv/bin/python3';
    console.log('[Segment] Using Python path:', pythonPath);

    // Prepare environment variables
    const env = {
      ...process.env,
      USE_MEDICAL_SAM2: useMedical ? 'true' : 'false',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPYCACHEPREFIX: '/tmp/pycache',
    };

    // Set timeout (5 minutes for model loading + inference on CPU)
    const TIMEOUT_MS = 300000;

    // Use inference_interactive.py for multi-box support
    // Pass data through stdin instead of command line argument to avoid E2BIG error
    const cwd = process.cwd();
    console.log('[Segment] Working directory:', cwd);
    
    const pythonProcess = spawn(pythonPath, ['scripts/inference_interactive.py'], {
      env: env,
      cwd: cwd,
    });

    console.log('[Segment] Python process started, waiting for result...');

    // Set timeout
    const timeoutId = setTimeout(() => {
      console.log('[Segment] Python timeout, killing process');
      pythonProcess.kill();
      resolve({ error: 'Python segmentation timeout (>120s)' });
    }, TIMEOUT_MS);

    // Write data to stdin
    pythonProcess.stdin.write(inputData);
    pythonProcess.stdin.end();

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      console.log('[Segment] Python stdout:', data.toString().substring(0, 500));
    });

    pythonProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      console.log('[Segment] Python stderr:', data.toString().substring(0, 500));
    });

    pythonProcess.on('close', (code: number) => {
      clearTimeout(timeoutId);
      console.log('[Segment] Python closed with code:', code);
      console.log('[Segment] stdout length:', stdout.length);
      console.log('[Segment] stderr:', stderr.substring(0, 500));
      
      if (code === 0 && stdout.trim()) {
        try {
          const result = JSON.parse(stdout);
          if (result.success) {
            console.log('[Segment] Segmentation success!');
            resolve({ masks: result.masks });
          } else {
            console.log('[Segment] Segmentation failed:', result.error);
            resolve({ error: result.error || 'Segmentation failed' });
          }
        } catch (e) {
          console.log('[Segment] Parse error:', e instanceof Error ? e.message : String(e));
          resolve({ error: `Failed to parse output: ${e instanceof Error ? e.message : String(e)}` });
        }
      } else {
        console.log('[Segment] Python exited with error');
        resolve({ error: `Python script exited with code ${code}: ${stderr}` });
      }
    });

    pythonProcess.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      console.log('[Segment] Python error:', err.message);
      resolve({ error: `Python not available: ${err.message}` });
    });
  });
}

function generateMockMasks(
  imageBase64: string,
  boxes: Box[],
  useMedical: boolean = false
): { WG?: string; CG?: string; PZ?: string } {
  const masks: { WG?: string; CG?: string; PZ?: string } = {};

  // Determine which masks to generate based on box types
  const hasWG = boxes.some(b => b.type === 'WG');
  const hasCG = boxes.some(b => b.type === 'CG');

  if (hasWG) {
    masks.WG = generateMockMask(imageBase64, 'WG', useMedical);
  }

  if (hasCG) {
    masks.CG = generateMockMask(imageBase64, 'CG', useMedical);
  }

  if (hasWG && hasCG) {
    masks.PZ = generateMockMask(imageBase64, 'PZ', useMedical);
  }

  return masks;
}

function generateMockMask(imageBase64: string, maskType: 'WG' | 'CG' | 'PZ', useMedical: boolean = false): string {
  // This is a placeholder function that generates a mock mask
  // In production, this would be replaced with actual model output

  // For demonstration, create a simple colored overlay
  const canvas = {
    width: 512,
    height: 512,
  };

  // Color based on mask type
  let gradientColor1, gradientColor2, labelColor, labelText;
  switch (maskType) {
    case 'WG':
      gradientColor1 = 'rgba(255,100,100,0.6)';
      gradientColor2 = 'rgba(200,50,50,0.6)';
      labelColor = 'rgba(255,100,100,1)';
      labelText = 'WG - Whole Gland';
      break;
    case 'CG':
      gradientColor1 = 'rgba(100,255,100,0.6)';
      gradientColor2 = 'rgba(50,200,50,0.6)';
      labelColor = 'rgba(100,255,100,1)';
      labelText = 'CG - Central Gland';
      break;
    case 'PZ':
      gradientColor1 = 'rgba(100,100,255,0.6)';
      gradientColor2 = 'rgba(50,50,200,0.6)';
      labelColor = 'rgba(100,100,255,1)';
      labelText = 'PZ - Peripheral Zone';
      break;
  }

  const maskData = `
    <svg width="${canvas.width}" height="${canvas.height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="diagonalHatch-${maskType}" width="10" height="10" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="10" style="stroke:rgba(255,255,255,0.3); stroke-width:1" />
        </pattern>
        <linearGradient id="grad-${maskType}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:${gradientColor1};stop-opacity:1" />
          <stop offset="100%" style="stop-color:${gradientColor2};stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#grad-${maskType})" />
      <rect width="100%" height="100%" fill="url(#diagonalHatch-${maskType})" />
      <rect x="50" y="50" width="412" height="412" rx="20" fill="rgba(255,255,255,0.15)" stroke="${labelColor}" stroke-width="3"/>
      <text x="50%" y="45%" text-anchor="middle" fill="white" font-size="24" font-weight="bold" font-family="sans-serif">
        ${maskType} DEMO MASK
      </text>
      <text x="50%" y="52%" text-anchor="middle" fill="white" font-size="16" font-family="sans-serif">
        ${labelText}
      </text>
      <text x="50%" y="58%" text-anchor="middle" fill="rgba(255,255,255,0.8)" font-size="12" font-family="sans-serif">
        Mock result for demonstration
      </text>
    </svg>
  `;

  // Convert SVG to base64
  const base64Mask = Buffer.from(maskData).toString('base64');
  return `data:image/svg+xml;base64,${base64Mask}`;
}

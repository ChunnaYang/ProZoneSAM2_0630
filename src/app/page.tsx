'use client';

import { useState, useRef, MouseEvent, TouchEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Upload, RefreshCw, Trash2, ImageIcon, Layers, Lightbulb, Info, CheckCircle2, Target, Microscope } from 'lucide-react';

interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'WG' | 'CG'; // Box type: WG (Whole Gland) or CG (Central Gland)
}

interface SegmentationResult {
  success: boolean;
  masks?: {
    WG?: string;  // Whole Gland mask
    CG?: string;  // Central Gland mask
    PZ?: string;  // Peripheral Zone mask (WG - CG)
  };
  error?: string;
}

export default function MedicalSAMDemo() {
  const [image, setImage] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]); // Multiple boxes support
  const [selectedBoxType, setSelectedBoxType] = useState<'WG' | 'CG'>('WG'); // Default to WG
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [currentBox, setCurrentBox] = useState<Box | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<SegmentationResult | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [useMedicalMode, setUseMedicalMode] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Use ref to track drawing state synchronously
  const isDrawingRef = useRef(false);
  const currentBoxRef = useRef<Box | null>(null);

  // Generate unique ID for boxes
  const generateBoxId = () => `box-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Load sample image for quick testing
  const loadSampleImage = async () => {
    try {
      console.log('[loadSampleImage] Starting fetch of sample image...');
      const response = await fetch('/assets/test_image.png');
      if (!response.ok) {
        throw new Error(`Failed to fetch sample image: ${response.statusText}`);
      }

      const blob = await response.blob();
      console.log('[loadSampleImage] Blob received. Size:', blob.size, 'bytes. Type:', blob.type);

      if (blob.size === 0) {
        throw new Error('Fetched blob is empty (0 bytes) — the asset may be missing or the path is wrong.');
      }

      // Wrap FileReader in a Promise so we await full Base64 conversion before proceeding
      console.log('[loadSampleImage] Starting FileReader.readAsDataURL...');
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          const result = event.target?.result as string;
          console.log('[loadSampleImage] FileReader onload fired. dataUrl length:', result?.length ?? 0);
          resolve(result);
        };
        reader.onerror = (event) => {
          console.error('[loadSampleImage] FileReader error:', event);
          reject(new Error('FileReader failed to convert blob to Base64'));
        };
        reader.readAsDataURL(blob);
      });

      console.log('[loadSampleImage] dataUrl starts with:', dataUrl.substring(0, 30));

      if (!dataUrl.startsWith('data:image/')) {
        throw new Error(`Unexpected dataUrl format — expected "data:image/..." but got: ${dataUrl.substring(0, 50)}`);
      }

      // Decode image dimensions before setting state
      console.log('[loadSampleImage] Decoding image dimensions...');
      await new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          console.log('[loadSampleImage] Image decoded. Dimensions:', img.width, 'x', img.height);
          setImageDimensions({ width: img.width, height: img.height });
          setImage(dataUrl);
          setBoxes([]);
          setResult(null);
          setStartPoint(null);
          setCurrentBox(null);
          console.log('[loadSampleImage] State updated — image and dimensions set successfully.');
          resolve();
        };
        img.onerror = () => {
          console.error('[loadSampleImage] Failed to decode image from dataUrl');
          reject(new Error('Failed to decode sample image from Base64 data URL'));
        };
        img.src = dataUrl;
      });
    } catch (error) {
      console.error('[loadSampleImage] Error:', error);
      alert(`Failed to load sample image: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          setImageDimensions({ width: img.width, height: img.height });
          setImage(event.target?.result as string);
          setBoxes([]); // Clear all boxes
          setResult(null);
          setStartPoint(null);
          setCurrentBox(null);
        };
        img.src = event.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (!image || !imageDimensions) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = imageDimensions.width / rect.width;
    const scaleY = imageDimensions.height / rect.height;

    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    const newBox = { id: generateBoxId(), x, y, width: 0, height: 0, type: selectedBoxType };
    console.log('[MouseDown] Start drawing at:', { x, y, type: selectedBoxType });

    // Update both state and ref
    setStartPoint({ x, y });
    setIsDrawing(true);
    setCurrentBox(newBox);

    // Update refs for synchronous access
    isDrawingRef.current = true;
    currentBoxRef.current = newBox;
  };

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!isDrawingRef.current || !startPoint || !imageDimensions) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = imageDimensions.width / rect.width;
    const scaleY = imageDimensions.height / rect.height;

    const currentX = Math.round((e.clientX - rect.left) * scaleX);
    const currentY = Math.round((e.clientY - rect.top) * scaleY);

    const width = currentX - startPoint.x;
    const height = currentY - startPoint.y;

    // Update current box properties while preserving id and type
    const updatedBox = {
      x: width < 0 ? currentX : startPoint.x,
      y: height < 0 ? currentY : startPoint.y,
      width: Math.abs(width),
      height: Math.abs(height),
    };

    // Update state and ref with the new box dimensions
    setCurrentBox((prevBox) => {
      if (prevBox) {
        const newBox = { ...prevBox, ...updatedBox };
        // Also update the ref synchronously
        currentBoxRef.current = newBox;
        return newBox;
      }
      return null;
    });
  };

  const handleMouseUp = () => {
    console.log('[MouseUp] isDrawingRef:', isDrawingRef.current, 'currentBoxRef:', currentBoxRef.current);

    // Use ref to get the latest values
    if (isDrawingRef.current && currentBoxRef.current && currentBoxRef.current.width > 0 && currentBoxRef.current.height > 0) {
      console.log('[MouseUp] Adding box:', currentBoxRef.current);
      const boxToAdd = { ...currentBoxRef.current }; // Create a copy to avoid reference issues
      setBoxes(prev => [...prev, boxToAdd]);
    }

    // Reset both state and ref
    setIsDrawing(false);
    isDrawingRef.current = false;
    setStartPoint(null);
    setCurrentBox(null);
    currentBoxRef.current = null;
  };

  const handleMouseLeave = () => {
    console.log('[MouseLeave] isDrawingRef:', isDrawingRef.current, 'currentBoxRef:', currentBoxRef.current);

    // Only clear if we're drawing but haven't created a valid box yet
    if (isDrawingRef.current && (!currentBoxRef.current || currentBoxRef.current.width === 0 || currentBoxRef.current.height === 0)) {
      console.log('[MouseLeave] Clearing current box');
    }

    // Reset both state and ref
    setIsDrawing(false);
    isDrawingRef.current = false;
    setStartPoint(null);
    setCurrentBox(null);
    currentBoxRef.current = null;
  };

  // Touch event handlers for mobile support
  const handleTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (!image || !imageDimensions) return;
    e.preventDefault(); // Prevent scrolling while drawing

    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = imageDimensions.width / rect.width;
    const scaleY = imageDimensions.height / rect.height;

    const x = Math.round((touch.clientX - rect.left) * scaleX);
    const y = Math.round((touch.clientY - rect.top) * scaleY);

    const newBox = { id: generateBoxId(), x, y, width: 0, height: 0, type: selectedBoxType };
    console.log('[TouchStart] Start drawing at:', { x, y, type: selectedBoxType });

    setStartPoint({ x, y });
    setIsDrawing(true);
    setCurrentBox(newBox);
    isDrawingRef.current = true;
    currentBoxRef.current = newBox;
  };

  const handleTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (!isDrawingRef.current || !startPoint || !imageDimensions) return;
    e.preventDefault(); // Prevent scrolling while drawing

    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = imageDimensions.width / rect.width;
    const scaleY = imageDimensions.height / rect.height;

    const currentX = Math.round((touch.clientX - rect.left) * scaleX);
    const currentY = Math.round((touch.clientY - rect.top) * scaleY);

    const width = currentX - startPoint.x;
    const height = currentY - startPoint.y;

    const updatedBox = {
      x: width < 0 ? currentX : startPoint.x,
      y: height < 0 ? currentY : startPoint.y,
      width: Math.abs(width),
      height: Math.abs(height),
    };

    setCurrentBox((prevBox) => {
      if (prevBox) {
        const newBox = { ...prevBox, ...updatedBox };
        currentBoxRef.current = newBox;
        return newBox;
      }
      return null;
    });
  };

  const handleTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    e.preventDefault();
    console.log('[TouchEnd] isDrawingRef:', isDrawingRef.current, 'currentBoxRef:', currentBoxRef.current);

    if (isDrawingRef.current && currentBoxRef.current && currentBoxRef.current.width > 0 && currentBoxRef.current.height > 0) {
      console.log('[TouchEnd] Adding box:', currentBoxRef.current);
      const boxToAdd = { ...currentBoxRef.current };
      setBoxes(prev => [...prev, boxToAdd]);
    }

    setIsDrawing(false);
    isDrawingRef.current = false;
    setStartPoint(null);
    setCurrentBox(null);
    currentBoxRef.current = null;
  };

  const handleTouchCancel = (e: TouchEvent<HTMLDivElement>) => {
    e.preventDefault();
    console.log('[TouchCancel] Cancelling touch draw');

    setIsDrawing(false);
    isDrawingRef.current = false;
    setStartPoint(null);
    setCurrentBox(null);
    currentBoxRef.current = null;
  };

  // Function to delete a specific box
  const deleteBox = (boxId: string) => {
    setBoxes(prev => prev.filter(box => box.id !== boxId));
    setResult(null); // Clear results when boxes change
  };

  // Function to clear all boxes
  const clearAllBoxes = () => {
    setBoxes([]);
    setResult(null);
  };

  const handleSegment = async () => {
    if (!image || boxes.length === 0) {
      console.warn('No image or boxes provided');
      return;
    }

    setIsLoading(true);
    setResult(null);

    try {
      const response = await fetch('/api/segment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image,
          boxes,  // Send all boxes
          useMedical: useMedicalMode,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Segmentation failed');
      }

      setResult(data);
    } catch (error) {
      console.error('Error:', error);
      setResult({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const resetAll = () => {
    setImage(null);
    setBoxes([]);
    setResult(null);
    setImageDimensions(null);
    setStartPoint(null);
    setCurrentBox(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Combine boxes with current drawing box for display
  const displayBoxes = [...boxes, ...(currentBox && isDrawing ? [currentBox] : [])];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">

      {/* ── Introduction Banner ── */}
      <div className="relative overflow-hidden bg-gradient-to-r from-blue-700 via-blue-600 to-purple-700 text-white">
        {/* Decorative background circles */}
        <div className="pointer-events-none absolute -top-16 -left-16 h-64 w-64 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute -bottom-20 -right-20 h-80 w-80 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute top-4 right-1/3 h-32 w-32 rounded-full bg-white/5" />

        <div className="relative mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            {/* Left: branding + description */}
            <div className="flex-1">
              <div className="mb-3 flex items-center gap-3">
                <img
                  src="https://code.coze.cn/api/sandbox/coze_coding/file/proxy?expire_time=-1&file_path=assets%2Flogo3.png&nonce=97f6f9fd-07eb-4aba-95b8-ba41d6aad315&project_id=7611091818876452915&sign=83ce3ce2b2d06a8f24d566d3e8375456040b2f238f2624d80c41f1226f09cb0b"
                  alt="ProZoneSAM2 Logo"
                  className="h-12 w-auto flex-shrink-0 drop-shadow-lg"
                />
                <div>
                  <h1 className="text-3xl font-extrabold tracking-tight leading-none">
                    ProZoneSAM2
                  </h1>
                  <p className="mt-0.5 text-sm font-medium text-blue-200">
                    Interactive Prostate Zone Segmentation
                  </p>
                </div>
              </div>

              <p className="max-w-xl text-sm leading-relaxed text-blue-100">
                <span className="font-semibold text-white">ProZoneSAM2</span> 基于 SAM2 构建，并使用边界框提示进行交互式前列腺区域分割。
                用户上传医学图像后，通过框选全腺体 WG 和中央腺体 CG，引导模型生成中央腺体与外周带 PZ 的分割结果。
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium backdrop-blur-sm">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-300" />
                  SAM2 驱动
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium backdrop-blur-sm">
                  <Target className="h-3.5 w-3.5 text-yellow-300" />
                  边界框提示
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium backdrop-blur-sm">
                  <Microscope className="h-3.5 w-3.5 text-purple-300" />
                  前列腺 MRI 专用
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/30 px-3 py-1 text-xs font-medium backdrop-blur-sm border border-green-400/40">
                  <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                  模型已就绪
                </span>
              </div>
            </div>

            {/* Right: college logo */}
            <div className="flex-shrink-0 self-start md:self-center">
              <img
                src="/深圳河套学院.png"
                alt="深圳河套学院"
                className="w-48 md:w-64 lg:w-72 h-auto drop-shadow-lg"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Main Content ── */}
      <div className="mx-auto max-w-7xl px-4 py-5 md:px-8 md:py-6">
        {/* Three-column layout: controls | canvas | info */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)_minmax(0,1fr)]">

          {/* ── LEFT PANEL – Controls ── */}
          <div className="space-y-4">
            {/* Upload Section */}
            <Card className="p-5 bg-gradient-to-br from-white to-blue-50/50 dark:from-slate-900 dark:to-blue-950/20 border-blue-200 dark:border-blue-800">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1 h-5 bg-gradient-to-b from-blue-500 to-purple-500 rounded-full"></div>
                <h2 className="text-base font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                  上传图像
                </h2>
              </div>
              <div className="space-y-2.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageUpload}
                  className="hidden"
                  id="image-upload"
                />
                <label htmlFor="image-upload">
                  <Button
                    variant="outline"
                    className="w-full h-9 border-blue-300 hover:border-blue-400 hover:bg-blue-50 dark:border-blue-700 dark:hover:bg-blue-950/30 transition-all"
                    asChild
                  >
                    <span className="flex items-center gap-2 text-base">
                      <Upload className="h-4 w-4" />
                      上传图像
                    </span>
                  </Button>
                </label>
                <Button
                  variant="outline"
                  onClick={loadSampleImage}
                  className="w-full h-9 border-purple-300 hover:border-purple-400 hover:bg-purple-50 dark:border-purple-700 dark:hover:bg-purple-950/30 transition-all"
                >
                  <ImageIcon className="mr-2 h-4 w-4 text-purple-600" />
                  <span className="text-base">加载示例图像</span>
                </Button>
                {image && (
                  <Button
                    variant="ghost"
                    onClick={resetAll}
                    className="w-full h-9 text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    重置
                  </Button>
                )}
              </div>
            </Card>

            {/* Box Type Selection */}
            <Card className="p-5 bg-gradient-to-br from-white to-orange-50/50 dark:from-slate-900 dark:to-orange-950/20 border-orange-200 dark:border-orange-800">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1 h-5 bg-gradient-to-b from-blue-500 to-orange-500 rounded-full"></div>
                <h2 className="text-base font-bold bg-gradient-to-r from-blue-600 to-orange-600 bg-clip-text text-transparent">
                  标注类型
                </h2>
              </div>
              <div className="space-y-2">
                <label className="flex items-center space-x-3 p-2.5 rounded-lg border-2 cursor-pointer transition-all hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-950/20 dark:border-blue-900"
                  style={{
                    borderColor: selectedBoxType === 'WG' ? 'rgba(59, 130, 246, 0.5)' : 'rgba(59, 130, 246, 0.2)',
                    backgroundColor: selectedBoxType === 'WG' ? 'rgba(59, 130, 246, 0.05)' : 'transparent'
                  }}>
                  <input
                    type="radio"
                    id="wg-type"
                    name="boxType"
                    checked={selectedBoxType === 'WG'}
                    onChange={() => setSelectedBoxType('WG')}
                    className="h-4 w-4 text-blue-600"
                  />
                  <span className="flex-1">
                    <span className="font-bold text-blue-600">WG</span>
                    <span className="ml-2 text-base text-slate-600 dark:text-slate-400">全腺体</span>
                  </span>
                </label>
                <label className="flex items-center space-x-3 p-2.5 rounded-lg border-2 cursor-pointer transition-all hover:border-orange-400 hover:bg-orange-50/50 dark:hover:bg-orange-950/20 dark:border-orange-900"
                  style={{
                    borderColor: selectedBoxType === 'CG' ? 'rgba(249, 115, 22, 0.5)' : 'rgba(249, 115, 22, 0.2)',
                    backgroundColor: selectedBoxType === 'CG' ? 'rgba(249, 115, 22, 0.05)' : 'transparent'
                  }}>
                  <input
                    type="radio"
                    id="cg-type"
                    name="boxType"
                    checked={selectedBoxType === 'CG'}
                    onChange={() => setSelectedBoxType('CG')}
                    className="h-4 w-4 text-orange-600"
                  />
                  <span className="flex-1">
                    <span className="font-bold text-orange-600">CG</span>
                    <span className="ml-2 text-base text-slate-600 dark:text-slate-400">中央腺体</span>
                  </span>
                </label>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-500 leading-relaxed">
                  💡 同时绘制 WG 和 CG 标注框以获取 PZ 分割结果（结果仅显示 CG 和 PZ）
                </p>
              </div>
            </Card>

            {/* Instructions */}
            <Card className="p-5 bg-gradient-to-br from-white to-purple-50/50 dark:from-slate-900 dark:to-purple-950/20 border-purple-200 dark:border-purple-800">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1 h-5 bg-gradient-to-b from-purple-500 to-pink-500 rounded-full"></div>
                <h2 className="text-base font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
                  使用指南
                </h2>
              </div>
              <ul className="space-y-2 text-base text-slate-600 dark:text-slate-400">
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 text-white text-xs flex items-center justify-center font-bold">1</span>
                  <span>上传医学图像</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-gradient-to-br from-cyan-500 to-green-500 text-white text-xs flex items-center justify-center font-bold">2</span>
                  <span>选择标注类型 (WG/CG)</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-gradient-to-br from-green-500 to-yellow-500 text-white text-xs flex items-center justify-center font-bold">3</span>
                  <span>在图像上绘制标注框</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-gradient-to-br from-yellow-500 to-orange-500 text-white text-xs flex items-center justify-center font-bold">4</span>
                  <span>运行分割</span>
                </li>
              </ul>
            </Card>

            <Card className="p-5 bg-gradient-to-br from-white to-slate-50/50 dark:from-slate-900 dark:to-slate-950/20">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1 h-5 bg-gradient-to-b from-slate-400 to-slate-600 rounded-full"></div>
                <h2 className="text-base font-bold text-slate-700 dark:text-slate-300">模式选择</h2>
              </div>
              <div className="space-y-3">
                <div className="flex items-center space-x-3">
                  <input
                    type="radio"
                    id="basic-mode"
                    name="mode"
                    checked={!useMedicalMode}
                    onChange={() => setUseMedicalMode(false)}
                    className="h-4 w-4"
                  />
                  <label htmlFor="basic-mode" className="text-base">
                    <span className="font-semibold">基础模式</span>
                    <span className="ml-2 text-slate-600 dark:text-slate-400">- 标准 SAM2</span>
                  </label>
                </div>
                <div className="flex items-center space-x-3">
                  <input
                    type="radio"
                    id="medical-mode"
                    name="mode"
                    checked={useMedicalMode}
                    onChange={() => setUseMedicalMode(true)}
                    className="h-4 w-4"
                  />
                  <label htmlFor="medical-mode" className="text-base">
                    <span className="font-semibold">医学模式</span>
                    <span className="ml-2 text-slate-600 dark:text-slate-400">- ProZoneSAM2</span>
                  </label>
                </div>
              </div>
            </Card>

            {/* Boxes List */}
            {boxes.length > 0 && (
              <Card className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-base font-semibold">标注框 ({boxes.length})</h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearAllBoxes}
                    className="text-red-600 hover:text-red-700 h-7 px-2 text-xs"
                  >
                    清除全部
                  </Button>
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {boxes.filter(box => box != null).map((box) => (
                    <div
                      key={box.id}
                      className="flex items-center justify-between rounded-lg border p-2.5 text-xs"
                      style={{
                        borderColor: box.type === 'WG' ? 'rgba(59, 130, 246, 0.3)' : 'rgba(249, 115, 22, 0.3)',
                        backgroundColor: box.type === 'WG' ? 'rgba(59, 130, 246, 0.05)' : 'rgba(249, 115, 22, 0.05)',
                      }}
                    >
                      <div className="flex items-center space-x-2">
                        <span className={`font-bold text-sm ${box.type === 'WG' ? 'text-blue-600' : 'text-orange-600'}`}>
                          {box.type}
                        </span>
                        <span className="text-slate-500 dark:text-slate-400">
                          {box.width}×{box.height}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteBox(box.id)}
                        className="h-6 w-6 p-0 text-red-500 hover:text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>

          {/* ── CENTER PANEL – Segmentation Canvas ── */}
          <div>
            <Card className="p-4 bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-950/50 shadow-lg h-full">
              {!image ? (
                <div
                  className="flex items-center justify-center rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-700 bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-800/50 dark:to-slate-900/50"
                  style={{ minHeight: '420px' }}
                >
                  <div className="text-center px-4">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-blue-100 to-purple-100 dark:from-blue-900/30 dark:to-purple-900/30 mb-4">
                      <Upload className="h-8 w-8 text-blue-600 dark:text-blue-400" />
                    </div>
                    <p className="text-base font-medium text-slate-700 dark:text-slate-300 mb-1">
                      上传图像开始使用
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-500">
                      支持 PNG、JPG 等图像格式
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Image Canvas */}
                  <div
                    ref={canvasRef}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseLeave}
                    onTouchStart={handleTouchStart}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                    onTouchCancel={handleTouchCancel}
                    className="relative overflow-hidden rounded-xl border-2 border-slate-200 dark:border-slate-700 shadow-md cursor-crosshair touch-none"
                    style={{
                      width: '100%',
                      paddingBottom: imageDimensions
                        ? `${(imageDimensions.height / imageDimensions.width) * 100}%`
                        : '75%',
                    }}
                  >
                    {/* Original Image */}
                    <img
                      src={image}
                      alt="上传的图像"
                      className="absolute inset-0 h-full w-full object-contain select-none"
                      draggable={false}
                    />

                    {/* Mask Overlay - Only show CG and PZ */}
                    {result?.masks && (
                      <div className="absolute inset-0 pointer-events-none">
                        {result.masks.CG && (
                          <img
                            src={result.masks.CG}
                            alt="CG Mask"
                            className="absolute inset-0 h-full w-full object-contain"
                            style={{ opacity: 0.7 }}
                          />
                        )}
                        {result.masks.PZ && (
                          <img
                            src={result.masks.PZ}
                            alt="PZ Mask"
                            className="absolute inset-0 h-full w-full object-contain"
                            style={{ opacity: 0.7 }}
                          />
                        )}
                      </div>
                    )}

                    {/* Selection Boxes - Hide when segmentation result is available, show when drawing */}
                    {(!result?.masks || isDrawing) && displayBoxes.length > 0 && imageDimensions && (
                      <>
                        {displayBoxes.map((displayBox) => (
                          <div
                            key={displayBox.id}
                            className={`absolute border-2 pointer-events-none ${
                              displayBox.type === 'WG'
                                ? 'border-blue-500 bg-blue-500/20'
                                : 'border-orange-500 bg-orange-500/20'
                            }`}
                            style={{
                              left: `${(displayBox.x / imageDimensions.width) * 100}%`,
                              top: `${(displayBox.y / imageDimensions.height) * 100}%`,
                              width: `${(displayBox.width / imageDimensions.width) * 100}%`,
                              height: `${(displayBox.height / imageDimensions.height) * 100}%`,
                            }}
                          >
                            {/* Box corners */}
                            {displayBox.type === 'WG' ? (
                              <>
                                <div className="absolute -top-1 -left-1 size-3 border-l-2 border-t-2 border-blue-500" />
                                <div className="absolute -top-1 -right-1 size-3 border-r-2 border-t-2 border-blue-500" />
                                <div className="absolute -bottom-1 -left-1 size-3 border-l-2 border-b-2 border-blue-500" />
                                <div className="absolute -bottom-1 -right-1 size-3 border-r-2 border-b-2 border-blue-500" />
                                {/* Box label */}
                                <div className="absolute -top-6 left-0 rounded bg-blue-500 px-2 py-0.5 text-xs font-bold text-white">
                                  WG
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="absolute -top-1 -left-1 size-3 border-l-2 border-t-2 border-orange-500" />
                                <div className="absolute -top-1 -right-1 size-3 border-r-2 border-t-2 border-orange-500" />
                                <div className="absolute -bottom-1 -left-1 size-3 border-l-2 border-b-2 border-orange-500" />
                                <div className="absolute -bottom-1 -right-1 size-3 border-r-2 border-b-2 border-orange-500" />
                                {/* Box label */}
                                <div className="absolute -top-6 left-0 rounded bg-orange-500 px-2 py-0.5 text-xs font-bold text-white">
                                  CG
                                </div>
                              </>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>

                  {/* Controls */}
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-slate-600 dark:text-slate-400 min-w-0 truncate">
                      {boxes.length > 0
                        ? `${boxes.length} 个标注框: ${boxes.map(b => b.type).join(', ')}`
                        : isDrawing
                        ? '正在绘制标注框...'
                        : '点击并拖拽图像以绘制标注框'}
                    </p>
                    <Button
                      onClick={handleSegment}
                      disabled={boxes.length === 0 || isLoading}
                      className="min-w-[140px] flex-shrink-0"
                    >
                      {isLoading ? '处理中...' : '运行分割'}
                    </Button>
                  </div>

                  {/* Error Message */}
                  {result?.error && (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
                      <strong>错误：</strong> {result.error}
                    </div>
                  )}

                  {/* Success Message */}
                  {result?.success && result.masks && (
                    <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
                      <strong>成功！</strong> 分割完成。
                      <div className="mt-2 space-y-1">
                        {result.masks.CG && (
                          <div className="flex items-center space-x-2">
                            <span className="inline-block h-3 w-3 rounded bg-green-500 flex-shrink-0"></span>
                            <span>CG (中央腺体) - 绿色</span>
                          </div>
                        )}
                        {result.masks.PZ && (
                          <div className="flex items-center space-x-2">
                            <span className="inline-block h-3 w-3 rounded bg-blue-500 flex-shrink-0"></span>
                            <span>PZ (外周区) - 蓝色</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>

          {/* ── RIGHT PANEL – Info & Features ── */}
          <div className="space-y-4">

            {/* Feature Highlights */}
            <Card className="p-5 bg-gradient-to-br from-white to-blue-50/40 dark:from-slate-900 dark:to-blue-950/20 border-blue-200 dark:border-blue-800">
              <div className="flex items-center gap-2 mb-3">
                <Layers className="h-4 w-4 text-blue-600 flex-shrink-0" />
                <h2 className="text-base font-bold text-blue-700 dark:text-blue-400">分割区域</h2>
              </div>
              <div className="space-y-3">
                <div className="flex items-start gap-2.5 rounded-lg bg-blue-50 dark:bg-blue-950/30 p-2.5">
                  <span className="mt-0.5 flex-shrink-0 inline-block h-3 w-3 rounded-full bg-blue-500"></span>
                  <div>
                    <p className="text-xs font-bold text-blue-700 dark:text-blue-300">WG — 全腺体</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">Whole Gland，前列腺整体轮廓</p>
                  </div>
                </div>
                <div className="flex items-start gap-2.5 rounded-lg bg-orange-50 dark:bg-orange-950/30 p-2.5">
                  <span className="mt-0.5 flex-shrink-0 inline-block h-3 w-3 rounded-full bg-orange-500"></span>
                  <div>
                    <p className="text-xs font-bold text-orange-700 dark:text-orange-300">CG — 中央腺体</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">Central Gland，前列腺中央区域</p>
                  </div>
                </div>
                <div className="flex items-start gap-2.5 rounded-lg bg-green-50 dark:bg-green-950/30 p-2.5">
                  <span className="mt-0.5 flex-shrink-0 inline-block h-3 w-3 rounded-full bg-green-500"></span>
                  <div>
                    <p className="text-xs font-bold text-green-700 dark:text-green-300">PZ — 外周带</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">Peripheral Zone，由 WG − CG 推导</p>
                  </div>
                </div>
              </div>
            </Card>

            {/* Quick Tips */}
            <Card className="p-5 bg-gradient-to-br from-white to-yellow-50/40 dark:from-slate-900 dark:to-yellow-950/20 border-yellow-200 dark:border-yellow-800">
              <div className="flex items-center gap-2 mb-3">
                <Lightbulb className="h-4 w-4 text-yellow-600 flex-shrink-0" />
                <h2 className="text-base font-bold text-yellow-700 dark:text-yellow-400">使用技巧</h2>
              </div>
              <ul className="space-y-2.5 text-xs text-slate-600 dark:text-slate-400">
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 text-yellow-500">▸</span>
                  <span>先绘制 <strong>WG</strong> 框，覆盖整个前列腺区域</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 text-yellow-500">▸</span>
                  <span>再绘制 <strong>CG</strong> 框，框选中央腺体部分</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 text-yellow-500">▸</span>
                  <span>标注框尽量贴合目标区域边界</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 text-yellow-500">▸</span>
                  <span>同时提供 WG 和 CG 框可获得 PZ 分割</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 text-yellow-500">▸</span>
                  <span>支持触屏设备绘制标注框</span>
                </li>
              </ul>
            </Card>

            {/* Model Info */}
            <Card className="p-5 bg-gradient-to-br from-white to-purple-50/40 dark:from-slate-900 dark:to-purple-950/20 border-purple-200 dark:border-purple-800">
              <div className="flex items-center gap-2 mb-3">
                <Info className="h-4 w-4 text-purple-600 flex-shrink-0" />
                <h2 className="text-base font-bold text-purple-700 dark:text-purple-400">模型信息</h2>
              </div>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-slate-400 flex-shrink-0">基础模型</dt>
                  <dd className="font-medium text-slate-700 dark:text-slate-300 text-right">SAM2</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-slate-400 flex-shrink-0">提示方式</dt>
                  <dd className="font-medium text-slate-700 dark:text-slate-300 text-right">边界框 (Box)</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-slate-400 flex-shrink-0">适用图像</dt>
                  <dd className="font-medium text-slate-700 dark:text-slate-300 text-right">前列腺 MRI</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-slate-400 flex-shrink-0">处理时间</dt>
                  <dd className="font-medium text-slate-700 dark:text-slate-300 text-right">12–18 秒</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-slate-400 flex-shrink-0">输出格式</dt>
                  <dd className="font-medium text-slate-700 dark:text-slate-300 text-right">PNG 掩码</dd>
                </div>
              </dl>
            </Card>

            {/* Results Guide */}
            <Card className="p-5 bg-gradient-to-br from-white to-green-50/40 dark:from-slate-900 dark:to-green-950/20 border-green-200 dark:border-green-800">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
                <h2 className="text-base font-bold text-green-700 dark:text-green-400">结果说明</h2>
              </div>
              <ul className="space-y-2 text-xs text-slate-600 dark:text-slate-400">
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 inline-block h-2.5 w-2.5 rounded-full bg-green-500"></span>
                  <span><strong>绿色区域</strong>为 CG 中央腺体分割结果</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 inline-block h-2.5 w-2.5 rounded-full bg-blue-500"></span>
                  <span><strong>蓝色区域</strong>为 PZ 外周带分割结果</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 text-slate-400">※</span>
                  <span>WG 框仅用于引导，不单独显示</span>
                </li>
              </ul>
            </Card>

          </div>
        </div>
      </div>
    </div>
  );
}

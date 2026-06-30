'use client';

import { useState, useRef, MouseEvent, TouchEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Upload, RefreshCw, Trash2, ImageIcon } from 'lucide-react';

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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/40 to-slate-100 p-4 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 md:p-6">
      <div className="mx-auto max-w-[1840px]">
        {/* Header */}
        <header className="mb-5 rounded-3xl border border-white/80 bg-white/85 px-6 py-4 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
          <div className="grid gap-5 lg:grid-cols-[360px_minmax(520px,1fr)_420px] lg:items-center">
            <div className="flex items-center justify-center lg:justify-start">
              <img
                src="/山东大学logo.png"
                alt="山东大学"
                className="h-16 w-auto object-contain md:h-20 lg:h-24"
              />
            </div>

            <div className="flex flex-col items-center justify-center text-center">
              <div className="flex items-center justify-center gap-4">
                <img
                  src="https://code.coze.cn/api/sandbox/coze_coding/file/proxy?expire_time=-1&file_path=assets%2Flogo3.png&nonce=97f6f9fd-07eb-4aba-95b8-ba41d6aad315&project_id=7611091818876452915&sign=83ce3ce2b2d06a8f24d566d3e8375456040b2f238f2624d80c41f1226f09cb0b"
                  alt="ProZoneSAM2 Logo"
                  className="h-14 w-auto flex-shrink-0 rounded-xl shadow-sm md:h-16"
                />
                <div className="text-left">
                  <h1 className="text-3xl font-black tracking-tight bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent md:text-4xl">
                    ProZoneSAM2
                  </h1>
                  <p className="mt-1 text-sm font-medium text-slate-600 dark:text-slate-400">
                    Interactive Prostate Zone Segmentation with Box Prompt
                  </p>
                </div>
              </div>
              <div className="mt-3 inline-flex rounded-full bg-gradient-to-r from-blue-100 to-purple-100 px-4 py-1.5 text-xs font-semibold text-blue-800 dark:from-blue-950/50 dark:to-purple-950/50 dark:text-blue-200">
                ✅ ProZoneSAM2 Model Ready
              </div>
            </div>

            <div className="flex items-center justify-center lg:justify-end">
              <img
                src="/深圳河套学院.png"
                alt="深圳河套学院"
                className="h-32 w-auto object-contain md:h-36 lg:h-40"
              />
            </div>
          </div>
        </header>

        <main className="grid gap-6 xl:grid-cols-[380px_minmax(720px,1fr)_400px] 2xl:grid-cols-[420px_minmax(840px,1fr)_440px]">
          {/* Left Panel */}
          <aside className="space-y-4">
            <Card className="border-blue-100 bg-white/90 p-5 shadow-sm dark:border-blue-900/60 dark:bg-slate-950/80">
              <h2 className="text-lg font-black text-slate-900 dark:text-slate-50">系统简介</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600 dark:text-slate-400">
                ProZoneSAM2 基于 SAM2 构建，使用边界框提示进行交互式前列腺区域分割。用户上传医学图像后，框选全腺体 WG 和中央腺体 CG，即可引导模型生成 CG 与 PZ 分割结果。
              </p>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-xl bg-blue-50 px-2 py-2 text-blue-700 dark:bg-blue-950/30 dark:text-blue-200">
                  <div className="font-black">WG</div>
                  <div className="mt-1 text-[11px]">全腺体</div>
                </div>
                <div className="rounded-xl bg-orange-50 px-2 py-2 text-orange-700 dark:bg-orange-950/30 dark:text-orange-200">
                  <div className="font-black">CG</div>
                  <div className="mt-1 text-[11px]">中央腺体</div>
                </div>
                <div className="rounded-xl bg-indigo-50 px-2 py-2 text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-200">
                  <div className="font-black">PZ</div>
                  <div className="mt-1 text-[11px]">外周带</div>
                </div>
              </div>
            </Card>

            {/* Upload Section */}
            <Card className="p-5 bg-gradient-to-br from-white to-blue-50/50 dark:from-slate-900 dark:to-blue-950/20 border-blue-200 dark:border-blue-800 shadow-sm">
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
                  disabled={isLoading}
                  className="hidden"
                  id="image-upload"
                />
                <label htmlFor="image-upload" className={isLoading ? 'pointer-events-none opacity-60' : ''}>
                  <Button
                    variant="outline"
                    className="w-full h-9 border-blue-300 hover:border-blue-400 hover:bg-blue-50 dark:border-blue-700 dark:hover:bg-blue-950/30 transition-all"
                    asChild
                  >
                    <span className="flex items-center justify-center gap-2 text-base">
                      <Upload className="h-4 w-4" />
                      上传图像
                    </span>
                  </Button>
                </label>
                <Button
                  type="button"
                  variant="outline"
                  onClick={loadSampleImage}
                  disabled={isLoading}
                  className="w-full h-9 border-purple-300 hover:border-purple-400 hover:bg-purple-50 dark:border-purple-700 dark:hover:bg-purple-950/30 transition-all"
                >
                  <ImageIcon className="mr-2 h-4 w-4 text-purple-600" />
                  <span className="text-base">加载示例图像</span>
                </Button>
                {image && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={resetAll}
                    disabled={isLoading}
                    className="w-full h-9 text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    重置
                  </Button>
                )}
              </div>
            </Card>

            {/* Box Type Selection */}
            <Card className="p-5 bg-gradient-to-br from-white to-orange-50/50 dark:from-slate-900 dark:to-orange-950/20 border-orange-200 dark:border-orange-800 shadow-sm">
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
                    disabled={isLoading}
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
                    disabled={isLoading}
                    className="h-4 w-4 text-orange-600"
                  />
                  <span className="flex-1">
                    <span className="font-bold text-orange-600">CG</span>
                    <span className="ml-2 text-base text-slate-600 dark:text-slate-400">中央腺体</span>
                  </span>
                </label>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-500 leading-relaxed">
                  💡 先绘制 WG，再绘制 CG，可得到 PZ = WG − CG。
                </p>
              </div>
            </Card>

            <Card className="p-5 bg-white/90 shadow-sm dark:bg-slate-950/80">
              <h2 className="mb-4 text-base font-bold text-slate-900 dark:text-slate-100">模式选择</h2>
              <div className="space-y-3">
                <div className="flex items-center space-x-3">
                  <input
                    type="radio"
                    id="basic-mode"
                    name="mode"
                    checked={!useMedicalMode}
                    onChange={() => setUseMedicalMode(false)}
                    disabled={isLoading}
                    className="h-4 w-4"
                  />
                  <label htmlFor="basic-mode" className="text-sm">
                    <span className="font-semibold">基础模式</span>
                    <span className="ml-2 text-slate-600 dark:text-slate-400">SAM2</span>
                  </label>
                </div>
                <div className="flex items-center space-x-3">
                  <input
                    type="radio"
                    id="medical-mode"
                    name="mode"
                    checked={useMedicalMode}
                    onChange={() => setUseMedicalMode(true)}
                    disabled={isLoading}
                    className="h-4 w-4"
                  />
                  <label htmlFor="medical-mode" className="text-sm">
                    <span className="font-semibold">医学模式</span>
                    <span className="ml-2 text-slate-600 dark:text-slate-400">ProZoneSAM2</span>
                  </label>
                </div>
              </div>
            </Card>

          </aside>

          {/* Center Panel - Canvas */}
          <section className="space-y-4">
            <Card className="p-4 bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-950/50 shadow-lg">
              <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-base font-medium text-slate-600 dark:text-slate-400">
                  {boxes.length > 0
                    ? `${boxes.length} 个标注框：${boxes.map(b => b.type).join('、')}`
                    : isDrawing
                    ? '正在绘制标注框...'
                    : '上传图像后，拖拽绘制 WG / CG 边界框。'}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {isLoading && (
                    <div className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700 dark:bg-blue-950/40 dark:text-blue-200">
                      分割中，请勿刷新页面
                    </div>
                  )}
                  <Button
                    type="button"
                    onClick={handleSegment}
                    disabled={!image || boxes.length === 0 || isLoading}
                    className="min-w-[160px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 font-bold shadow-md hover:from-blue-700 hover:to-purple-700"
                  >
                    {isLoading ? '分割中...' : '开始分割'}
                  </Button>
                </div>
              </div>

              {!image ? (
                <div className="flex aspect-[4/3] min-h-[420px] items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-gradient-to-br from-slate-50 to-slate-100 dark:border-slate-700 dark:from-slate-800/50 dark:to-slate-900/50">
                  <div className="text-center px-4">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-blue-100 to-purple-100 dark:from-blue-900/30 dark:to-purple-900/30 mb-4">
                      <Upload className="h-8 w-8 text-blue-600 dark:text-blue-400" />
                    </div>
                    <p className="text-base font-medium text-slate-700 dark:text-slate-300 mb-1">
                      上传图像开始使用
                    </p>
                    <p className="text-base text-slate-500 dark:text-slate-500">
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

                    {/* Loading Overlay */}
                    {isLoading && (
                      <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/20 backdrop-blur-[1px]">
                        <div className="rounded-2xl bg-white/95 px-5 py-4 text-center shadow-xl dark:bg-slate-950/95">
                          <RefreshCw className="mx-auto mb-2 h-6 w-6 animate-spin text-blue-600" />
                          <div className="text-sm font-bold text-slate-800 dark:text-slate-100">正在分割...</div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">模型推理中，请等待结果返回</div>
                        </div>
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
                                <div className="absolute -top-6 left-0 rounded bg-blue-500 px-2 py-0.5 text-base font-bold text-white">
                                  WG
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="absolute -top-1 -left-1 size-3 border-l-2 border-t-2 border-orange-500" />
                                <div className="absolute -top-1 -right-1 size-3 border-r-2 border-t-2 border-orange-500" />
                                <div className="absolute -bottom-1 -left-1 size-3 border-l-2 border-b-2 border-orange-500" />
                                <div className="absolute -bottom-1 -right-1 size-3 border-r-2 border-b-2 border-orange-500" />
                                <div className="absolute -top-6 left-0 rounded bg-orange-500 px-2 py-0.5 text-base font-bold text-white">
                                  CG
                                </div>
                              </>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>

                  {/* Canvas Status */}
                  <div className="rounded-2xl bg-slate-50 p-3 text-base text-slate-600 dark:bg-slate-900/60 dark:text-slate-400">
                    {boxes.length > 0
                      ? `已添加 ${boxes.length} 个标注框：${boxes.map(b => b.type).join('、')}`
                      : isDrawing
                      ? '正在绘制标注框...'
                      : '点击并拖拽图像以绘制标注框'}
                  </div>

                  {/* Error Message */}
                  {result?.error && (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-base text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
                      <strong>错误：</strong> {result.error}
                    </div>
                  )}

                  {/* Success Message */}
                  {result?.success && result.masks && (
                    <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-base text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
                      <strong>成功！</strong> 分割完成。
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {result.masks.CG && (
                          <div className="flex items-center space-x-2">
                            <span className="inline-block h-3 w-3 rounded bg-green-500"></span>
                            <span>CG (中央腺体) - 绿色</span>
                          </div>
                        )}
                        {result.masks.PZ && (
                          <div className="flex items-center space-x-2">
                            <span className="inline-block h-3 w-3 rounded bg-blue-500"></span>
                            <span>PZ (外周区) - 蓝色</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>
          </section>

          {/* Right Panel */}
          <aside className="space-y-4">
            <Card className="border-purple-100 bg-white/90 p-5 shadow-sm dark:border-purple-900/60 dark:bg-slate-950/80">
              <h2 className="text-lg font-black text-slate-900 dark:text-slate-50">操作流程</h2>
              <ol className="mt-4 space-y-3 text-sm text-slate-600 dark:text-slate-400">
                <li className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-black text-white">1</span>
                  <span>上传图像或加载示例图像。</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-black text-white">2</span>
                  <span>选择 WG / CG，并在图像中拖拽绘制边界框。</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-purple-600 text-xs font-black text-white">3</span>
                  <span>点击开始分割，等待结果叠加显示。</span>
                </li>
              </ol>
            </Card>
            {/* Boxes List */}
            {boxes.length > 0 && (
              <Card className="border-blue-100 bg-white/90 p-5 shadow-sm dark:border-blue-900/60 dark:bg-slate-950/80">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-black text-slate-900 dark:text-slate-50">标注框坐标 ({boxes.length})</h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearAllBoxes}
                    disabled={isLoading}
                    className="text-red-600 hover:text-red-700"
                  >
                    清除全部
                  </Button>
                </div>
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {boxes.filter(box => box != null).map((box) => (
                    <div
                      key={box.id}
                      className="flex items-center justify-between rounded-lg border p-3 text-sm"
                      style={{
                        borderColor: box.type === 'WG' ? 'rgba(59, 130, 246, 0.3)' : 'rgba(249, 115, 22, 0.3)',
                        backgroundColor: box.type === 'WG' ? 'rgba(59, 130, 246, 0.05)' : 'rgba(249, 115, 22, 0.05)',
                      }}
                    >
                      <div className="flex items-center space-x-3">
                        <span className={`font-bold ${box.type === 'WG' ? 'text-blue-600' : 'text-orange-600'}`}>
                          {box.type}
                        </span>
                        <span className="text-slate-600 dark:text-slate-400">
                          x:{box.x}, y:{box.y}, {box.width}×{box.height}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteBox(box.id)}
                        disabled={isLoading}
                        className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card className="border-indigo-100 bg-white/90 p-5 shadow-sm dark:border-indigo-900/60 dark:bg-slate-950/80">
              <h2 className="text-lg font-black text-slate-900 dark:text-slate-50">结果说明</h2>
              <div className="mt-4 space-y-3 text-sm leading-7 text-slate-600 dark:text-slate-400">
                <p>
                  <span className="font-bold text-orange-600">CG</span> 以绿色掩膜显示；
                  <span className="font-bold text-blue-600"> PZ</span> 以蓝色掩膜显示。
                </p>
                <div className="rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4 text-center dark:border-indigo-900/60 dark:bg-indigo-950/20">
                  <span className="font-black text-blue-700">PZ</span>
                  <span className="mx-2 text-slate-500">=</span>
                  <span className="font-black text-blue-700">WG</span>
                  <span className="mx-2 text-slate-500">−</span>
                  <span className="font-black text-orange-600">CG</span>
                </div>
              </div>
            </Card>

            <Card className="border-emerald-100 bg-white/90 p-5 shadow-sm dark:border-emerald-900/60 dark:bg-slate-950/80">
              <h2 className="text-lg font-black text-slate-900 dark:text-slate-50">标注建议</h2>
              <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-600 dark:text-slate-400">
                <li>• 边界框尽量完整覆盖目标区域，避免截断腺体边缘。</li>
                <li>• 建议先绘制 WG，再绘制 CG，便于稳定显示 PZ。</li>
                <li>• 分割完成前请保持页面打开，等待结果叠加到图像上。</li>
              </ul>
            </Card>
          </aside>
        </main>
      </div>
    </div>
  );
}

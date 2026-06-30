'use client';

import { useState, useRef, useEffect, MouseEvent, TouchEvent } from 'react';
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

  // Use refs to track drawing and segmentation state synchronously.
  // The segmentation ref prevents duplicate requests and avoids refresh-like UI resets
  // while the Railway backend is still processing the current image.
  const isDrawingRef = useRef(false);
  const currentBoxRef = useRef<Box | null>(null);
  const isSegmentingRef = useRef(false);

  // Prevent accidental refresh/navigation while segmentation is running.
  // This only protects the frontend state and does not change the image, boxes, API payload,
  // model inference, or segmentation performance.
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isLoading) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isLoading]);

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
    if (isLoading) return;
    setBoxes(prev => prev.filter(box => box.id !== boxId));
    setResult(null); // Clear results when boxes change
  };

  // Function to clear all boxes
  const clearAllBoxes = () => {
    if (isLoading) return;
    setBoxes([]);
    setResult(null);
  };

  const handleSegment = async (event?: MouseEvent<HTMLButtonElement>) => {
    event?.preventDefault();
    event?.stopPropagation();

    if (isSegmentingRef.current || isLoading) {
      console.warn('Segmentation is already running');
      return;
    }

    if (!image || boxes.length === 0) {
      console.warn('No image or boxes provided');
      return;
    }

    isSegmentingRef.current = true;
    setIsLoading(true);
    setResult(null);

    try {
      const response = await fetch('/api/segment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
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
      isSegmentingRef.current = false;
      setIsLoading(false);
    }
  };

  const resetAll = () => {
    if (isLoading) return;
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
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.12),transparent_34%),linear-gradient(135deg,#f8fafc_0%,#eef2ff_45%,#f8fafc_100%)] dark:from-slate-950 dark:to-slate-900 px-4 py-5 md:px-6 md:py-8">
      <div className="mx-auto max-w-[1760px]">
        {/* Header */}
        <header className="relative mb-6 rounded-3xl border border-white/80 bg-white/75 px-6 py-5 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-950/70">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <img
                src="https://code.coze.cn/api/sandbox/coze_coding/file/proxy?expire_time=-1&file_path=assets%2Flogo3.png&nonce=97f6f9fd-07eb-4aba-95b8-ba41d6aad315&project_id=7611091818876452915&sign=83ce3ce2b2d06a8f24d566d3e8375456040b2f238f2624d80c41f1226f09cb0b"
                alt="ProZoneSAM2 Logo"
                className="h-14 w-auto flex-shrink-0 rounded-xl shadow-sm"
              />
              <div>
                <h1 className="text-3xl font-black tracking-tight bg-gradient-to-r from-blue-600 via-violet-600 to-purple-600 bg-clip-text text-transparent md:text-4xl">
                  ProZoneSAM2
                </h1>
                <p className="mt-1 text-sm font-medium text-slate-600 dark:text-slate-400">
                  Interactive Prostate Zone Segmentation with Box Prompt
                </p>
              </div>
            </div>

            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center lg:justify-end">
              <div className="inline-flex items-center rounded-full bg-gradient-to-r from-blue-100 to-purple-100 px-4 py-1.5 text-xs font-semibold text-blue-800 shadow-sm dark:from-blue-950/50 dark:to-purple-950/50 dark:text-blue-200">
                ✅ ProZoneSAM2 Model Ready
              </div>
              <img
                src="/深圳河套学院.png"
                alt="深圳河套学院"
                className="h-12 w-auto md:h-14"
              />
            </div>
          </div>
        </header>

        {/* Main Workbench */}
        <main className="grid gap-5 xl:grid-cols-[minmax(300px,0.95fr)_minmax(560px,1.35fr)_minmax(300px,0.95fr)] 2xl:grid-cols-[380px_minmax(680px,1fr)_380px]">
          {/* Left Panel */}
          <aside className="space-y-4">
            <Card className="overflow-hidden border-blue-100 bg-white/90 p-5 shadow-md dark:border-blue-900/60 dark:bg-slate-950/80">
              <div className="mb-3 inline-flex rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700 dark:bg-blue-950/40 dark:text-blue-200">
                System Overview
              </div>
              <h2 className="text-xl font-black text-slate-900 dark:text-slate-50">
                交互式前列腺区域分割
              </h2>
              <p className="mt-3 text-sm leading-7 text-slate-600 dark:text-slate-400">
                ProZoneSAM2 基于 SAM2 构建，并使用边界框提示进行交互式前列腺区域分割。用户上传医学图像后，通过框选全腺体 WG 和中央腺体 CG，引导模型生成中央腺体与外周带 PZ 的分割结果。
              </p>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-2xl bg-blue-50 px-2 py-3 text-blue-700 dark:bg-blue-950/30 dark:text-blue-200">
                  <div className="font-black">WG</div>
                  <div className="mt-1 text-[11px]">Whole Gland</div>
                </div>
                <div className="rounded-2xl bg-orange-50 px-2 py-3 text-orange-700 dark:bg-orange-950/30 dark:text-orange-200">
                  <div className="font-black">CG</div>
                  <div className="mt-1 text-[11px]">Central Gland</div>
                </div>
                <div className="rounded-2xl bg-indigo-50 px-2 py-3 text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-200">
                  <div className="font-black">PZ</div>
                  <div className="mt-1 text-[11px]">Peripheral Zone</div>
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
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoading}
                  className="w-full h-10 border-blue-300 hover:border-blue-400 hover:bg-blue-50 dark:border-blue-700 dark:hover:bg-blue-950/30 transition-all"
                >
                  <Upload className="mr-2 h-4 w-4" />
                  <span className="text-sm font-semibold">上传图像</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={loadSampleImage}
                  disabled={isLoading}
                  className="w-full h-10 border-purple-300 hover:border-purple-400 hover:bg-purple-50 dark:border-purple-700 dark:hover:bg-purple-950/30 transition-all"
                >
                  <ImageIcon className="mr-2 h-4 w-4 text-purple-600" />
                  <span className="text-sm font-semibold">加载示例图像</span>
                </Button>
                {image && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={resetAll}
                    disabled={isLoading}
                    className="w-full h-10 text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
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
                <label className="flex items-center space-x-3 p-3 rounded-xl border-2 cursor-pointer transition-all hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-950/20 dark:border-blue-900"
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
                    <span className="ml-2 text-sm text-slate-600 dark:text-slate-400">全腺体 / Whole Gland</span>
                  </span>
                </label>
                <label className="flex items-center space-x-3 p-3 rounded-xl border-2 cursor-pointer transition-all hover:border-orange-400 hover:bg-orange-50/50 dark:hover:bg-orange-950/20 dark:border-orange-900"
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
                    <span className="ml-2 text-sm text-slate-600 dark:text-slate-400">中央腺体 / Central Gland</span>
                  </span>
                </label>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-500 leading-relaxed">
                  💡 依次绘制 WG 和 CG 标注框后运行分割，可得到 CG 与 PZ 结果。
                </p>
              </div>
            </Card>

            {/* Mode Selection */}
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
                    <span className="ml-2 text-slate-600 dark:text-slate-400">标准 SAM2</span>
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

            {/* Boxes List */}
            {boxes.length > 0 && (
              <Card className="p-5 bg-white/90 shadow-sm dark:bg-slate-950/80">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-base font-bold">标注框 ({boxes.length})</h2>
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
                      className="flex items-center justify-between rounded-xl border p-3 text-sm"
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
                          {box.width}×{box.height}
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
          </aside>

          {/* Center Panel - Canvas */}
          <section className="space-y-4">
            <Card className="overflow-hidden border-slate-200 bg-white/95 p-4 shadow-xl dark:border-slate-800 dark:bg-slate-950/80">
              <div className="mb-4 flex flex-col gap-3 border-b border-slate-100 pb-4 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-black text-slate-900 dark:text-slate-50">Segmentation Canvas</h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    上传图像后，在中心画布中拖拽绘制 WG / CG 边界框。
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded-full bg-green-50 px-3 py-1 font-bold text-green-700 dark:bg-green-950/30 dark:text-green-200">CG 绿色</span>
                  <span className="rounded-full bg-blue-50 px-3 py-1 font-bold text-blue-700 dark:bg-blue-950/30 dark:text-blue-200">PZ 蓝色</span>
                </div>
              </div>

              {!image ? (
                <div className="flex aspect-[4/3] min-h-[460px] items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-gradient-to-br from-slate-50 to-blue-50/60 dark:border-slate-700 dark:from-slate-800/50 dark:to-slate-900/50">
                  <div className="text-center px-4">
                    <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-blue-100 to-purple-100 dark:from-blue-900/30 dark:to-purple-900/30 mb-5 shadow-inner">
                      <Upload className="h-10 w-10 text-blue-600 dark:text-blue-400" />
                    </div>
                    <p className="text-lg font-bold text-slate-700 dark:text-slate-300 mb-1">
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
                    className="relative overflow-hidden rounded-2xl border-2 border-slate-200 bg-slate-950/5 shadow-inner cursor-crosshair touch-none dark:border-slate-700 dark:bg-slate-900/60"
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
                                {/* Box label */}
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

                  {/* Controls */}
                  <div className="flex flex-col gap-3 rounded-2xl bg-slate-50 p-3 dark:bg-slate-900/60 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                      {boxes.length > 0
                        ? `${boxes.length} 个标注框: ${boxes.map(b => b.type).join(', ')}`
                        : isDrawing
                        ? '正在绘制标注框...'
                        : '点击并拖拽图像以绘制标注框'}
                    </p>
                    <Button
                      type="button"
                      onClick={handleSegment}
                      disabled={boxes.length === 0 || isLoading}
                      className="min-w-[170px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 font-bold shadow-md hover:from-blue-700 hover:to-purple-700"
                    >
                      {isLoading ? '处理中...' : '运行分割'}
                    </Button>
                  </div>

                  {/* Error Message */}
                  {result?.error && (
                    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
                      <strong>错误：</strong> {result.error}
                    </div>
                  )}

                  {/* Success Message */}
                  {result?.success && result.masks && (
                    <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
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
            <Card className="border-purple-100 bg-white/90 p-5 shadow-md dark:border-purple-900/60 dark:bg-slate-950/80">
              <div className="mb-3 inline-flex rounded-full bg-purple-50 px-3 py-1 text-xs font-bold text-purple-700 dark:bg-purple-950/40 dark:text-purple-200">
                Workflow
              </div>
              <h2 className="text-lg font-black text-slate-900 dark:text-slate-50">推荐操作流程</h2>
              <div className="mt-4 space-y-3 text-sm text-slate-600 dark:text-slate-400">
                <div className="flex gap-3 rounded-2xl bg-slate-50 p-3 dark:bg-slate-900/60">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-black text-white">1</span>
                  <div>
                    <div className="font-bold text-slate-800 dark:text-slate-100">上传图像</div>
                    <div className="mt-0.5 leading-6">导入前列腺 MRI 或超声二维图像。</div>
                  </div>
                </div>
                <div className="flex gap-3 rounded-2xl bg-slate-50 p-3 dark:bg-slate-900/60">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-black text-white">2</span>
                  <div>
                    <div className="font-bold text-slate-800 dark:text-slate-100">绘制 WG 与 CG</div>
                    <div className="mt-0.5 leading-6">先框选全腺体，再框选中央腺体，边界框尽量覆盖目标区域。</div>
                  </div>
                </div>
                <div className="flex gap-3 rounded-2xl bg-slate-50 p-3 dark:bg-slate-900/60">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-purple-600 text-xs font-black text-white">3</span>
                  <div>
                    <div className="font-bold text-slate-800 dark:text-slate-100">运行分割</div>
                    <div className="mt-0.5 leading-6">模型根据 box prompt 输出 CG 与 PZ 可视化叠加结果。</div>
                  </div>
                </div>
              </div>
            </Card>

            <Card className="border-indigo-100 bg-white/90 p-5 shadow-md dark:border-indigo-900/60 dark:bg-slate-950/80">
              <div className="mb-3 inline-flex rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-200">
                Model Logic
              </div>
              <h2 className="text-lg font-black text-slate-900 dark:text-slate-50">区域生成逻辑</h2>
              <div className="mt-4 space-y-3 text-sm leading-7 text-slate-600 dark:text-slate-400">
                <p>
                  <span className="font-bold text-blue-600">WG</span> 表示前列腺全腺体区域，
                  <span className="font-bold text-orange-600"> CG</span> 表示中央腺体区域。
                </p>
                <div className="rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4 text-center dark:border-indigo-900/60 dark:bg-indigo-950/20">
                  <span className="font-black text-blue-700">PZ</span>
                  <span className="mx-2 text-slate-500">=</span>
                  <span className="font-black text-blue-700">WG</span>
                  <span className="mx-2 text-slate-500">−</span>
                  <span className="font-black text-orange-600">CG</span>
                </div>
                <p>
                  建议同时输入 WG 和 CG 两类提示框，便于获得更完整的外周带分割显示。
                </p>
              </div>
            </Card>

            <Card className="border-emerald-100 bg-white/90 p-5 shadow-md dark:border-emerald-900/60 dark:bg-slate-950/80">
              <div className="mb-3 inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                Display Notes
              </div>
              <h2 className="text-lg font-black text-slate-900 dark:text-slate-50">结果说明</h2>
              <ul className="mt-4 space-y-3 text-sm text-slate-600 dark:text-slate-400">
                <li className="flex items-start gap-2">
                  <span className="mt-1 inline-block h-3 w-3 rounded-full bg-green-500"></span>
                  <span><strong>CG</strong> 使用绿色半透明区域显示。</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-1 inline-block h-3 w-3 rounded-full bg-blue-500"></span>
                  <span><strong>PZ</strong> 使用蓝色半透明区域显示。</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-1 inline-block h-3 w-3 rounded-full bg-slate-400"></span>
                  <span>当前页面仅调整布局与说明文字，不改变分割接口、推理参数和后处理流程。</span>
                </li>
              </ul>
            </Card>
          </aside>
        </main>
      </div>
    </div>
  );
}

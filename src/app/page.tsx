'use client';

import { useState, useRef, MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Upload, RefreshCw, Trash2, Plus } from 'lucide-react';

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
  const loadSampleImage = () => {
    const sampleImage = new Image();
    sampleImage.onload = () => {
      setImageDimensions({ width: sampleImage.width, height: sampleImage.height });
      setImage('/assets/test_image.png');
      setBoxes([]); // Clear all boxes
      setResult(null);
      setStartPoint(null);
      setCurrentBox(null);
    };
    sampleImage.onerror = () => {
      console.error('Failed to load sample image');
      alert('Failed to load sample image');
    };
    sampleImage.src = '/assets/test_image.png';
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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-7xl mx-auto relative overflow-hidden">
        {/* Shenzhen Hetao College Logo - absolute top-right */}
        <img
          src="/深圳河套学院.png"
          alt="深圳河套学院"
          className="absolute -top-8 right-0 md:right-2 w-64 md:w-80 lg:w-96 h-auto z-20"
        />

        {/* Header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="flex items-center gap-3 mb-2">
            <img
              src="https://code.coze.cn/api/sandbox/coze_coding/file/proxy?expire_time=-1&file_path=assets%2Flogo3.png&nonce=97f6f9fd-07eb-4aba-95b8-ba41d6aad315&project_id=7611091818876452915&sign=83ce3ce2b2d06a8f24d566d3e8375456040b2f238f2624d80c41f1226f09cb0b"
              alt="ProZoneSAM2 Logo"
              className="h-12 w-auto flex-shrink-0"
            />
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent leading-tight">
              ProZoneSAM2
            </h1>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Interactive Medical Image Segmentation with Box Prompt
          </p>
          <div className="mt-2 inline-flex items-center rounded-full bg-gradient-to-r from-blue-100 to-purple-100 px-3 py-1 text-xs text-blue-800 dark:from-blue-950/50 dark:to-purple-950/50 dark:text-blue-200">
            ✅ ProZoneSAM2 Model Ready
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-4">
          {/* Left Panel - Controls */}
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

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-semibold">模式选择</h2>
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
              <Card className="p-6">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold">标注框 ({boxes.length})</h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearAllBoxes}
                    className="text-red-600 hover:text-red-700"
                  >
                    清除全部
                  </Button>
                </div>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {boxes.filter(box => box != null).map((box, index) => (
                    <div
                      key={box.id}
                      className="flex items-center justify-between rounded-lg border p-3 text-base"
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
                          {box.width}×{box.height} at ({box.x}, {box.y})
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteBox(box.id)}
                        className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>

          {/* Right Panel - Canvas */}
          <div className="lg:col-span-3">
            <Card className="p-4 bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-950/50 shadow-lg">
              {!image ? (
                <div className="flex items-center justify-center rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-700 bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-800/50 dark:to-slate-900/50" style={{ minHeight: '400px' }}>
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
                    className="relative overflow-hidden rounded-xl border-2 border-slate-200 dark:border-slate-700 shadow-md cursor-crosshair"
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
                  <div className="flex items-center justify-between">
                    <p className="text-base text-slate-600 dark:text-slate-400">
                      {boxes.length > 0
                        ? `${boxes.length} 个标注框: ${boxes.map(b => b.type).join(', ')}`
                        : isDrawing
                        ? '正在绘制标注框...'
                        : '点击并拖拽图像以绘制标注框'}
                    </p>
                    <Button
                      onClick={handleSegment}
                      disabled={boxes.length === 0 || isLoading}
                      className="min-w-[160px]"
                    >
                      {isLoading ? '处理中...' : '运行分割'}
                    </Button>
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
                      <div className="mt-2">
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
          </div>
        </div>
      </div>
    </div>
  );
}

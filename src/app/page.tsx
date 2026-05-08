'use client';

import { useState, useRef, MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Upload, RefreshCw, Trash2 } from 'lucide-react';

interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'WG' | 'CG';
}

interface SegmentationResult {
  success: boolean;
  masks?: {
    WG?: string;
    CG?: string;
    PZ?: string;
  };
  error?: string;
}

export default function MedicalSAMDemo() {
  const [image, setImage] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [selectedBoxType, setSelectedBoxType] = useState<'WG' | 'CG'>('WG');
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [currentBox, setCurrentBox] = useState<Box | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<SegmentationResult | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [useMedicalMode, setUseMedicalMode] = useState(true);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const isDrawingRef = useRef(false);
  const currentBoxRef = useRef<Box | null>(null);

  const generateBoxId = () =>
    `box-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];

    if (!file) return;

    const reader = new FileReader();

    reader.onload = (event) => {
      const img = new Image();

      img.onload = () => {
        setImageDimensions({
          width: img.width,
          height: img.height,
        });

        setImage(event.target?.result as string);
        setBoxes([]);
        setResult(null);
        setStartPoint(null);
        setCurrentBox(null);
      };

      img.src = event.target?.result as string;
    };

    reader.readAsDataURL(file);
  };

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (!image || !imageDimensions) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = imageDimensions.width / rect.width;
    const scaleY = imageDimensions.height / rect.height;

    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    const newBox: Box = {
      id: generateBoxId(),
      x,
      y,
      width: 0,
      height: 0,
      type: selectedBoxType,
    };

    console.log('[MouseDown] Start drawing at:', {
      x,
      y,
      type: selectedBoxType,
    });

    setStartPoint({ x, y });
    setIsDrawing(true);
    setCurrentBox(newBox);

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

    const updatedBox = {
      x: width < 0 ? currentX : startPoint.x,
      y: height < 0 ? currentY : startPoint.y,
      width: Math.abs(width),
      height: Math.abs(height),
    };

    setCurrentBox((prevBox) => {
      if (!prevBox) return null;

      const newBox = {
        ...prevBox,
        ...updatedBox,
      };

      currentBoxRef.current = newBox;
      return newBox;
    });
  };

  const handleMouseUp = () => {
    console.log(
      '[MouseUp] isDrawingRef:',
      isDrawingRef.current,
      'currentBoxRef:',
      currentBoxRef.current
    );

    if (
      isDrawingRef.current &&
      currentBoxRef.current &&
      currentBoxRef.current.width > 0 &&
      currentBoxRef.current.height > 0
    ) {
      console.log('[MouseUp] Adding box:', currentBoxRef.current);
      const boxToAdd = { ...currentBoxRef.current };
      setBoxes((prev) => [...prev, boxToAdd]);
    }

    setIsDrawing(false);
    isDrawingRef.current = false;
    setStartPoint(null);
    setCurrentBox(null);
    currentBoxRef.current = null;
  };

  const handleMouseLeave = () => {
    console.log(
      '[MouseLeave] isDrawingRef:',
      isDrawingRef.current,
      'currentBoxRef:',
      currentBoxRef.current
    );

    setIsDrawing(false);
    isDrawingRef.current = false;
    setStartPoint(null);
    setCurrentBox(null);
    currentBoxRef.current = null;
  };

  const deleteBox = (boxId: string) => {
    setBoxes((prev) => prev.filter((box) => box.id !== boxId));
    setResult(null);
  };

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
          boxes,
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

  const displayBoxes = [...boxes, ...(currentBox && isDrawing ? [currentBox] : [])];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4 md:p-8 dark:from-slate-950 dark:to-slate-900">
      <div className="relative mx-auto w-full max-w-[2200px] px-6 xl:px-12">
        {/* Shenzhen Hetao College Logo */}
        <img
          src="/深圳河套学院.png"
          alt="深圳河套学院"
          className="absolute -top-8 right-0 z-20 h-auto w-64 md:right-2 md:w-80 lg:w-96"
        />

        {/* Header */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-3 flex items-center gap-4">
            <img
              src="https://code.coze.cn/api/sandbox/coze_coding/file/proxy?expire_time=-1&file_path=assets%2Flogo3.png&nonce=97f6f9fd-07eb-4aba-95b8-ba41d6aad315&project_id=7611091818876452915&sign=83ce3ce2b2d06a8f24d566d3e8375456040b2f238f2624d80c41f1226f09cb0b"
              alt="ProZoneSAM2 Logo"
              className="h-16 w-auto flex-shrink-0"
            />

            <h1 className="bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-5xl font-bold leading-tight text-transparent">
              ProZoneSAM2
            </h1>
          </div>

          <p className="text-lg text-slate-600 dark:text-slate-400">
            Interactive Medical Image Segmentation with Box Prompt
          </p>

          <div className="mt-3 inline-flex items-center rounded-full bg-gradient-to-r from-blue-100 to-purple-100 px-5 py-2 text-sm font-semibold text-blue-800 dark:from-blue-950/50 dark:to-purple-950/50 dark:text-blue-200">
            ✅ ProZoneSAM2 Model Ready
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[460px_1fr]">
          {/* Left Panel - Controls */}
          <div className="space-y-6">
            {/* Upload Section */}
            <Card className="border-blue-200 bg-gradient-to-br from-white to-blue-50/50 p-7 dark:border-blue-800 dark:from-slate-900 dark:to-blue-950/20">
              <div className="mb-4 flex items-center gap-3">
                <div className="h-7 w-1.5 rounded-full bg-gradient-to-b from-blue-500 to-purple-500" />
                <h2 className="bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-2xl font-bold text-transparent">
                  上传图像
                </h2>
              </div>

              <div className="space-y-3">
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
                    className="h-14 w-full rounded-xl border-blue-300 text-xl transition-all hover:border-blue-400 hover:bg-blue-50 dark:border-blue-700 dark:hover:bg-blue-950/30"
                    asChild
                  >
                    <span className="flex items-center gap-3 font-semibold">
                      <Upload className="h-6 w-6" />
                      上传图像
                    </span>
                  </Button>
                </label>

                {image && (
                  <Button
                    variant="ghost"
                    onClick={resetAll}
                    className="h-14 w-full rounded-xl text-xl text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                  >
                    <RefreshCw className="mr-3 h-5 w-5" />
                    重置
                  </Button>
                )}
              </div>
            </Card>

            {/* Box Type Selection */}
            <Card className="border-orange-200 bg-gradient-to-br from-white to-orange-50/50 p-7 dark:border-orange-800 dark:from-slate-900 dark:to-orange-950/20">
              <div className="mb-4 flex items-center gap-3">
                <div className="h-7 w-1.5 rounded-full bg-gradient-to-b from-blue-500 to-orange-500" />
                <h2 className="bg-gradient-to-r from-blue-600 to-orange-600 bg-clip-text text-2xl font-bold text-transparent">
                  标注类型
                </h2>
              </div>

              <div className="space-y-4">
                <label
                  className="flex cursor-pointer items-center space-x-4 rounded-xl border-2 p-5 transition-all hover:border-blue-400 hover:bg-blue-50/50 dark:border-blue-900 dark:hover:bg-blue-950/20"
                  style={{
                    borderColor:
                      selectedBoxType === 'WG'
                        ? 'rgba(59, 130, 246, 0.5)'
                        : 'rgba(59, 130, 246, 0.2)',
                    backgroundColor:
                      selectedBoxType === 'WG'
                        ? 'rgba(59, 130, 246, 0.05)'
                        : 'transparent',
                  }}
                >
                  <input
                    type="radio"
                    id="wg-type"
                    name="boxType"
                    checked={selectedBoxType === 'WG'}
                    onChange={() => setSelectedBoxType('WG')}
                    className="h-6 w-6 text-blue-600"
                  />

                  <span className="flex-1 text-xl">
                    <span className="font-bold text-blue-600">WG</span>
                    <span className="ml-3 text-slate-600 dark:text-slate-400">
                      全腺体
                    </span>
                  </span>
                </label>

                <label
                  className="flex cursor-pointer items-center space-x-4 rounded-xl border-2 p-5 transition-all hover:border-orange-400 hover:bg-orange-50/50 dark:border-orange-900 dark:hover:bg-orange-950/20"
                  style={{
                    borderColor:
                      selectedBoxType === 'CG'
                        ? 'rgba(249, 115, 22, 0.5)'
                        : 'rgba(249, 115, 22, 0.2)',
                    backgroundColor:
                      selectedBoxType === 'CG'
                        ? 'rgba(249, 115, 22, 0.05)'
                        : 'transparent',
                  }}
                >
                  <input
                    type="radio"
                    id="cg-type"
                    name="boxType"
                    checked={selectedBoxType === 'CG'}
                    onChange={() => setSelectedBoxType('CG')}
                    className="h-6 w-6 text-orange-600"
                  />

                  <span className="flex-1 text-xl">
                    <span className="font-bold text-orange-600">CG</span>
                    <span className="ml-3 text-slate-600 dark:text-slate-400">
                      中央腺体
                    </span>
                  </span>
                </label>

                <p className="mt-3 text-base leading-relaxed text-slate-500 dark:text-slate-500">
                  💡 同时绘制 WG 和 CG 标注框以获取 PZ 分割结果（结果仅显示 CG 和 PZ）
                </p>
              </div>
            </Card>

            {/* Instructions */}
            <Card className="border-purple-200 bg-gradient-to-br from-white to-purple-50/50 p-7 dark:border-purple-800 dark:from-slate-900 dark:to-purple-950/20">
              <div className="mb-4 flex items-center gap-3">
                <div className="h-7 w-1.5 rounded-full bg-gradient-to-b from-purple-500 to-pink-500" />
                <h2 className="bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-2xl font-bold text-transparent">
                  使用指南
                </h2>
              </div>

              <ul className="space-y-4 text-xl text-slate-600 dark:text-slate-400">
                <li className="flex items-center gap-3">
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 text-sm font-bold text-white">
                    1
                  </span>
                  <span>上传医学图像</span>
                </li>

                <li className="flex items-center gap-3">
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-green-500 text-sm font-bold text-white">
                    2
                  </span>
                  <span>选择标注类型 (WG/CG)</span>
                </li>

                <li className="flex items-center gap-3">
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-green-500 to-yellow-500 text-sm font-bold text-white">
                    3
                  </span>
                  <span>在图像上绘制标注框</span>
                </li>

                <li className="flex items-center gap-3">
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-yellow-500 to-orange-500 text-sm font-bold text-white">
                    4
                  </span>
                  <span>运行分割</span>
                </li>
              </ul>
            </Card>

            {/* Mode Selection */}
            <Card className="p-7">
              <h2 className="mb-5 text-2xl font-bold">模式选择</h2>

              <div className="space-y-4">
                <div className="flex items-center space-x-4">
                  <input
                    type="radio"
                    id="basic-mode"
                    name="mode"
                    checked={!useMedicalMode}
                    onChange={() => setUseMedicalMode(false)}
                    className="h-6 w-6"
                  />

                  <label htmlFor="basic-mode" className="text-xl">
                    <span className="font-semibold">基础模式</span>
                    <span className="ml-3 text-slate-600 dark:text-slate-400">
                      - 标准 SAM2
                    </span>
                  </label>
                </div>

                <div className="flex items-center space-x-4">
                  <input
                    type="radio"
                    id="medical-mode"
                    name="mode"
                    checked={useMedicalMode}
                    onChange={() => setUseMedicalMode(true)}
                    className="h-6 w-6"
                  />

                  <label htmlFor="medical-mode" className="text-xl">
                    <span className="font-semibold">医学模式</span>
                    <span className="ml-3 text-slate-600 dark:text-slate-400">
                      - ProZoneSAM2
                    </span>
                  </label>
                </div>
              </div>
            </Card>

            {/* Boxes List */}
            {boxes.length > 0 && (
              <Card className="p-7">
                <div className="mb-5 flex items-center justify-between">
                  <h2 className="text-2xl font-bold">标注框 ({boxes.length})</h2>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearAllBoxes}
                    className="text-base text-red-600 hover:text-red-700"
                  >
                    清除全部
                  </Button>
                </div>

                <div className="max-h-64 space-y-3 overflow-y-auto">
                  {boxes
                    .filter((box) => box != null)
                    .map((box) => (
                      <div
                        key={box.id}
                        className="flex items-center justify-between rounded-xl border p-5 text-lg"
                        style={{
                          borderColor:
                            box.type === 'WG'
                              ? 'rgba(59, 130, 246, 0.3)'
                              : 'rgba(249, 115, 22, 0.3)',
                          backgroundColor:
                            box.type === 'WG'
                              ? 'rgba(59, 130, 246, 0.05)'
                              : 'rgba(249, 115, 22, 0.05)',
                        }}
                      >
                        <div className="flex items-center space-x-3">
                          <span
                            className={`font-bold ${
                              box.type === 'WG'
                                ? 'text-blue-600'
                                : 'text-orange-600'
                            }`}
                          >
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
                          className="h-9 w-9 p-0 text-red-600 hover:text-red-700"
                        >
                          <Trash2 className="h-5 w-5" />
                        </Button>
                      </div>
                    ))}
                </div>
              </Card>
            )}
          </div>

          {/* Right Panel - Canvas */}
          <div className="min-w-0">
            <Card className="bg-gradient-to-br from-white to-slate-50 p-4 shadow-lg dark:from-slate-900 dark:to-slate-950/50">
              {!image ? (
                <div
                  className="flex items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-gradient-to-br from-slate-50 to-slate-100 dark:border-slate-700 dark:from-slate-800/50 dark:to-slate-900/50"
                  style={{ minHeight: '400px' }}
                >
                  <div className="px-4 text-center">
                    <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-purple-100 dark:from-blue-900/30 dark:to-purple-900/30">
                      <Upload className="h-8 w-8 text-blue-600 dark:text-blue-400" />
                    </div>

                    <p className="mb-1 text-base font-medium text-slate-700 dark:text-slate-300">
                      上传图像开始使用
                    </p>

                    <p className="text-base text-slate-500 dark:text-slate-500">
                      支持 PNG、JPG 等图像格式
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Image Canvas - Do not change this size logic */}
                  <div
                    ref={canvasRef}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseLeave}
                    className="relative cursor-crosshair overflow-hidden rounded-xl border-2 border-slate-200 shadow-md dark:border-slate-700"
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
                      className="absolute inset-0 h-full w-full select-none object-contain"
                      draggable={false}
                    />

                    {/* Mask Overlay - Only show CG and PZ */}
                    {result?.masks && (
                      <div className="pointer-events-none absolute inset-0">
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
                    {(!result?.masks || isDrawing) &&
                      displayBoxes.length > 0 &&
                      imageDimensions && (
                        <>
                          {displayBoxes.map((displayBox) => (
                            <div
                              key={displayBox.id}
                              className={`pointer-events-none absolute border-2 ${
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
                              {displayBox.type === 'WG' ? (
                                <>
                                  <div className="absolute -left-1 -top-1 size-3 border-l-2 border-t-2 border-blue-500" />
                                  <div className="absolute -right-1 -top-1 size-3 border-r-2 border-t-2 border-blue-500" />
                                  <div className="absolute -bottom-1 -left-1 size-3 border-b-2 border-l-2 border-blue-500" />
                                  <div className="absolute -bottom-1 -right-1 size-3 border-b-2 border-r-2 border-blue-500" />

                                  <div className="absolute -top-7 left-0 rounded bg-blue-500 px-2 py-0.5 text-base font-bold text-white">
                                    WG
                                  </div>
                                </>
                              ) : (
                                <>
                                  <div className="absolute -left-1 -top-1 size-3 border-l-2 border-t-2 border-orange-500" />
                                  <div className="absolute -right-1 -top-1 size-3 border-r-2 border-t-2 border-orange-500" />
                                  <div className="absolute -bottom-1 -left-1 size-3 border-b-2 border-l-2 border-orange-500" />
                                  <div className="absolute -bottom-1 -right-1 size-3 border-b-2 border-r-2 border-orange-500" />

                                  <div className="absolute -top-7 left-0 rounded bg-orange-500 px-2 py-0.5 text-base font-bold text-white">
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
                    <p className="text-lg text-slate-600 dark:text-slate-400">
                      {boxes.length > 0
                        ? `${boxes.length} 个标注框: ${boxes
                            .map((b) => b.type)
                            .join(', ')}`
                        : isDrawing
                          ? '正在绘制标注框...'
                          : '点击并拖拽图像以绘制标注框'}
                    </p>

                    <Button
                      onClick={handleSegment}
                      disabled={boxes.length === 0 || isLoading}
                      className="h-12 min-w-[220px] rounded-xl text-lg font-bold"
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
                            <span className="inline-block h-3 w-3 rounded bg-green-500" />
                            <span>CG (中央腺体) - 绿色</span>
                          </div>
                        )}

                        {result.masks.PZ && (
                          <div className="flex items-center space-x-2">
                            <span className="inline-block h-3 w-3 rounded bg-blue-500" />
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

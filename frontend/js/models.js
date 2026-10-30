// Local vision models available for benchmarking: the registry only (no transformers.js),
// so both the page and the inference worker can import it cheaply.
// The code that loads and runs the models is in engine.js.
//
// Every model gets the same user prompt text; only the model's own chat format differs.
//
// Precision presets:
//   fast:       4-bit weights with fp16 math. Needs the GPU's "shader-f16" feature.
//   balanced:   fp16 only for the embedding lookup, fp32 math elsewhere.
//   compatible: 4-bit weights with fp32 math. Slower, but works without shader-f16.
//   cpu:        no GPU; onnxruntime's WebAssembly backend.
// downloadMB is the approximate size of the selected files (cached after first load).

// balanced: fp16 only for the embedding table lookup (smaller download, fp32 math elsewhere)
// cpu: no GPU at all; runs on onnxruntime's WebAssembly backend
const BALANCED = { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' };
const COMPATIBLE = { embed_tokens: 'fp32', vision_encoder: 'q4', decoder_model_merged: 'q4' };
const smolvlmPrecisions = (fastMB, balancedMB, compatMB) => ({
  fast: { dtype: { embed_tokens: 'fp16', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16' }, device: 'webgpu', downloadMB: fastMB },
  balanced: { dtype: BALANCED, device: 'webgpu', downloadMB: balancedMB },
  compatible: { dtype: COMPATIBLE, device: 'webgpu', downloadMB: compatMB },
  cpu: { dtype: COMPATIBLE, device: 'wasm', downloadMB: compatMB },
});

export const LOCAL_MODELS = [
  {
    id: 'HuggingFaceTB/SmolVLM2-256M-Video-Instruct',
    label: 'SmolVLM2 256M',
    family: 'smolvlm',
    precisions: smolvlmPrecisions(190, 210, 265),
  },
  {
    id: 'HuggingFaceTB/SmolVLM2-500M-Video-Instruct',
    label: 'SmolVLM2 500M',
    family: 'smolvlm',
    precisions: smolvlmPrecisions(360, 390, 485),
  },
  {
    id: 'onnx-community/Janus-Pro-1B-ONNX',
    label: 'Janus-Pro 1B',
    family: 'janus',
    precisions: {
      // Same split as the official Janus WebGPU demo: input embedding on the CPU (wasm)
      fast: {
        dtype: { prepare_inputs_embeds: 'q4', language_model: 'q4f16', lm_head: 'fp16', gen_head: 'fp16', gen_img_embeds: 'fp16', image_decode: 'fp32' },
        device: { prepare_inputs_embeds: 'wasm', language_model: 'webgpu', lm_head: 'webgpu', gen_head: 'webgpu', gen_img_embeds: 'webgpu', image_decode: 'webgpu' },
        downloadMB: 2410,
      },
    },
  },
  {
    id: 'onnx-community/Qwen3.5-2B-ONNX-OPT',
    label: 'Qwen3.5 2B',
    family: 'qwen',
    // Weights live in separate .onnx_data files (one chunk each for these presets)
    externalData: { embed_tokens: 1, vision_encoder: 1, decoder_model_merged: 1 },
    precisions: {
      fast: { dtype: { embed_tokens: 'q4f16', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16' }, device: 'webgpu', downloadMB: 1585 },
      compatible: { dtype: { embed_tokens: 'q4', vision_encoder: 'q4', decoder_model_merged: 'q4' }, device: 'webgpu', downloadMB: 1755 },
    },
  },
];

export const PRECISION_LABELS = {
  fast: 'Fast: 4-bit weights, fp16 math',
  balanced: 'Balanced: 4-bit weights, fp16 embeddings, fp32 math',
  compatible: 'Compatible: 4-bit weights, fp32 math',
  cpu: 'CPU only (WebAssembly): no GPU, slower',
};

// Presets that need the GPU's fp16 shader support
export const NEEDS_F16 = new Set(['fast', 'balanced']);

export const findModel = (id) => LOCAL_MODELS.find((m) => m.id === id);

// File name suffix per precision, as transformers.js names its ONNX files
const DTYPE_SUFFIX = { fp32: '', fp16: '_fp16', q4: '_q4', q4f16: '_q4f16', q8: '_quantized', int8: '_int8', uint8: '_uint8', bnb4: '_bnb4' };

// The ONNX files a preset needs, including external weight files ("x.onnx_data", "x.onnx_data_1", ...)
export function modelFiles(entry, precision) {
  return Object.entries(entry.precisions[precision].dtype).flatMap(([part, dtype]) => {
    const file = `onnx/${part}${DTYPE_SUFFIX[dtype]}.onnx`;
    const chunks = entry.externalData?.[part] || 0;
    return [file, ...Array.from({ length: chunks }, (_, i) => `${file}_data${i ? `_${i}` : ''}`)];
  });
}


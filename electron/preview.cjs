function buildPreviewProxyArguments(sourcePath, outputPath) {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-i', sourcePath,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', outputPath,
  ]
}

module.exports = { buildPreviewProxyArguments }

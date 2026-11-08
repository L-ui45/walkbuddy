// 从摄像头当前画面截一张小图，够模型看清就行，别传原图
export function grabFrame(video, { maxEdge = 512, quality = 0.6 } = {}) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, maxEdge / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  // 前置镜头预览是镜像的，截图前先翻回来，免得模型把字看反
  if (video.classList.contains('mirror')) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return base64 || null;
}

export async function openCamera(video, { facing = 'environment' } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('这个浏览器不给摄像头权限（需要 https 或 localhost 打开）');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  stopStream(video);
  video.srcObject = stream;
  video.classList.toggle('mirror', facing === 'user');
  await video.play().catch(() => {});
  return stream;
}

export function stopStream(video) {
  const old = video?.srcObject;
  if (old) {
    for (const track of old.getTracks()) track.stop();
    video.srcObject = null;
  }
}

export function hasRearCamera() {
  return navigator.mediaDevices?.enumerateDevices
    ? navigator.mediaDevices
        .enumerateDevices()
        .then((list) => list.filter((d) => d.kind === 'videoinput').length > 1)
        .catch(() => false)
    : Promise.resolve(false);
}

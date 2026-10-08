export function drawDotTitle(canvas) {
  const source = document.createElement('canvas');
  source.width = canvas.width; source.height = canvas.height;
  const sourceContext = source.getContext('2d');
  sourceContext.font = 'bold 23px "Malgun Gothic", sans-serif';
  sourceContext.textAlign = 'center';
  sourceContext.fillText(canvas.getAttribute('aria-label'), canvas.width / 2, 29);
  const pixels = sourceContext.getImageData(0, 0, canvas.width, canvas.height).data;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111';
  for (let y = 0; y < canvas.height; y += 2) for (let x = 0; x < canvas.width; x += 2) {
    if (pixels[(y * canvas.width + x) * 4 + 3] > 70) {
      context.beginPath(); context.arc(x, y, .72, 0, Math.PI * 2); context.fill();
    }
  }
}

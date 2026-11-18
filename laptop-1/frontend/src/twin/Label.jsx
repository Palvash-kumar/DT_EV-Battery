import { useEffect, useMemo } from 'react';
import { CanvasTexture, SRGBColorSpace } from 'three';

const PX = 2; // draw at 2x for sharp text
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// A text label drawn onto a small canvas and shown as a sprite, so it always
// faces the camera. No DOM nodes and no font download, which keeps the scene
// cheap and avoids extra React roots inside the canvas.
//
// lines: [{ text, bold?, color? }]   dashed: border style for simulated values
export function Label({ lines, position, height = 0.55, dashed = false, highlight = false }) {
  const key = JSON.stringify([lines, dashed, highlight]);

  const { texture, aspect } = useMemo(() => {
    const size = 15 * PX;
    const lineH = size * 1.3;
    const pad = 7 * PX;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontFor = (l) => `${l.bold ? 700 : 500} ${size}px ${FONT}`;
    const width = Math.max(
      ...lines.map((l) => {
        ctx.font = fontFor(l);
        return ctx.measureText(l.text).width;
      }),
    );
    canvas.width = Math.ceil(width + pad * 2);
    canvas.height = Math.ceil(lines.length * lineH + pad * 2 - (lineH - size));

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = highlight ? '#1f5fae' : dashed ? '#8a5a00' : '#9da1a6';
    ctx.lineWidth = (highlight ? 3 : 2) * PX;
    ctx.setLineDash(dashed ? [6 * PX, 4 * PX] : []);
    ctx.beginPath();
    ctx.roundRect(PX, PX, canvas.width - 2 * PX, canvas.height - 2 * PX, 5 * PX);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => {
      ctx.font = fontFor(l);
      ctx.fillStyle = l.color || '#1b1b1a';
      ctx.fillText(l.text, canvas.width / 2, pad + i * lineH);
    });

    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 4;
    return { texture: tex, aspect: canvas.width / canvas.height };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => () => texture.dispose(), [texture]);

  const h = height * lines.length;
  return (
    <sprite position={position} scale={[h * aspect, h, 1]} renderOrder={10}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

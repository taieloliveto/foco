"""Genera los íconos de Foco (anillos de enfoque sobre degradé índigo). Uso: python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'web', 'icons')
os.makedirs(OUT, exist_ok=True)
A, B = (112, 96, 240), (66, 52, 190)
WHITE = (255, 255, 255, 255)


def bg(size, rounded):
    g = Image.new('RGBA', (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)
            px[x, y] = tuple(int(A[i] + (B[i] - A[i]) * t) for i in range(3)) + (255,)
    if rounded:
        m = Image.new('L', (size, size), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
        g.putalpha(m)
    return g


def render(size, rounded, scale):
    big = size * 4
    img = bg(big, rounded)
    d = ImageDraw.Draw(img)
    c = big / 2
    for r, w in [(34, 6.5), (20, 6.5)]:
        R = r / 100 * big * scale
        d.ellipse([c - R, c - R, c + R, c + R], outline=WHITE, width=int(w / 100 * big * scale))
    R = 7 / 100 * big * scale
    d.ellipse([c - R, c - R, c + R, c + R], fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


render(192, True, 1.0).save(os.path.join(OUT, 'icon-192.png'))
render(512, True, 1.0).save(os.path.join(OUT, 'icon-512.png'))
render(512, False, 0.74).save(os.path.join(OUT, 'maskable-512.png'))
render(180, False, 0.9).convert('RGB').save(os.path.join(OUT, 'apple-touch-icon.png'))
print('íconos generados en', os.path.abspath(OUT))

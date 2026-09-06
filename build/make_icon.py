"""
Generate the PDF Reader app icon: an open book with a music note, on a
rounded blue tile. Renders at high resolution for crisp antialiasing, then
exports a multi-size .ico (Windows app) and a .png (Electron window).
"""
import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SS = 8            # supersample factor for smooth edges
BASE = 256       # logical icon size
S = BASE * SS    # working canvas size


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def rounded_tile(size, radius, top, bottom):
    """A vertical gradient tile with rounded corners (RGBA)."""
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        grad.putpixel((0, y), lerp(top, bottom, y / max(1, size - 1)))
    grad = grad.resize((size, size))

    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)

    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask)
    return tile


def draw_book(d, cx, cy, w, h):
    """Open book: two curved pages meeting at a center spine."""
    white = (255, 255, 255, 255)
    page_line = (208, 220, 236, 255)

    half = w / 2
    spine_dip = h * 0.14      # how much the spine sits lower than outer edges
    top_out = cy - h / 2      # outer top edge y
    top_in = top_out + spine_dip
    bot_out = cy + h / 2
    bot_in = bot_out - spine_dip

    # Left page (polygon with a gentle curve approximated by many points)
    left = [
        (cx, top_in), (cx - half * 0.5, top_out - h * 0.02),
        (cx - half, top_out + h * 0.06),
        (cx - half, bot_out - h * 0.02),
        (cx - half * 0.5, bot_out + h * 0.02),
        (cx, bot_in),
    ]
    right = [(2 * cx - x, y) for (x, y) in left]

    d.polygon(left, fill=white)
    d.polygon(right, fill=white)

    # Spine shadow line
    d.line([(cx, top_in), (cx, bot_in)], fill=page_line, width=max(2, int(S * 0.006)))

    # Text lines on each page
    lw = max(2, int(S * 0.010))
    for i in range(4):
        ly = cy - h * 0.18 + i * (h * 0.13)
        d.line([(cx - half * 0.82, ly + (top_in - cy) * 0.0),
                (cx - half * 0.18, ly)], fill=page_line, width=lw)
        d.line([(cx + half * 0.18, ly),
                (cx + half * 0.82, ly)], fill=page_line, width=lw)


def draw_note(d, cx, cy, scale_):
    """A single eighth note sitting above the book spine."""
    accent = (255, 255, 255, 255)
    stem_w = max(3, int(S * 0.018))
    head_r = int(S * 0.045 * scale_)

    stem_top = cy - int(S * 0.14 * scale_)
    stem_x = cx + int(S * 0.02)
    # Stem
    d.line([(stem_x, stem_top), (stem_x, cy)], fill=accent, width=stem_w)
    # Flag
    d.line([(stem_x, stem_top),
            (stem_x + int(S * 0.06), stem_top + int(S * 0.06))],
           fill=accent, width=stem_w)
    # Note head
    d.ellipse([stem_x - head_r * 2, cy - head_r,
               stem_x, cy + head_r], fill=accent)


def build():
    top = (58, 141, 255)      # light blue
    bottom = (10, 90, 220)    # deeper blue
    tile = rounded_tile(S, radius=int(S * 0.22), top=top, bottom=bottom)
    d = ImageDraw.Draw(tile)

    cx = S // 2
    # Book sits slightly low; note floats above it.
    draw_book(d, cx, int(S * 0.60), w=int(S * 0.62), h=int(S * 0.40))
    draw_note(d, int(S * 0.50), int(S * 0.34), scale_=1.0)

    # Downsample to base size for antialiasing.
    icon = tile.resize((BASE, BASE), Image.LANCZOS)

    png_path = os.path.join(OUT_DIR, "icon.png")
    icon.save(png_path)

    ico_path = os.path.join(OUT_DIR, "icon.ico")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    icon.save(ico_path, sizes=[(s, s) for s in sizes])

    print("Wrote:", png_path)
    print("Wrote:", ico_path)


if __name__ == "__main__":
    build()

"""Regenerate app PNG and Windows ICO using CairoSVG and Pillow."""

from io import BytesIO
from pathlib import Path
from struct import pack

import cairosvg
from PIL import Image


artwork = Path(__file__).resolve().parent
width = 1024
source = cairosvg.svg2png(url=str(artwork / "icon.svg"), output_width=width)
master = Image.open(BytesIO(source)).convert("RGBA")


def render(size):
    return master.resize((size, size), Image.Resampling.LANCZOS)


render(512).save(artwork / "icon.png", optimize=True)

# The ICO carries independent alpha PNG frames to avoid OS scaling a single
# oversized frame for Start menu, taskbar and Explorer.
sizes = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
offset = 6 + 16 * len(sizes)
entries, frames = [], []
for size in sizes:
    png = BytesIO()
    render(size).save(png, format="PNG", optimize=True)
    frame = png.getvalue()
    entries.append(pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(frame), offset))
    frames.append(frame)
    offset += len(frame)
(artwork / "icon.ico").write_bytes(pack("<HHH", 0, 1, len(sizes)) + b"".join(entries + frames))

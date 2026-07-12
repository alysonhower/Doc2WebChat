#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = ["pillow>=12,<13"]
# ///

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1] / "src" / "icons"
SCALE = 8


def scaled(points: tuple[int, ...]) -> tuple[int, ...]:
    return tuple(value * SCALE for value in points)


def make_icon(size: int) -> None:
    canvas = Image.new("RGBA", (size * SCALE, size * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    margin = max(1, round(size * 0.06))
    radius = max(2, round(size * 0.22))
    draw.rounded_rectangle(
        scaled((margin, margin, size - margin, size - margin)),
        radius=radius * SCALE,
        fill="#16233B",
    )

    document = (round(size * 0.24), round(size * 0.16), round(size * 0.71), round(size * 0.77))
    draw.rounded_rectangle(scaled(document), radius=max(1, size // 18) * SCALE, fill="#F8FAFC")
    fold = [
        (round(size * 0.55), round(size * 0.16)),
        (round(size * 0.71), round(size * 0.32)),
        (round(size * 0.55), round(size * 0.32)),
    ]
    draw.polygon([(x * SCALE, y * SCALE) for x, y in fold], fill="#B9E8F6")

    bubble = (round(size * 0.38), round(size * 0.47), round(size * 0.86), round(size * 0.78))
    draw.rounded_rectangle(scaled(bubble), radius=max(2, size // 10) * SCALE, fill="#22C3E6")
    tail = [
        (round(size * 0.67), round(size * 0.75)),
        (round(size * 0.75), round(size * 0.88)),
        (round(size * 0.77), round(size * 0.74)),
    ]
    draw.polygon([(x * SCALE, y * SCALE) for x, y in tail], fill="#22C3E6")

    dot_radius = max(1, round(size * 0.025))
    for center_x in (0.52, 0.62, 0.72):
        cx = round(size * center_x)
        cy = round(size * 0.625)
        draw.ellipse(
            scaled((cx - dot_radius, cy - dot_radius, cx + dot_radius, cy + dot_radius)),
            fill="#16233B",
        )

    icon = canvas.resize((size, size), Image.Resampling.LANCZOS)
    icon.save(ROOT / f"icon-{size}.png", optimize=True)


if __name__ == "__main__":
    for icon_size in (16, 32, 48, 128):
        make_icon(icon_size)

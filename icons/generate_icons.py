from PIL import Image, ImageDraw, ImageFont

ALT_BLUE = (59, 92, 155, 255)  # Altimate Medical wordmark blue
WHITE = (255, 255, 255, 255)
FONT_PATH = "/c/Windows/Fonts/segoeuib.ttf"
MARK_PATH = "altimate-mark.png"  # cropped from the Altimate Medical logo, transparent bg


def rounded_mask(size, radius_ratio):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    return m


def with_opacity(img, opacity):
    img = img.copy()
    a = img.getchannel("A").point(lambda p: int(p * opacity))
    img.putalpha(a)
    return img


def paste_centered(canvas, layer, scale):
    size = canvas.size[0]
    target = int(size * scale)
    ratio = target / max(layer.size)
    resized = layer.resize((int(layer.size[0] * ratio), int(layer.size[1] * ratio)), Image.LANCZOS)
    x = (size - resized.size[0]) // 2
    y = (size - resized.size[1]) // 2
    canvas.alpha_composite(resized, (x, y))


def draw_ff(canvas, size, color, scale=0.46):
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(FONT_PATH, int(size * scale))
    text = "FF"
    bbox = draw.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=color)


def make_icon(size, out_path, radius_ratio=0.22, logo_scale=0.86, ff_scale=0.46, logo_opacity=0.32, full_bleed=False):
    mark = Image.open(MARK_PATH).convert("RGBA")

    canvas = Image.new("RGBA", (size, size), WHITE)
    paste_centered(canvas, with_opacity(mark, logo_opacity), logo_scale)
    draw_ff(canvas, size, ALT_BLUE, scale=ff_scale)

    if full_bleed:
        canvas.save(out_path)
        return

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(canvas, (0, 0), rounded_mask(size, radius_ratio))
    out.save(out_path)


if __name__ == "__main__":
    make_icon(192, "icon-192.png")
    make_icon(512, "icon-512.png")
    # Maskable: full-bleed (no transparency/rounding — the OS applies its own mask shape),
    # content scaled down further so it survives being cropped to a circle.
    make_icon(512, "icon-maskable-512.png", logo_scale=0.70, ff_scale=0.36, full_bleed=True)
    make_icon(180, "apple-touch-icon.png", full_bleed=True)  # iOS fills the square itself
    make_icon(32, "favicon-32.png", radius_ratio=0.18, logo_scale=0.9, ff_scale=0.5, logo_opacity=0.4)
    print("done")

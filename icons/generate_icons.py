from PIL import Image, ImageDraw, ImageFont

BLUE = (37, 99, 235, 255)  # tailwind blue-600
WHITE = (255, 255, 255, 255)
FONT_PATH = "/c/Windows/Fonts/segoeuib.ttf"


def rounded_square(size, radius_ratio, bg=BLUE, transparent=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * radius_ratio)
    if transparent:
        draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=bg)
    else:
        draw.rectangle([0, 0, size - 1, size - 1], fill=bg)
    return img, draw


def draw_monogram(size, draw, text="FF", scale=0.46):
    font = ImageFont.truetype(FONT_PATH, int(size * scale))
    bbox = draw.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=WHITE)


def draw_mic_badge(size, img):
    # small mic glyph badge, bottom-right accent circle
    badge_d = int(size * 0.34)
    cx, cy = int(size * 0.78), int(size * 0.78)
    badge = Image.new("RGBA", (badge_d, badge_d), (0, 0, 0, 0))
    bd = ImageDraw.Draw(badge)
    bd.ellipse([0, 0, badge_d - 1, badge_d - 1], fill=(30, 64, 175, 255))  # blue-800
    # mic body
    mw, mh = badge_d * 0.22, badge_d * 0.4
    mx0, my0 = badge_d / 2 - mw / 2, badge_d * 0.18
    bd.rounded_rectangle([mx0, my0, mx0 + mw, my0 + mh], radius=mw / 2, fill=WHITE)
    # mic stand arc
    bd.arc([badge_d * 0.28, badge_d * 0.32, badge_d * 0.72, badge_d * 0.72], start=20, end=160, fill=WHITE, width=max(2, int(badge_d * 0.06)))
    bd.line([badge_d / 2, badge_d * 0.72, badge_d / 2, badge_d * 0.84], fill=WHITE, width=max(2, int(badge_d * 0.06)))
    img.alpha_composite(badge, (int(cx - badge_d / 2), int(cy - badge_d / 2)))


def make_icon(size, radius_ratio, out_path, maskable=False):
    img, draw = rounded_square(size, radius_ratio, transparent=not maskable)
    scale = 0.40 if maskable else 0.46
    draw_monogram(size, draw, scale=scale)
    if not maskable:
        draw_mic_badge(size, img)
    img.save(out_path)


if __name__ == "__main__":
    make_icon(192, 0.22, "icon-192.png")
    make_icon(512, 0.22, "icon-512.png")
    make_icon(512, 0.0, "icon-maskable-512.png", maskable=True)
    make_icon(180, 0.0, "apple-touch-icon.png")  # iOS ignores radius/alpha, fills square
    make_icon(32, 0.18, "favicon-32.png")
    print("done")

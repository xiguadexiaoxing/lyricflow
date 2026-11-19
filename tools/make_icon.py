from PIL import Image, ImageDraw, ImageFont
import math

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

# diagonal gradient: #ffd28a -> #ffb054 -> #ff7a59
stops = [(0.0, (255, 210, 138)), (0.52, (255, 176, 84)), (1.0, (255, 122, 89))]
grad = Image.new("RGB", (SIZE, SIZE))
px = grad.load()
for y in range(SIZE):
    for x in range(SIZE):
        t = (x + y) / (2.0 * (SIZE - 1))
        for i in range(len(stops) - 1):
            a, ca = stops[i]
            b, cb = stops[i + 1]
            if a <= t <= b:
                f = (t - a) / (b - a)
                px[x, y] = tuple(int(ca[j] + (cb[j] - ca[j]) * f) for j in range(3))
                break

mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=224, fill=255)
img.paste(grad, (0, 0), mask)

# soft top highlight
highlight = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
hd = ImageDraw.Draw(highlight)
for i in range(220):
    alpha = int(26 * (1 - i / 220.0))
    hd.rounded_rectangle([20 + i, 14 + i, SIZE - 20 - i, SIZE // 2], radius=200, outline=(255, 255, 255, alpha), width=2)
img = Image.alpha_composite(img, Image.composite(highlight, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), mask))

# music note glyph
font = ImageFont.truetype(r"C:\Windows\Fonts\seguisym.ttf", 640)
glyph = "♫"
draw = ImageDraw.Draw(img)
bbox = draw.textbbox((0, 0), glyph, font=font)
w = bbox[2] - bbox[0]
h = bbox[3] - bbox[1]
x = (SIZE - w) / 2 - bbox[0]
y = (SIZE - h) / 2 - bbox[1] - 12
draw.text((x, y), glyph, font=font, fill=(27, 19, 5, 255))

# trim to 256 and export
img256 = img.resize((256, 256), Image.LANCZOS)
img256.save(r"D:\lyricflow-main\assets\lyricflow-256.png")
img.save(r"D:\lyricflow-main\assets\lyricflow.ico", format="ICO",
         sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)])
print("bbox", bbox, "saved")
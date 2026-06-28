import cv2, numpy as np
from PIL import Image

src = "tmp/imagegen/robot-source.jpeg"
img = cv2.cvtColor(cv2.imread(src), cv2.COLOR_BGR2RGB).astype(np.float32)
h, w = img.shape[:2]

corners = np.vstack([img[0:25,0:25].reshape(-1,3), img[0:25,w-25:w].reshape(-1,3),
                     img[h-25:h,0:25].reshape(-1,3), img[h-25:h,w-25:w].reshape(-1,3)])
bg = corners.mean(0)
dist = np.linalg.norm(img - bg, axis=2)

T0, T1 = 45.0, 95.0
alpha = np.clip((dist - T0)/(T1 - T0), 0, 1)

hard_bg = (dist < (T0+T1)/2).astype(np.uint8)
n, lbl = cv2.connectedComponents(hard_bg)
border_labels = set(lbl[0,:]) | set(lbl[-1,:]) | set(lbl[:,0]) | set(lbl[:,-1])
border_labels.discard(0)
connected_bg = np.isin(lbl, list(border_labels))

a = (alpha*255).astype(np.uint8)
a[connected_bg & (dist < T0)] = 0
a[~connected_bg] = 255
a = cv2.morphologyEx(a, cv2.MORPH_CLOSE, np.ones((3,3),np.uint8))

# 면적 임계값 이상인 모든 조각 유지(양팔 보존), 작은 노이즈만 제거
nC, lblC, st, _ = cv2.connectedComponentsWithStats((a>10).astype(np.uint8))
keep = np.zeros_like(a, bool)
min_area = 0.003 * h * w   # 전체의 0.3% 이상이면 유지
kept = 0
for i in range(1, nC):
    if st[i, cv2.CC_STAT_AREA] >= min_area:
        keep |= (lblC == i); kept += 1
a[~keep] = 0
a = cv2.GaussianBlur(a,(3,3),0)
print("kept components:", kept)

rgba = np.dstack([img.astype(np.uint8), a])
out = Image.fromarray(rgba,"RGBA")
bb = Image.fromarray(a).getbbox()
crop = out.crop(bb); cw,ch = crop.size
side = max(cw,ch); pad=int(side*0.10)
canvas = Image.new("RGBA",(side+2*pad,side+2*pad),(0,0,0,0))
canvas.paste(crop,((side+2*pad-cw)//2,(side+2*pad-ch)//2),crop)
canvas.resize((256,256),Image.LANCZOS).save("tmp/imagegen/robot-extracted.png")
print("alpha bbox:", bb, "crop:", (cw,ch))

# 다크 미리보기
im = Image.open("tmp/imagegen/robot-extracted.png").convert("RGBA")
c = Image.new("RGBA", im.size, (17,17,17,255)); c.alpha_composite(im)
c.convert("RGB").save("tmp/imagegen/preview-dark.png")

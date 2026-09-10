export const MAX_PHOTOS = 4;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export interface Photo {
  id: string;
  name: string;
  dataUrl: string;
}

export async function preparePhoto(file: File): Promise<Photo> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error(
      "Choose JPG, PNG, or WebP images. Export HEIC photos as JPG first.",
    );
  if (file.size > MAX_PHOTO_BYTES)
    throw new Error("Each original photo must be smaller than 8 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare your photo.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    if (dataUrl.length > 2_000_000)
      throw new Error("The photo is too detailed. Try a smaller crop.");
    return { id: crypto.randomUUID(), name: file.name, dataUrl };
  } finally {
    bitmap.close();
  }
}
